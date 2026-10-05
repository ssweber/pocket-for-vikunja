// Checklists, their projects and templates, and writing steps.
import {cache, taskDrafts, TZ} from '../util.js';
import {allPages, api, items, NetError, patchTask} from '../api.js';
import {parseFragment} from '../html.js';
import {CHECKLIST_MARK, draftSteps, hasTemplateLabel, isChecklistDesc, isRun, isTemplateLabel, parseStep, patiently, problemText, STEP_IGNORE, stepProblems, stepWords} from '../checklists.js';
import {captureLines} from '../quickadd.js';
import {ALREADY, NOT_RELATED, randomId, sync} from '../sync.js';
import {saved} from '../lists.js';
import {renderSeq} from './views.js';

// Templates as last loaded, kept for starting a run without a connection: id -> {id, title, project_id, related_tasks}.
let templatesKept = {};
const keepTemplate = t => { templatesKept[t.id] = {id: t.id, title: t.title, project_id: t.project_id, related_tasks: {subtask: (t.related_tasks?.subtask || []).map(s => ({id: s.id, title: s.title}))}}; };

export default {
  isChecklistProject(p){ return isChecklistDesc(p?.description); },
  get checklistProjects(){ return this.projects.filter(p => this.isChecklistProject(p)); },
  get checklistIds(){ return new Set(this.checklistProjects.map(p => p.id)); },
  // The lit tab: Checklists for a run as well, Projects for a project and the list of them.
  get tab(){ return ['checklists', 'run'].includes(this.route.name) ? 'checklists' : this.route.name === 'today' ? 'today' : 'projects'; },
  // What the open task is in a checklist project: a template, a run, one of a run's steps, or a task that could be made a template.
  get checklistRole(){
    const t = this.sheet.task, r = t?.related_tasks || {};
    if (!t || !this.checklistIds.has(t.project_id)) return null;
    if (hasTemplateLabel(t) && t.done) return 'template';
    if (r.parenttask?.length) return r.copiedfrom?.length ? 'step' : null;
    return r.copiedfrom?.length && !hasTemplateLabel(t) ? 'run' : 'candidate';
  },
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
        labels.length ? allPages(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: `done = true && labels in ${labels.join(', ')}`})) : [],
        this.openTasks(p.id),
        // Finished lately: one page of the newest done tasks, of which the runs.
        api(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', sort_by: 'done_at', order_by: 'desc', per_page: 50})).then(items)]);
      return {project: {id: p.id, title: p.title},
        templates: templates.filter(t => !t.related_tasks?.parenttask?.length).sort((a, b) => a.title.localeCompare(b.title))
          .map(t => { keepTemplate(t); return {id: t.id, title: t.title, steps: (t.related_tasks?.subtask || []).length}; }),
        runs: open.filter(isRun).map(t => ({id: t.id, title: t.title, forText: this.forText(t),
          steps: (t.related_tasks?.subtask || []).map(s => ({id: s.id, done: s.done, title: s.title}))})),
        finished: finished.filter(t => this.isRunTask(t)).slice(0, 5).map(t => ({id: t.id, title: t.title, done_at: t.done_at, forText: this.forText(t)}))};
    }));
    if (seq !== renderSeq) return;
    saved.set('templates', templatesKept);
    this.view.checklists = checklists;
    saved.set('checklists', {checklists, at: new Date().toISOString()});
  },
  forText(t){
    const who = (t.assignees || []).map(u => u.id === this.user?.id ? 'you' : u.name || u.username);
    return who.length ? 'For ' + who.join(', ') : '';
  },
  // Don't start a run that's waiting to be set up after all. What was set up already is deleted.
  async cancelStart(id){
    let made = null, gone = false;
    await sync.lock(async () => { const e = await sync.fresh(id); if (!e) { gone = true; return; } await sync.remove(id); if (e.runId) made = e; });
    this.refreshPending();
    if (gone) { this.notify('It had started already. Delete it from its ⋯ if it isn\'t needed.'); this.render(); return; }
    if (made) await this.deleteRun(made.runId, {quiet: true, also: made.steps.map(s => s.taskId).filter(Boolean)});
    this.notify('Not started');
    this.render();
  },
  // Runs being set up, waiting for a connection or under way, in a project.
  startingIn(pid){ return this.pending.filter(e => e.kind === 'run' && e.template.project_id === pid); },
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
    if (hasTemplateLabel(t)) return false;                                   // a template, or a run being set up
    if ((t.assignees || []).some(u => u.id === this.user?.id)) return true;
    const parent = t.related_tasks?.parenttask?.[0]?.id;
    if (t.id in runs) return runs[t.id];
    if (parent in runs) return runs[parent];
    return !isRun(t) && !(parent && t.related_tasks?.copiedfrom?.length);   // a run, or a step of one, that isn't known
  },

  /* Make the open task a template: label it "template", then mark its steps and itself done, so none of them is a
     to-do anywhere. Itself last, so one cut off half way isn't a template yet, and the button finishes it. */
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
      this.notify('Made a checklist template. Start runs from it here or under Checklists.');
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
    await patiently(() => patchTask(t.id, {done: true}));
  },

  /* ---------- writing steps: under New template, and under a template ---------- */
  // The rows being written ('new': the New template sheet, 'add': under a template), and how they read.
  draftRows(which){ return which === 'new' ? this.sheet.newTpl?.rows || [] : this.sheet.addRows; },
  draft(which){ return draftSteps(this.draftRows(which), which === 'new' ? [] : this.subtasks.map(s => ({key: 'task:' + s.id, text: s.title}))); },
  addDraftRow(which, at){
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
    this.sheet.newTpl = {project: {id: p.id, title: p.title}, name: kept?.name || '', rows: kept?.rows?.length ? kept.rows : [{key: randomId(), text: '', keep: false, from: null}], busy: false};
    this.$nextTick(() => document.getElementById('nt-name')?.focus());
  },
  /* A template in one go: the task, its steps under it, then made a template. Cut off half way, the task stays in the
     project with the steps made so far, and Make template on it finishes it. */
  async createTemplate(){
    const nt = this.sheet.newTpl, name = nt?.name.trim(), d = nt && draftSteps(nt.rows);
    if (!name || !d.added.length || d.problem || nt.busy) return;
    nt.busy = true;
    let t = null;
    try {
      const made = await this.createLines([name], {pid: nt.project.id, ignore: {due: true, repeat: true, project: true}});
      if (made.error) throw made.error;
      t = {id: made.ids[0], project_id: nt.project.id, labels: []};
      const r = await this.createLines(d.added, {parent: t, ignore: STEP_IGNORE});
      if (r.error) throw r.error;
      await this.markTemplate(t, r.ids);
      nt.made = true; taskDrafts.delete('newtpl:' + nt.project.id);
      if (this.sheet.newTpl === nt) this.closeSheet(true);
      this.notify(`Made ${name}. Start a run of it here.`);
      if (this.route.name === 'checklists') this.render(); else this.go('#/checklists');
    } catch (e) {
      nt.busy = false;
      this.notify(t ? `Not finished: ${e.message}. “${name}” is in ${nt.project.title}: open it there and tap Use as checklist template.` : 'Not made: ' + e.message);
    }
  },
  // Steps added under a template: made, marked done like the rest, and any step they count from given its name.
  async addTemplateSteps(){
    const t = this.sheet.task, d = this.draft('add');
    if (!t || !d.added.length || d.problem || this.sheet.subBusy) return;
    this.sheet.subBusy = true;
    const r = {ids: [], problems: [], error: null};
    try {
      for (const {key, title} of d.renames) await patiently(() => patchTask(+key.slice(5), {title}));
      Object.assign(r, await this.createLines(d.added, {parent: t, ignore: STEP_IGNORE}));
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
      try { const full = await api('/tasks/' + t.id); cache.set(full.id, full); if (this.sheet.task?.id === full.id) this.showTask(full); } catch {}
    }
    const but = r.problems.length ? `, but ${r.problems.join('; ')}` : '';
    if (r.error) this.notify(`Added ${r.ids.length} of ${d.added.length}${but}. Stopped: ${r.error.message}`);
    else if (but) this.notify(`Added ${r.ids.length}${but}`);
  },
  /* Move a template's step up or down. Vikunja keeps steps in the order they were linked and can't reorder them, so
     from the first step that moves, each is unlinked and linked again, in the new order. Not when that would leave a
     step counting from a later one: a template already wrong that way can still be put right. */
  // Change a template's step in place: written as in New template, a time in words read as T#.
  editStep(st){ this.sheet.stepEdit = {id: st.id, text: stepWords(st.title, this.subtasks.map(s => s.title))}; },
  // What the step being changed is saved as, read after the steps before it.
  stepEditInfo(i){
    const e = this.sheet.stepEdit;
    if (!e?.text.trim()) return null;
    const before = this.subtasks.slice(0, i).map(s => ({key: 'task:' + s.id, text: s.title}));
    const d = draftSteps([{key: 'edit', text: e.text, keep: false, from: null}], before).info.get('edit');
    const titles = this.subtasks.map((s, k) => k === i ? d.saved : s.title), problems = stepProblems(titles).filter(p => p.i === i);
    return {saved: d.saved, text: d.text, problem: problems.map(p => p.text).join('; ') || d.problem};
  },
  async saveStepEdit(i){
    const e = this.sheet.stepEdit, st = this.subtasks[i];
    if (!e || !st || st.id !== e.id) return;
    const info = this.stepEditInfo(i);
    this.sheet.stepEdit = null;
    if (!info || info.saved === st.title) return;
    const titles = this.subtasks.map((s, k) => k === i ? info.saved : s.title);
    if (stepProblems(titles).length > stepProblems(this.subtasks.map(s => s.title)).length) { this.notify('Not changed: ' + problemText(stepProblems(titles))); return; }
    const was = st.title;
    st.title = info.saved;
    try { await this.saveTask(st.id, {title: info.saved}); this.sheet.dirty = true; }
    catch (err) { st.title = was; this.notify(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message); }
  },
  // Take a step out of a template. Runs started already keep their copy of it.
  async removeStep(i){
    const t = this.sheet.task, st = this.subtasks[i];
    if (!t || !st || this.sheet.checklistBusy) return;
    const rest = this.subtasks.filter((_, k) => k !== i).map(s => s.title), problems = stepProblems(rest);
    if (problems.length > stepProblems(this.subtasks.map(s => s.title)).length) { this.notify('Not removed: ' + problemText(problems)); return; }
    if (!confirm(`Remove “${parseStep(st.title).title}” from the template? Runs already started keep it.`)) return;
    this.sheet.checklistBusy = true;
    try {
      await patiently(() => api('/tasks/' + st.id, {method: 'DELETE'}));
      cache.delete(st.id);
      t.related_tasks = {...t.related_tasks, subtask: this.subtasks.filter(s => s.id !== st.id)};
      this.sheet.dirty = true;
      this.notify('Step removed');
    } catch (err) { this.notify('Not removed: ' + err.message); }
    finally { this.sheet.checklistBusy = false; }
  },
  async moveStep(i, dir){
    const t = this.sheet.task, steps = [...this.subtasks], j = i + dir;
    if (!t || j < 0 || j >= steps.length || this.sheet.checklistBusy) return;
    const before = stepProblems(steps.map(s => s.title));
    [steps[i], steps[j]] = [steps[j], steps[i]];
    const after = stepProblems(steps.map(s => s.title));
    if (after.length > before.length) {
      const fresh = after.filter(p => !before.some(b => b.text === p.text && b.title === p.title));
      this.notify('Not moved: ' + problemText(fresh.length ? fresh : after));
      return;
    }
    t.related_tasks = {...t.related_tasks, subtask: steps};                    // shown in the new order straight away
    this.sheet.checklistBusy = true;
    let loose = null;                                                         // a step unlinked and not yet linked again
    try {
      for (const s of steps.slice(Math.min(i, j))) {
        await patiently(() => api(`/tasks/${t.id}/relations/subtask/${s.id}`, {method: 'DELETE'})).catch(e => { if (e.code !== NOT_RELATED) throw e; });
        loose = s;
        await patiently(() => this.linkSubtask(t.id, s.id)).catch(e => { if (e.code !== ALREADY.link) throw e; });
        loose = null;
      }
    } catch (e) {
      this.notify(loose ? `“${parseStep(loose.title).title}” is no longer a step: ${e.message}. Add it again.` : 'The steps weren\'t moved: ' + e.message);
    } finally {
      this.sheet.checklistBusy = false;
      try { const full = await api('/tasks/' + t.id); cache.set(full.id, full); if (this.sheet.task?.id === t.id) this.showTask(full); } catch {}
    }
  },
};
