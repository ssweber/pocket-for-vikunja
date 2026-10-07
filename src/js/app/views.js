// Projects and labels, the screens and their lists, search, moving overdue tasks, and New project.
import {cache, colorOf, PRIOS, TZ} from '../util.js';
import {allPages, api, ApiError, errText, items, LOADED, NetError} from '../api.js';
import {addDays, dueInfo, isSet, repeats, startOfDay} from '../dates.js';
import {CHECKLIST_MARK, comesRound, hasTemplateLabel, stepsOf, templateName} from '../checklists.js';
import {currentRoute} from '../routing.js';
import {projectName} from '../quickadd.js';
import {saved, soonestFirst, todayGroups, viewKey} from '../lists.js';
import {shared} from './core.js';
import {pendingSaves} from './sheet.js';

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
  // A row's title: a template's without its "TEMPLATE: ".
  rowTitle(t){ return hasTemplateLabel(t) ? templateName(t.title) : t.title; },
  // What's under a row's title. A subtask in its parent's sheet (g.sheet) has its due date only, as yet.
  rowMeta(t, g){
    const out = [], due = dueInfo(t.due_date);
    if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label});
    if (g?.sheet) return out;
    if (t.priority) out.push({key: 'prio', prio: t.priority, text: '', label: 'Priority: ' + PRIOS[t.priority].label});
    /* A template that comes round: what tapping it does (starting it moves it on only once it's due today), its project,
       so two projects' "Opening up" can be told apart, and who it's for, instead of its label and steps. */
    if (comesRound(t) && this.checklistIds.has(t.project_id)) {
      out.push({key: 'tpl', text: !this.canWrite(t.project_id) ? 'Checklist' : this.tickOf(t) ? 'Checklist: tap to start' : 'Checklist, for then'});
      const tp = this.projById.get(t.project_id);
      if (tp && this.route.name !== 'project') out.push({key: 'p', color: colorOf(tp.hex_color), text: tp.title});
      if ((t.assignees || []).length) out.push({key: 'for', text: this.forText(t)});
      return out;
    }
    const p = (this.route.name === 'today' || this.route.name === 'search') && this.projById.get(t.project_id);
    // A step of a run on Today or in search: which run, instead of the project (the run's), so two runs' steps can be
    // told apart. (In a project's list, it's under its run already.)
    const run = (this.route.name === 'today' || this.route.name === 'search') && this.stepRun(t) && t.related_tasks.parenttask[0];
    if (run) out.push({key: 'run', icon: 'checklist', text: run.title, label: 'Step of ' + run.title});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    for (const l of (t.labels || []).slice(0,3)) out.push({key: 'l' + l.id, color: colorOf(l.hex_color), text: l.title});
    // A run: who it's for, as its screen says ("For you and Jo"). Any other task: who else it's assigned to.
    if (this.isRunTask(t)) { if ((t.assignees || []).length) out.push({key: 'for', text: this.forText(t)}); }
    else for (const u of t.assignees || []) if (u.id !== this.user?.id) out.push({key: 'u' + u.id, text: u.name || '@' + u.username, label: 'Assigned to ' + (u.name || u.username)});
    if (repeats(t)) out.push({key: 'rep', text: '↻', label: 'Repeats'});
    const subs = t.related_tasks?.subtask || [];
    // A run's steps done, ticks waiting to be sent too, and the next one.
    if (subs.length && this.isRunTask(t)) {
      const c = this.runCount({steps: stepsOf(t)});
      out.push({key: 'sub', icon: 'subtasks', cls: 'num', text: c.done + '/' + c.total, label: 'Steps done'});
      if (c.next && !t.done) out.push({key: 'next', text: 'Next: ' + c.next});
    } else if (subs.length) out.push({key: 'sub', icon: 'subtasks', cls: 'num', text: subs.filter(s => s.done).length + '/' + subs.length, label: 'Subtasks done'});
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
          const groups = (s.groups || []).map(g => ({...g, tasks: g.tasks.map(t => { cache.set(t.id, t); return this.keep(t); })}));
          const checklists = (s.checklists || []).map(cl => ({...cl, runs: (cl.runs || []).map(t => this.keep(t))}));
          Object.assign(this.view, {loading: false, groups, project: s.project || null, checklists, run: s.run || null, savedAt: s.at});
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
    for (const t of mine) if (!isSet(t.due_date)) inRuns.tasks.push(this.keep(t));
    for (const t of claimed) if (!isSet(t.due_date) && runs[this.stepRun(t)] === false && !inRuns.tasks.some(x => x.id === t.id)) { cache.set(t.id, t); inRuns.tasks.push(this.keep(t)); }
    this.placeDated(groups, tasks.filter(t => isSet(t.due_date)).map(t => this.keep(t)));
    this.todayDay = +startOfDay();
    // Yours, still without a date, and not a subtask: a pasted list shows only its first line.
    for (const t of added) if (!isSet(t.due_date) && t.created_by?.id === this.user?.id && !t.related_tasks?.parenttask?.length && !(t.id in runs)) nodate.tasks.push(this.keep(t));
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
    this.view.groups = [{key: r.showDone ? 'done' : 'open', cls: '', title: r.showDone ? 'Done' : 'Open', tasks: list.map(t => this.keep(t))}];
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
    // Your settings and the server's (reminder emails, say), changed in Vikunja since Pocket opened.
    api('/user').then(u => { if (u?.id === this.user?.id) { this.user = u; saved.set('user', u); } }, () => {});
    api('/info', {auth: false}).then(i => { if (i) { this.info = i; saved.set('info', i); } }, () => {});
    try { await this.loadProjects(); await this.render(); } catch (e) { this.notify(e.message); } finally { this.refreshing = false; }
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
      {key: 'open', cls: '', title: 'Open', tasks: soonestFirst(opened).map(t => this.keep(t))},
      {key: 'done', cls: '', title: finished.length >= 50 ? 'Done · the 50 most recent' : 'Done', tasks: finished.map(t => this.keep(t))},
    ];
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
      // For checklists: on Checklists, where Getting started says what's next.
      if (np.checklists) { this.perms[p.id] = 2; saved.set('perms', this.perms); }
      this.go(np.checklists ? '#/checklists' : '#/project/' + p.id);
      this.notify(np.checklists ? `Made ${p.title}, for checklists.` : `Made ${p.title}`);
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
