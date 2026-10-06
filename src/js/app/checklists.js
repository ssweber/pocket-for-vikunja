// Checklists, their projects and templates, and writing steps.
import {cache, taskDrafts, TZ} from '../util.js';
import {allPages, api, items, NetError, patchTask, why} from '../api.js';
import {fmtTime, isSet, startOfDay} from '../dates.js';
import {htmlToText, parseFragment} from '../html.js';
import {CHECKLIST_MARK, comesRound, draftSteps, hasTemplateLabel, isChecklistDesc, isTemplate, isRun, isRunDesc, isRunStepTask, isTemplateLabel, notesOnly, parseStep, patiently, problemText, STEP_IGNORE, stepInfos, stepOrder, stepProblems, stepsOf, stepWords, repeatWords, templateName, templateTitle, withOrder} from '../checklists.js';
import {captureLines} from '../quickadd.js';
import {ALREADY, randomId, sync} from '../sync.js';
import {jobsFor} from './sending.js';
import {saved} from '../lists.js';
import {renderSeq} from './views.js';
import {newBox} from './core.js';

// Templates as last loaded, kept for starting a run without a connection: id -> {id, title, project_id, related_tasks},
// with the steps in order, and when it comes round and who for.
let templatesKept = {};
const keepTemplate = t => { templatesKept[t.id] = {id: t.id, title: t.title, project_id: t.project_id, labels: t.labels, done: t.done, due_date: t.due_date,
  repeat_after: t.repeat_after, repeat_mode: t.repeat_mode, assignees: t.assignees || [], related_tasks: {subtask: stepsOf(t).map(s => ({id: s.id, title: s.title}))}}; };
// A time as a template's line says it: "6:00 PM" today, else "Wed, Oct 7, 8:00 AM".
const whenText = (d, today) => +startOfDay(d) === +startOfDay() ? fmtTime(d) + (today ? ' ' + today : '')
  : d.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

export default {
  // A template as its sheet shows it now, kept for starting a run offline: so a step just moved, added or removed is
  // taken into account, not only once Checklists loads again.
  keepTemplate(t){
    if (!isTemplate(t)) return;
    templatesKept = {...saved.get('templates'), ...templatesKept};
    keepTemplate(t); saved.set('templates', templatesKept);
  },
  isChecklistProject(p){ return isChecklistDesc(p?.description); },
  get checklistProjects(){ return this.projects.filter(p => this.isChecklistProject(p)); },
  get checklistIds(){ return new Set(this.checklistProjects.map(p => p.id)); },
  // The lit tab: Checklists for a run as well, Projects for a project and the list of them.
  get tab(){ return ['checklists', 'run'].includes(this.route.name) ? 'checklists' : this.route.name === 'today' ? 'today' : 'projects'; },
  /* What the open task is in a checklist project: a template, one of its steps ('tplstep'), a run, one of a run's steps,
     or a task that could be made a template. Vikunja's related tasks come without their labels, so a step's template is
     known from its own copy, as last loaded. */
  get checklistRole(){
    const t = this.sheet.task, r = t?.related_tasks || {};
    if (!t || !this.checklistIds.has(t.project_id)) return null;
    if (isTemplate(t)) return 'template';
    const p = r.parenttask?.[0];
    if (p) return isRunStepTask(t) ? 'step' : hasTemplateLabel(cache.get(p.id)) || templatesKept[p.id] ? 'tplstep' : null;
    return (r.copiedfrom?.length || isRunDesc(t.description)) && !hasTemplateLabel(t) ? 'run' : 'candidate';
  },
  // A template and its steps are never done or not done: their sheets have no tick, progress, priority or due date.
  get ofTemplate(){ return ['template', 'tplstep'].includes(this.checklistRole); },
  /* A project's ⋯. What's offered depends on your access to it (Vikunja's max_permission: 0 read, 1 write, 2 admin):
     renaming, archiving and checklists need write access, and deleting needs admin. */
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
      this.projectChanged({...p, ...got}); this.notify('Renamed');
    } catch (err) { e.name = p.title; this.notify('Not renamed: ' + err.message); }
  },
  async archiveProject(){
    const p = this.sheet.project;
    if (!p || !confirm(`Archive “${p.title}”? It's hidden here and in Vikunja, with its tasks, until it's unarchived in Vikunja on the web.`)) return;
    try {
      await api('/projects/' + p.id, {method: 'PATCH', body: {is_archived: true}});
      this.setProjects(this.projects.filter(x => x.id !== p.id)); saved.set('projects', this.projects);
      this.closeSheet(true); this.go('#/projects'); this.notify('Archived ' + p.title);
    } catch (err) { this.notify('Not archived: ' + err.message); }
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
      this.closeSheet(true); this.go('#/projects'); this.notify('Deleted ' + p.title);
    } catch (err) { this.notify('Not deleted: ' + err.message); }
  },
  /* Use a project for checklists, or not: a paragraph "pocket:checklists" added to its description, or taken out. The rest
     of the description stays as it was. */
  async setChecklists(p, on){
    this.sheet.checklistBusy = true;
    try {
      let description;
      if (on) description = (p.description || '').trim() + `<p>${CHECKLIST_MARK}</p>`;
      else {
        const root = parseFragment(p.description);
        for (const el of [...root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')]) if (el.textContent.trim().toLowerCase() === CHECKLIST_MARK) el.remove();
        description = root.innerHTML;
        if (isChecklistDesc(description)) description = description.replace(new RegExp(CHECKLIST_MARK, 'gi'), '');   // not in a paragraph of its own
        description = description.trim() || '<p></p>';                          // Vikunja's PATCH skips an empty one
      }
      const got = await api('/projects/' + p.id, {method: 'PATCH', body: {description}}) || await api('/projects/' + p.id);
      const next = {...p, ...got};
      this.setProjects(this.projects.map(x => x.id === p.id ? next : x)); saved.set('projects', this.projects);
      if (this.view.project?.id === p.id) this.view.project = next;
      if (this.sheet.project?.id === p.id) this.sheet.project = next;
      this.notify(on ? 'Now for checklists. Its templates and runs are under Checklists.' : 'No longer for checklists');
    } catch (e) { this.notify('Not changed: ' + e.message); }
    finally { this.sheet.checklistBusy = false; }
  },
  openTasks(pid){ return allPages(`/projects/${pid}/tasks?` + new URLSearchParams({filter: 'done = false', filter_timezone: TZ})); },
  // Each checklist project, with its templates and the runs still open in it.
  async loadChecklists(seq){
    templatesKept = saved.get('templates') || {};
    const ws = this.checklistProjects;
    const labels = ws.length ? (await this.loadLabels(true)).filter(isTemplateLabel).map(l => l.id) : [];
    const checklists = await Promise.all(ws.map(async p => {
      const [templates, open, finished] = await Promise.all([
        // Done, or not done with a due date: one that comes round.
        labels.length ? allPages(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: `labels in ${labels.join(', ')}`})) : [],
        this.openTasks(p.id),
        // Finished lately: one page of the newest done tasks, of which the runs.
        api(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', sort_by: 'done_at', order_by: 'desc', per_page: 50})).then(items)]);
      return {project: {id: p.id, title: p.title},
        templates: templates.filter(isTemplate).map(t => ({...t, name: templateName(t.title)})).sort((a, b) => a.name.localeCompare(b.name))
          .map(t => { keepTemplate(t); return {id: t.id, title: t.name, steps: (t.related_tasks?.subtask || []).length,
            done: t.done, labels: t.labels, due_date: t.due_date, repeat_after: t.repeat_after, repeat_mode: t.repeat_mode}; }),
        runs: open.filter(isRun).map(t => ({id: t.id, title: t.title, forText: this.forText(t),
          steps: stepsOf(t).map(s => ({id: s.id, done: s.done, title: s.title}))})),
        finished: finished.filter(t => this.isRunTask(t)).slice(0, 5).map(t => ({id: t.id, title: t.title, done_at: t.done_at, forText: this.forText(t)}))};
    }));
    if (seq !== renderSeq) return;
    saved.set('templates', templatesKept);
    this.view.checklists = checklists;
    saved.set('checklists', {checklists, at: new Date().toISOString()});
  },
  /* A template's line under Checklists, after its steps: "Next: Wed, Oct 7, 8:00 AM, then every day", or "Due now,
     since 6:00 PM today, just once". '' for one that doesn't come round. */
  scheduleText(t){
    if (!comesRound(t)) return '';
    const d = new Date(t.due_date), then = repeatWords(t) ? ', then ' + repeatWords(t) : ', just once';
    return (d <= new Date() ? 'Due now, since ' + whenText(d, 'today') : 'Next: ' + (+startOfDay(d) === +startOfDay() ? 'today, ' : '') + whenText(d)) + then;
  },
  // Whether a template that's due shows on your Today: for its assignees, or, with none, for anyone who can start it.
  templateFor(t){
    const who = t.assignees || [];
    return who.length ? who.some(u => u.id === this.user?.id) : this.canWrite(t.project_id);
  },
  forText(t){
    const who = (t.assignees || []).map(u => u.id === this.user?.id ? 'you' : u.name || u.username);
    return who.length ? 'For ' + who.join(', ') : '';
  },
  /* Don't start a run that's waiting to be set up after all. What reached Vikunja already is deleted (sendRun), now or,
     without a connection, once Pocket reaches it: until then the entry stays, so a half-made copy isn't left behind. */
  async cancelStart(id){
    let gone = false, made = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      made = !!(e.tried || e.steps.some(s => s.tried));
      if (made) await sync.save({...e, cancelled: true}); else await sync.remove(id);
    });
    this.refreshPending();
    if (gone) { this.notify('It had started already. Delete it from its ⋯ if it isn\'t needed.'); this.render(); return; }
    if (made) { await sync.lock(() => this.sendEntry(id)); this.refreshPending(); }
    this.notify('Not started');
    this.render();
  },
  // Runs being set up, waiting for a connection or under way, in a project.
  startingIn(pid){ return this.pending.filter(e => e.kind === 'run' && !e.cancelled && e.template.project_id === pid); },
  /* The open runs in checklist projects, and whether each is yours: you started it, or it's for you. Today shows those,
     and not everyone else's. `mine`: yours. */
  async loadRunIndex(){
    const ws = this.checklistProjects;
    if (!ws.length) return {index: {}, mine: []};
    try {
      const index = {}, mine = [];
      for (const list of await Promise.all(ws.map(p => this.openTasks(p.id)))) for (const t of list) if (isRun(t)) {
        index[t.id] = t.created_by?.id === this.user?.id || (t.assignees || []).some(u => u.id === this.user?.id);
        if (index[t.id]) mine.push(t);
      }
      saved.set('runs', index);
      return {index, mine};
    } catch (e) { if (e instanceof NetError) return {index: saved.get('runs') || {}, mine: []}; throw e; }
  },
  // Whether Today shows a task: in a checklist project, a run of yours, a step of one, or one assigned to you. Anything
  // else there that isn't part of a run shows as anywhere else.
  inToday(t, runs){
    if (!this.checklistIds.has(t.project_id)) return true;
    if (hasTemplateLabel(t)) return comesRound(t) && this.templateFor(t);  // a template that's due, not a run being set up
    if ((t.assignees || []).some(u => u.id === this.user?.id)) return true;
    const parent = t.related_tasks?.parenttask?.[0]?.id;
    if (t.id in runs) return runs[t.id];
    if (parent in runs) return runs[parent];
    return !isRun(t) && !isRunStepTask(t);                                 // a run, or a step of one, that isn't known
  },

  /* Make the open task a template: label it "template", then mark its steps done, so none of them is a to-do anywhere,
     and itself: done, or, with a due date, left not done to come round at that time (its repeat kept). Itself last, so
     one cut off half way isn't a template yet, and the button finishes it. */
  async makeTemplate(){
    const t = this.sheet.task;
    if (!t || this.sheet.checklistBusy) return;
    const problems = stepProblems(this.subtasks.map(s => s.title));
    if (problems.length) { this.notify('Not made a template: ' + problemText(problems)); return; }
    this.sheet.checklistBusy = true;
    try {
      await this.markTemplate(t, this.subtasks.filter(s => !s.done).map(s => s.id));
      const full = await api('/tasks/' + t.id);
      cache.set(full.id, full);
      if (this.sheet.task?.id === t.id) { this.showTask(full); this.sheet.dirty = true; }
      this.notify(comesRound(full) ? `Made a checklist template that comes round. ${this.scheduleText(full)}: it shows on Today then, and starting a run moves it on.`
        : 'Made a checklist template. Start runs from it here or under Checklists.');
    } catch (e) { this.notify('Not made a template: ' + e.message); }
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
    // A copy of something (a template duplicated on the web, say): its "copied from" link would make it a run being set up.
    for (const c of t.related_tasks?.copiedfrom || [])
      await patiently(() => api(`/tasks/${t.id}/relations/copiedfrom/${c.id}`, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
    await patiently(() => patchTask(t.id, {done: !isSet(t.due_date), ...t.title && {title: templateTitle(t.title)}}));
  },

  /* ---------- writing steps: under New template, and under a template ---------- */
  // The rows being written ('new': the New template sheet, 'add': under a template), and how they read.
  draftRows(which){ return which === 'new' ? this.sheet.newTpl?.rows || [] : this.sheet.addRows; },
  draft(which){ return draftSteps(this.draftRows(which), which === 'new' ? [] : this.subtasks.map(s => ({key: 'task:' + s.id, text: s.title})), this.stepWordsOnly); },
  // A step's words without what quick add reads in them (@people, *labels, !priority): what it's named and picked by.
  get stepWordsOnly(){ return t => this.stepParsed(t).title || t; },
  // The rows being written that will be sent, each with the chips tapped off in it.
  draftIgnores(which){ return this.draftRows(which).filter(r => r.text.trim()).map(r => r.ignore || {}); },
  addDraftRow(which, at){
    // A phone only opens its keyboard for a field focused during the tap, and the new row is there only after it: an
    // unseen field takes the focus now, so the keyboard opens, and passes it on.
    document.getElementById('focus-keeper')?.focus({preventScroll: true});
    const rows = this.draftRows(which), k = at ?? rows.length;
    rows.splice(k, 0, {key: randomId(), text: '', keep: false, from: null});
    this.$nextTick(() => document.getElementById(`${which}-step-${k}`)?.focus());
  },
  moveDraftRow(which, k, dir){
    const rows = this.draftRows(which), j = k + dir;
    if (j >= 0 && j < rows.length) [rows[k], rows[j]] = [rows[j], rows[k]];
  },
  dropDraftRow(which, k){
    const rows = this.draftRows(which);
    rows.splice(k, 1);
    if (which === 'new' && !rows.length) this.addDraftRow('new');
  },
  // A list pasted into a row: a row a line, in place of the row if it was empty.
  pasteDraft(which, e, k){
    const lines = captureLines(e.clipboardData?.getData('text') || '');
    if (lines.length < 2) return;
    e.preventDefault();
    const rows = this.draftRows(which), empty = !rows[k].text.trim();
    rows.splice(empty ? k : k + 1, empty ? 1 : 0, ...lines.map(text => ({key: randomId(), text, keep: false, from: null})));
  },
  openNewTemplate(p){
    this.openSheet('newtpl');
    const kept = taskDrafts.get('newtpl:' + p.id);                          // written before, and not made yet
    // The name is written in quick add's box ('tname'), and each step in one of its own.
    this.sheet.newTpl = {project: {id: p.id, title: p.title}, box: {...newBox(), text: kept?.name || ''},
      rows: kept?.rows?.length ? kept.rows.map(r => ({...r, focus: false})) : [{key: randomId(), text: '', keep: false, from: null}], busy: false};
    this.$nextTick(() => document.getElementById('nt-name')?.focus());
  },
  /* A template in one go: the task, its steps under it, then made a template. Cut off half way, the task stays in the
     project with the steps made so far: tapping Make again carries on with that one (nt.jobs), and Use as checklist
     template on it finishes it too. */
  async createTemplate(){
    const nt = this.sheet.newTpl, name = nt?.box.text.trim(), d = nt && this.draft('new');
    if (!name || !d.added.length || d.problem || nt.busy) return;
    const shown = templateName(this.stepParsed(name, nt.box.ignore).title);   // without @people and *labels
    nt.busy = true;
    let t = null;
    try {
      // Another name is another task, and its steps are new too.
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
      this.notify(`Made ${shown}. Start a run of it here.`);
      if (this.route.name === 'checklists') this.render(); else this.go('#/checklists');
    } catch (e) {
      nt.busy = false;
      this.notify(t ? `Not finished: ${why(e)}. Tap Make template again to finish “${shown}”.` : 'Not made: ' + why(e));
    }
  },
  // Steps added under a template: made, marked done like the rest, and any step they count from given its name.
  async addTemplateSteps(){
    const t = this.sheet.task, d = this.draft('add');
    if (!t || !d.added.length || d.problem || this.sheet.subBusy) return;
    this.sheet.subBusy = true;
    const r = {ids: [], problems: [], error: null};
    // Each row keeps how far it got, so Add after a cut-off finds a step whose reply was lost instead of adding it again.
    const rows = this.sheet.addRows.filter(x => x.text.trim()), jobs = jobsFor(rows.map(x => x.job), d.added);
    rows.forEach((x, k) => { x.job = jobs[k]; });
    try {
      for (const {key, title} of d.renames) await patiently(() => patchTask(+key.slice(5), {title}));
      Object.assign(r, await this.createLines(d.added, {parent: t, ignore: STEP_IGNORE, ignores: this.draftIgnores('add'), jobs}));
      for (const id of r.ids) await patiently(() => patchTask(id, {done: true})).catch(e => r.problems.push(e.message));
    } catch (e) { r.error = e; }
    if (this.sheet.task?.id === t.id) {
      this.sheet.subBusy = false;
      if (r.error) {
        const rows = this.sheet.addRows.filter(x => x.text.trim()), made = new Map(rows.slice(0, r.ids.length).map((x, k) => [x.key, 'task:' + r.ids[k]]));
        this.sheet.addRows = rows.slice(r.ids.length).map(x => made.has(x.from) ? {...x, from: made.get(x.from)} : x);
        const tt = this.sheet.task;
        tt.related_tasks = {...tt.related_tasks, subtask: [...this.subtasks, ...r.ids.map((id, k) => ({id, title: d.added[k], done: true}))]};
      } else this.sheet.addRows = [];
      this.sheet.dirty = true;
      try { const full = await this.readTask(t.id); if (full) { cache.set(full.id, full); if (this.sheet.task?.id === full.id) this.showTask(full); } } catch {}
    }
    const but = r.problems.length ? `, but ${r.problems.join('; ')}` : '';
    if (r.error) this.notify(`Added ${r.ids.length} of ${d.added.length}${but}. Stopped: ${why(r.error)}`);
    else if (but) this.notify(`Added ${r.ids.length}${but}`);
  },
  // A row's time chip, when there's something to show in it: as a list, for x-for.
  draftShown(d){ return d && (d.problem || d.offset !== null || d.kept || d.name) ? [d] : []; },
  // The first line of a step's notes, under it in its template.
  stepNote(st){ return htmlToText(notesOnly(st.description)).trim().split('\n')[0]; },
  // Change a template's step in place: written as a row in New template, a time in words read as T#, with its chip.
  // Its field is there only after the tap, so an unseen one takes the focus now to open the keyboard, as in addDraftRow.
  editStep(st){
    const e = this.sheet.stepEdit, k = e ? this.subtasks.findIndex(s => s.id === e.id) : -1;
    if (k >= 0 && e.id !== st.id) this.saveStepEdit(k);                       // one still open, its box no longer focused
    document.getElementById('focus-keeper')?.focus({preventScroll: true});
    this.sheet.stepEdit = {id: st.id, text: stepWords(st.title, this.subtasks.map(s => s.title)), keep: false, from: null};
  },
  /* The step being changed, read as a row after the steps before it: how it reads (draftSteps), with every step's title
     once it's saved, since a step it now counts from may get a name. Null while it's empty. */
  stepEditDraft(i){
    const e = this.sheet.stepEdit;
    if (!e?.text.trim()) return null;
    const before = this.subtasks.slice(0, i).map(s => ({key: 'task:' + s.id, text: s.title}));
    const d = draftSteps([{key: 'edit', text: e.text, keep: e.keep, from: e.from}], before, this.stepWordsOnly), info = d.info.get('edit');
    const titles = this.subtasks.map((s, k) => k === i ? info.saved : d.renames.find(r => r.key === 'task:' + s.id)?.title ?? s.title);
    return {...info, titles, problem: stepProblems(titles).filter(p => p.i === i).map(p => p.text).join('; ') || info.problem};
  },
  async saveStepEdit(i){
    const e = this.sheet.stepEdit, st = this.subtasks[i];
    if (!e || !st || st.id !== e.id) return;
    const d = this.stepEditDraft(i);
    const todo = d ? this.subtasks.map((s, k) => ({s, was: s.title, title: d.titles[k]})).filter(x => x.title !== x.was) : [];
    if (!todo.length) { this.sheet.stepEdit = null; return; }
    // Refused, or not saved: what was typed stays in the box, to put right or try again.
    if (stepProblems(d.titles).length > stepProblems(this.subtasks.map(s => s.title)).length) { this.notify('Not changed: ' + problemText(stepProblems(d.titles))); return; }
    this.sheet.stepEdit = null;
    // Read as quick add reads a step: @people assign it, *labels label it, !priority sets it. Its title without them.
    const own = todo.find(x => x.s.id === e.id), p = own && this.stepParsed(own.title, e.ignore);
    if (own) own.title = p.title;
    for (const x of todo) x.s.title = x.title;
    // A step it counts from first, given its name, then this one.
    try {
      for (const x of todo) { await this.saveTask(x.s.id, {title: x.title}); x.saved = true; this.sheet.dirty = true; }
      if (p && (p.assignees.length || p.labels.length || p.priority)) {
        // As a line of quick add is sent, on the step that's there: someone who can't see the project stays in its title.
        const job = {taskId: e.id, done: false}, t = await this.createTask(p, this.sheet.task?.project_id, {job});
        if (job.body.title !== p.title || p.priority) await this.saveTask(e.id, {title: job.body.title, ...p.priority && {priority: p.priority}});
        if (t.problems.length) this.notify('Changed, but ' + t.problems.join('; '));
        const full = await this.readTask(this.sheet.task.id).catch(() => null);
        if (full && this.sheet.task?.id === full.id) this.showTask(full);
      }
    } catch (err) {
      for (const x of todo) if (!x.saved) x.s.title = x.was;
      this.notify(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message);
      if (this.subtasks.some(s => s.id === e.id) && !this.sheet.stepEdit) this.sheet.stepEdit = {...e};
    }
  },
  // A step's notes and photos, in its own sheet. What was written in its box is saved first, and if it can't be, it stays.
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
    const t = this.sheet.task, st = this.subtasks[i];
    if (!t || !st || this.sheet.checklistBusy) return;
    const rest = this.subtasks.filter((_, k) => k !== i).map(s => s.title), problems = stepProblems(rest);
    // Said by their number on screen, before the step comes out.
    if (problems.length > stepProblems(this.subtasks.map(s => s.title)).length) { this.notify('Not removed: ' + problemText(problems.map(p => ({...p, i: p.i >= i ? p.i + 1 : p.i})))); return; }
    if (!confirm(`Remove “${parseStep(st.title).title}” from the template? Runs already started keep it.`)) return;
    this.sheet.checklistBusy = true;
    try {
      // Gone already, or a reply lost on the way back: removed all the same if Vikunja no longer has it.
      await patiently(() => api('/tasks/' + st.id, {method: 'DELETE'})).catch(async e => {
        if (e.status !== 404 && (!(e instanceof NetError) || await api('/tasks/' + st.id).then(() => true, x => x.status !== 404))) throw e;
      });
      cache.delete(st.id);
      t.related_tasks = {...t.related_tasks, subtask: this.subtasks.filter(s => s.id !== st.id)};
      this.keepTemplate(t);
      this.sheet.dirty = true;
      this.notify('Step removed');
    } catch (err) { this.notify('Not removed: ' + why(err)); }
    finally { this.sheet.checklistBusy = false; }
  },
  /* Move a template's step up or down: its order line is written with every step in the new order. Not when that would
     leave a step with a problem it didn't have, such as counting from a later one: a template already wrong that way
     can still be put right. The step is moved in the order Vikunja has when it's sent, and only the order line changes,
     so notes and moves saved elsewhere since the sheet opened stay. */
  async moveStep(i, dir){
    const t = this.sheet.task, st = this.subtasks[i];
    if (!t || !st || this.sheet.checklistBusy) return;
    // The steps in their new order, or null if this step can't go that way in them; throws for a problem it makes.
    const moved = steps => {
      const k = steps.findIndex(s => s.id === st.id), out = [...steps];
      if (k < 0 || k + dir < 0 || k + dir >= steps.length) return null;
      [out[k], out[k + dir]] = [out[k + dir], out[k]];
      const before = stepProblems(steps.map(s => s.title));
      const fresh = stepProblems(out.map(s => s.title)).filter(p => !before.some(b => b.text === p.text && b.title === p.title));
      if (fresh.length) throw new Error(problemText(fresh.map(p => ({...p, i: steps.indexOf(out[p.i])}))));   // by its number on screen
      return out;
    };
    let steps;
    try { steps = moved(this.subtasks); } catch (e) { this.notify('Not moved: ' + e.message); return; }
    if (!steps) return;
    const was = stepOrder(t.description), box = document.getElementById('step-edit-' + st.id);
    t.description = withOrder(t.description, steps.map(s => s.id));          // shown in the new order straight away
    // Its row moved takes the focus off its box: given back once it's moved, before its row looks for where the focus
    // went (its focusout), so the step stays open to move again.
    if (box && box === document.activeElement) setTimeout(() => box.isConnected && box.focus({preventScroll: true}));
    this.sheet.checklistBusy = true;
    try {
      const got = await patiently(() => this.saveTask(t.id, null, now => { const s = moved(stepsOf(now)); return s && {description: withOrder(now.description, s.map(x => x.id))}; }));
      if (this.sheet.task?.id === t.id) this.showTask(got);
      this.sheet.dirty = true;
    } catch (e) { if (this.sheet.task?.id === t.id) t.description = withOrder(t.description, was); this.notify('Not moved: ' + why(e)); }
    finally { this.sheet.checklistBusy = false; }
  },
};
