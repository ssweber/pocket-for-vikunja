// Projects and labels, the screens and their lists, search, moving overdue tasks, and New project.
import {cache, collapseRows, colorOf, PRIOS, raw, store, TZ} from '../util.js';
import {allPages, api, ApiError, errText, LOADED, NetError, partOf, why} from '../api.js';
import {addDays, dueInfo, isSet, repeats, shortDue, startOfDay} from '../dates.js';
import {CHECKLIST_MARK, comesRound, hasTemplateLabel, templateName} from '../checklists.js';
import {currentRoute} from '../routing.js';
import {projectName} from '../quickadd.js';
import {batchMs, DONE_PART, doneParentIds, drawnOf, FIRST_ROWS, FOUND_PART, keptGroups, nextBatch, OWN_META, parentIds, saved, soonestFirst, todayGroups, viewKey} from '../lists.js';
import {cardGroup, countdown, openSubs, todayItems} from '../cards.js';
import {headText, moreDone} from '../messages.js';
import {listViewOf} from '../order.js';
import {haptic} from '../haptics.js';
import {tickFeel} from '../progress.js';
import {shared} from './core.js';
import {pendingSaves} from './sheet.js';

export let renderSeq = 0;
let behindTimer, preloadTimer, preloading = false, drawSeq = 0, nearEnd = null, searched = '';
const PRELOAD_AGE = 60e3;                        // a copy kept younger than this isn't loaded again in the background
// The projects whose Done section was left open, kept on the phone: project id -> true.
const doneOpen = {
  all(){ try { return JSON.parse(store.get('done.open')) || {}; } catch { return {}; } },
  set(id, open){ const a = this.all(); if (open) a[id] = true; else delete a[id]; store.set('done.open', JSON.stringify(a)); },
};
/* How many a list of done tasks shown a part at a time has in all, from a part of it read (doneTasks, foundDone): what
   Vikunja counts, less those it leaves out (`skip`, so far: templates, their steps, a run's); `was` if Vikunja didn't say. */
const counted = (part, skip, was) => part.total == null ? was : Math.max(0, part.total - skip);

export default {
  async loadProjects(){
    const list = await allPages('/projects?is_archived=false');
    this.setProjects(list.filter(p => p.id > 0 && !p.is_archived).sort((a,b) => (a.position||0) - (b.position||0) || a.title.localeCompare(b.title)));
    saved.set('projects', this.projects);
  },
  // Which are for checklists is worked out here, once, as every row asks it (isRunTask): each project's description is
  // read as HTML for it. Every change to the projects comes through here, with new objects.
  setProjects(list){
    this.projects = list; this.projById = new Map(list.map(p => [p.id, p]));
    this.checklistProjects = list.filter(p => this.isChecklistProject(p)); this.checklistIds = new Set(this.checklistProjects.map(p => p.id));
    setTimeout(() => this.loadPerms());
  },
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
  // Lists with a task's open and done copies both on screen, where a tick moves it between them: search, and a project
  // with its Done section.
  get bothWays(){ return ['search', 'project'].includes(this.route.name); },

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
  navigated(){ this.headerTucked = false; this.cursor = null; this.resetCards(); this.foldLines(); if (!this.signedIn) return; this.closeSheet(true); this.render(); },
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
    return {title: 'All clear.', body: 'New tasks you add now land in this project.'};
  },
  // A row's title: a template's without its "TEMPLATE: ".
  rowTitle(t){ return hasTemplateLabel(t) ? templateName(t.title) : t.title; },
  // A row's tick: a step on a run's screen through the outbox (tickStep), a subtask in its sheet, the sheet's own task
  // (sheetDone), or a task (a card's step too), which then becomes the one quick add's box adds subtasks to
  // (aimAfterTick). On a row marked done or not done, waiting for the batch to clear, it takes that back (unmark,
  // leaving.js). The tap is felt (tickFeel): firmer marking it done, as a full swipe is; a step's as tickStep has it.
  tickRow(t, g, row){
    if (g.run) return this.tickStep(t, t.done ? 'undone' : 'done');
    haptic(tickFeel(t.done));
    if (g.own) return this.sheetDone();
    if (g.card) this.pinCard(g.card);                    // the step after it comes in once it has gone (app/cards.js)
    if (this.unmark(t.id)) { if (!g.sheet) this.aimAfterTick(t); return; }
    if (g.sheet) return this.toggleSubtask(t);
    this.toggleDone(t, row); this.aimAfterTick(t);
  },
  /* A row on one line (g.line: Today, and a card's rows there; motion-and-rows-plan, section 9): at its right, its
     priority's bars, small, as on a card's heading (one-concept-plan, part 4), when it's due, short (shortDue; a run's
     step's countdown, "in 18m", "12m late"; nothing for today with no time under the Today heading, g.key), red when
     late, and its project's colour dot. Labels and counts are off Today (rowMeta's `extra`), and all of what's under its
     title elsewhere (rowMeta: when, in words, priority, project or run, the task it's under) is said to a screen reader
     instead (`said`). Worked out once per row (task-row.html). */
  rowWhen(t, g){
    const meta = this.rowMeta(t, g), left = meta.find(m => m.key === 'due')?.countdown, p = this.projById.get(t.project_id);
    const due = left ? {text: left.text, cls: left.late ? 'overdue' : 'today'} : shortDue(t.due_date, new Date(this.rowNow()), {underToday: g?.key === 'today'});
    const said = meta.filter(m => !m.extra).map(m => m.key === 'due' ? m.label || (m.cls.includes('overdue') ? 'Late: ' : 'Due ') + m.text : m.label || m.text).filter(Boolean);
    return {prio: t.priority || 0, due, color: p ? colorOf(p.hex_color) : null, said: said.join(', ')};
  },
  // Now, for a row's countdown and when it's due: on Today, its minute (groupedAt), which redraws it once a minute.
  rowNow(){ return this.route.name === 'today' && this.groupedAt || Date.now(); },
  /* What's under a row's title. A subtask in its parent's sheet (g.sheet) has its due date only, as yet. The sheet's own
     row (g.own) only when it's due and how soon (OWN_META): its project, run or parent are in the path over it, and its
     labels and counts in the sheet under it. A run's own row atop its screen (g.top), nothing: who it's for is its slot. A step on a run's screen (g.run): Inserted or Repeated, its comments, and,
     not done, its countdown or when it's due. Labels and counts are `extra`: a row on one line leaves them out, and
     doesn't say them (rowWhen). */
  rowMeta(t, g){
    if (g?.top) return [];
    if (g?.own) return this.rowMeta(t, {depth: {}}).filter(m => OWN_META.includes(m.key));
    if (g?.run) return [t.added && {key: 'added', cls: 'added', text: t.added},
      t.notes.length && {key: 'notes', cls: 'note-mark num', icon: 'comment', text: String(t.notes.length), label: t.notes.length === 1 ? 'A comment' : t.notes.length + ' comments'},
      t.dueText && !t.done && {key: 'due', cls: 'due num' + (t.late ? ' overdue' : ''), text: t.dueText}].filter(Boolean);
    const out = [], due = dueInfo(t.due_date), card = g?.card;
    // A done task over its open subtasks: why it's on the open list.
    if (!g?.sheet && t.done && g?.heads?.includes(t.id)) out.push({key: 'head', text: headText(g.tasks.filter(x => !x.done && parentIds(x).includes(t.id)).length)});
    // A run's step not done yet, due within a day: its countdown, to the minute (on Today, its minute redraws it: rowNow).
    const left = due && !t.done && this.stepRun(t) && countdown(+new Date(t.due_date), this.rowNow());
    if (left) out.push({key: 'due', cls: 'due num ' + (left.late ? 'overdue' : 'today'), text: left.text, label: left.late ? 'Late: ' + left.text : 'Due ' + left.text, countdown: left});
    else if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label});
    if (g?.sheet) return out;
    if (t.priority) out.push({key: 'prio', prio: t.priority, text: '', label: 'Priority: ' + PRIOS[t.priority].label});
    /* A template that comes round: what tapping it does (starting it moves it on only once it's due today), its project,
       so two projects' "Opening up" can be told apart, instead of its label and steps. Who it's for is its slot's
       pictures, as a run's are (forSlot). */
    if (comesRound(t) && this.checklistIds.has(t.project_id)) {
      out.push({key: 'tpl', text: !this.canWrite(t.project_id) ? 'Checklist' : this.tickOf(t) ? 'Checklist: tap to start' : 'Checklist, for then'});
      const tp = this.projById.get(t.project_id);
      if (tp && this.route.name !== 'project') out.push({key: 'p', color: colorOf(tp.hex_color), text: tp.title});
      return out;
    }
    // (A card's step has its project and its run or task on the card, over it.)
    const p = !card && (this.route.name === 'today' || this.route.name === 'search') && this.projById.get(t.project_id);
    // A step of a run on Today or in search: which run, instead of the project (the run's), so two runs' steps can be
    // told apart. (In a project's list, it's under its run already.)
    const run = !card && (this.route.name === 'today' || this.route.name === 'search') && this.stepRun(t) && t.related_tasks.parenttask[0];
    if (run) out.push({key: 'run', icon: 'checklist', text: run.title, label: 'Step of ' + run.title});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    // A subtask with its parent not above it here (not due this week, say, or done): the parent's name, to know it by.
    const up = !run && p && !g?.depth?.[t.id] && t.related_tasks?.parenttask?.[0];
    if (up) out.push({key: 'up', text: '↳ ' + up.title, label: 'Subtask of ' + up.title});
    for (const l of (t.labels || []).slice(0,3)) out.push({key: 'l' + l.id, color: colorOf(l.hex_color), text: l.title, extra: true});
    if (repeats(t)) out.push({key: 'rep', text: '↻', label: 'Repeats'});
    // Its subtasks done (a done task's): one with a ring (a run, an open parent) has its count in it (rowRing).
    const subs = t.related_tasks?.subtask || [];
    if (subs.length && !this.isRunTask(t) && !this.rowRing(t, g || {})) out.push({key: 'sub', icon: 'subtasks', cls: 'num', text: subs.filter(s => s.done).length + '/' + subs.length, label: 'Subtasks done', extra: true});
    if (t.comment_count) out.push({key: 'com', icon: 'comment', cls: 'num', text: String(t.comment_count), label: 'Comments', extra: true});
    // Photos and files still uploading count too, so a photo added with a task shows on its row straight away. (Said on
    // one line while some wait: that's not a count, it's work still to send.)
    const att = t.attachments?.length || 0, waiting = t.pending ? t.waiting : this.waitingByTask.get(t.id)?.length || 0;
    if (att + waiting) out.push({key: 'att', icon: 'clip', cls: 'num', text: String(att + waiting), label: 'Attachments' + (waiting ? `, ${waiting} waiting to upload` : ''), extra: !waiting});
    // (Not a run's step's: its reminder is Pocket's own, for the countdown it shows.)
    if (!this.stepRun(t) && (t.reminders || []).some(r => new Date(r.reminder) > new Date())) out.push({key: 'rem', icon: 'bell', text: '', label: 'A reminder is still to come'});
    return out;
  },

  // `kept`: only the copy kept of a new screen, if it has one, and nothing loaded: boot, opening before Vikunja has said
  // who's signed in. Resolves to whether it showed one.
  async render({kept = false} = {}){
    let r = currentRoute();
    // A link to a project's done tasks, from before they were a section of its list: the list, with the section open.
    if (r.name === 'project' && r.showDone) { doneOpen.set(r.id, true); history.replaceState(history.state, '', '#/project/' + r.id); r = currentRoute(); }
    if (r.name === 'add') {                      // deep link: #/add?text=Buy+milk+tomorrow
      if (kept) return false;
      history.replaceState(null, '', '#/today');
      await this.render();
      this.cap.text = r.text; this.$nextTick(() => this.$refs.capture.focus());
      return;
    }
    this.route = r;
    if (r.name !== 'run') this.runFrom = location.hash || '#/today';
    if (r.name !== 'run' && r.name !== 'project') this.projectFrom = location.hash || '#/today';
    const seq = ++renderSeq;
    /* A new screen opens at once with the copy kept of it, loaded afresh behind it and changed in place (settle); with
       none, it says Loading. The same screen is refreshed in place. Either way, a load that takes over a second says so,
       with a thin line under the header (view.behind), not over what's on screen. */
    const fresh = this.view.route !== location.hash;
    if (fresh) {
      const s = r.name === 'projects' ? this.projects.length && {} : this.savedView(r);
      if (kept && !s) return false;
      this.drawFrom(0);                                  // its first rows at once, the rest a batch at a time
      Object.assign(this.view, {loading: !s, groups: [], cards: {}, project: null, savedAt: null, checklists: [], run: null, listView: null});
      if (s) this.showSaved(r, s);
      if (scrollY) scrollTo(0, 0);                       // a new screen starts at its top
      Object.assign(this.hint, {at: null, pick: true});  // the hint, if it's still to show, on the new screen's first row (pickHint)
    }
    this.view.route = location.hash; this.view.error = ''; this.view.bootFailed = false;
    if (kept) return fresh;
    this.view.updating = !this.view.loading; this.view.behind = false;
    clearTimeout(behindTimer);
    behindTimer = setTimeout(() => { if (seq === renderSeq && this.view.updating) this.view.behind = true; }, 1000);
    try {
      if (r.name === 'today') await this.loadToday(seq);
      else if (r.name === 'projects') { if (!this.projects.length) await this.loadProjects(); }
      else if (r.name === 'project') await this.loadProject(seq, r);
      else if (r.name === 'search') await this.loadSearch(seq);
      else if (r.name === 'checklists') await this.loadChecklists(seq);
      else if (r.name === 'run') await this.loadRun(seq, r.id);
      if (seq === renderSeq) { this.view.loading = false; this.view.savedAt = null; this.schedulePreload(); }   // fresh from Vikunja
    } catch (e) {
      if (seq !== renderSeq || (e instanceof ApiError && e.status === 401)) return;
      if (e instanceof NetError) {
        // Keep what's on screen (the copy kept of it, say), the banner saying we're offline; Today placed again for the
        // time now (after midnight, say).
        if (!this.view.loading) { if (r.name === 'today') this.regroupToday(); return; }
        const s = saved.get(viewKey(r));                 // a run's, which isn't shown before it's loaded
        if (s) { this.showSaved(r, s); return; }
      }
      if (r.name === 'run' && e.runGone) { this.runGone(r.id); return; }
      // A project that's gone (deleted elsewhere): back to the list of them.
      if (r.name === 'project' && e instanceof ApiError && e.status === 404) { await this.loadProjects().catch(() => {}); this.go('#/projects'); this.notify('That project isn\'t there any more.'); return; }
      // A refresh that fails says so, unless it would hide a message still being read; what's on screen stays.
      if (!this.view.loading) { if (!(this.toast.show && this.toast.until - Date.now() > 1500)) this.notify((r.name === 'search' ? 'Couldn\'t search: ' : 'Couldn\'t refresh: ') + e.message); return; }
      Object.assign(this.view, {loading: false, error: errText(e)});
    } finally {
      if (seq === renderSeq) { clearTimeout(behindTimer); this.view.updating = this.view.behind = false; }
    }
  },
  /* ---------- drawing a long screen (performance-plan, part 5) ---------- */
  /* A screen's rows from row `n` on, drawn a few at a time: FIRST_ROWS at once, then, after that's painted, a batch a
     frame, each a frame's work for the first few screens and then about a second's (batchMs, nextBatch), down the
     screen's lists in order (drawn, listGroups' `before`), until every row is drawn. Meanwhile the screen counts as busy (#view[aria-busy], app.html), so the tests wait for it.
     Scrolling to within a screen of the end of what's drawn draws the rest at once, so the end of what's drawn is never
     taken for the end of the list; and so does holding a row to move it (reorderOf), which needs all its siblings. */
  drawFrom(n){
    this.drawTo = Math.min(this.drawTo, n + FIRST_ROWS);
    if (this.drawing) return;
    this.drawing = true;
    const seq = ++drawSeq;
    let rows = FIRST_ROWS, took = null, y = scrollY;
    // (only scrolling down: going to a screen's top, as a new screen does, isn't nearing its end)
    nearEnd = () => { const down = scrollY > y; y = scrollY; if (down && scrollY + 2 * innerHeight >= document.documentElement.scrollHeight) this.drawAll(); };
    const step = () => {
      if (seq !== drawSeq) return;
      if (!this.view.loading) {                          // (with no copy kept, its rows come with the load)
        if (this.drawTo >= this.view.groups.reduce((k, g) => k + g.tasks.length, 0)) return this.drawAll();
        if (took !== null) rows = nextBatch(rows, took, batchMs(this.drawTo - n));
        this.drawTo += rows;
        // How long the batch took to draw: Alpine draws it straight after this, before anything queued after it.
        const t0 = performance.now(); took = null; queueMicrotask(() => { took = performance.now() - t0; });
      }
      requestAnimationFrame(step);
    };
    addEventListener('scroll', nearEnd, {passive: true});
    requestAnimationFrame(() => requestAnimationFrame(step));   // the second frame: after the first rows are painted
  },
  // Every row drawn: the rest of a screen being drawn a batch at a time, and anything added later, at once.
  drawAll(){ drawSeq++; this.drawTo = Infinity; this.drawing = false; removeEventListener('scroll', nearEnd); nearEnd = null; },
  /* What list `g` (listGroups) draws of its rows or cards, so far. The list as it is, not as Alpine watches it: x-for
     going over a watched list reads each item through Alpine, for each batch, every row drawn so far. */
  drawn(g){ return drawnOf(raw(g.cards ? g.items : g.tasks), g.before, this.drawTo); },
  /* The copy of a screen kept on the phone, to show while it loads: Today, a project and Checklists, as last loaded (or
     loaded in the background: preload), and only ever this account's. */
  savedView(r){
    if (!['today', 'project', 'checklists'].includes(r.name) || !this.user || saved.get('user')?.id !== this.user.id) return null;
    const s = saved.get(viewKey(r));
    return s && (r.name !== 'project' || s.project?.id === r.id) ? s : null;
  },
  // A copy kept of screen `r`, on screen: its tasks the ones on screen already, where those are as new (keptRows); Today's
  // cards with their steps. A project's Done is open only if it's open now, not as it was when the copy was kept (and
  // has no tasks till it's loaded: keptGroups).
  showSaved(r, s){
    this.keptRows(s.steps || []);
    const open = r.name === 'project' && !!doneOpen.all()[r.id];
    const groups = keptGroups(s.groups || []).map(g => ({...g, loading: false, tasks: this.keptRows(g.tasks), ...g.key === 'done' && {open}}));
    const checklists = (s.checklists || []).map(cl => ({...cl, runs: this.keptRows(cl.runs || [])}));
    const project = s.project && (this.projById.get(s.project.id) || s.project);
    Object.assign(this.view, {loading: false, groups, cards: s.cards || {}, project: project || null, checklists, run: s.run || null, savedAt: s.at, listView: s.listView || null});
    // Where its tasks are in its List view, unless this session knows better (a move since).
    for (const [id, pos] of Object.entries(s.positions || {})) if (!(id in this.positions)) this.positions[id] = pos;
    if (r.name === 'today') this.regroupToday();
  },
  /* ---------- the other tabs, loaded in the background ---------- */
  /* Once a screen has loaded, the copies kept of Today, the project opened last (or the first favourite) and Checklists
     are loaded afresh behind it, one at a time, when the phone has nothing else to do: switching to one then shows a
     fresh copy at once; first, who can see each project, now and then (refreshPeople). Only reads: nothing is changed
     in Vikunja, nor on the screen. Not without a connection, nor on one the phone says is slow or to be sparing with
     (Save-Data), nor a copy kept less than a minute ago; and not while the screen's rows are still being drawn (drawFrom),
     which it would only slow. */
  schedulePreload(){
    clearTimeout(preloadTimer);
    const idle = window.requestIdleCallback || (f => setTimeout(f));
    preloadTimer = setTimeout(() => idle(() => this.preload(), {timeout: 5000}), 2000);
  },
  async preload(){
    if (this.drawing) return this.schedulePreload();
    const c = navigator.connection;
    if (preloading || this.offline || !this.signedIn || !this.user || document.visibilityState !== 'visible' || c?.saveData || /2g/.test(c?.effectiveType || '')) return;
    preloading = true;
    try {
      await this.refreshPeople();                      // who can see each project, for the claim slots (claimSlot)
      for (const k of this.preloads()) {
        const kept = saved.get(k.key);
        if (location.hash === k.hash || (kept && Date.now() - Date.parse(kept.at) < PRELOAD_AGE)) continue;
        if (this.offline || saved.get('user')?.id !== this.user?.id) break;
        try { saved.set(k.key, {...await k.load(), at: new Date().toISOString()}); } catch { /* tried again after the next screen loads */ }
      }
    } finally { preloading = false; }
  },
  // What's loaded in the background: {hash: its screen, key: its copy's (viewKey), load: its copy}. Each row is a task as
  // Vikunja has it (`t => t`): the tasks on screen aren't touched.
  preloads(){
    const out = [{hash: '#/today', key: 'today', load: async () => this.todayFrom(await this.readToday(), t => t)}];
    const p = this.projById.get(saved.get('project.last')) || this.favorites[0];
    if (p) out.push({hash: '#/project/' + p.id, key: viewKey({name: 'project', id: p.id}), load: async () => {
      const d = await this.readProject(p, false);         // Done's count only (keptGroups)
      return {groups: [{key: 'open', cls: '', title: 'Open', tasks: d.list, heads: d.heads}, this.doneGroup(null, d.count, false, t => t)],
        project: d.project, listView: d.listView, positions: d.positions};
    }});
    if (this.checklistProjects.length) out.push({hash: '#/checklists', key: 'checklists', load: async () => ({checklists: await this.readChecklists(t => t)})});
    return out;
  },
  /* Lists loaded afresh, over what's on screen (`ids`: their tasks): the rows no longer in them fold away first, as a
     tick's do, rather than vanish from under a finger, and the rows new to the screen fade in, softly, unlike one just
     added. Rows marked done or deleted stay, for the batch (keepMarked). Resolves to whether this load (`seq`) is still
     the one to show. */
  async settle(ids, seq){
    if (this.view.loading) return seq === renderSeq;
    const now = new Set(ids), shown = [...this.view.groups.flatMap(g => g.tasks), ...this.view.checklists.flatMap(cl => cl.runs || [])].map(t => t.id);
    const gone = shown.filter(id => !now.has(id) && !this.lines[id] && !this.leaving[id]), was = new Set(shown), arrived = ids.filter(id => !was.has(id));
    // Found in one pass over the page, not one for each row gone (2,000 of them, when a project's Done closes).
    const out = new Set(gone.map(String));
    if (gone.length) await collapseRows([...document.querySelectorAll('#view :is(.row:not(.step-line), .day-card)[data-id]')].filter(el => out.has(el.dataset.id)));
    if (seq !== renderSeq) return false;
    if (arrived.length) this.flash(arrived, 'arrived');
    return true;
  },
  /* Rows marked done or deleted, waiting for the batch to clear (leaving.js), stay where they were through a load of
     their list, though Vikunja's no longer has them (a task done): they go with the batch. On Today, whose groups
     are by date, so does one Vikunja now has in another group: a repeating task ticked, or added done, is open again
     at its next date, and moves there when its mark goes (its row shown done meanwhile: keep, tasks.js). */
  keepMarked(groups){
    const now = new Map(groups.flatMap(g => g.tasks.map(t => [t.id, g]))), today = this.route.name === 'today';
    for (const old of this.view.groups) old.tasks.forEach((t, i) => {
      const g = this.leaving[t.id] && groups.find(x => x.key === old.key), has = now.get(t.id);
      if (!g || has === g || (has && !today)) return;
      if (has) has.tasks.splice(has.tasks.findIndex(x => x.id === t.id), 1);
      g.tasks.splice(Math.min(i, g.tasks.length), 0, t); now.set(t.id, g);
    });
    return groups;
  },
  async loadToday(seq){
    const got = await this.readToday();
    if (seq !== renderSeq) return;
    const {groups, cards, steps, positions} = this.todayFrom(got, t => { cache.set(t.id, t); return this.keep(t); });
    if (!await this.settle(groups.flatMap(g => g.tasks.map(t => t.id)), seq)) return;
    this.todayDay = +startOfDay();
    Object.assign(this.positions, positions);
    Object.assign(this.view, {cards, groups: this.keepMarked(groups)});
    saved.set('today', {groups, cards, steps, positions, at: new Date().toISOString()});
  },
  /* What Today shows, from Vikunja: its rows and its cards (todayItems), with each card's task and open subtasks
     (readCards), not yet in their groups. */
  async readToday(){
    const end = addDays(startOfDay(), 8);
    const t0 = startOfDay();
    const q = new URLSearchParams({filter: `done = false && due_date < '${end.toISOString()}'`, filter_timezone: TZ, sort_by: 'due_date', order_by: 'asc', expand: 'comment_count'});
    const qNew = new URLSearchParams({filter: `done = false && created >= '${t0.toISOString()}'`, filter_timezone: TZ, sort_by: 'created', order_by: 'desc', expand: 'comment_count'});
    // And steps you've claimed in someone else's run, still open, which may have no date yet.
    const qMine = new URLSearchParams({filter: `done = false && assignees in ${this.user?.username}`, filter_timezone: TZ, expand: 'comment_count'});
    const [all, allAdded, {index: runs, mine, open = []}, claimed] = await Promise.all([allPages('/tasks?' + q), allPages('/tasks?' + qNew), this.loadRunIndex(),
      this.checklistIds.size && this.user ? allPages('/tasks?' + qMine).catch(() => []) : []]);
    const tasks = all.filter(t => this.inToday(t, runs)), added = allAdded.filter(t => this.inToday(t, runs));
    const theirs = claimed.filter(t => !isSet(t.due_date) && runs[this.stepRun(t)] === false);
    const {rows, cards} = todayItems({tasks, added, mine, claimed: theirs}, this.user, t => this.isRunTask(t));
    const read = cards.size ? await this.readCards(cards, [...tasks, ...added, ...mine, ...claimed, ...open]) : {parents: [], steps: [], positions: {}};
    return {rows, cards, ...read};
  },
  /* Today's groups of those, each task's row given by `own`: the one on screen, or (preload) Vikunja's as it is. A card
     goes where what brought it says (cardGroup); one whose task can't be read shows what brought it as rows instead.
     Returns {groups, cards: by task id, as the screen keeps them, steps, positions}. */
  todayFrom({rows, cards, parents, steps, positions}, own){
    const groups = todayGroups(), at = Object.fromEntries(groups.map(g => [g.key, g])), dated = [], shown = {}, seen = new Set();
    const put = (t, key) => { if (seen.has(t.id)) return; seen.add(t.id); if (key === 'dated') dated.push(own(t)); else at[key].tasks.push(own(t)); };
    const byId = new Map(parents.map(p => [p.id, p]));
    for (const [id, c] of cards) {
      const p = byId.get(id);
      if (p) { shown[id] = {when: c.when, made: c.made, focus: c.focus}; put(p, cardGroup(c, this.isRunTask(p))); }
    }
    for (const {t, key} of rows) put(t, key);
    for (const [id, c] of cards) if (!byId.has(id)) for (const t of c.from) put(t, isSet(t.due_date) ? 'dated' : this.stepRun(t) ? 'runs' : 'nodate');
    this.placeDated(groups, dated, shown);
    return {groups, cards: shown, steps: steps.map(own), positions};
  },
  /* A project's open tasks, in the order of its List view in Vikunja (order.js), each subtask under its parent in its
     own order; its done tasks in a section of their own below, counted, and loaded once it's opened. A project with no
     List view, or one Pocket can't read, is in the order its tasks were made, and can't be reordered. */
  async loadProject(seq, r){
    if (!this.projById.has(r.id)) await this.loadProjects();
    const p = this.projById.get(r.id), open = p && doneOpen.all()[p.id];
    this.view.project = p || null;
    if (!p) { this.view.groups = []; return; }
    // Done, open, as many as it shows now, loaded afresh: a new visit's the latest DONE_PART (it has none yet).
    const d = await this.readProject(p, open && Math.max(DONE_PART, this.view.groups.find(g => g.key === 'done')?.tasks.length || 0));
    if (seq !== renderSeq) return;
    for (const t of [...d.tasks, ...d.read]) cache.set(t.id, t);
    const groups = [{key: 'open', cls: '', title: 'Open', tasks: d.list.map(t => this.keep(t)), heads: d.heads}, this.doneGroup(d.finished, d.count, open)];
    // Done's tasks over a copy that kept only its count (keptGroups) come as Done's do when it's opened, not faded in as new.
    const shown = this.view.groups.find(g => g.key === 'done'), quiet = g => g.key === 'done' && shown && !shown.loaded;
    if (!await this.settle(groups.flatMap(g => quiet(g) ? [] : g.tasks.map(t => t.id)), seq)) return;
    Object.assign(this.positions, d.positions);
    for (const e of this.pending) if (e.kind === 'act' && e.op === 'position') this.positions[e.task] = e.pos;   // a move made meanwhile
    Object.assign(this.view, {project: d.project, listView: d.listView, groups: this.keepMarked(groups)});
    saved.set('project.last', p.id);                            // loaded in the background from now on (preloads)
    this.saveProject();
    if (open && !d.finished) this.loadDoneSection(this.view.groups[1]);
  },
  /* A project's lists from Vikunja, its tasks as Vikunja has them: {project, listView, tasks: what the view gave, read: the
     heads read besides, list: its open list, heads, positions, count: of its done tasks, finished: the latest `withDone` of
     those (doneTasks), if asked}. */
  async readProject(p, withDone){
    const q = {filter_timezone: TZ, expand: 'comment_count'}, id = p.id;
    /* Its done tasks, counted by Vikunja. Not in a project for checklists: there, most are templates' and runs' steps,
       which its Done leaves out (withoutTemplates), so it's counted once it's loaded. */
    const count = this.checklistIds.has(id) ? null : api(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', per_page: 1})).then(d => d?.total ?? null, () => null);
    const done = withDone ? this.doneTasks(p, 0, withDone).catch(() => null) : null;
    let lv = listViewOf(p), tasks = null;
    // Its List view, as last loaded: gone, or not one Pocket can read, the project's views are looked up again, once.
    for (let tries = 0; lv && !tasks && tries < 2; tries++) {
      try { tasks = await allPages(`/projects/${p.id}/views/${lv.id}/tasks?expand=subtasks&` + new URLSearchParams(q)); }
      catch (e) {
        if (!(e instanceof ApiError && [403, 404].includes(e.status))) throw e;
        await this.loadProjects(); p = this.projById.get(id) || p;
        const again = listViewOf(p); lv = again && again.id !== lv.id ? again : null;
      }
    }
    if (!tasks) { lv = null; tasks = await allPages(`/projects/${p.id}/tasks?` + new URLSearchParams({...q, filter: 'done = false'})); }
    /* A done parent with subtasks still open is shown over them, a card with its heading struck through (doneParentIds):
       as the view gave it, under an open task, or else read, all of them in one request; not read, as its subtasks name
       it. A run in progress is a card, its open steps on it (parent-tasks-plan, part 2); a finished one's steps aren't
       on the list, so a run finished with steps not done is in Done, not over them. */
    const shown = this.onProjectList(tasks), headIds = doneParentIds(shown, p.id), given = new Map(tasks.map(t => [t.id, t])), missing = headIds.filter(id => !given.has(id));
    const read = missing.length ? await allPages('/tasks?' + new URLSearchParams({...q, filter: 'id in ' + missing.join(', ')})).catch(() => []) : [];
    const named = id => tasks.flatMap(t => t.related_tasks?.parenttask || []).find(x => x.id === id);
    const heads = headIds.map(id => given.get(id) || read.find(t => t.id === id) || named(id));
    const [n, finished] = await Promise.all([count, done]);
    // The view gives each open task's subtasks, done ones too: those are in the Done section.
    const list = [...shown.filter(t => !t.done), ...heads], positions = {};
    if (lv) {
      for (const t of tasks) positions[t.id] = t.position || 0;
      // A head the view didn't give has no position Pocket can read (the view leaves out what's done): it goes where
      // its first open subtask is, where Vikunja's web app shows that subtask.
      for (const h of heads.filter(h => !given.has(h.id))) {
        const at = Math.min(...list.filter(t => !t.done && (t.related_tasks?.parenttask || []).some(x => x.id === h.id)).map(t => positions[t.id] || Infinity));
        positions[h.id] = at < Infinity ? at : 0;
      }
      // Moves still waiting to be sent, as they'll be.
      for (const e of this.pending) if (e.kind === 'act' && e.op === 'position') positions[e.task] = e.pos;
    }
    return {project: p, listView: lv?.id || null, tasks, read, list, heads: headIds, positions, count: n, finished};
  },
  /* The Done section: `part` loaded (doneTasks; or null, not yet), `count` from Vikunja (null if it didn't say), each
     task's row given by `own` (as for Today). It shows the latest DONE_PART, and its count all of them; a row at its end
     shows DONE_PART more (moreOf). */
  doneGroup(part, count, open, own = t => this.keep(t)){
    return {key: 'done', cls: 'done-sec', title: 'Done', fold: true, open: !!open, loading: false, loaded: !!part, per: DONE_PART, skip: part?.skip || 0,
      count: part ? counted(part, part.skip, count) : count, tasks: (part?.tasks || []).map(own)};
  },
  /* `n` of a project's done tasks, the most recently done first, from the `from`th on (performance-plan, part 9):
     {tasks, total: how many Vikunja counts, skip: how many of those read it left out}. Not templates, nor their steps
     or a run's (withoutTemplates): in a project for checklists, where most are, every one is read and those left out
     first, so the parts and the count are of what Done shows. */
  async doneTasks(p, from = 0, n = DONE_PART){
    const path = `/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', filter_timezone: TZ, sort_by: 'done_at', order_by: 'desc', expand: 'comment_count'});
    if (this.checklistIds.has(p.id)) {
      const list = this.withoutTemplates(await allPages(path), true);
      for (const t of list) cache.set(t.id, t);
      return {tasks: list.slice(from, from + n), total: list.length, skip: 0};
    }
    const {items: list, total} = await partOf(path, from, n);
    for (const t of list) cache.set(t.id, t);
    const tasks = this.withoutTemplates(list, true);
    return {tasks, total, skip: list.length - tasks.length};
  },
  // The Done section opened, loading it the first time, or closed again. Each project's is kept as it was left.
  toggleDoneSection(){
    const p = this.view.project, g = this.view.groups.find(x => x.key === 'done');
    if (!p || !g) return;
    g.open = !g.open; doneOpen.set(p.id, g.open);
    if (g.open) this.loadDoneSection(g);
  },
  async loadDoneSection(g){
    const p = this.view.project;
    if (g.loaded || g.loading || !p) return;
    g.loading = true;
    try {
      const part = await this.doneTasks(p);
      if (this.view.project?.id !== p.id) return;
      this.drawFrom(this.listGroups.find(x => x.key === 'done')?.before ?? 0);   // its first rows at once, the rest in batches
      Object.assign(g, {tasks: part.tasks.map(t => this.keep(t)), loaded: true, per: DONE_PART, skip: part.skip, count: counted(part, part.skip, g.count)});
      this.saveProject();
    } catch (e) { g.open = false; this.say('Couldn\'t load the done tasks: ' + why(e), {place: 'done', cls: 'failed'}); }
    finally { g.loading = false; }
  },
  /* The row at the end of list `key` (a project's Done, search's done matches), shown a part at a time, the most
     recently done first: {title, note} (moreDone), or null when every one is shown, or it isn't loaded. */
  moreOf(key){
    const g = this.view.groups.find(x => x.key === key);
    return g?.per && g.loaded !== false && typeof g.count === 'number' ? moreDone(g.count - g.tasks.length, g.per) : null;
  },
  /* Its tap: the next part, read from where the list is shown to (those left out counted in), and put after it, but any
     on it already (done since, and so read again); its first rows drawn at once, the rest in batches. The row keeps the
     focus; once it's gone (none left), the first row it showed has it. Each visit starts again at the latest part. */
  async showMore(key){
    const g = this.view.groups.find(x => x.key === key), p = this.view.project, s = this.searchQ.trim(), at = g?.tasks.length;
    if (!g || this.showingMore || !this.moreOf(key)) return;
    this.showingMore = key;
    try {
      const part = this.route.name === 'search' ? await this.foundDone(s, at + g.skip) : await this.doneTasks(p, at + g.skip);
      if (this.view.groups.find(x => x.key === key) !== g) return;                 // gone meanwhile: another screen, or loaded afresh
      const have = new Set(g.tasks.map(t => t.id)), add = part.tasks.filter(t => !have.has(t.id));
      this.drawFrom((this.listGroups.find(x => x.key === key)?.before ?? 0) + g.tasks.length);
      g.skip += part.skip; g.count = counted(part, g.skip, g.count);
      g.tasks.push(...add.map(t => this.keep(t)));
      if (add.length && !this.moreOf(key)) this.$nextTick(() => document.querySelector(`#view .row[data-id="${add[0].id}"] > button.body`)?.focus({preventScroll: true}));
    } catch (e) { this.say('Couldn\'t load the done tasks: ' + why(e), {place: 'more', cls: 'failed'}); }
    finally { this.showingMore = null; }
  },
  // The project on screen, kept for opening without a connection, with where its tasks are in its List view.
  saveProject(){
    const p = this.view.project;
    if (!p || this.route.name !== 'project') return;
    const groups = keptGroups(this.view.groups), ids = groups.flatMap(g => g.tasks.map(t => t.id)).filter(id => id in this.positions);
    saved.set(viewKey(this.route), {groups, project: p, listView: this.view.listView, at: new Date().toISOString(),
      positions: Object.fromEntries(ids.map(id => [id, this.positions[id]]))});
  },
  /* Load a newer Pocket if the server has one, when nothing would be lost by reloading; otherwise the next refresh or
     return to Pocket tries again. It only asks whether the page changed since this copy was loaded, which the server
     answers in a few bytes, and runs alongside the list refresh, not before it. */
  async updateIfNew(){
    if (!LOADED || !this.signedIn || this.screen !== 'app') return;
    let res;
    // eslint-disable-next-line no-restricted-globals -- Pocket's own page, not Vikunja's API
    try { res = await fetch(new URL('.', location.href), {cache: 'no-store', headers: {'If-Modified-Since': LOADED.toUTCString()}}); }
    catch { return; }                                                          // offline: no news
    if (res.status !== 200) return;
    const busy = this.sheet.open || this.cap.text.trim() || this.runInsert.text.trim() || this.capPhotos.length || this.cap.busy || this.searchQ || this.movingOverdue || this.starting
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
  /* Vikunja's search: words in the title or notes, or a task's number. Open tasks soonest first, then the latest
     FOUND_PART done, with a row for more (moreOf; the same search again, as many as it shows). Not templates or their
     steps: they're on Checklists (withoutTemplates). An open task found with open subtasks is a stacked card, collapsed
     (cardOf), so its subtasks are read with it, as Today's cards' are (readCards): who's on each, and where each is in
     its project's List view. */
  async loadSearch(seq){
    const s = this.searchQ.trim();
    if (!s) { this.view.groups = []; return; }
    const open = new URLSearchParams({q: s, filter: 'done = false', filter_timezone: TZ, expand: 'comment_count'});
    const again = s === searched ? this.view.groups.find(g => g.key === 'done')?.tasks.length || 0 : 0;
    const [opened, found] = await Promise.all([allPages('/tasks?' + open), this.foundDone(s, 0, Math.max(FOUND_PART, again))]);
    if (seq !== renderSeq) return;
    const finished = found.list;
    searched = s;
    const parents = opened.filter(t => openSubs(t).length && !hasTemplateLabel(t));
    const read = parents.length ? await this.readCards(new Map(parents.map(t => [t.id, {project: t.project_id}])), [...opened, ...finished]) : {steps: [], positions: {}};
    if (seq !== renderSeq) return;
    for (const t of read.steps) { cache.set(t.id, t); this.keep(t); }
    Object.assign(this.positions, read.positions);
    for (const t of [...opened, ...finished]) cache.set(t.id, t);
    this.view.groups = this.keepMarked([
      {key: 'open', cls: '', title: 'Open', tasks: soonestFirst(this.withoutTemplates(opened)).map(t => this.keep(t))},
      {key: 'done', cls: '', title: 'Done', per: FOUND_PART, skip: found.skip, count: counted(found, found.skip, null), tasks: found.tasks.map(t => this.keep(t))},
    ]);
  },

  /* `n` of the done tasks search `s` finds, the most recently done first, from the `from`th on: {tasks, list: all those
     read, total, skip}, as doneTasks. */
  async foundDone(s, from, n = FOUND_PART){
    const {items: list, total} = await partOf('/tasks?' + new URLSearchParams({q: s, filter: 'done = true', filter_timezone: TZ, sort_by: 'done_at', order_by: 'desc', expand: 'comment_count'}), from, n);
    for (const t of list) cache.set(t.id, t);
    const tasks = this.withoutTemplates(list);
    return {tasks, list, total, skip: list.length - tasks.length};
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
      // Its screen, open, shows it was made; for checklists, Checklists says so too.
      this.go(np.checklists ? '#/checklists' : '#/project/' + p.id);
      if (np.checklists) this.say(`Made ${p.title}, for checklists.`, {place: 'checklists'}); else this.said = `Made ${p.title}`;
    } catch (e) {
      np.busy = false;
      this.say(e instanceof NetError ? 'Offline. A project can be made once you\'re back online.' : 'Not made: ' + e.message, {place: 'sheet:top', cls: 'failed'});
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
      this.say(e instanceof NetError ? 'Offline — you can create the project once you\'re back online' : 'Project not created: ' + e.message, {place: 'cap', cls: 'failed'});
    } finally { this.creatingProject = false; }
  },
};
