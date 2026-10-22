// Checklist projects and templates: reading them, making a template, and writing and editing its steps.
import { andList, memo, raw, store, taskDrafts, TZ, userCache } from '../util.js';
import { allPages, api, NetError, passing, why } from '../api.js';
import { fmtTime, isSet, repeats, startOfDay } from '../dates.js';
import { htmlToText, parseFragment } from '../html.js';
import {
  allComments,
  CHECKLIST_MARK,
  comesRound,
  draftSteps,
  endedOf,
  inBatches,
  isChecklistDesc,
  isTemplateLabel,
  notesOnly,
  parseStep,
  problemText,
  roleOf,
  runRules,
  stepInfos,
  stepProblems,
  stepsOf,
  stepWords,
  repeatWords,
  templateName,
  templateTitle,
} from '../checklists.js';
import { captureLines } from '../quickadd.js';
import { itemsOf, packParsed, randomId, sync, uuid7 } from '../sync.js';
import { saved } from '../lists.js';
import {
  archiveAsk,
  archivedText,
  changedBut,
  checklistsOn,
  deletedProject,
  deleteProjectAsk,
  directFailed,
  notDone,
  removeStepAsk,
  SAID,
  setUpText,
  startMarksDone,
  templateCreated,
  templateMade,
  templateNotSaved,
  templateProblem,
  waitText,
} from '../messages.js';
import { renderSeq } from './views.js';
import { newBox, newStepBox } from './core.js';
import { addLines, lineOf, movedSteps, personOf, startsIn, tagOf } from '../ops/index.js';
import { copyOf, putting, started } from './tasks.js';
import { TASK, TASK_COUNT, TASK_REACTIONS_COMMENTS } from '../tasks.js';

/* How many days back Checklists shows finished checklists. Older ones are in the project's Done. */
export const FINISHED_DAYS = 7;
// Templates as last loaded, kept so a checklist can be started offline. This maps a template id to the fields a start
// needs, with the steps in order. Until Checklists loads, it is the copy saved on the phone.
let templatesKept = null;
const kept = () => (templatesKept ||= saved.get('templates') || {});
// A memo of each task's role, by task id (role).
const roles = new Map();
const keepTemplate = t => {
  templatesKept[t.id] = {
    id: t.id,
    title: t.title,
    project_id: t.project_id,
    labels: t.labels,
    done: t.done,
    due_date: t.due_date,
    repeat_after: t.repeat_after,
    repeat_mode: t.repeat_mode,
    assignees: t.assignees || [],
    related_tasks: { subtask: stepsOf(t).map(s => ({ id: s.id, title: s.title })) },
  };
};
// A time as it appears in a template's schedule message, formatted as Today does: "6:00 PM" today, "tomorrow 8:00 AM",
// "yesterday 6:00 PM", else "Wed, Oct 7, 8:00 AM".
const whenText = (d, today) => {
  const days = Math.round((startOfDay(d) - startOfDay()) / 864e5);
  if (!days) return fmtTime(d) + (today ? ' ' + today : '');
  if (days === 1 || days === -1) return (days === 1 ? 'tomorrow ' : 'yesterday ') + fmtTime(d);
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
// The same time inside a sentence: "today at 6:00 PM", "tomorrow at 8:00 AM", "on Wed, Oct 7 at 8:00 AM".
const onText = d => {
  const days = Math.round((startOfDay(d) - startOfDay()) / 864e5);
  return (
    (!days
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days === -1
          ? 'yesterday'
          : 'on ' + d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) +
    ' at ' +
    fmtTime(d)
  );
};

export default {
  // Keep a template as its sheet shows it now, so a checklist started offline sees a step that was just moved, added or
  // removed.
  keepTemplate(t) {
    if (!this.readyTemplate(t)) return;
    templatesKept = { ...saved.get('templates'), ...kept() };
    keepTemplate(t);
    saved.set('templates', templatesKept);
  },
  isChecklistProject(p) {
    return isChecklistDesc(p?.description);
  },
  // The highlighted tab. A checklist highlights Checklists, and a project highlights Projects.
  get tab() {
    return ['checklists', 'run'].includes(this.route.name)
      ? 'checklists'
      : this.route.name === 'today'
        ? 'today'
        : 'projects';
  },
  /* What a task is in Checklists (roleOf). Many bindings ask about a row's task, so its role is a memo for each task
     id (memo, util.js). The memo doesn't see Vikunja's copies or the kept templates change, so it can miss a parent that
     Pocket learns later is a template. No row asks for 'tplstep'. Any other copy of a task, or a task asked about with
     the list it is in, gets its role worked out each time. */
  role(t, list = null) {
    if (!this.checklistIds.has(t?.project_id)) return null;
    const id = t.id;
    if (list || raw(t) !== raw(this.tasks[id])) return roleOf(t, this.known(list));
    if (!roles.has(id))
      roles.set(
        id,
        memo(function () {
          return roleOf(this.tasks[id], this.known());
        }),
      );
    return roles.get(id).call(this);
  },
  // What Pocket has seen of a task's parent, which Vikunja leaves out of the task (roleOf).
  known(list = null) {
    return { checklistIds: this.checklistIds, copyOf, kept: kept(), list };
  },
  // A template that Checklists lists and a checklist can start from. A template Make template didn't finish, or a copy
  // still being set up as a checklist, isn't.
  readyTemplate(t) {
    return this.role(t) === 'template' && (t.done || comesRound(t));
  },
  // Whether a task orders its subtasks by its own order line, as templates and runs do. Other tasks order them by the
  // project's List view (order.js).
  hasOwnOrder(t) {
    return ['template', 'run'].includes(this.role(t));
  },
  // The role of the open task in the sheet. A template that isn't ready gets the sheet of a candidate, so Make template
  // can finish it.
  get checklistRole() {
    const t = this.sheetTask,
      role = this.role(t);
    return role === 'template' && !this.readyTemplate(t) ? 'candidate' : role;
  },
  /* Remove from a list what belongs on Checklists: done templates and their steps. This is used for a project's Done
     and for search. An open template with a due date stays, because it is due. With `runSteps`, the steps of a
     checklist are removed too, because they show on the checklist's screen. A step's template can be in the same
     list, so role() is given the list. */
  withoutTemplates(list, runSteps = false) {
    if (!this.checklistIds.size) return list;
    return list.filter(t => {
      const r = this.role(t, list);
      return !((t.done && r === 'template') || r === 'tplstep' || (runSteps && r === 'step'));
    });
  },
  // What a project's open list shows: a checklist in progress, as a card with its open steps. The steps of a finished
  // checklist are left out. So a checklist finished with steps not done appears only in Done, not as a card over them.
  onProjectList(list) {
    const runs = new Set(list.filter(t => !t.done && this.isRunTask(t)).map(t => t.id));
    return this.withoutTemplates(list).filter(t => {
      const r = this.stepRun(t);
      return !r || runs.has(r);
    });
  },
  // A template's "template" label can't be removed, because the label is what makes it a template.
  keepsLabel(l) {
    return this.checklistRole === 'template' && isTemplateLabel(l);
  },
  // A template and its steps are never ticked as done, so their sheets have no tick, progress, priority or due date.
  get ofTemplate() {
    return ['template', 'tplstep'].includes(this.checklistRole);
  },
  // Open the project's sheet. What it offers depends on the user's access (Vikunja's max_permission: 0 read, 1 write,
  // 2 admin). Renaming, archiving and checklists need write. Deleting needs admin.
  async openProject() {
    const p = this.view.project;
    if (!p) return;
    this.openSheet('project');
    this.sheet.project = p;
    this.sheet.projEdit = {
      name: p.title,
      perm: null,
      tasks: null,
      kids: this.projects.filter(x => x.parent_project_id === p.id).length,
    };
    try {
      const [full, list] = await Promise.all([api('/projects/' + p.id), api(`/projects/${p.id}/tasks?per_page=1`)]);
      if (this.sheet.project?.id !== p.id) return;
      Object.assign(this.sheet.projEdit, { perm: full.max_permission ?? 0, tasks: list?.total ?? null });
      this.perms[p.id] = full.max_permission ?? 1;
      saved.set('perms', this.perms);
    } catch (e) {
      if (this.sheet.project?.id === p.id) this.sheet.projEdit.perm = e instanceof NetError ? -1 : 0;
    }
  },
  // Update a changed project in the project list, on the screen and in the sheet.
  projectChanged(next) {
    this.setProjects(this.projects.map(x => (x.id === next.id ? next : x)));
    saved.set('projects', this.projects);
    if (this.view.project?.id === next.id) this.view.project = next;
    if (this.sheet.project?.id === next.id) this.sheet.project = next;
  },
  async renameProject() {
    const p = this.sheet.project,
      e = this.sheet.projEdit,
      title = e?.name.trim();
    if (!p || !title || title === p.title) {
      if (e && p) e.name = p.title;
      return;
    }
    try {
      const got = (await api('/projects/' + p.id, { method: 'PATCH', body: { title } })) || { title };
      this.projectChanged({ ...p, ...got });
      this.say(SAID.renamed, { place: 'sheet:top' });
    } catch (err) {
      e.name = p.title;
      this.say(directFailed(err, 'rename the project', 'Renaming the project'), { place: 'sheet:top', cls: 'failed' });
    }
  },
  async archiveProject() {
    const p = this.sheet.project;
    if (!p || !confirm(archiveAsk(p.title))) return;
    try {
      await api('/projects/' + p.id, { method: 'PATCH', body: { is_archived: true } });
      this.setProjects(this.projects.filter(x => x.id !== p.id));
      saved.set('projects', this.projects);
      this.closeSheet(true);
      this.go('#/projects');
      this.say(archivedText(p.title), { place: 'projects' });
    } catch (err) {
      this.say(directFailed(err, 'archive the project', 'Archiving the project'), {
        place: 'sheet:top',
        cls: 'failed',
      });
    }
  },
  async deleteProject() {
    const p = this.sheet.project,
      e = this.sheet.projEdit;
    if (!p) return;
    if (!confirm(deleteProjectAsk(p.title, e?.tasks, e?.kids || 0))) return;
    try {
      await api('/projects/' + p.id, { method: 'DELETE' });
      await this.loadProjects();
      this.closeSheet(true);
      this.go('#/projects');
      this.say(deletedProject(p.title), { place: 'projects' });
    } catch (err) {
      this.say(directFailed(err, 'delete the project', 'Deleting the project'), { place: 'sheet:top', cls: 'failed' });
    }
  },
  // Mark a project for checklists, or unmark it. The mark is a paragraph "pocket:checklists" in the project's
  // description, and the rest of the description stays.
  async setChecklists(p, on) {
    this.sheet.checklistBusy = true;
    try {
      let description;
      if (on) description = (p.description || '').trim() + `<p>${CHECKLIST_MARK}</p>`;
      else {
        const root = parseFragment(p.description);
        for (const el of [...root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')])
          if (el.textContent.trim().toLowerCase() === CHECKLIST_MARK) el.remove();
        description = root.innerHTML;
        if (isChecklistDesc(description)) description = description.replace(new RegExp(CHECKLIST_MARK, 'gi'), ''); // the mark was not in a paragraph of its own
        description = description.trim() || '<p></p>'; // Vikunja's PATCH ignores an empty description
      }
      const got =
        (await api('/projects/' + p.id, { method: 'PATCH', body: { description } })) ||
        (await api('/projects/' + p.id));
      const next = { ...p, ...got };
      this.setProjects(this.projects.map(x => (x.id === p.id ? next : x)));
      saved.set('projects', this.projects);
      if (this.view.project?.id === p.id) this.view.project = next;
      if (this.sheet.project?.id === p.id) this.sheet.project = next;
      this.say(checklistsOn(on), { place: 'sheet:top' });
    } catch (e) {
      this.say(
        directFailed(
          e,
          `turn checklists ${on ? 'on' : 'off'} for the project`,
          `Turning checklists ${on ? 'on' : 'off'} for the project`,
        ),
        {
          place: 'sheet:top',
          cls: 'failed',
        },
      );
    } finally {
      this.sheet.checklistBusy = false;
    }
  },
  /* ---------- setting checklists up ---------- */
  // Create a project named "Checklists", mark it for checklists, add an example template, and open the Checklists
  // screen.
  async setUpChecklists() {
    if (this.settingUp) return;
    this.settingUp = true;
    try {
      const p = await api('/projects', {
        method: 'POST',
        body: { title: 'Checklists', description: `<p>${CHECKLIST_MARK}</p>` },
      });
      this.setProjects([...this.projects, p]);
      saved.set('projects', this.projects);
      this.perms[p.id] = 2;
      saved.set('perms', this.perms);
      /* The example's ops go through the outbox. Only Vikunja's refusal of the template itself means it wasn't made.
         Ops that wait are sent later, and a refused step, or an answer the relay can't vouch for, waits in the Outbox,
         as any op does. */
      const r = await this.addExample(p).catch(refused => ({ refused, all: [] })),
        refused = r.refused && r.refused.code !== 'unknown',
        waits = r.status !== 'sent' && !r.all.some(x => x.status === 'error');
      this.go('#/checklists');
      this.say(setUpText(!refused, waits ? waitText(r) : ''), { place: 'checklists', cls: refused ? 'failed' : '' });
    } catch (e) {
      this.say(directFailed(e, 'set up checklists', 'Setting up checklists'), { place: 'setup', cls: 'failed' });
    } finally {
      this.settingUp = false;
    }
  },
  /* The example template has four steps, each with its notes. The first is assigned to the user, and the third is due
     18 minutes after the second. The lines are read with quick add's label, assignee and priority parsing off, so the
     user's settings can't change them. Returns how sending went (newTemplate). */
  async addExample(p) {
    const off = { labels: true, assignees: true, priority: true },
      steps = [
        'Turn on the espresso machine',
        'Put the croissants in the oven',
        'Take the croissants out T#18m',
        'Wipe down the tables',
      ];
    const r = await this.newTemplate(p.id, 'Example: Opening up', steps, {
      ignore: off,
      ignores: steps.map(() => off),
      more: (tpl, [first, , third]) => [
        {
          op: 'edit',
          task: tpl,
          rebase: 'notes',
          text: 'This is an example. Tap Start and tick off its steps. Then edit it to make your own template, or delete it from its ⋯ menu.',
        },
        { op: 'assign', task: first, person: personOf(this.user), add: true, was: [] },
        {
          op: 'edit',
          task: third,
          rebase: 'notes',
          text: "Due 18 minutes after the croissants go in. Every checklist shows a step's notes and photos on that step.",
        },
      ],
    });
    return r;
  },
  // Whether Getting started shows on Checklists: for a project's admin (who can share it), until they hide it.
  gettingStarted(pid) {
    return this.perms[pid] >= 2 && !this.startedHidden[pid];
  },
  // Hide Getting started, or show it again from the project's menu.
  hideGettingStarted(pid, hide = true) {
    this.startedHidden = { ...this.startedHidden, [pid]: hide };
    store.set('started.hidden', JSON.stringify(this.startedHidden));
  },
  // The share page for a project in Vikunja's web app. Sharing is done there.
  shareUrl(pid) {
    return `${this.server}/projects/${pid}/settings/share`;
  },
  async openTasks(pid) {
    const at = started(),
      list = await allPages(
        `/projects/${pid}/tasks?` +
          new URLSearchParams({ filter: 'done = false', filter_timezone: TZ, expand: 'comment_count' }),
      );
    this.change(w => w.read(list, TASK_COUNT, at));
    return list;
  },
  // Load each checklist project with its templates and open checklists.
  async loadChecklists(seq) {
    const checklists = await this.readChecklists(t => this.row(t));
    if (
      seq !== renderSeq ||
      !(await this.settle(
        checklists.flatMap(cl => [...cl.runs, ...cl.finished].map(t => t.id)),
        seq,
      ))
    )
      return;
    this.view.checklists = checklists;
    this.keepScreen('checklists', { checklists, at: new Date().toISOString() });
  },
  // Read the checklist projects from Vikunja. `own` maps each open checklist to the copy to use. That is the copy on
  // screen, or Vikunja's copy when preloading.
  async readChecklists(own) {
    templatesKept = saved.get('templates') || {};
    const ws = this.checklistProjects;
    const labels = ws.length ? (await this.loadLabels(true)).filter(isTemplateLabel).map(l => l.id) : [];
    const checklists = await Promise.all(
      ws.map(async p => {
        const since = new Date(Date.now() - FINISHED_DAYS * 864e5).toISOString(),
          at = started();
        const [, templates, open, done] = await Promise.all([
          // The user's access, read again each time, since it decides who may start a checklist or change a template.
          // Other projects keep the access Pocket read once (loadPerms).
          api('/projects/' + p.id)
            .then(full => {
              this.perms[p.id] = full.max_permission ?? 1;
            })
            .catch(() => {}),
          // Templates: done ones, and open ones with a due date.
          labels.length
            ? allPages(
                `/projects/${p.id}/tasks?` + new URLSearchParams({ filter: `labels in ${labels.join(', ')}` }),
              ).then(putting(TASK, at))
            : [],
          this.openTasks(p.id),
          // Everything done in the last FINISHED_DAYS: the checklists finished then, and the steps that tell how each went.
          // A known gap: a step done before that, in a checklist finished since, is left out of its skips and comments.
          allPages(
            `/projects/${p.id}/tasks?` +
              new URLSearchParams([
                ['filter', `done = true && done_at >= '${since}'`],
                ['filter_timezone', TZ],
                ['sort_by', 'done_at'],
                ['order_by', 'desc'],
                ['expand', 'reactions'],
                ['expand', 'comments'],
                ['expand', 'comment_count'],
              ]),
          )
            .then(list => inBatches(list, 4, allComments))
            .then(putting([...TASK_REACTIONS_COMMENTS, 'comment_count'], at)),
        ]);
        // The steps' fresh copies go to the store too, since a finished checklist's ring counts its steps from there. That
        // includes its open steps, or a step done on this phone and undone elsewhere would still count as done.
        const finished = done.filter(t => this.isRunTask(t)),
          ids = new Set(finished.map(t => t.id));
        for (const s of done) if (!this.isRunTask(s)) own(s);
        for (const s of open) if (s.related_tasks?.parenttask?.some(x => ids.has(x.id))) own(s);
        return {
          project: { id: p.id, title: p.title },
          templates: templates
            .filter(t => this.readyTemplate(t))
            .map(t => ({ ...t, name: templateName(t.title) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(t => {
              keepTemplate(t);
              return {
                id: t.id,
                title: t.name,
                steps: (t.related_tasks?.subtask || []).length,
                done: t.done,
                labels: t.labels,
                due_date: t.due_date,
                repeat_after: t.repeat_after,
                repeat_mode: t.repeat_mode,
              };
            }),
          runs: open.filter(t => !t.done && this.isRunTask(t)).map(own),
          finished: finished.map(own),
          ended: endedOf(finished, [...done, ...open]),
        };
      }),
    );
    saved.set('templates', templatesKept);
    saved.set('perms', this.perms);
    return checklists;
  },
  /* The schedule message for a template under Checklists, shown after its steps. Examples: "Next: Wed, Oct 7, 8:00 AM,
     then every day" and "Due now, since 6:00 PM today, just once". Returns '' for a template that is done. */
  scheduleText(t) {
    if (!comesRound(t)) return '';
    const d = new Date(t.due_date),
      then = repeatWords(t) ? ', then ' + repeatWords(t) : ', just once';
    return (
      (d <= new Date()
        ? 'Due now, since ' + whenText(d, 'today')
        : 'Next: ' + (+startOfDay(d) === +startOfDay() ? 'today, ' : '') + whenText(d)) + then
    );
  },
  // The note under a template's "When it's due" setting. It explains what the date and the repeat do.
  get comesRoundNote() {
    const t = this.sheetTask;
    if (!t || this.checklistRole !== 'template') return '';
    if (t.done || !isSet(t.due_date))
      return repeats(t)
        ? `This template repeats ${repeatWords(t)} once it has a date. Set a date to make it appear on Today. Until then, start it from Checklists.`
        : 'With no date, start this template from Checklists when you need it. Set a date to make it appear on Today.';
    const on = onText(new Date(t.due_date));
    return repeats(t)
      ? `This template is due ${on}, then ${repeatWords(t)}. Today lists it from a week before. Starting a checklist on or after the due day moves it to its next date.`
      : `This template is due ${on}, once. Today lists it from a week before. ${startMarksDone(templateName(t.title), true)} Choose Repeats to make it repeat.`;
  },
  // The open template's settings for its checklists, {wait, order}, read from its notes (runRules).
  get templateRules() {
    return this.checklistRole === 'template' ? runRules(this.sheetTask?.description) : { wait: false, order: false };
  },
  // Turn one of the open template's settings ('wait' or 'order') on or off. The switch shows the change at once.
  setTemplateRule(key, on) {
    const t = this.sheetTask;
    if (t && this.canEdit) this.act({ op: 'edit', task: t.id, run: null, rebase: 'rules', rules: { [key]: on } });
  },
  // Whether a due template shows on the user's Today. It shows for its assignees. With no assignees, it shows for
  // anyone who can start it.
  templateFor(t) {
    const who = t.assignees || [];
    return who.length ? who.some(u => u.id === this.user?.id) : this.canWrite(t.project_id);
  },
  // Build the text "For you and <name>", with "you" first.
  forText(t) {
    const all = t.assignees || [],
      me = this.user?.id;
    const who = [
      ...all.filter(u => u.id === me).map(() => 'you'),
      ...all.filter(u => u.id !== me).map(u => u.name || u.username),
    ];
    return who.length ? 'For ' + andList(who) : '';
  },
  // The checklist starts in a project that are waiting to be sent or being sent now.
  startingIn(pid) {
    return startsIn(this.pending, pid);
  },
  /* The open checklists in checklist projects, and whether each is the user's (started by the user or assigned to the
     user). Today shows only the user's checklists. Returns {index, mine, open}. `index` maps each checklist id to that
     flag, and `mine` lists the user's checklists. `open` is every open task in those projects, steps included, for
     the cards. */
  async loadRunIndex() {
    const ws = this.checklistProjects;
    if (!ws.length) return { index: {}, mine: [], open: [] };
    try {
      const index = {},
        mine = [],
        open = (await Promise.all(ws.map(p => this.openTasks(p.id)))).flat();
      for (const t of open)
        if (!t.done && this.isRunTask(t)) {
          index[t.id] = t.created_by?.id === this.user?.id || (t.assignees || []).some(u => u.id === this.user?.id);
          if (index[t.id]) mine.push(t);
        }
      saved.set('runs', index);
      return { index, mine, open };
    } catch (e) {
      if (e instanceof NetError) return { index: saved.get('runs') || {}, mine: [], open: [] };
      throw e;
    }
  },
  // Whether Today shows a task. In a checklist project, Today shows the user's checklists, their steps, and tasks
  // assigned to the user. A task there that is not part of a checklist shows as it would in any other project.
  inToday(t, runs) {
    if (!this.checklistIds.has(t.project_id)) return true;
    const role = this.role(t);
    if (role === 'template') return comesRound(t) && this.templateFor(t); // a due template, not a checklist being set up
    if ((t.assignees || []).some(u => u.id === this.user?.id)) return true;
    const parent = t.related_tasks?.parenttask?.[0]?.id;
    if (t.id in runs) return runs[t.id];
    if (parent in runs) return runs[parent];
    return role !== 'run' && role !== 'step'; // a checklist Pocket doesn't know, or one of its steps, is hidden
  },

  /* Make the open task a template, as a makeTemplate op (ops/templates.js): it labels the task, marks the open
     subtasks done as its steps, and marks the task done last. The sheet shows the template at once. Once Vikunja has
     it, the sheet says when it is due. Offline it waits in the Outbox. A refusal waits there too, and the sender says
     why. */
  async makeTemplate() {
    const t = this.sheetTask;
    if (!t || this.sheet.checklistBusy) return;
    const problems = stepProblems(this.subtasks.map(s => s.title));
    if (problems.length) {
      this.say(templateProblem(problemText(problems)), { place: 'sheet:top', cls: 'failed' });
      return;
    }
    this.sheet.checklistBusy = true;
    try {
      const steps = this.subtasks.filter(s => !s.done).map(s => s.id),
        r = await this.act({ op: 'makeTemplate', task: t.id, run: null, steps });
      if (r.status === 'offline' && !r.behind) this.say(waitText(r), { place: 'sheet:top' });
      if (r.status !== 'sent') return;
      const full = await this.readCopy(t.id).catch(() => null);
      if (!full) return;
      if (this.sheet.id === t.id) {
        this.showTask(full);
        this.sheet.dirty = true;
      }
      this.say(
        comesRound(full)
          ? templateMade(this.scheduleText(full), repeats(full), templateName(full.title))
          : templateMade(),
        {
          place: 'sheet:top',
        },
      );
    } finally {
      this.sheet.checklistBusy = false;
    }
  },
  // Line `text` of a template's name or steps, as a step's box reads it with the chips in `off` tapped off, packed as
  // the add box packs a line (itemsOf). Null for a line with no title.
  templateLine(text, off = {}) {
    return itemsOf([{ raw: text, p: this.stepParsed(text, off), under: null }])[0] ?? null;
  },
  /* Queue a new template in project `pid`: its task, named `name` with the prefix, as an add op, a templateStep op for
     each of `lines`, then the makeTemplate op, which waits for the steps. `ignore` holds the chips tapped off for the
     name, and `ignores` for each line. `more(template, steps)` gives ops on the new tasks, named by their waiting ids,
     that go before makeTemplate. Returns how sending went (actAll), with `refused` the error that refused the name before
     its task was made. */
  async newTemplate(pid, name, lines, { ignore = {}, ignores = [], more = () => [] } = {}) {
    const [tpl] = addLines([this.templateLine(templateTitle(name), ignore)], { pid }),
      task = 'pending-' + tpl.id,
      label = templateName(tpl.p.title);
    const steps = lines.flatMap((text, k) => {
        const x = this.templateLine(text, ignores[k]);
        return x
          ? [{ id: uuid7(), op: 'templateStep', task, under: task, pid, p: x.p, after: null, label, run: null }]
          : [];
      }),
      waits = steps.map(f => 'pending-' + f.id);
    // The caller says what became of the name, which isn't a line of quick add's to give back there.
    const r = await this.actAll(
      [
        tpl,
        ...steps,
        ...more(task, waits).map(f => ({ run: null, ...f })),
        { op: 'makeTemplate', task, steps: [], lines: waits, label, run: null },
      ],
      new Set([tpl.id]),
    );
    return { ...r, refused: r.all.find(x => x.id === tpl.id && x.status === 'error' && !sync.taskOf(tpl.id))?.error };
  },

  /* ---------- writing steps: in New template, and under a template ---------- */
  /* A template's sheet lists its steps like a task's subtasks (sheet/sub-list.html): one row per step, then one box at
     the bottom. Each line typed or pasted in the box becomes a step. `which` is 'new' for the box in New template and
     'add' for the box under an existing template.

     Under an existing template, new steps are sent to Vikunja at once (addTemplateSteps). In New template nothing is
     sent until the user taps Create template. Until then each line is a row that exists only on the phone: {id, key,
     text, keep, from, ignore}. The same row markup draws, edits, moves and removes these rows and a template's saved
     steps. New lines go after the row the box sits under (sheet.subAt). */
  // The rows in New template, or under an existing template the rows being sent to Vikunja.
  draftRows(which) {
    return which === 'new' ? this.sheet.newTpl?.rows || [] : this.sheet.addRows;
  },
  // The box as a row with key '+', so a single line in it is parsed as a step and gets its time chip.
  stepBox(which) {
    return (which === 'new' ? this.sheet.newTpl?.add : this.sheet.addBox) || { text: '' };
  },
  get stepWhich() {
    return this.sheet.kind === 'newtpl' ? 'new' : 'add';
  },
  // The rows in order. While the box holds a single line, that line is included as a row where the box sits. A pasted
  // list is parsed only once it is added. Under an existing template that has steps being sent, only those steps.
  draftAll(which) {
    const rows = this.draftRows(which),
      b = this.stepBox(which),
      text = (b.text || '').trim();
    if (!text || text.includes('\n') || (which === 'add' && rows.length)) return rows;
    const at = which === 'new' ? rows.findIndex(r => r.id === this.sheet.subAt) : -1;
    return at < 0 ? [...rows, b] : [...rows.slice(0, at + 1), b, ...rows.slice(at + 1)];
  },
  // Parse the rows (draftSteps). Under an existing template, if the box is under a step, the new rows follow that step.
  draft(which) {
    const at =
      which === 'new' || this.sheet.subAt == null ? -1 : this.subtasks.findIndex(s => s.id === this.sheet.subAt);
    const before =
      which === 'new'
        ? []
        : (at < 0 ? this.subtasks : this.subtasks.slice(0, at + 1)).map(s => ({ key: 'task:' + s.id, text: s.title }));
    return draftSteps(this.draftAll(which), before, this.stepWordsOnly);
  },
  // A step's title without quick add's @people, *labels and !priority. This is the name used to refer to the step.
  get stepWordsOnly() {
    return t => this.stepParsed(t).title || t;
  },
  // For each row that will be sent, the chips the user tapped off.
  draftIgnores(which) {
    return this.draftRows(which)
      .filter(r => r.text.trim())
      .map(r => r.ignore || {});
  },
  // A row in New template: a step that exists only on the phone. It has an id for the task row and a key for
  // draftSteps.
  newStepRow(text, more = {}) {
    const key = randomId();
    return { id: 'new-' + key, key, text, keep: false, from: null, ignore: {}, ...more };
  },
  /* Add the box's lines as steps, on Enter or the box's button. A single line keeps its chips (the time and the ones
     tapped off). In New template the lines become rows after the row the box is under, or at the end, and the box
     moves under the last new row. Under an existing template the lines are sent (addTemplateSteps), unless a line has
     a problem, which its chip shows. The box stays, emptied and focused. */
  sendSteps(which) {
    const b = this.stepBox(which),
      lines = captureLines(b.text || '');
    if (!lines.length) return;
    const one = lines.length === 1,
      was = { text: b.text, keep: b.keep, from: b.from, ignore: b.ignore };
    const made = lines.map(text =>
      this.newStepRow(text, one ? { keep: !!b.keep, from: b.from ?? null, ignore: b.ignore || {} } : {}),
    );
    Object.assign(b, { text: '', keep: false, from: null, ignore: {} });
    if (which === 'add') {
      this.sheet.addRows = made;
      if (this.draft('add').problem) {
        this.sheet.addRows = [];
        Object.assign(b, was);
        return;
      }
      return this.addTemplateSteps();
    }
    const rows = this.draftRows('new'),
      at = rows.findIndex(r => r.id === this.sheet.subAt);
    // A row that counted from the box's line now counts from the row that line became, or from nothing if several lines
    // were added.
    for (const r of rows) if (r.from === '+') r.from = one ? made[0].key : null;
    rows.splice(at < 0 ? rows.length : at + 1, 0, ...made);
    if (at >= 0) this.sheet.subAt = made.at(-1).id;
  },
  /* A hidden field holds the focus while a box appears, so the phone's keyboard stays open. Then the box takes the
     focus, along with anything typed in the meantime, such as the first letters of a fast typist. */
  keepFocus() {
    const k = document.getElementById('focus-keeper');
    if (k) {
      k.value = '';
      k.focus({ preventScroll: true });
    }
  },
  passFocus(el, add, atEnd = false) {
    const k = document.getElementById('focus-keeper'),
      typed = k?.value || '';
    if (k) k.value = '';
    if (!el) return;
    if (typed) {
      add(typed);
      el.value = atEnd ? el.value + typed : typed + el.value;
    }
    el.focus();
    if (typed) {
      const at = atEnd ? el.value.length : typed.length;
      el.setSelectionRange(at, at);
    }
  },
  // Move a New template row to index `to`. Moving the row takes the focus off the row's box, so the focus is given back
  // afterwards.
  placeDraftRow(which, k, to) {
    const rows = this.draftRows(which),
      box = document.activeElement;
    if (to < 0 || to >= rows.length || to === k || !rows[k]) return;
    rows.splice(to, 0, rows.splice(k, 1)[0]);
    if (box?.classList.contains('draft-in')) setTimeout(() => box.isConnected && box.focus({ preventScroll: true }));
  },
  // Remove a row that was swiped to Delete or left empty. A box under the row moves to the row before it, or to the
  // bottom. A row that counted from the removed row goes back to counting from the previous step. The removed row was
  // never sent, so there is nothing to undo.
  dropDraftRow(which, k) {
    const rows = this.draftRows(which),
      [gone] = rows.splice(k, 1);
    if (!gone) return;
    if (this.sheet.stepEdit?.key === gone.key) this.sheet.stepEdit = null;
    if (which === 'new' && this.sheet.subAt === gone.id) this.sheet.subAt = rows[k - 1]?.id ?? null;
    for (const r of rows) if (r.from === gone.key) r.from = null;
  },
  openNewTemplate(p) {
    this.openSheet('newtpl');
    const kept = taskDrafts.get('newtpl:' + p.id); // an earlier draft that was never created
    // The name goes in a quick-add box ('tname'). The steps go in the box below them ('new:+').
    this.sheet.newTpl = {
      project: { id: p.id, title: p.title },
      box: { ...newBox(), text: kept?.name || '' },
      rows: (kept?.rows || [])
        .filter(r => r.text?.trim())
        .map(r => this.newStepRow(r.text, { keep: !!r.keep, from: null, ignore: r.ignore || {} })),
      add: { ...newStepBox(), text: kept?.add || '' },
      busy: false,
    };
    this.$nextTick(() => document.getElementById('nt-name')?.focus());
  },
  /* Create the template from New template, as ops (newTemplate). Online the sheet waits for them, and Checklists then
     lists the template. Offline they wait in the Outbox. If Vikunja refuses the name, the sheet stays open and says
     why. A refusal after that waits in the Outbox, and the sender says why. */
  async createTemplate() {
    const nt = this.sheet.newTpl;
    if (nt && !nt.busy && (nt.add.text || '').trim()) this.sendSteps('new'); // text still in the box counts as a step
    const name = nt?.box.text.trim(),
      d = nt && this.draft('new');
    if (!name || !d.added.length || d.problem || nt.busy) return;
    const shown = templateName(this.stepParsed(name, nt.box.ignore).title); // without @people and *labels
    nt.busy = true;
    const r = await this.newTemplate(nt.project.id, name, d.added, {
      ignore: nt.box.ignore,
      ignores: this.draftIgnores('new'),
    });
    if (r.refused && r.refused.code !== 'unknown') {
      nt.busy = false;
      this.say(templateNotSaved(why(r.refused)), { place: 'sheet:top', cls: 'failed' });
      return;
    }
    nt.made = true;
    taskDrafts.delete('newtpl:' + nt.project.id);
    if (this.sheet.newTpl === nt) this.closeSheet(true);
    if (this.route.name === 'checklists') this.render();
    else this.go('#/checklists');
    // A name whose answer is unknown waits in the Outbox, and the sender has said so.
    if (r.status === 'sent') this.say(templateCreated(shown), { place: 'checklists' });
    else if (r.status === 'offline' && !r.refused) this.say(waitText(r), { place: 'checklists' });
  },
  /* Add the box's lines under the template as steps, a templateStep op each, which the sheet shows at once and which
     Vikunja makes done. A step a new line counts from gets the name the line gives it, as an edit, first. If the box is
     under a step, the new steps go after it, each after the one before, and the box moves under the last of them.
     Offline they wait in the Outbox. */
  async addTemplateSteps() {
    const t = this.sheetTask,
      d = this.draft('add');
    if (!t || !d.added.length || d.problem) return;
    const ignores = this.draftIgnores('add'),
      label = templateName(t.title),
      renames = d.renames.map(({ key, title }) => {
        const id = +key.slice(5);
        return { op: 'edit', task: id, run: null, set: { title }, was: { title: this.tasks[id]?.title ?? '' } };
      });
    // A batch added while the one before it waits goes after that one's last step (subAfter).
    let after = this.sheet.subAt == null ? null : (this.sheet.subAfter ?? this.sheet.subAt);
    const steps = d.added.flatMap((text, k) => {
      const x = this.templateLine(text, ignores[k]);
      if (!x) return [];
      const f = { id: uuid7(), op: 'templateStep', task: t.id, under: t.id, pid: t.project_id, p: x.p, after, label };
      if (after != null) after = 'pending-' + f.id;
      return [f];
    });
    this.sheet.addRows = [];
    if (!steps.length) return;
    const last = 'pending-' + steps.at(-1).id;
    if (after != null) this.sheet.subAfter = last;
    const r = await this.actAll([...renames, ...steps.map(f => ({ run: null, ...f }))]);
    this.sheet.dirty = true;
    if (this.sheet.id !== t.id) return;
    const made = sync.taskOf(steps.at(-1).id);
    if (made && this.sheet.subAfter === last) {
      this.sheet.subAt = made;
      this.sheet.subAfter = null;
    }
    if (r.status === 'offline' && !r.behind) this.say(waitText(r, steps.length), { place: 'sheet:subtasks' });
    else if (r.status === 'sent') this.unsay('sheet:subtasks'); // clear the message from an earlier failed try
  },
  // A row's time chip as a list for x-for: [d] when there is something to show, else [].
  draftShown(d) {
    return d && (d.problem || d.offset !== null || d.kept || d.name) ? [d] : [];
  },
  // The first line of a step's notes, under it in its template.
  stepNote(st) {
    return htmlToText(notesOnly(st.description)).trim().split('\n')[0];
  },
  // Edit a template's step in place, the way a New template row is edited. A time written in words is read as T#, with
  // its chip. The step's text field appears only after the tap, so keepFocus takes the focus now to open the keyboard.
  editStep(st) {
    const e = this.sheet.stepEdit,
      k = e ? this.subList.findIndex(s => s.id === e.id) : -1;
    if (k >= 0 && e.id !== st.id) this.saveStepEdit(k); // save another step still being edited
    this.keepFocus();
    // The title may still contain text that quick add would parse, because the user tapped its chip off when writing
    // the step. Keep ignoring that text, so editing doesn't turn it into a priority or a person.
    const text = st.key
        ? st.text
        : stepWords(
            st.title,
            this.subtasks.map(s => s.title),
          ),
      kept = this.stepParsed(text);
    const ignore = Object.fromEntries(
      [
        ['assignees', kept.assignees.length],
        ['labels', kept.labels.length],
        ['priority', kept.priority],
      ]
        .filter(([, n]) => n)
        .map(([k]) => [k, true]),
    );
    // A New template row (it has a `key`) is edited in place.
    this.sheet.stepEdit = st.key ? st : { id: st.id, text, keep: false, from: null, ignore };
    // The box takes the focus when it appears (x-init). If a redraw happened first, pass the focus on now.
    setTimeout(() => {
      const el = document.getElementById('step-edit-' + st.id);
      if (el && document.activeElement?.id === 'focus-keeper')
        this.passFocus(
          el,
          t => {
            if (this.sheet.stepEdit?.id === st.id) this.sheet.stepEdit.text += t;
          },
          true,
        );
    }, 50);
  },
  /* Parse the step being edited, after the steps before it (draftSteps). Returns the step's info plus `titles`, every
     step's title as it will be saved, because a step it counts from may get a name. Returns null while the step is
     empty. */
  stepEditDraft(i) {
    const e = this.sheet.stepEdit;
    if (!e?.text.trim()) return null;
    if (e.key) return this.draft('new').info.get(e.key) || null; // a New template row: read together with the other rows there
    const before = this.subtasks.slice(0, i).map(s => ({ key: 'task:' + s.id, text: s.title }));
    const d = draftSteps(
        [{ key: 'edit', text: e.text, keep: e.keep, from: e.from, ignore: e.ignore }],
        before,
        this.stepWordsOnly,
      ),
      info = d.info.get('edit');
    const titles = this.subtasks.map((s, k) =>
      k === i ? info.saved : (d.renames.find(r => r.key === 'task:' + s.id)?.title ?? s.title),
    );
    return {
      ...info,
      titles,
      problem:
        stepProblems(titles)
          .filter(p => p.i === i)
          .map(p => p.text)
          .join('; ') || info.problem,
    };
  },
  // The edited step's assignees and labels, as chips. Tapping a chip strikes it through (stepEdit.drop), and saving
  // removes it from the step.
  stepHasChips() {
    const e = this.sheet.stepEdit,
      st = e && this.subtasks.find(s => s.id === e.id),
      P = this.prefixes;
    if (!st || !P) return [];
    const drop = e.drop || {},
      people = st.assignees || [],
      labels = st.labels || [];
    const chip = (k, text) => ({
      key: 'had-' + k,
      kind: 'had',
      text,
      off: !!drop[k],
      hint: drop[k] ? `Tap to keep ${text} on this step` : `Tap to remove ${text} from this step`,
      action: () => {
        e.drop = { ...e.drop, [k]: !e.drop?.[k] };
      },
    });
    return [
      ...people.map(u => chip('u' + u.id, P.assignee + u.username)),
      ...labels.filter(l => !isTemplateLabel(l)).map(l => chip('l' + l.id, P.label + l.title)),
    ];
  },
  async saveStepEdit(i) {
    const e = this.sheet.stepEdit,
      st = this.subtasks[i];
    // A New template row already holds its text. If it was left empty, remove it.
    if (e?.key) {
      this.sheet.stepEdit = null;
      if (!e.text.trim())
        this.dropDraftRow(
          'new',
          this.draftRows('new').findIndex(r => r.key === e.key),
        );
      return;
    }
    if (!e || !st || st.id !== e.id) return;
    // The user's access can arrive while the box is open, and it may not let them change this template.
    if (!this.canEdit) {
      this.sheet.stepEdit = null;
      this.say(SAID.notYours, { place: 'sheet:subtasks', cls: 'failed' });
      return;
    }
    const d = this.stepEditDraft(i),
      drops = Object.keys(e.drop || {}).filter(k => e.drop[k]);
    const todo = d
      ? this.subtasks.map((s, k) => ({ s, was: s.title, title: d.titles[k] })).filter(x => x.title !== x.was)
      : [];
    const notes = d?.notes || '';
    if (!todo.length && !drops.length && !notes) {
      this.sheet.stepEdit = null;
      return;
    }
    // The edit would create a new problem. Keep the text in the box so the user can fix it.
    if (d && stepProblems(d.titles).length > stepProblems(this.subtasks.map(s => s.title)).length) {
      this.say(notDone('changed', problemText(stepProblems(d.titles))), { place: 'sheet:subtasks', cls: 'failed' });
      return;
    }
    this.sheet.stepEdit = null;
    /* Parse the edited title as quick add does. @people, *labels and !priority are applied, as assign, label and edit
       ops, and the title is saved without them. A person who can't see the project stays in the title, and so does
       anyone Pocket can't look up while it can't reach Vikunja. */
    const own = todo.find(x => x.s.id === e.id),
      p = own && this.stepParsed(own.title, e.ignore),
      line = p && (await this.stepLine(p));
    if (own) own.title = line.body.title;
    const was = (list, of) => (list || []).map(of);
    const ops = [
      // The renamed steps go in order, so a step this one counts from is named first. A title that only lost its
      // @people or *labels is not renamed, so taking a person off again leaves nothing to send.
      ...todo
        .filter(x => x.title !== x.was || (x === own && p.priority))
        .map(x => ({
          op: 'edit',
          task: x.s.id,
          set: { title: x.title, ...(x === own && p.priority && { priority: p.priority }) },
          was: { title: x.was, ...(x === own && p.priority && { priority: x.s.priority || 0 }) },
        })),
      ...(line?.people || []).map(u => ({
        op: 'assign',
        task: e.id,
        person: personOf(userCache.get(u.name.toLowerCase()) ?? { id: u.id, username: u.name }),
        add: true,
        was: was(st.assignees, personOf),
      })),
      ...(line?.labels || []).map(name => ({
        op: 'label',
        task: e.id,
        tag: tagOf(this.labels?.find(l => l.title.toLowerCase() === name.toLowerCase()) ?? { title: name }),
        add: true,
        was: was(st.labels, tagOf),
      })),
      // Notes typed after " // " go at the end of the step's notes, so its asks stay.
      ...(notes ? [{ op: 'edit', task: e.id, rebase: 'addNotes', text: notes }] : []),
      // The people and labels the user tapped off.
      ...drops.map(k => {
        const id = +k.slice(1);
        return k[0] === 'u'
          ? {
              op: 'assign',
              task: e.id,
              person: personOf(st.assignees.find(u => u.id === id)),
              add: false,
              was: was(st.assignees, personOf),
            }
          : {
              op: 'label',
              task: e.id,
              tag: tagOf(st.labels.find(l => l.id === id)),
              add: false,
              was: was(st.labels, tagOf),
            };
      }),
    ];
    await this.actAll(ops.map(f => ({ run: null, ...f })));
    this.sheet.dirty = true;
    if (line?.problems.length) this.say(changedBut(line.problems), { place: 'sheet:subtasks', cls: 'failed' });
  },
  // A step's new title as quick add makes it (lineOf). Without a connection, the @people stay in the title.
  async stepLine(p) {
    try {
      return await lineOf(this, packParsed(p), this.sheetTask?.project_id);
    } catch (e) {
      if (!passing(e)) throw e;
      return {
        body: { title: p.title },
        people: [],
        labels: p.labels,
        problems: p.assignees.map(n => `@${n}: ${why(e)}`),
      };
    }
  },
  // Open a step's own sheet, for notes and photos. An edit in progress is saved first. If saving fails, the current
  // sheet stays open.
  async openStep(i) {
    const st = this.subtasks[i];
    await this.saveStepEdit(i);
    if (st && !this.sheet.stepEdit) this.openTask(st.id);
  },
  // The data for a template step's own sheet: its number among the template's steps, and when it is due. Both are read
  // from the template's steps.
  get tplStep() {
    const t = this.sheetTask,
      p = this.parentTask,
      tpl = p && (copyOf(p.id) || kept()[p.id]);
    if (!tpl) return null;
    const steps = stepsOf(tpl),
      i = steps.findIndex(s => s.id === t?.id);
    if (i < 0) return null;
    return { no: i + 1, of: steps.length, ...stepInfos(steps.map(s => this.subRow(s).title))[i] };
  },
  // Delete a step from a template. Checklists already started keep their copy of it.
  async removeStep(i) {
    if (this.sheet.kind === 'newtpl') return this.dropDraftRow('new', i); // the step was never sent, so just remove the row
    const t = this.sheetTask,
      st = this.subtasks[i];
    if (!t || !st || this.sheet.checklistBusy) return;
    const rest = this.subtasks.filter((_, k) => k !== i).map(s => s.title),
      problems = stepProblems(rest);
    // Report problems using the step numbers on screen now, from before the removal.
    if (problems.length > stepProblems(this.subtasks.map(s => s.title)).length) {
      this.say(notDone('removed', problemText(problems.map(p => ({ ...p, i: p.i >= i ? p.i + 1 : p.i })))), {
        place: 'sheet:subtasks',
        cls: 'failed',
      });
      return;
    }
    if (!confirm(removeStepAsk(parseStep(st.title).title))) return;
    // A delete op with no Restore. The step leaves the template's steps at once, and a refusal brings it back.
    if ((await this.deleteNow([[st.id]])).status === 'error') return;
    this.keepTemplate(t);
    this.sheet.dirty = true;
    this.say(SAID.stepRemoved, { place: 'sheet:subtasks' });
  },
  /* Move a template's step by `dir` places: -1 moves it up and 1 moves it down. With `dragged`, the step moves as far
     as it was dragged. The order line is rewritten with every step. Pocket refuses a move that would create a problem
     the template didn't have, such as a step counting from a later step. A move that fixes an existing problem is
     allowed. The move is an edit, made on the order Vikunja has when it is sent, and only the order line changes.
     So notes and moves saved elsewhere since the sheet opened are kept. */
  async moveStep(i, dir, dragged = false) {
    if (this.sheet.kind === 'newtpl') return this.placeDraftRow('new', i, i + dir); // on the phone only, so just reorder the rows
    const t = this.sheetTask,
      st = this.subtasks[i],
      to = i + dir,
      rest = this.subtasks.filter((_, k) => k !== i);
    if (!t || !st || this.sheet.checklistBusy || to < 0 || to >= this.subtasks.length || !dir) return;
    // The move, as an edit's order (movedSteps, ops/edit.js), with where the step was for its Undo.
    const m = {
      step: st.id,
      dir,
      after: to > 0 ? rest[to - 1].id : null,
      to,
      dragged,
      from: this.subtasks[i - 1]?.id ?? null,
      at: i,
    };
    try {
      if (!movedSteps(this.subtasks, m)) return;
    } catch (e) {
      this.say(notDone('moved', e.message), { place: 'sheet:subtasks', cls: 'failed' });
      return;
    }
    const box = document.getElementById('step-edit-' + st.id);
    const sending = this.act({ op: 'edit', task: t.id, run: null, rebase: 'order', moves: [m] }); // shown at once
    this.sheet.dirty = true;
    // Moving the row takes the focus off its box. Give the focus back before the row's focusout handler runs, so the
    // step stays open and can move again.
    if (box && box === document.activeElement) setTimeout(() => box.isConnected && box.focus({ preventScroll: true }));
    if ((await sending).status === 'sent' && this.sheet.id === t.id) this.unsay('sheet:subtasks'); // an earlier refusal
  },
};
