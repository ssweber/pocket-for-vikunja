// Checklist projects and templates: reading them, making a template, and writing and editing its steps.
import {andList, cache, store, taskDrafts, TZ} from '../util.js';
import {allPages, api, items, NetError, patchTask, why} from '../api.js';
import {fmtTime, isSet, repeats, startOfDay} from '../dates.js';
import {htmlToText, parseFragment} from '../html.js';
import {CHECKLIST_MARK, comesRound, draftSteps, hasTemplateLabel, isChecklistDesc, isTemplate, isRun, isRunDesc, isRunStepTask, isTemplateLabel, notesOnly, parseStep, patiently, problemText, STEP_IGNORE, stepInfos, stepOrder, stepProblems, stepsOf, stepWords, repeatWords, templateName, templateTitle, withOrder} from '../checklists.js';
import {captureLines} from '../quickadd.js';
import {ALREADY, randomId, sync} from '../sync.js';
import {jobsFor} from './sending.js';
import {saved} from '../lists.js';
import {renderSeq} from './views.js';
import {newBox, newStepBox} from './core.js';

// Templates as last loaded, kept for starting a checklist offline: id -> the fields a start needs, with the steps in
// order.
let templatesKept = {};
const keepTemplate = t => { templatesKept[t.id] = {id: t.id, title: t.title, project_id: t.project_id, labels: t.labels, done: t.done, due_date: t.due_date,
  repeat_after: t.repeat_after, repeat_mode: t.repeat_mode, assignees: t.assignees || [], related_tasks: {subtask: stepsOf(t).map(s => ({id: s.id, title: s.title}))}}; };
// A time as a template's line says it, as Today does: "6:00 PM" today, "tomorrow 8:00 AM", "yesterday 6:00 PM", else
// "Wed, Oct 7, 8:00 AM".
const whenText = (d, today) => {
  const days = Math.round((startOfDay(d) - startOfDay()) / 864e5);
  if (!days) return fmtTime(d) + (today ? ' ' + today : '');
  if (days === 1 || days === -1) return (days === 1 ? 'tomorrow ' : 'yesterday ') + fmtTime(d);
  return d.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
};
// The same in a sentence: "today at 6:00 PM", "tomorrow at 8:00 AM", "on Wed, Oct 7 at 8:00 AM".
const onText = d => {
  const days = Math.round((startOfDay(d) - startOfDay()) / 864e5);
  return (!days ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : 'on ' + d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})) + ' at ' + fmtTime(d);
};

export default {
  // Keep a template as its sheet shows it now, so an offline start sees a step just moved, added or removed.
  keepTemplate(t){
    if (!isTemplate(t)) return;
    templatesKept = {...saved.get('templates'), ...templatesKept};
    keepTemplate(t); saved.set('templates', templatesKept);
  },
  isChecklistProject(p){ return isChecklistDesc(p?.description); },
  // The lit tab. A run lights Checklists, a project lights Projects.
  get tab(){ return ['checklists', 'run'].includes(this.route.name) ? 'checklists' : this.route.name === 'today' ? 'today' : 'projects'; },
  /* What the open task is in a checklist project: 'template', 'tplstep' (a template's step), 'run', 'step' (a run's)
     or 'candidate' (a task that could become a template). Vikunja's related tasks come without labels, so a step's
     parent is checked against the parent's own copy as last loaded. */
  get checklistRole(){
    const t = this.sheet.task, r = t?.related_tasks || {};
    if (!t || !this.checklistIds.has(t.project_id)) return null;
    if (isTemplate(t)) return 'template';
    const p = r.parenttask?.[0];
    if (p) return isRunStepTask(t) ? 'step' : hasTemplateLabel(cache.get(p.id)) || templatesKept[p.id] ? 'tplstep' : null;
    return (r.copiedfrom?.length || isRunDesc(t.description)) && !hasTemplateLabel(t) ? 'run' : 'candidate';
  },
  /* Filter out of a list what belongs on Checklists: done templates and their steps, for a project's Done and for
     search. A template that comes round stays, since it is due. With `runSteps`, a run's steps go too: they show on
     the run's screen. Vikunja gives a task's parent without labels, so a step's template is recognised from what is at
     hand (a template in the same list, a kept one, or a title starting "TEMPLATE:") and never fetched. */
  withoutTemplates(list, runSteps = false){
    const ids = this.checklistIds;
    if (!ids.size) return list;
    const here = new Set(list.filter(isTemplate).map(t => t.id)), kept = {...saved.get('templates'), ...templatesKept};
    const tpl = p => here.has(p.id) || !!kept[p.id] || hasTemplateLabel(cache.get(p.id)) || /^\s*template:/i.test(p.title || '');
    return list.filter(t => !ids.has(t.project_id)
      || !(t.done && isTemplate(t) || (t.related_tasks?.parenttask || []).some(tpl) || runSteps && this.stepRun(t)));
  },
  // What a project's open list shows: a run in progress with its open steps, as a card. A finished run's steps are
  // left out, so a run finished with steps not done sits in Done, not over them.
  onProjectList(list){
    const runs = new Set(list.filter(t => !t.done && this.isRunTask(t)).map(t => t.id));
    return this.withoutTemplates(list).filter(t => { const r = this.stepRun(t); return !r || runs.has(r); });
  },
  // A template's "template" label can't be removed: it is what makes it a template.
  keepsLabel(l){ return this.checklistRole === 'template' && isTemplateLabel(l); },
  // A template and its steps are never done or not done: their sheets have no tick, progress, priority or due date.
  get ofTemplate(){ return ['template', 'tplstep'].includes(this.checklistRole); },
  // Open the project's sheet. What it offers depends on access (Vikunja's max_permission: 0 read, 1 write, 2 admin):
  // renaming, archiving and checklists need write, deleting needs admin.
  async openProject(){
    const p = this.view.project; if (!p) return;
    this.openSheet('project');
    this.sheet.project = p;
    this.sheet.projEdit = {name: p.title, perm: null, tasks: null, kids: this.projects.filter(x => x.parent_project_id === p.id).length};
    try {
      const [full, list] = await Promise.all([api('/projects/' + p.id), api(`/projects/${p.id}/tasks?per_page=1`)]);
      if (this.sheet.project?.id !== p.id) return;
      Object.assign(this.sheet.projEdit, {perm: full.max_permission ?? 0, tasks: list?.total ?? null});
      this.perms[p.id] = full.max_permission ?? 1; saved.set('perms', this.perms);
    } catch (e) { if (this.sheet.project?.id === p.id) this.sheet.projEdit.perm = e instanceof NetError ? -1 : 0; }
  },
  // Put a changed project into the lists, the project on screen and the sheet.
  projectChanged(next){
    this.setProjects(this.projects.map(x => x.id === next.id ? next : x)); saved.set('projects', this.projects);
    if (this.view.project?.id === next.id) this.view.project = next;
    if (this.sheet.project?.id === next.id) this.sheet.project = next;
  },
  async renameProject(){
    const p = this.sheet.project, e = this.sheet.projEdit, title = e?.name.trim();
    if (!p || !title || title === p.title) { if (e && p) e.name = p.title; return; }
    try {
      const got = await api('/projects/' + p.id, {method: 'PATCH', body: {title}}) || {title};
      this.projectChanged({...p, ...got}); this.say('Renamed', {place: 'sheet:top'});
    } catch (err) { e.name = p.title; this.say('Not renamed: ' + err.message, {place: 'sheet:top', cls: 'failed'}); }
  },
  async archiveProject(){
    const p = this.sheet.project;
    if (!p || !confirm(`Archive “${p.title}”? It's hidden here and in Vikunja, with its tasks, until it's unarchived in Vikunja on the web.`)) return;
    try {
      await api('/projects/' + p.id, {method: 'PATCH', body: {is_archived: true}});
      this.setProjects(this.projects.filter(x => x.id !== p.id)); saved.set('projects', this.projects);
      this.closeSheet(true); this.go('#/projects'); this.say('Archived ' + p.title, {place: 'projects'});
    } catch (err) { this.say('Not archived: ' + err.message, {place: 'sheet:top', cls: 'failed'}); }
  },
  async deleteProject(){
    const p = this.sheet.project, e = this.sheet.projEdit;
    if (!p) return;
    const n = e?.tasks, k = e?.kids || 0;
    const what = [n !== null && n !== undefined ? `${n} task${n === 1 ? '' : 's'}` : 'its tasks', k && `${k} project${k === 1 ? '' : 's'} inside it`].filter(Boolean).join(' and ');
    if (!confirm(`Delete “${p.title}” and its ${what}? This can't be undone.`)) return;
    try {
      await api('/projects/' + p.id, {method: 'DELETE'});
      await this.loadProjects();
      this.closeSheet(true); this.go('#/projects'); this.say('Deleted ' + p.title, {place: 'projects'});
    } catch (err) { this.say('Not deleted: ' + err.message, {place: 'sheet:top', cls: 'failed'}); }
  },
  // Mark a project for checklists, or unmark it: a paragraph "pocket:checklists" in its description. The rest of the
  // description stays.
  async setChecklists(p, on){
    this.sheet.checklistBusy = true;
    try {
      let description;
      if (on) description = (p.description || '').trim() + `<p>${CHECKLIST_MARK}</p>`;
      else {
        const root = parseFragment(p.description);
        for (const el of [...root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')]) if (el.textContent.trim().toLowerCase() === CHECKLIST_MARK) el.remove();
        description = root.innerHTML;
        if (isChecklistDesc(description)) description = description.replace(new RegExp(CHECKLIST_MARK, 'gi'), '');   // the mark wasn't in a paragraph of its own
        description = description.trim() || '<p></p>';                          // Vikunja's PATCH ignores an empty description
      }
      const got = await api('/projects/' + p.id, {method: 'PATCH', body: {description}}) || await api('/projects/' + p.id);
      const next = {...p, ...got};
      this.setProjects(this.projects.map(x => x.id === p.id ? next : x)); saved.set('projects', this.projects);
      if (this.view.project?.id === p.id) this.view.project = next;
      if (this.sheet.project?.id === p.id) this.sheet.project = next;
      this.say(on ? 'Now for checklists. Its templates and checklists are under Checklists.' : 'No longer for checklists', {place: 'sheet:top'});
    } catch (e) { this.say('Not changed: ' + e.message, {place: 'sheet:top', cls: 'failed'}); }
    finally { this.sheet.checklistBusy = false; }
  },
  /* ---------- setting checklists up ---------- */
  // Set up checklists: make a project "Checklists" marked for checklists, with an example template, then open
  // Checklists.
  async setUpChecklists(){
    if (this.settingUp) return;
    this.settingUp = true;
    try {
      const p = await api('/projects', {method: 'POST', body: {title: 'Checklists', description: `<p>${CHECKLIST_MARK}</p>`}});
      this.setProjects([...this.projects, p]); saved.set('projects', this.projects);
      this.perms[p.id] = 2; saved.set('perms', this.perms);
      let made = true;
      try { await this.addExample(p); } catch { made = false; }
      this.go('#/checklists');
      this.say(made ? 'Set up Checklists, with an example template to try.' : 'Set up Checklists, but the example template couldn\'t be created: add one with New template.', {place: 'checklists', cls: made ? '' : 'failed'});
    } catch (e) { this.say(e instanceof NetError ? 'Setting up checklists needs a connection to Vikunja.' : 'Not set up: ' + e.message, {place: 'setup', cls: 'failed'}); }
    finally { this.settingUp = false; }
  },
  // The example template: four steps, the first assigned to the user, the third due 18 minutes after the second.
  // Written with quick add's parsing off, so the user's settings don't change it.
  async addExample(p){
    const title = templateTitle('Example: Opening up'), steps = ['Turn on the espresso machine', 'Put the croissants in the oven', 'Take the croissants out T#18m', 'Wipe down the tables'];
    const made = await this.createLines([title], {pid: p.id, ignore: {...STEP_IGNORE, labels: true, assignees: true, priority: true}});
    if (made.error) throw made.error;
    const t = {id: made.ids[0], title, project_id: p.id, labels: [], due_date: null};
    await patiently(() => patchTask(t.id, {description: '<p>An example to try: tap Start and tick its steps off. Then edit it into a template of your own, or delete it from its ⋯.</p>'}));
    const r = await this.createLines(steps, {parent: t, ignore: {...STEP_IGNORE, labels: true, assignees: true, priority: true}});
    if (r.error) throw r.error;
    await patiently(() => api(`/tasks/${r.ids[0]}/assignees`, {method: 'POST', body: {user_id: this.user.id}})).catch(() => {});
    await patiently(() => patchTask(r.ids[2], {description: '<p>Due 18 minutes after the croissants go in. Notes and photos on a step show on it in every checklist.</p>'})).catch(() => {});
    await this.markTemplate(t, r.ids);
  },
  // Whether Getting started shows on Checklists: for a project's admin (who can share it), until they hide it.
  gettingStarted(pid){ return this.perms[pid] >= 2 && !this.startedHidden[pid]; },
  // Hide Getting started, or show it again from the project's menu.
  hideGettingStarted(pid, hide = true){
    this.startedHidden = {...this.startedHidden, [pid]: hide};
    store.set('started.hidden', JSON.stringify(this.startedHidden));
  },
  // Vikunja's share page for a project, in its web app: sharing is done there.
  shareUrl(pid){ return `${this.server}/projects/${pid}/settings/share`; },
  openTasks(pid){ return allPages(`/projects/${pid}/tasks?` + new URLSearchParams({filter: 'done = false', filter_timezone: TZ})); },
  // Load each checklist project with its templates and open runs.
  async loadChecklists(seq){
    const checklists = await this.readChecklists(t => this.keep(t));
    if (seq !== renderSeq || !await this.settle(checklists.flatMap(cl => cl.runs.map(t => t.id)), seq)) return;
    this.view.checklists = checklists;
    saved.set('checklists', {checklists, at: new Date().toISOString()});
  },
  // Read the checklist projects from Vikunja. `own` maps each run to the copy to use: the one on screen, or Vikunja's
  // when preloading.
  async readChecklists(own){
    templatesKept = saved.get('templates') || {};
    const ws = this.checklistProjects;
    const labels = ws.length ? (await this.loadLabels(true)).filter(isTemplateLabel).map(l => l.id) : [];
    const checklists = await Promise.all(ws.map(async p => {
      const [templates, open, finished] = await Promise.all([
        // Templates: done, or not done with a due date (one that comes round).
        labels.length ? allPages(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: `labels in ${labels.join(', ')}`})) : [],
        this.openTasks(p.id),
        // Recently finished runs, from one page of the newest done tasks.
        api(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', sort_by: 'done_at', order_by: 'desc', per_page: 50})).then(items)]);
      return {project: {id: p.id, title: p.title},
        templates: templates.filter(isTemplate).map(t => ({...t, name: templateName(t.title)})).sort((a, b) => a.name.localeCompare(b.name))
          .map(t => { keepTemplate(t); return {id: t.id, title: t.name, steps: (t.related_tasks?.subtask || []).length,
            done: t.done, labels: t.labels, due_date: t.due_date, repeat_after: t.repeat_after, repeat_mode: t.repeat_mode}; }),
        runs: open.filter(isRun).map(own),
        finished: finished.filter(t => this.isRunTask(t)).slice(0, 5).map(t => ({id: t.id, title: t.title, done_at: t.done_at, forText: this.forText(t)}))};
    }));
    saved.set('templates', templatesKept);
    return checklists;
  },
  /* A template's line under Checklists, after its steps: "Next: Wed, Oct 7, 8:00 AM, then every day", or "Due now,
     since 6:00 PM today, just once". '' for one that doesn't come round. */
  scheduleText(t){
    if (!comesRound(t)) return '';
    const d = new Date(t.due_date), then = repeatWords(t) ? ', then ' + repeatWords(t) : ', just once';
    return (d <= new Date() ? 'Due now, since ' + whenText(d, 'today') : 'Next: ' + (+startOfDay(d) === +startOfDay() ? 'today, ' : '') + whenText(d)) + then;
  },
  // Under a template's When it's due: what its date and repeat do, in words.
  get comesRoundNote(){
    const t = this.sheet.task;
    if (!t || this.checklistRole !== 'template') return '';
    if (t.done || !isSet(t.due_date)) return repeats(t) ? `Give it a date to have it come round ${repeatWords(t)}, on Today. Until then, start it from Checklists.`
      : 'Without a date, start it from Checklists whenever it\'s needed. Give it one to have it show on Today then.';
    const on = onText(new Date(t.due_date));
    return repeats(t) ? `It shows on Today ${on}, then ${repeatWords(t)}. Starting a checklist moves it on to the next time.`
      : `It shows on Today ${on}, just once: starting a checklist ends it. Pick Repeats to have it come round.`;
  },
  // Whether a due template shows on the user's Today: for its assignees, or with none, for anyone who can start it.
  templateFor(t){
    const who = t.assignees || [];
    return who.length ? who.some(u => u.id === this.user?.id) : this.canWrite(t.project_id);
  },
  // "For you and <name>", with you first.
  forText(t){
    const all = t.assignees || [], me = this.user?.id;
    const who = [...all.filter(u => u.id === me).map(() => 'you'), ...all.filter(u => u.id !== me).map(u => u.name || u.username)];
    return who.length ? 'For ' + andList(who) : '';
  },
  /* Cancel a checklist start that is still waiting. Anything that reached Vikunja already is deleted (sendRun), now or
     once there is a connection. The entry stays until then, so no half-made copy is left behind. */
  async cancelStart(id){
    let gone = false, made = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      made = !!(e.tried || e.steps.some(s => s.tried));
      if (made) await sync.save({...e, cancelled: true}); else await sync.remove(id);
    });
    this.refreshPending();
    if (gone) { this.say('It had started already. Delete it from its ⋯ if it isn\'t needed.', {place: ['sheet:top', 'checklists']}); this.render(); return; }
    if (made) { await sync.lock(() => this.sendEntry(id)); this.refreshPending(); }
    this.say('Not started', {place: ['sheet:top', 'checklists']});
    this.render();
  },
  // Checklist starts in a project that are waiting or under way.
  startingIn(pid){ return this.pending.filter(e => e.kind === 'run' && !e.cancelled && e.template.project_id === pid); },
  /* The open runs in checklist projects, with whether each is the user's (started by them, or assigned to them). Today
     shows only those. `open`: every open task there, steps included, for the cards. */
  async loadRunIndex(){
    const ws = this.checklistProjects;
    if (!ws.length) return {index: {}, mine: [], open: []};
    try {
      const index = {}, mine = [], open = (await Promise.all(ws.map(p => this.openTasks(p.id)))).flat();
      for (const t of open) if (isRun(t)) {
        index[t.id] = t.created_by?.id === this.user?.id || (t.assignees || []).some(u => u.id === this.user?.id);
        if (index[t.id]) mine.push(t);
      }
      saved.set('runs', index);
      return {index, mine, open};
    } catch (e) { if (e instanceof NetError) return {index: saved.get('runs') || {}, mine: [], open: []}; throw e; }
  },
  // Whether Today shows a task. In a checklist project: a run of the user's, a step of one, or a task assigned to them.
  // Anything else there that isn't part of a run shows as anywhere.
  inToday(t, runs){
    if (!this.checklistIds.has(t.project_id)) return true;
    if (hasTemplateLabel(t)) return comesRound(t) && this.templateFor(t);  // a template that's due, not a run being set up
    if ((t.assignees || []).some(u => u.id === this.user?.id)) return true;
    const parent = t.related_tasks?.parenttask?.[0]?.id;
    if (t.id in runs) return runs[t.id];
    if (parent in runs) return runs[parent];
    return !isRun(t) && !isRunStepTask(t);                                 // an unknown run, or a step of one, is hidden
  },

  /* Make the open task a template: label it "template", mark its steps done so none is a to-do anywhere, then mark the
     task itself done, or with a due date leave it open to come round. The task comes last, so one cut off half way
     isn't a template yet and the button can finish it. */
  async makeTemplate(){
    const t = this.sheet.task;
    if (!t || this.sheet.checklistBusy) return;
    const problems = stepProblems(this.subtasks.map(s => s.title));
    if (problems.length) { this.say('Template not created: ' + problemText(problems), {place: 'sheet:top', cls: 'failed'}); return; }
    this.sheet.checklistBusy = true;
    try {
      await this.markTemplate(t, this.subtasks.filter(s => !s.done).map(s => s.id));
      const full = await api('/tasks/' + t.id);
      cache.set(full.id, full);
      if (this.sheet.task?.id === t.id) { this.showTask(full); this.sheet.dirty = true; }
      this.say(!comesRound(full) ? 'Template created. Start it here or under Checklists.'
        : `Template created. ${this.scheduleText(full)}: it appears on Today then, and starting it `
          + (repeats(full) ? 'advances it to the next occurrence.' : 'ends it, as it doesn\'t repeat.'), {place: 'sheet:top'});
    } catch (e) { this.say('Template not created: ' + e.message, {place: 'sheet:top', cls: 'failed'}); }
    finally { this.sheet.checklistBusy = false; }
  },
  async markTemplate(t, stepIds){
    if (!hasTemplateLabel(t)) {
      const all = (await this.loadLabels(true)).filter(isTemplateLabel);
      let l = all.find(x => x.created_by?.id === this.user?.id) || all[0];
      if (!l) { l = await api('/labels', {method: 'POST', body: {title: 'template'}}); this.labels.push(l); }
      await api(`/tasks/${t.id}/labels`, {method: 'POST', body: {label_id: l.id}}).catch(e => { if (e.code !== ALREADY.label) throw e; });
    }
    for (const id of stepIds) await patiently(() => patchTask(id, {done: true}));
    // A "copied from" link (a template duplicated in the web app, say) would make it look like a run being set up, so drop it.
    for (const c of t.related_tasks?.copiedfrom || [])
      await patiently(() => api(`/tasks/${t.id}/relations/copiedfrom/${c.id}`, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
    await patiently(() => patchTask(t.id, {done: !isSet(t.due_date), ...t.title && {title: templateTitle(t.title)}}));
  },

  /* ---------- writing steps: in New template, and under a template ---------- */
  /* A template's steps are listed in its sheet like a task's subtasks (sheet/sub-list.html): a row for each, then one
     box at the foot. Each line typed or pasted in the box becomes a step. `which` is 'new' for New template's box and
     'add' for the one under a template. Under a template, steps are sent at once (addTemplateSteps). In New template
     nothing reaches Vikunja until Create template: the lines become rows on the phone ({id, key, text, keep, from,
     ignore}) that are drawn, edited, moved and removed like a template's steps, by the same row. A row the box sits
     under (sheet.subAt) gets the next lines after it. */
  // New template's rows, or under a template the rows on their way to Vikunja.
  draftRows(which){ return which === 'new' ? this.sheet.newTpl?.rows || [] : this.sheet.addRows; },
  // The box as a row with key '+', so a single line in it is parsed as a step and gets its time chip.
  stepBox(which){ return (which === 'new' ? this.sheet.newTpl?.add : this.sheet.addBox) || {text: ''}; },
  get stepWhich(){ return this.sheet.kind === 'newtpl' ? 'new' : 'add'; },
  // The rows in order, with the box's line where the box sits while it is a single line (a pasted list is parsed once
  // added). Under a template with steps on their way, only those.
  draftAll(which){
    const rows = this.draftRows(which), b = this.stepBox(which), text = (b.text || '').trim();
    if (!text || text.includes('\n') || (which === 'add' && rows.length)) return rows;
    const at = which === 'new' ? rows.findIndex(r => r.id === this.sheet.subAt) : -1;
    return at < 0 ? [...rows, b] : [...rows.slice(0, at + 1), b, ...rows.slice(at + 1)];
  },
  // Parse the rows (draftSteps). Under a template with the box under a step, they follow that step.
  draft(which){
    const at = which === 'new' || this.sheet.subAt == null ? -1 : this.subtasks.findIndex(s => s.id === this.sheet.subAt);
    const before = which === 'new' ? [] : (at < 0 ? this.subtasks : this.subtasks.slice(0, at + 1)).map(s => ({key: 'task:' + s.id, text: s.title}));
    return draftSteps(this.draftAll(which), before, this.stepWordsOnly);
  },
  // A step's title without quick add's @people, *labels and !priority: what it is named and referred to by.
  get stepWordsOnly(){ return t => this.stepParsed(t).title || t; },
  // The chips tapped off in each row that will be sent.
  draftIgnores(which){ return this.draftRows(which).filter(r => r.text.trim()).map(r => r.ignore || {}); },
  // A New template row: a step on the phone only, with an id for the task row and a key for draftSteps.
  newStepRow(text, more = {}){ const key = randomId(); return {id: 'new-' + key, key, text, keep: false, from: null, ignore: {}, ...more}; },
  /* Add the box's lines as steps (Enter, or its button). A single line keeps its chips (the time, those tapped off).
     In New template the lines become rows after the row the box is under, or last, and the box moves under the last
     of them. Under a template they are sent (addTemplateSteps), unless a line has a problem, which its chip shows.
     The box stays, emptied and focused. */
  sendSteps(which){
    const b = this.stepBox(which), lines = captureLines(b.text || '');
    if (!lines.length || (which === 'add' && this.sheet.subBusy)) return;
    const one = lines.length === 1, was = {text: b.text, keep: b.keep, from: b.from, ignore: b.ignore};
    const made = lines.map(text => this.newStepRow(text, one ? {keep: !!b.keep, from: b.from ?? null, ignore: b.ignore || {}} : {}));
    Object.assign(b, {text: '', keep: false, from: null, ignore: {}});
    if (which === 'add') {
      // A line cut off mid-send before carries on from its job, so nothing is added twice.
      for (const r of made) r.job = b.jobs?.find(j => j.text === r.text)?.job;
      this.sheet.addRows = made;
      if (this.draft('add').problem) { this.sheet.addRows = []; Object.assign(b, was); return; }
      b.jobs = null;
      return this.addTemplateSteps();
    }
    const rows = this.draftRows('new'), at = rows.findIndex(r => r.id === this.sheet.subAt);
    // A row that counted from the box's line now counts from the row that line became.
    for (const r of rows) if (r.from === '+') r.from = one ? made[0].key : null;
    rows.splice(at < 0 ? rows.length : at + 1, 0, ...made);
    if (at >= 0) this.sheet.subAt = made.at(-1).id;
  },
  /* An unseen field holds the focus while a box appears, so the phone's keyboard stays open. The box then takes the
     focus, with anything typed meanwhile (a fast typist's first letters). */
  keepFocus(){ const k = document.getElementById('focus-keeper'); if (k) { k.value = ''; k.focus({preventScroll: true}); } },
  passFocus(el, add, atEnd = false){
    const k = document.getElementById('focus-keeper'), typed = k?.value || '';
    if (k) k.value = '';
    if (!el) return;
    if (typed) { add(typed); el.value = atEnd ? el.value + typed : typed + el.value; }
    el.focus();
    if (typed) { const at = atEnd ? el.value.length : typed.length; el.setSelectionRange(at, at); }
  },
  // Move a New template row to index `to`. The move takes the focus off the row's box, so it is
  // given back afterwards.
  placeDraftRow(which, k, to){
    const rows = this.draftRows(which), box = document.activeElement;
    if (to < 0 || to >= rows.length || to === k || !rows[k]) return;
    rows.splice(to, 0, rows.splice(k, 1)[0]);
    if (box?.classList.contains('draft-in')) setTimeout(() => box.isConnected && box.focus({preventScroll: true}));
  },
  // Remove a row (swiped to Delete, or left empty). A box under it moves to the row before, or the foot. A row that
  // counted from it counts from the step before again. It was never sent, so there is nothing to undo.
  dropDraftRow(which, k){
    const rows = this.draftRows(which), [gone] = rows.splice(k, 1);
    if (!gone) return;
    if (this.sheet.stepEdit?.key === gone.key) this.sheet.stepEdit = null;
    if (which === 'new' && this.sheet.subAt === gone.id) this.sheet.subAt = rows[k - 1]?.id ?? null;
    for (const r of rows) if (r.from === gone.key) r.from = null;
  },
  openNewTemplate(p){
    this.openSheet('newtpl');
    const kept = taskDrafts.get('newtpl:' + p.id);                          // a draft from before, not created yet
    // The name is written in quick add's box ('tname'), and its steps in the box at their foot ('new:+').
    this.sheet.newTpl = {project: {id: p.id, title: p.title}, box: {...newBox(), text: kept?.name || ''},
      rows: (kept?.rows || []).filter(r => r.text?.trim()).map(r => this.newStepRow(r.text, {keep: !!r.keep, from: null, ignore: r.ignore || {}})),
      add: {...newStepBox(), text: kept?.add || ''}, busy: false};
    this.$nextTick(() => document.getElementById('nt-name')?.focus());
  },
  /* Create the template in one go: the task, its steps, then mark it a template. Cut off half way, the task stays in
     the project with the steps made so far: Create template again carries on from there (nt.jobs), and so does Use as
     checklist template on the task. */
  async createTemplate(){
    const nt = this.sheet.newTpl;
    if (nt && !nt.busy && (nt.add.text || '').trim()) this.sendSteps('new');      // what's still in the box is a step too
    const name = nt?.box.text.trim(), d = nt && this.draft('new');
    if (!name || !d.added.length || d.problem || nt.busy) return;
    const shown = templateName(this.stepParsed(name, nt.box.ignore).title);   // without @people and *labels
    nt.busy = true;
    let t = null;
    try {
      // A changed name means a new task, and new steps.
      const line = templateTitle(name), kept = nt.jobs?.name[0]?.line === line ? nt.jobs : null;
      const jobs = nt.jobs = {name: jobsFor(kept?.name || [], [line]), steps: jobsFor(kept?.steps || [], d.added)};
      const made = await this.createLines([line], {pid: nt.project.id, ignore: {...STEP_IGNORE, ...nt.box.ignore}, jobs: jobs.name});
      if (made.error) throw made.error;
      t = {id: made.ids[0], project_id: nt.project.id, labels: []};
      const r = await this.createLines(d.added, {parent: t, ignore: STEP_IGNORE, ignores: this.draftIgnores('new'), jobs: jobs.steps});
      if (r.error) throw r.error;
      await this.markTemplate(t, r.ids);
      nt.made = true; taskDrafts.delete('newtpl:' + nt.project.id);
      if (this.sheet.newTpl === nt) this.closeSheet(true);
      if (this.route.name === 'checklists') this.render(); else this.go('#/checklists');
      this.say(`Created ${shown}. Start it here.`, {place: 'checklists'});
    } catch (e) {
      nt.busy = false;
      this.say(t ? `Not finished: ${why(e)}. Tap Create template again to finish “${shown}”.` : 'Not created: ' + why(e), {place: 'sheet:top', cls: 'failed'});
    }
  },
  // Add steps under a template: create them, mark them done like the rest, and name any step they count from.
  async addTemplateSteps(){
    const t = this.sheet.task, d = this.draft('add');
    if (!t || !d.added.length || d.problem || this.sheet.subBusy) return;
    this.sheet.subBusy = true;
    const r = {ids: [], problems: [], error: null};
    // Each row keeps how far it got, so Add after a cut-off finds a step whose reply was lost instead of adding it again.
    const rows = this.sheet.addRows.filter(x => x.text.trim()), jobs = jobsFor(rows.map(x => x.job), d.added);
    rows.forEach((x, k) => { x.job = jobs[k]; });
    const under = this.sheet.subAt;
    try {
      for (const {key, title} of d.renames) await patiently(() => patchTask(+key.slice(5), {title}));
      Object.assign(r, await this.createLines(d.added, {parent: t, ignore: STEP_IGNORE, ignores: this.draftIgnores('add'), jobs}));
      for (const id of r.ids) await patiently(() => patchTask(id, {done: true})).catch(e => r.problems.push(e.message));
      // With the box under a step, put the new steps after it in the order line, starting from the order Vikunja has now.
      if (under != null && r.ids.length) await patiently(() => this.saveTask(t.id, null, now => {
        const ids = stepsOf(now).map(s => s.id).filter(id => !r.ids.includes(id)), k = ids.indexOf(under);
        return k < 0 ? null : {description: withOrder(now.description, [...ids.slice(0, k + 1), ...r.ids, ...ids.slice(k + 1)])};
      })).catch(e => r.problems.push('not put in their place: ' + e.message));
    } catch (e) { r.error = e; }
    /* A step created but not linked under the template (Vikunja refused) is deleted, so it isn't left as a task of its
       own on someone's Today. Add creates it again. Offline it stays, for Add to carry on with. */
    if (r.error && !(r.error instanceof NetError)) for (const x of rows) if (x.job?.taskId && !x.job.linked && !r.ids.includes(x.job.taskId)) {
      await api('/tasks/' + x.job.taskId, {method: 'DELETE'}).then(() => { x.job = null; }, () => {});
    }
    if (this.sheet.task?.id === t.id) {
      this.sheet.subBusy = false;
      if (r.error) {
        // Lines not added go back in the box, each with its job, for the next try to carry on with.
        const left = this.sheet.addRows.filter(x => x.text.trim()).slice(r.ids.length), b = this.stepBox('add');
        b.text = [...left.map(x => x.text), b.text].filter(x => x?.trim()).join('\n'); b.jobs = left.map(x => ({text: x.text, job: x.job}));
        this.sheet.addRows = [];
        const tt = this.sheet.task;
        tt.related_tasks = {...tt.related_tasks, subtask: [...this.subtasks, ...r.ids.map((id, k) => ({id, title: d.added[k], done: true}))]};
      } else {
        // With the box under a step, move it under the last step added.
        this.sheet.addRows = [];
        if (under != null && this.sheet.subAt === under && r.ids.length) this.sheet.subAt = r.ids.at(-1);
      }
      this.sheet.dirty = true;
      try { const full = await this.readTask(t.id); if (full) { cache.set(full.id, full); if (this.sheet.task?.id === full.id) this.showTask(full); } } catch {}
    }
    const but = r.problems.length ? `, but ${r.problems.join('; ')}` : '';
    if (r.error) this.say(`Added ${r.ids.length} of ${d.added.length}${but}. Stopped: ${why(r.error)}`, {place: 'sheet:subtasks', cls: 'failed'});
    else if (but) this.say(`Added ${r.ids.length}${but}`, {place: 'sheet:subtasks', cls: 'failed'});
    else this.unsay('sheet:subtasks');                                       // a try that failed before is done now
  },
  // A row's time chip as a list for x-for: [d] when there is something to show, else [].
  draftShown(d){ return d && (d.problem || d.offset !== null || d.kept || d.name) ? [d] : []; },
  // The first line of a step's notes, under it in its template.
  stepNote(st){ return htmlToText(notesOnly(st.description)).trim().split('\n')[0]; },
  // Edit a template's step in place, as a New template row: a time in words is read as T#, with its chip. Its field
  // appears only after the tap, so keepFocus takes the focus now to open the keyboard.
  editStep(st){
    const e = this.sheet.stepEdit, k = e ? this.subList.findIndex(s => s.id === e.id) : -1;
    if (k >= 0 && e.id !== st.id) this.saveStepEdit(k);                       // save another step still being edited
    this.keepFocus();
    // Words quick add would parse that are still in the title were kept as words when written (a chip tapped off).
    // Keep ignoring them, so editing doesn't turn them into a priority or a person.
    const text = st.key ? st.text : stepWords(st.title, this.subtasks.map(s => s.title)), kept = this.stepParsed(text);
    const ignore = Object.fromEntries([['assignees', kept.assignees.length], ['labels', kept.labels.length], ['priority', kept.priority]].filter(([, n]) => n).map(([k]) => [k, true]));
    // A New template row (it has a `key`) is edited in place.
    this.sheet.stepEdit = st.key ? st : {id: st.id, text, keep: false, from: null, ignore};
    // The box takes the focus as it appears (x-init). If a redraw got there first, pass it now.
    setTimeout(() => {
      const el = document.getElementById('step-edit-' + st.id);
      if (el && document.activeElement?.id === 'focus-keeper') this.passFocus(el, t => { if (this.sheet.stepEdit?.id === st.id) this.sheet.stepEdit.text += t; }, true);
    }, 50);
  },
  /* Parse the step being edited after the steps before it (draftSteps). Returns its info with every step's title as it
     will be saved, since a step it counts from may be given a name. Null while empty. */
  stepEditDraft(i){
    const e = this.sheet.stepEdit;
    if (!e?.text.trim()) return null;
    if (e.key) return this.draft('new').info.get(e.key) || null;                // New template's: read with the rows there
    const before = this.subtasks.slice(0, i).map(s => ({key: 'task:' + s.id, text: s.title}));
    const d = draftSteps([{key: 'edit', text: e.text, keep: e.keep, from: e.from}], before, this.stepWordsOnly), info = d.info.get('edit');
    const titles = this.subtasks.map((s, k) => k === i ? info.saved : d.renames.find(r => r.key === 'task:' + s.id)?.title ?? s.title);
    return {...info, titles, problem: stepProblems(titles).filter(p => p.i === i).map(p => p.text).join('; ') || info.problem};
  },
  // The edited step's assignees and labels as chips. A tap strikes one through (stepEdit.drop), and saving removes it.
  stepHasChips(){
    const e = this.sheet.stepEdit, st = e && this.subtasks.find(s => s.id === e.id), P = this.prefixes;
    if (!st || !P) return [];
    const drop = e.drop || {}, people = this.sheet.subPeople[st.id] || st.assignees || [], labels = this.sheet.subLabels[st.id] || st.labels || [];
    const chip = (k, text) => ({key: 'had-' + k, kind: 'had', text, off: !!drop[k], hint: drop[k] ? `Tap to keep ${text} on this step` : `Tap to take ${text} off this step`,
      action: () => { e.drop = {...e.drop, [k]: !e.drop?.[k]}; }});
    return [...people.map(u => chip('u' + u.id, P.assignee + u.username)), ...labels.filter(l => !isTemplateLabel(l)).map(l => chip('l' + l.id, P.label + l.title))];
  },
  async saveStepEdit(i){
    const e = this.sheet.stepEdit, st = this.subtasks[i];
    // A New template row already holds the text. Left empty, it is removed.
    if (e?.key) { this.sheet.stepEdit = null; if (!e.text.trim()) this.dropDraftRow('new', this.draftRows('new').findIndex(r => r.key === e.key)); return; }
    if (!e || !st || st.id !== e.id) return;
    const d = this.stepEditDraft(i), drops = Object.keys(e.drop || {}).filter(k => e.drop[k]);
    const todo = d ? this.subtasks.map((s, k) => ({s, was: s.title, title: d.titles[k]})).filter(x => x.title !== x.was) : [];
    if (!todo.length && !drops.length) { this.sheet.stepEdit = null; return; }
    // A new problem: the text stays in the box to put right.
    if (stepProblems(d.titles).length > stepProblems(this.subtasks.map(s => s.title)).length) { this.say('Not changed: ' + problemText(stepProblems(d.titles)), {place: 'sheet:subtasks', cls: 'failed'}); return; }
    this.sheet.stepEdit = null;
    // Parse the edited title as quick add does: @people, *labels and !priority are applied, and the title is saved without them.
    const own = todo.find(x => x.s.id === e.id), p = own && this.stepParsed(own.title, e.ignore);
    if (own) own.title = p.title;
    for (const x of todo) x.s.title = x.title;
    // Renamed steps are saved in order, so a step this one counts from gets its name first.
    try {
      for (const x of todo) { await this.saveTask(x.s.id, {title: x.title}); x.saved = true; this.sheet.dirty = true; }
      if (p && (p.assignees.length || p.labels.length || p.priority)) {
        // Apply them as quick add sends a line, to the existing step. A person who can't see the project stays in the title.
        const job = {taskId: e.id, done: false}, t = await this.createTask(p, this.sheet.task?.project_id, {job});
        if (job.body.title !== p.title || p.priority) await this.saveTask(e.id, {title: job.body.title, ...p.priority && {priority: p.priority}});
        if (t.problems.length) this.say('Changed, but ' + t.problems.join('; '), {place: 'sheet:subtasks', cls: 'failed'});
      }
      // Remove the assignees and labels tapped off.
      for (const k of drops) {
        const id = +k.slice(1);
        await patiently(() => api(`/tasks/${e.id}/${k[0] === 'u' ? 'assignees' : 'labels'}/${id}`, {method: 'DELETE'})).catch(err => { if (err.status !== 404) throw err; });
        const had = k[0] === 'u' ? this.sheet.subPeople : this.sheet.subLabels;
        if (had[e.id]) had[e.id] = had[e.id].filter(x => x.id !== id);
        this.sheet.dirty = true;
      }
      if ((p && (p.assignees.length || p.labels.length || p.priority)) || drops.length) {
        const full = await this.readTask(this.sheet.task.id).catch(() => null);
        if (full && this.sheet.task?.id === full.id) { this.showTask(full); this.loadSubPeople(full); }
      }
    } catch (err) {
      for (const x of todo) if (!x.saved) x.s.title = x.was;
      this.say(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message, {place: 'sheet:subtasks', cls: 'failed'});
      if (this.subtasks.some(s => s.id === e.id) && !this.sheet.stepEdit) this.sheet.stepEdit = {...e};
    }
  },
  // Open a step's own sheet, for notes and photos. An edit in progress is saved first. If that fails, stay.
  async openStep(i){
    const st = this.subtasks[i];
    await this.saveStepEdit(i);
    if (st && !this.sheet.stepEdit) this.openTask(st.id);
  },
  // A template's step in its own sheet: its number, and when it's due, read from its template's steps.
  get tplStep(){
    const t = this.sheet.task, p = this.parentTask, tpl = p && (cache.get(p.id) || templatesKept[p.id]);
    if (!tpl) return null;
    const steps = stepsOf(tpl), i = steps.findIndex(s => s.id === t?.id);
    if (i < 0) return null;
    return {no: i + 1, of: steps.length, ...stepInfos(steps.map(s => s.id === t.id ? t.title : s.title))[i]};
  },
  // Take a step out of a template. Runs started already keep their copy of it.
  async removeStep(i){
    if (this.sheet.kind === 'newtpl') return this.dropDraftRow('new', i);       // never sent: it just goes
    const t = this.sheet.task, st = this.subtasks[i];
    if (!t || !st || this.sheet.checklistBusy) return;
    const rest = this.subtasks.filter((_, k) => k !== i).map(s => s.title), problems = stepProblems(rest);
    // Problems are reported by the step numbers on screen, before removal.
    if (problems.length > stepProblems(this.subtasks.map(s => s.title)).length) { this.say('Not removed: ' + problemText(problems.map(p => ({...p, i: p.i >= i ? p.i + 1 : p.i}))), {place: 'sheet:subtasks', cls: 'failed'}); return; }
    if (!confirm(`Remove “${parseStep(st.title).title}” from the template? Checklists already started keep it.`)) return;
    this.sheet.checklistBusy = true;
    try {
      // Count it removed if Vikunja no longer has it: a 404, or a lost reply with the step gone.
      await patiently(() => api('/tasks/' + st.id, {method: 'DELETE'})).catch(async e => {
        if (e.status !== 404 && (!(e instanceof NetError) || await api('/tasks/' + st.id).then(() => true, x => x.status !== 404))) throw e;
      });
      cache.delete(st.id);
      t.related_tasks = {...t.related_tasks, subtask: this.subtasks.filter(s => s.id !== st.id)};
      this.keepTemplate(t);
      this.sheet.dirty = true;
      this.say('Step removed', {place: 'sheet:subtasks'});
    } catch (err) { this.say('Not removed: ' + why(err), {place: 'sheet:subtasks', cls: 'failed'}); }
    finally { this.sheet.checklistBusy = false; }
  },
  /* Move a template's step `dir` places up (-1) or down (1), or as far as it was dragged
     (`dragged`). The order line is rewritten with every step. Refused when the move would create a problem the
     template didn't have, such as counting from a later step; an existing problem can still be fixed. The move is
     applied to the order Vikunja has when it is sent, and only the order line changes, so notes and moves saved
     elsewhere since the sheet opened stay. */
  async moveStep(i, dir, dragged = false){
    if (this.sheet.kind === 'newtpl') return this.placeDraftRow('new', i, i + dir);   // on the phone only: its place among the rows
    const t = this.sheet.task, st = this.subtasks[i], to = i + dir, rest = this.subtasks.filter((_, k) => k !== i);
    if (!t || !st || this.sheet.checklistBusy || to < 0 || to >= this.subtasks.length || !dir) return;
    const after = to > 0 ? rest[to - 1].id : null;
    // The steps in their new order, or null if nothing moves. Throws for a problem the move creates.
    const moved = steps => {
      const k = steps.findIndex(s => s.id === st.id), others = steps.filter(s => s.id !== st.id);
      if (k < 0) return null;
      const at = after === null ? 0 : others.findIndex(s => s.id === after) + 1;
      const place = !dragged ? k + dir : at > 0 || after === null ? at : Math.min(to, others.length);
      if (place === k || place < 0 || place > others.length) return null;
      const out = [...others.slice(0, place), steps[k], ...others.slice(place)];
      const before = stepProblems(steps.map(s => s.title));
      const fresh = stepProblems(out.map(s => s.title)).filter(p => !before.some(b => b.text === p.text && b.title === p.title));
      if (fresh.length) throw new Error(problemText(fresh.map(p => ({...p, i: steps.indexOf(out[p.i])}))));   // by its number on screen
      return out;
    };
    let steps;
    try { steps = moved(this.subtasks); } catch (e) { this.say('Not moved: ' + e.message, {place: 'sheet:subtasks', cls: 'failed'}); return; }
    if (!steps) return;
    const was = stepOrder(t.description), box = document.getElementById('step-edit-' + st.id);
    t.description = withOrder(t.description, steps.map(s => s.id));          // shown in the new order straight away
    // Moving the row takes the focus off its box. Give it back before the row's focusout handler runs, so the step
    // stays open to move again.
    if (box && box === document.activeElement) setTimeout(() => box.isConnected && box.focus({preventScroll: true}));
    this.sheet.checklistBusy = true;
    try {
      const got = await patiently(() => this.saveTask(t.id, null, now => { const s = moved(stepsOf(now)); return s && {description: withOrder(now.description, s.map(x => x.id))}; }));
      if (this.sheet.task?.id === t.id) { this.showTask(got); this.unsay('sheet:subtasks'); }   // one that failed before is moved now
      this.sheet.dirty = true;
    } catch (e) { if (this.sheet.task?.id === t.id) t.description = withOrder(t.description, was); this.say('Not moved: ' + why(e), {place: 'sheet:subtasks', cls: 'failed'}); }
    finally { this.sheet.checklistBusy = false; }
  },
};
