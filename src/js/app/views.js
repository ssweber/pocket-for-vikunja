// Projects and labels, the screens and their lists, search, moving overdue tasks, and New project.
import {cache, collapse, colorOf, PRIOS, TZ} from '../util.js';
import {allPages, api, ApiError, errText, items, LOADED, NetError} from '../api.js';
import {addDays, dueInfo, isLate, isSet, repeats, startOfDay} from '../dates.js';
import {doneText, openSubtasks, pctOf, undoing} from '../progress.js';
import {CHECKLIST_MARK} from '../checklists.js';
import {currentRoute} from '../routing.js';
import {projectName} from '../quickadd.js';
import {saved, soonestFirst, todayGroups, viewKey} from '../lists.js';
import {shared} from './core.js';
import {pendingSaves, plainReminders} from './sheet.js';

export let renderSeq = 0;

export default {
  async loadProjects(){
    const list = await allPages('/projects?is_archived=false');
    this.setProjects(list.filter(p => p.id > 0 && !p.is_archived).sort((a,b) => (a.position||0) - (b.position||0) || a.title.localeCompare(b.title)));
    saved.set('projects', this.projects);
  },
  setProjects(list){ this.projects = list; this.projById = new Map(list.map(p => [p.id, p])); setTimeout(() => this.loadPerms()); },
  async loadLabels(force){
    if (this.labelsLoaded && !force) return this.labels;
    this.labels = await allPages('/labels'); this.labelsLoaded = true; return this.labels;
  },
  get tree(){
    const kids = new Map();
    for (const p of this.projects) { const k = p.parent_project_id && this.projById.has(p.parent_project_id) ? p.parent_project_id : 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
    const out = [];
    (function walk(pid, depth){ for (const p of kids.get(pid) || []) { out.push({p, depth}); walk(p.id, depth+1); } })(0, 0);
    return out;
  },
  get favorites(){ return this.projects.filter(p => p.is_favorite); },
  defaultProjectId(){
    if (this.route.name === 'project' && this.projById.has(this.route.id)) return this.route.id;
    const d = this.user?.settings?.default_project_id;
    if (d && this.projById.has(d)) return d;
    return this.projects[0]?.id;
  },
  /* Push a saved task into every list row showing it. */
  syncTask(saved){
    for (const g of this.view.groups) for (const t of g.tasks) if (t.id === saved.id) Object.assign(t, saved);
  },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
  viewWantsDone(){ return this.route.name === 'project' && !!this.route.showDone; },

  /* ---------- views ---------- */
  /* Go to a screen. Each is an entry in the history, remembering the one before (`from`), so the phone's Back goes back
     through them. An open sheet's entry is replaced, so Back from there doesn't come back to the sheet. */
  go(hash){
    if (hash === location.hash && !history.state?.sheet) { this.navigated(); return; }
    const from = location.hash || '#/today';
    if (history.state?.sheet) history.replaceState({from}, '', hash); else history.pushState({from}, '', hash);
    shared.onClosedSheet = false;
    this.navigated();
  },
  navigated(){ this.headerTucked = false; if (!this.signedIn) return; this.closeSheet(true); this.render(); },
  // Pocket's own Back: the phone's Back when the screen before is that one, so the history doesn't grow; else go there.
  back(to){
    if (history.state?.from !== to || history.state?.sheet === true) { this.go(to); return; }
    const closed = history.state?.sheet === 'closed';                     // past the closed sheet's entry too
    shared.onClosedSheet = false;
    history.go(closed ? -2 : -1);
  },
  // The page's name: the tab says Today, Projects or Checklists; a project shows its name, and its parent's, above its
  // list; a run its own, and its project's.
  get head(){
    const r = this.route;
    if (r.name === 'projects') return {kicker: '', title: 'Projects'};
    if (r.name === 'search') return {kicker: '', title: 'Search'};
    if (r.name === 'checklists') return {kicker: '', title: 'Checklists'};
    if (r.name === 'run') {
      const run = this.view.run?.run;
      return {kicker: this.projById.get(run?.project_id)?.title || '', title: run?.title || 'Run'};
    }
    if (r.name === 'project') {
      const p = this.view.project; if (!p) return {kicker: '', title: 'Project'};
      return {kicker: this.projById.get(p.parent_project_id)?.title || '', title: p.title};
    }
    return {kicker: '', title: 'Today'};
  },
  // Shown on the Today heading, so "Friday" on a task can be read against today.
  get todayDate(){ return new Date(this.groupedAt || Date.now()).toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'}); },
  get emptyText(){
    if (this.route.name === 'today') return {title: 'Nothing due this week.', body: `Today is ${this.todayDate}. Add a task below — try “Call Ana tomorrow !3”.`};
    if (this.route.name === 'search') return this.searchQ.trim()
      ? {title: `No tasks match “${this.searchQ.trim()}”.`, body: 'Searching looks at titles and notes, in open and done tasks.'}
      : {title: 'Search your tasks.', body: 'Finds open and done tasks in all your projects by words in their title or notes, or by number, like #12.'};
    if (!this.view.project) return {title: 'Project not found.', body: 'It may be archived or you lost access.'};
    return this.route.showDone ? {title: 'Nothing done here yet.', body: ''} : {title: 'All clear.', body: 'New tasks you add now land in this project.'};
  },
  rowMeta(t){
    const out = [], due = dueInfo(t.due_date);
    if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label});
    if (t.priority) out.push({key: 'prio', prio: t.priority, text: '', label: 'Priority: ' + PRIOS[t.priority].label});
    const p = (this.route.name === 'today' || this.route.name === 'search') && this.projById.get(t.project_id);
    // A step of a run on Today or in search: which run, instead of the project (the run's), so two runs' steps can be
    // told apart. (In a project's list, it's under its run already.)
    const run = (this.route.name === 'today' || this.route.name === 'search') && this.stepRun(t) && t.related_tasks.parenttask[0];
    if (run) out.push({key: 'run', icon: 'checklist', text: run.title, label: 'Step of ' + run.title});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    for (const l of (t.labels || []).slice(0,3)) out.push({key: 'l' + l.id, color: colorOf(l.hex_color), text: l.title});
    for (const u of t.assignees || []) if (u.id !== this.user?.id) out.push({key: 'u' + u.id, text: u.name || '@' + u.username, label: 'Assigned to ' + (u.name || u.username)});
    if (repeats(t)) out.push({key: 'rep', text: '↻', label: 'Repeats'});
    const subs = t.related_tasks?.subtask || [];
    if (subs.length) out.push({key: 'sub', icon: 'subtasks', cls: 'num', text: subs.filter(s => s.done).length + '/' + subs.length, label: 'Subtasks done'});
    if (t.comment_count) out.push({key: 'com', icon: 'comment', cls: 'num', text: String(t.comment_count), label: 'Comments'});
    // Photos and files still uploading count too, so a photo added with a task shows on its row straight away.
    const att = t.attachments?.length || 0, waiting = t.pending ? t.waiting : this.waitingByTask.get(t.id)?.length || 0;
    if (att + waiting) out.push({key: 'att', icon: 'clip', cls: 'num', text: String(att + waiting), label: 'Attachments' + (waiting ? `, ${waiting} waiting to upload` : '')});
    if ((t.reminders || []).some(r => new Date(r.reminder) > new Date())) out.push({key: 'rem', icon: 'bell', text: '', label: 'A reminder is still to come'});
    return out;
  },

  async render(){
    const r = currentRoute();
    if (r.name === 'add') {                      // deep link: #/add?text=Buy+milk+tomorrow
      history.replaceState(null, '', '#/today');
      await this.render();
      this.cap.text = r.text; this.$nextTick(() => this.$refs.capture.focus());
      return;
    }
    this.route = r;
    if (r.name !== 'run') this.runFrom = location.hash || '#/today';
    if (r.name !== 'run' && r.name !== 'project') this.projectFrom = location.hash || '#/today';
    const seq = ++renderSeq;
    const fresh = this.view.route !== location.hash;   // new screen: show Loading; same screen: refresh in place
    if (fresh) Object.assign(this.view, {loading: true, groups: [], project: null, savedAt: null, checklists: [], run: null});
    this.view.route = location.hash; this.view.error = ''; this.view.bootFailed = false;
    try {
      if (r.name === 'today') await this.loadToday(seq);
      else if (r.name === 'projects') { if (!this.projects.length) await this.loadProjects(); }
      else if (r.name === 'project') await this.loadProject(seq, r);
      else if (r.name === 'search') await this.loadSearch(seq);
      else if (r.name === 'checklists') await this.loadChecklists(seq);
      else if (r.name === 'run') await this.loadRun(seq, r.id);
      if (seq === renderSeq) { this.view.loading = false; this.view.savedAt = null; }   // fresh from Vikunja
    } catch (e) {
      if (seq !== renderSeq || (e instanceof ApiError && e.status === 401)) return;
      if (e instanceof NetError) {
        // Keep what's on screen, the banner saying we're offline; Today placed again for the time now (after midnight, say).
        if (!fresh && !this.view.loading) { if (r.name === 'today') this.regroupToday(); return; }
        const s = saved.get(viewKey(r));
        if (s) {
          for (const g of s.groups || []) for (const t of g.tasks) cache.set(t.id, t);
          Object.assign(this.view, {loading: false, groups: s.groups || [], project: s.project || null, checklists: s.checklists || [], run: s.run || null, savedAt: s.at});
          if (r.name === 'today') this.regroupToday();
          return;
        }
      }
      if (r.name === 'run' && e.runGone) { this.runGone(r.id); return; }
      // A project that's gone (deleted elsewhere): back to the list of them.
      if (r.name === 'project' && e instanceof ApiError && e.status === 404) { await this.loadProjects().catch(() => {}); this.go('#/projects'); this.notify('That project isn\'t there any more.'); return; }
      // A refresh that fails says so, unless it would hide a message still being read.
      if (!fresh && !this.view.loading) { if (!(this.toast.show && this.toast.until - Date.now() > 1500)) this.notify((r.name === 'search' ? 'Couldn\'t search: ' : 'Couldn\'t refresh: ') + e.message); return; }
      Object.assign(this.view, {loading: false, error: errText(e)});
    }
  },
  async loadToday(seq){
    const end = addDays(startOfDay(), 8);
    const t0 = startOfDay();
    const q = new URLSearchParams({filter: `done = false && due_date < '${end.toISOString()}'`, filter_timezone: TZ, sort_by: 'due_date', order_by: 'asc', expand: 'comment_count'});
    const qNew = new URLSearchParams({filter: `done = false && created >= '${t0.toISOString()}'`, filter_timezone: TZ, sort_by: 'created', order_by: 'desc', expand: 'comment_count'});
    // And steps you've claimed in someone else's run, still open, which may have no date yet.
    const qMine = new URLSearchParams({filter: `done = false && assignees in ${this.user?.username}`, filter_timezone: TZ, expand: 'comment_count'});
    const [all, allAdded, {index: runs, mine}, claimed] = await Promise.all([allPages('/tasks?' + q), allPages('/tasks?' + qNew), this.loadRunIndex(),
      this.checklistIds.size && this.user ? allPages('/tasks?' + qMine).catch(() => []) : []]);
    if (seq !== renderSeq) return;
    const tasks = all.filter(t => this.inToday(t, runs)), added = allAdded.filter(t => this.inToday(t, runs));
    for (const t of [...tasks, ...added, ...mine]) cache.set(t.id, t);
    const groups = todayGroups(), [, , inRuns, nodate] = groups;
    // Your runs in progress: a run has no due date, its timed steps have theirs.
    for (const t of mine) if (!isSet(t.due_date)) inRuns.tasks.push({...t});
    for (const t of claimed) if (!isSet(t.due_date) && runs[this.stepRun(t)] === false && !inRuns.tasks.some(x => x.id === t.id)) { cache.set(t.id, t); inRuns.tasks.push({...t}); }
    this.placeDated(groups, tasks.filter(t => isSet(t.due_date)).map(t => ({...t})));
    this.todayDay = +startOfDay();
    // Yours, still without a date, and not a subtask: a pasted list shows only its first line.
    for (const t of added) if (!isSet(t.due_date) && t.created_by?.id === this.user?.id && !t.related_tasks?.parenttask?.length && !(t.id in runs)) nodate.tasks.push({...t});
    this.view.groups = groups;
    saved.set('today', {groups, at: new Date().toISOString()});
  },
  async loadProject(seq, r){
    if (!this.projById.has(r.id)) await this.loadProjects();
    const p = this.projById.get(r.id);
    this.view.project = p || null;
    if (!p) { this.view.groups = []; return; }
    const q = new URLSearchParams({sort_by: 'due_date', order_by: 'asc', filter_include_nulls: 'true', filter_timezone: TZ, expand: 'comment_count'});
    q.set('filter', r.showDone ? 'done = true' : 'done = false');
    const tasks = await allPages(`/projects/${p.id}/tasks?` + q);
    if (seq !== renderSeq) return;
    for (const t of tasks) cache.set(t.id, t);
    const list = r.showDone ? tasks.sort((a,b) => new Date(b.done_at) - new Date(a.done_at)) : soonestFirst(tasks);
    this.view.groups = [{key: r.showDone ? 'done' : 'open', cls: '', title: r.showDone ? 'Done' : 'Open', tasks: list.map(t => ({...t}))}];
    saved.set(viewKey(r), {groups: this.view.groups, project: p, at: new Date().toISOString()});
  },
  /* Load a newer Pocket if the server has one, when nothing would be lost by reloading; otherwise the next refresh or
     return to Pocket tries again. It only asks whether the page changed since this copy was loaded, which the server
     answers in a few bytes, and runs alongside the list refresh, not before it. */
  async updateIfNew(){
    if (!LOADED || !this.signedIn || this.screen !== 'app') return;
    let res;
    try { res = await fetch(new URL('.', location.href), {cache: 'no-store', headers: {'If-Modified-Since': LOADED.toUTCString()}}); }
    catch { return; }                                                          // offline: no news
    if (res.status !== 200) return;
    const busy = this.sheet.open || this.cap.text.trim() || this.capPhotos.length || this.cap.busy || this.searchQ || this.movingOverdue || this.starting
      || this.pending.length || pendingSaves;
    if (!busy) location.reload();
  },
  async refresh(){
    this.updateIfNew();
    this.refreshing = true;
    this.people = null; this.access = {}; this.userKnown = {}; this.labelsLoaded = false;   // sharing and labels may have changed too
    try { await this.loadProjects(); await this.render(); } catch (e) { this.notify(e.message); } finally { this.refreshing = false; }
  },

  // `extra` is saved along with it, and `undoExtra` with the Undo: progress uses these to mark a task done at 100%.
  async toggleDone(t, rowEl, extra = {}, undoExtra = {}){
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl);
    const was = t.done, subs = this.isRunTask(t) || extra.quiet ? [] : openSubtasks(t);   // a run's steps are ticked on its screen, with who did each
    // A repeating task moves on its dates, and its reminders at a set time: Undo puts them back.
    const back = {due_date: t.due_date};
    for (const k of ['start_date', 'end_date']) if (isSet(t[k])) back[k] = t[k];
    if ((t.reminders || []).some(r => !r.relative_to)) back.reminders = plainReminders(t);
    t.done = !was;
    try {
      const {quiet, ...patch} = extra;
      const saved = await this.saveTask(t.id, {done: !was, ...patch});
      Object.assign(t, saved);
      if (!was && !saved.done) {                 // repeating task rolled forward: Undo puts its date back
        const d = dueInfo(saved.due_date);
        this.notify(d ? 'Repeats · next ' + d.label : 'Done — repeats', {label: 'Undo', fn: async () => {
          try {
            if (!await this.unchanged(t)) { this.notify(`Not undone: “${t.title}” was changed since.`); return; }
            Object.assign(t, await this.saveTask(t.id, {...back, ...undoExtra}));
          } catch (e) { this.notify('Not undone: ' + e.message); }
          this.render();
        }});
        this.render(); return;
      }
      // Its open subtasks are done with it, and Undo opens them again too.
      const closed = was ? [] : await this.closeSubtasks(subs);
      if (!was) this.notify(doneText(closed.length, subs.length, t.title), {label: 'Undo', done: true, says: closed.length < subs.length, fn: async () => { await this.toggleDone(t, null, {...undoExtra, quiet: true}); await this.reopen(closed); this.render(); }});
      else if (!extra.quiet && !undoing(extra)) this.notify('Marked not done', {label: 'Undo', fn: async () => { await this.toggleDone(t, null, {quiet: true}); this.render(); }});
      this.afterTick(t, rowEl, was, [t.id, ...closed]);
    } catch (e) {
      t.done = was;
      this.notify(e instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + e.message);
    }
  },

  /* A run's step ticked in a list or a sheet: as on the run's screen, with a ✅ for who did it, through the outbox, so it
     waits without a connection. */
  async tickRunStep(t, run, rowEl){
    const was = t.done;
    t.done = !was;
    navigator.vibrate?.(10);
    const r = await this.act({op: was ? 'undone' : 'done', task: t.id, run});
    if (r.status === 'error') { if (!r.error.saved) t.done = was; return; }
    if (!was) this.notify(r.status === 'offline' ? `Done: ${t.title}. It's sent once Pocket reaches Vikunja.` : doneText(0, 0, t.title),
      {label: 'Undo', done: true, says: r.status === 'offline', fn: async () => { await this.act({op: 'undone', task: t.id, run}); t.done = false; this.render(); }});
    this.afterTick(t, rowEl, was);
  },
  /* After a tick in a list, once it has registered: the row slides away if the list doesn't show tasks done (or not
     done) now, with the subtasks ticked with it. In search, which shows both, it moves between Open and Done. */
  afterTick(t, rowEl, was, ids = [t.id]){
    if (!rowEl) return;
    setTimeout(async () => {
      if (this.route.name === 'search') {
        const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')), to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
        if (!from || !to || !from.tasks.some(x => x.id === t.id)) return;
        await collapse(rowEl);
        for (const id of ids) {
          const i = from.tasks.findIndex(x => x.id === id);
          if (i >= 0) { const [x] = from.tasks.splice(i, 1); x.done = t.done; to.tasks.unshift(x); }
        }
        return;
      }
      if (t.done === this.viewWantsDone()) return;
      await collapse(rowEl);
      if (t.done !== this.viewWantsDone()) ids.forEach(id => this.removeRow(id));
    }, was ? 0 : 700);
  },
  // Mark these subtasks of a task just done, done too, one by one. Returns the ids marked; stops at the first that fails.
  async closeSubtasks(subs){
    const closed = [];
    for (const s of subs) { try { await this.saveTask(s.id, {done: true}); closed.push(s.id); } catch { break; } }
    return closed;
  },
  // Mark these subtasks not done again (an Undo), saying if any couldn't be.
  async reopen(ids){
    let failed = 0;
    for (const id of ids) await this.saveTask(id, {done: false}).catch(() => failed++);
    if (failed) this.notify(`Not all undone: ${failed} subtask${failed === 1 ? '' : 's'} couldn't be marked not done.`);
  },
  /* The sheet's tick, or its progress taken to 100%: done, and its open subtasks with it, as in the list. */
  async sheetDone(patch = null){
    const t = this.sheet.task;
    if (!t) return;
    if (this.checklistRole === 'step' && this.parentTask) { await this.tickRunStep(t, this.parentTask.id, null); this.sheet.dirty = true; return; }
    if (!patch && t.done) return this.save({done: false});                  // the tick, on a done task: not done after all
    const subs = this.isRunTask(t) ? [] : openSubtasks(t), pctWas = pctOf(t);
    await this.save(patch || {done: true});
    if (!subs.length || !cache.get(t.id)?.done) return;                     // not saved, or it repeats
    const closed = await this.closeSubtasks(subs);
    // The parent's save brought Vikunja's copy of its subtasks, still open then: those are the ones the sheet shows.
    for (const s of t.related_tasks?.subtask || []) if (closed.includes(s.id)) s.done = true;
    this.sheet.dirty = true;
    this.notify(doneText(closed.length, subs.length, t.title), {label: 'Undo', done: true, says: closed.length < subs.length, fn: async () => {
      await this.saveTask(t.id, {done: false, percent_done: pctWas / 100}).catch(e => this.notify('Not undone: ' + e.message));
      await this.reopen(closed);
      const back = await api('/tasks/' + t.id).catch(() => null);
      if (back && this.sheet.task?.id === t.id) { cache.set(back.id, back); this.showTask(back); }
      this.render();
    }});
  },

  /* ---------- search ---------- */
  // The magnifier. The box is focused here, during the tap, since that's the only way a phone opens its keyboard for it.
  openSearch(){
    this.$refs.header.classList.add('searching');
    this.$refs.searchIn.focus();
    if (this.route.name !== 'search') { this.searchFrom = location.hash || '#/today'; this.searchQ = ''; }
    this.go('#/search');
  },
  closeSearch(){
    this.searchQ = '';
    this.back(this.searchFrom && this.searchFrom !== '#/search' ? this.searchFrom : '#/today');
  },
  // Vikunja's search: words in the title or notes, or a task's number. Open tasks soonest first, then the 50 most
  // recently done.
  async loadSearch(seq){
    const s = this.searchQ.trim();
    if (!s) { this.view.groups = []; return; }
    const open = new URLSearchParams({q: s, filter: 'done = false', filter_timezone: TZ, expand: 'comment_count'});
    const done = new URLSearchParams({q: s, filter: 'done = true', filter_timezone: TZ, sort_by: 'done_at', order_by: 'desc', per_page: 50, expand: 'comment_count'});
    const [opened, finished = []] = await Promise.all([allPages('/tasks?' + open), api('/tasks?' + done).then(items)]);
    if (seq !== renderSeq) return;
    for (const t of [...opened, ...finished]) cache.set(t.id, t);
    this.view.groups = [
      {key: 'open', cls: '', title: 'Open', tasks: soonestFirst(opened).map(t => ({...t}))},
      {key: 'done', cls: '', title: finished.length >= 50 ? 'Done · the 50 most recent' : 'Done', tasks: finished.map(t => ({...t}))},
    ];
  },

  /* ---------- overdue ---------- */
  // "Move all to today": each overdue task to today, at the time of day it had. Undo puts every date back.
  async moveOverdueToToday(){
    const tasks = this.view.groups.find(g => g.key === 'overdue')?.tasks || [];
    if (!tasks.length || this.movingOverdue) return;
    this.movingOverdue = true;
    const now = new Date();
    // Each at the time of day it had, or, if that time's gone today, the next whole hour (in the day's last hour, 11:59
    // PM), so it isn't overdue again.
    const next = new Date(now); next.setHours(now.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) next.setTime(new Date(now).setHours(23, 59, 0, 0));
    const moves = tasks.map(t => {
      const d = new Date(t.due_date);
      d.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
      return {t, was: t.due_date, due: (isLate(d.toISOString(), now, this.dueTime) ? next : d).toISOString()};
    });
    const moved = await this.saveEach(moves.map(m => [m.t, {due_date: m.due}]));
    this.movingOverdue = false;
    const left = moves.length - moved.length, n = moved.length;
    const undo = {label: 'Undo', fn: async () => {
      const still = [];                                                       // not changed since, elsewhere
      for (const m of moves.filter(m => moved.includes(m.t))) if (await this.unchanged(m.t).catch(() => false)) still.push(m);
      const back = await this.saveEach(still.map(m => [m.t, {due_date: m.was}]));
      const k = n - back.length;
      if (k) this.notify(`${k === 1 ? '1 task' : k + ' tasks'} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still due today.`);
      this.render();
    }};
    if (!n) return this.notify(this.offline ? 'Offline — not moved' : 'Not moved: Vikunja didn\'t save the changes');
    this.notify(`Moved ${n === 1 ? '1 task' : n + ' tasks'} to today` + (left ? `. ${left === 1 ? '1 wasn\'t' : left + ' weren\'t'} saved and ${left === 1 ? 'is' : 'are'} still overdue.` : ''), undo);
    this.render();
  },
  // Whether a task is still as Pocket last saved it, so an Undo doesn't write over a change made since, elsewhere.
  async unchanged(t){ const now = await api('/tasks/' + t.id); return !t.updated || now.updated === t.updated; },
  // Saves [task, patch] pairs one after another; resolves to the tasks that saved.
  async saveEach(pairs){
    const results = await Promise.allSettled(pairs.map(([t, patch]) => this.saveTask(t.id, patch)));
    return pairs.filter((p, i) => results[i].status === 'fulfilled').map(([t]) => t);
  },

  /* ---------- new project ---------- */
  openNewProject(){
    this.openSheet('newproj');
    this.sheet.newProj = {name: '', parent: '', checklists: false, busy: false};
    this.$nextTick(() => document.getElementById('np-name')?.focus());
  },
  // A project made from the Projects tab, inside another if picked, and for checklists if asked; then opened.
  async makeProject(){
    const np = this.sheet.newProj, name = np?.name.trim();
    if (!name || np.busy) return;
    np.busy = true;
    try {
      const body = {title: name, ...(np.parent ? {parent_project_id: +np.parent} : {}), ...(np.checklists ? {description: `<p>${CHECKLIST_MARK}</p>`} : {})};
      const p = await api('/projects', {method: 'POST', body});
      this.setProjects([...this.projects, p]);
      saved.set('projects', this.projects);
      if (this.sheet.newProj === np) this.closeSheet(true);
      this.go('#/project/' + p.id);
      this.notify(np.checklists ? `Made ${p.title}. Its templates and runs are under Checklists.` : `Made ${p.title}`);
    } catch (e) {
      np.busy = false;
      this.notify(e instanceof NetError ? 'Offline. A project can be made once you\'re back online.' : 'Not made: ' + e.message);
    }
  },
  async createProject(name){
    if (this.creatingProject) return;
    this.creatingProject = true;
    try {
      const p = await api('/projects', {method: 'POST', body: {title: projectName(name)}});
      this.setProjects([...this.projects, p]);
      saved.set('projects', this.projects);
    } catch (e) {
      this.notify(e instanceof NetError ? 'Offline — you can create the project once you\'re back online' : 'Project not created: ' + e.message);
    } finally { this.creatingProject = false; }
  },
};
