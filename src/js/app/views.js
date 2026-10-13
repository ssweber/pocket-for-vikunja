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
const PRELOAD_AGE = 60e3;                        // skip background reloads for copies newer than this
// The projects whose Done section is open, remembered on this phone: project id -> true.
const doneOpen = {
  all(){ try { return JSON.parse(store.get('done.open')) || {}; } catch { return {}; } },
  set(id, open){ const a = this.all(); if (open) a[id] = true; else delete a[id]; store.set('done.open', JSON.stringify(a)); },
};
/* Compute a paged Done count from Vikunja's total, minus excluded templates and steps. Use was when Vikunja
   omitted the total. */
const counted = (part, skip, was) => part.total == null ? was : Math.max(0, part.total - skip);

export default {
  async loadProjects(){
    const list = await allPages('/projects?is_archived=false');
    this.setProjects(list.filter(p => p.id > 0 && !p.is_archived).sort((a,b) => (a.position||0) - (b.position||0) || a.title.localeCompare(b.title)));
    saved.set('projects', this.projects);
  },
  // Index checklist projects once per project change. Parsing each description as HTML on every row would slow
  // long lists.
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
  // Search and project Done sections move tasks between separate Open and Done groups after a tick.
  get bothWays(){ return ['search', 'project'].includes(this.route.name); },

  /* ---------- views ---------- */
  /* Give each screen a history entry and remember its predecessor. Replace an open sheet's entry so Back does not
     reopen that sheet. */
  go(hash){
    if (hash === location.hash && !history.state?.sheet) { this.navigated(); return; }
    const from = location.hash || '#/today';
    if (history.state?.sheet) history.replaceState({from}, '', hash); else history.pushState({from}, '', hash);
    shared.onClosedSheet = false;
    this.navigated();
  },
  navigated(){ this.headerTucked = false; this.light(null); this.runBoxAt = null; this.resetCards(); this.foldLines(); if (!this.signedIn) return; this.closeSheet(true); this.render(); },
  // Use history.back when it leads to the requested screen. Otherwise open that screen with go().
  back(to){
    if (history.state?.from !== to || history.state?.sheet === true) { this.go(to); return; }
    const closed = history.state?.sheet === 'closed';                     // also go back past the closed sheet's history entry
    shared.onClosedSheet = false;
    history.go(closed ? -2 : -1);
  },
  // The heading of each screen. Project and checklist screens also show the parent project above the title.
  get head(){
    const r = this.route;
    if (r.name === 'projects') return {kicker: '', title: 'Projects'};
    if (r.name === 'search') return {kicker: '', title: 'Search'};
    if (r.name === 'checklists') return {kicker: '', title: 'Checklists'};
    if (r.name === 'run') {
      const run = this.view.run?.run;
      return {kicker: this.projById.get(run?.project_id)?.title || '', title: run?.title || 'Checklist'};
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
    if (this.route.name === 'today') return {title: 'Nothing due this week.', body: `Today is ${this.todayDate}. Add a task below — try “Call the plumber tomorrow !3”.`};
    if (this.route.name === 'search') return this.searchQ.trim()
      ? {title: `No tasks match “${this.searchQ.trim()}”.`, body: 'Searching looks at titles and notes, in open and done tasks.'}
      : {title: 'Search your tasks.', body: 'Finds open and done tasks in all your projects by words in their title or notes, or by number, like #12.'};
    if (!this.view.project) return {title: 'Project not found.', body: 'It may be archived or you lost access.'};
    return {title: 'All clear.', body: 'New tasks you add now land in this project.'};
  },
  // A row's title: a template's without its "TEMPLATE: ".
  rowTitle(t){ return hasTemplateLabel(t) ? templateName(t.title) : t.title; },
  // Send a row's tick to the action for its place: a checklist step, the sheet's own task, a sheet subtask or a list
  // row. Tapping the tick of a marked row undoes the mark instead. The phone vibrates once.
  tickRow(t, g, row){
    if (g.run) return this.tickStep(t, t.done ? 'undone' : 'done');
    haptic(tickFeel(t.done));
    if (g.own) return this.sheetDone();
    if (g.card) this.pinCard(g.card);                    // the next step joins the card after this one leaves (app/cards.js)
    if (this.unmark(t.id)) return;
    if (g.sheet) return this.toggleSubtask(t);
    this.toggleDone(t, row);
  },
  /* Open the item a row stands for. A checklist step's title selects its card, the sheet's own title edits in place,
     and a sheet subtask opens its task. A list row opens a task, a checklist, or the Start sheet of an open template.
     A pending row has no saved task to open. */
  tapRow(t, g){
    if (g.run) return this.showStep(t.i, true);
    if (g.step) return this.editStep(t);
    if (t.pending) return;
    if (g.own) return this.editTitle();
    return g.sheet || g.top ? this.openTask(t.id) : this.openRow(t);
  },
  /* Send a ring tap to the checklist screen's own handler, or to ringTap with its row and sheet. That lets the
     confirmation and Undo appear where the tap happened. */
  tapRing(t, r, el){
    if (r.tap) return r.tap();
    const sheet = !!el.closest('#sheet');
    return this.ringTap(t, sheet ? null : el.closest('.day-card, .row'), sheet);
  },
  /* Build compact metadata for a one-line row. Show priority, a short due date or countdown, and the project dot
     only when the card heading does not already show it. Leave labels and counts off Today, and put the fuller
     metadata in said for screen readers. Compute this once per row. */
  rowWhen(t, g){
    const meta = this.rowMeta(t, g), left = meta.find(m => m.key === 'due')?.countdown, p = this.projById.get(t.project_id);
    const due = left ? {text: left.text, cls: left.late ? 'overdue' : 'today'} : shortDue(t.due_date, new Date(this.rowNow()), {underToday: g?.key === 'today'});
    const said = meta.filter(m => !m.extra).map(m => m.key === 'due' ? m.label || (m.cls.includes('overdue') ? 'Late: ' : 'Due ') + m.text : m.label || m.text).filter(Boolean);
    return {prio: t.priority || 0, due, color: p && g?.card?.project !== t.project_id ? colorOf(p.hex_color) : null, said: said.join(', ')};
  },
  // Use Today's grouping minute for due text so its rows redraw only once a minute.
  rowNow(){ return this.route.name === 'today' && this.groupedAt || Date.now(); },
  /* Build metadata for each row context. Sheet subtasks show due dates, while the sheet's own row omits details
     already shown elsewhere in the sheet. A checklist's top row uses its assignee slot. Checklist steps show how
     they were added, their comments and their timing. One-line rows omit extra labels and counts. */
  rowMeta(t, g){
    if (g?.top) return [];
    // A template step's row shows when it is due in a checklist, or what is wrong with it, and the first line of its notes.
    if (g?.step) {
      const s = this.stepShown(t), note = this.stepNote(t);
      return [(s.problem || s.text) && {key: 'when', cls: 'num' + (s.problem ? ' due overdue' : ''), text: s.problem || s.text}, note && {key: 'note', cls: 'step-note', text: note}].filter(Boolean);
    }
    if (g?.own) return this.rowMeta(t, {depth: {}}).filter(m => OWN_META.includes(m.key));
    if (g?.run) return [t.added && {key: 'added', cls: 'added', text: t.added},
      t.notes.length && {key: 'notes', cls: 'note-mark num', icon: 'comment', text: String(t.notes.length), label: t.notes.length === 1 ? 'A comment' : t.notes.length + ' comments'},
      t.dueText && !t.done && {key: 'due', cls: 'due num' + (t.late ? ' overdue' : ''), text: t.dueText}].filter(Boolean);
    const out = [], due = dueInfo(t.due_date), card = g?.card;
    // A done task stays on the open list while it has open subtasks. Show a message that says why.
    if (!g?.sheet && t.done && g?.heads?.includes(t.id)) out.push({key: 'head', text: headText(g.tasks.filter(x => !x.done && parentIds(x).includes(t.id)).length)});
    // A checklist step that is not done and is due within a day shows a countdown to the minute. On Today, rowNow
    // redraws it once a minute.
    const left = due && !t.done && this.stepRun(t) && countdown(+new Date(t.due_date), this.rowNow());
    if (left) out.push({key: 'due', cls: 'due num ' + (left.late ? 'overdue' : 'today'), text: left.text, label: left.late ? 'Late: ' + left.text : 'Due ' + left.text, countdown: left});
    else if (due) out.push({key: 'due', cls: 'due num ' + due.cls, text: due.label});
    if (g?.sheet) return out;
    if (t.priority) out.push({key: 'prio', prio: t.priority, text: '', label: 'Priority: ' + PRIOS[t.priority].label});
    /* Show a repeating template's Start action and project instead of labels and counts, so matching names in
       different projects are clear. The slot shows who its checklists are for. */
    if (comesRound(t) && this.checklistIds.has(t.project_id)) {
      out.push({key: 'tpl', text: !this.canWrite(t.project_id) ? 'Checklist' : this.tickOf(t) ? 'Checklist. Tap to start.' : 'Checklist, not due yet'});
      const tp = this.projById.get(t.project_id);
      if (tp && this.route.name !== 'project') out.push({key: 'p', color: colorOf(tp.hex_color), text: tp.title});
      return out;
    }
    // Avoid repeating the card's project on its step rows, except when a step belongs to another project.
    const p = (!card || card.project !== t.project_id) && (this.route.name === 'today' || this.route.name === 'search') && this.projById.get(t.project_id);
    // Name the checklist on Today and search step rows, so steps with the same name can be told apart. Project lists
    // already show the checklist above its steps.
    const run = !card && (this.route.name === 'today' || this.route.name === 'search') && this.stepRun(t) && t.related_tasks.parenttask[0];
    if (run) out.push({key: 'run', icon: 'checklist', text: run.title, label: 'Step of ' + run.title});
    else if (p) out.push({key: 'p', color: colorOf(p.hex_color), text: p.title});
    // Name an absent parent so an isolated subtask can be identified.
    const up = !card && !run && p && !g?.depth?.[t.id] && t.related_tasks?.parenttask?.[0];
    if (up) out.push({key: 'up', text: '↳ ' + up.title, label: 'Subtask of ' + up.title});
    for (const l of (t.labels || []).slice(0,3)) out.push({key: 'l' + l.id, color: colorOf(l.hex_color), text: l.title, extra: true});
    if (repeats(t)) out.push({key: 'rep', text: '↻', label: 'Repeats'});
    // Show the count of done subtasks. A task with a ring (a checklist or an open parent) shows it in the ring (rowRing).
    const subs = t.related_tasks?.subtask || [];
    if (subs.length && !this.isRunTask(t) && !this.rowRing(t, g || {})) out.push({key: 'sub', icon: 'subtasks', cls: 'num', text: subs.filter(s => s.done).length + '/' + subs.length, label: 'Subtasks done', extra: true});
    if (t.comment_count) out.push({key: 'com', icon: 'comment', cls: 'num', text: String(t.comment_count), label: 'Comments', extra: true});
    // Include pending uploads in file counts immediately. Describe waiting files as work still to send instead of
    // a single total.
    const att = t.attachments?.length || 0, waiting = t.pending ? t.waiting : this.waiting.files[t.id] || 0;
    if (att + waiting) out.push({key: 'att', icon: 'clip', cls: 'num', text: String(att + waiting), label: 'Attachments' + (waiting ? `, ${waiting} waiting to upload` : ''), extra: !waiting});
    // Skip checklist steps. Their reminder is Pocket's own, for the countdown the step shows.
    if (!this.stepRun(t) && (t.reminders || []).some(r => new Date(r.reminder) > new Date())) out.push({key: 'rem', icon: 'bell', text: '', label: 'A reminder is still to come'});
    return out;
  },

  // With kept, show only a cached screen before the signed-in account is known. Return whether a cached screen was
  // shown.
  async render({kept = false} = {}){
    let r = currentRoute();
    // An old link to a project's done tasks. Open the project's list with its Done section open.
    if (r.name === 'project' && r.showDone) { doneOpen.set(r.id, true); history.replaceState(history.state, '', '#/project/' + r.id); r = currentRoute(); }
    if (r.name === 'add') {                      // deep link: #/add?text=Buy+milk+tomorrow
      if (kept) return false;
      history.replaceState(null, '', '#/today');
      await this.render();
      this.cap.text = r.text; this.$nextTick(() => this.$refs.capture.focus());
      return;
    }
    // Keep the same route object when refreshing a screen. Every row reads it, so replacing an unchanged route
    // would recompute the whole list after every send or refresh.
    if (JSON.stringify(raw(this.route)) !== JSON.stringify(r)) this.route = r;
    if (r.name !== 'run') this.runFrom = location.hash || '#/today';
    if (r.name !== 'run' && r.name !== 'project') this.projectFrom = location.hash || '#/today';
    const seq = ++renderSeq;
    /* Open from the cached screen immediately and refresh its rows in place. Without a copy, show Loading. Report
       loads taking over a second under the header so the message does not cover the rows. */
    const fresh = this.view.route !== location.hash;
    if (fresh) {
      const s = r.name === 'projects' ? this.projects.length && {} : this.savedView(r);
      if (kept && !s) return false;
      this.drawFrom(0);                                  // draw the first rows now and the rest in batches
      Object.assign(this.view, {loading: !s, groups: [], cards: {}, project: null, savedAt: null, checklists: [], run: null, listView: null});
      if (s) this.showSaved(r, s);
      if (scrollY) scrollTo(0, 0);                       // a new screen starts at its top
      Object.assign(this.hint, {at: null, pick: true});  // show the hint, if not yet shown, on the first row (pickHint)
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
        // Keep visible rows after a failed load and show the offline banner. Regroup Today for the current date.
        if (!this.view.loading) { if (r.name === 'today') this.regroupToday(); return; }
        const s = saved.get(viewKey(r));                 // a checklist's saved copy is used only after a failed load
        if (s) { this.showSaved(r, s); return; }
      }
      if (r.name === 'run' && e.runGone) { this.runGone(r.id); return; }
      // The project was deleted elsewhere. Go back to the Projects list.
      if (r.name === 'project' && e instanceof ApiError && e.status === 404) { await this.loadProjects().catch(() => {}); this.go('#/projects'); this.notify('That project no longer exists.'); return; }
      // Show a failed refresh as a message, unless it would replace a message still being read. The rows on screen stay.
      if (!this.view.loading) { if (!(this.toast.show && this.toast.until - Date.now() > 1500)) this.notify((r.name === 'search' ? 'Couldn\'t search: ' : 'Couldn\'t refresh: ') + e.message); return; }
      Object.assign(this.view, {loading: false, error: errText(e)});
    } finally {
      if (seq === renderSeq) { clearTimeout(behindTimer); this.view.updating = this.view.behind = false; }
    }
  },
  /* ---------- drawing a long screen ---------- */
  /* Draw FIRST_ROWS immediately, then add batches after the first paint. Adjust batch size from measured rendering
     time. Keep aria-busy set until all rows are drawn. Draw the rest when scrolling near the end or starting a
     reorder, so a partial list cannot look complete or omit siblings needed for a move. */
  drawFrom(n){
    this.drawTo = Math.min(this.drawTo, n + FIRST_ROWS);
    if (this.drawing) return;
    this.drawing = true;
    const seq = ++drawSeq;
    let rows = FIRST_ROWS, took = null, y = scrollY;
    // Only scrolling down counts. Jumping to the top of a new screen is not nearing the end.
    nearEnd = () => { const down = scrollY > y; y = scrollY; if (down && scrollY + 2 * innerHeight >= document.documentElement.scrollHeight) this.drawAll(); };
    const step = () => {
      if (seq !== drawSeq) return;
      if (!this.view.loading) {                          // without a saved copy, the rows arrive with the load
        if (this.drawTo >= this.view.groups.reduce((k, g) => k + g.tasks.length, 0)) return this.drawAll();
        if (took !== null) rows = nextBatch(rows, took, batchMs(this.drawTo - n));
        this.drawTo += rows;
        // Measure the batch after Alpine renders it but before later queued work runs.
        const t0 = performance.now(); took = null; queueMicrotask(() => { took = performance.now() - t0; });
      }
      requestAnimationFrame(step);
    };
    addEventListener('scroll', nearEnd, {passive: true});
    requestAnimationFrame(() => requestAnimationFrame(step));   // the second frame: after the first rows are painted
  },
  // Draw all remaining rows at once, and any rows added later.
  drawAll(){ drawSeq++; this.drawTo = Infinity; this.drawing = false; removeEventListener('scroll', nearEnd); nearEnd = null; },
  /* Return the rows or cards drawn so far from an unwatched list. Otherwise x-for would read every drawn item
     through Alpine again for every batch. */
  drawn(g){ return drawnOf(raw(g.cards ? g.items : g.tasks), g.before, this.drawTo); },
  /* Cache Today, projects and Checklists for opening while they reload, including background loads. Keep copies
     separate for each account. */
  savedView(r){
    if (!['today', 'project', 'checklists'].includes(r.name) || !this.user || saved.get('user')?.id !== this.user.id) return null;
    const s = saved.get(viewKey(r));
    return s && (r.name !== 'project' || s.project?.id === r.id) ? s : null;
  },
  // Restore cached groups with current task objects when they are as new. Keep the project's current Done toggle,
  // and load Done tasks separately because the cache keeps only their count.
  showSaved(r, s){
    this.keptRows(s.steps || []);
    const open = r.name === 'project' && !!doneOpen.all()[r.id];
    const groups = keptGroups(s.groups || []).map(g => ({...g, loading: false, tasks: this.keptRows(g.tasks), ...g.key === 'done' && {open}}));
    const checklists = (s.checklists || []).map(cl => ({...cl, runs: this.keptRows(cl.runs || [])}));
    const project = s.project && (this.projById.get(s.project.id) || s.project);
    Object.assign(this.view, {loading: false, groups, cards: s.cards || {}, project: project || null, checklists, run: s.run || null, savedAt: s.at, listView: s.listView || null});
    // Restore the tasks' positions in the project's List view, unless this session has newer ones from a move.
    for (const [id, pos] of Object.entries(s.positions || {})) if (!(id in this.positions)) this.positions[id] = pos;
    if (r.name === 'today') this.regroupToday();
  },
  /* ---------- the other tabs, loaded in the background ---------- */
  /* Refresh cached Today, the last project or first favourite, and Checklists in the background when the phone is
     idle. Load project access first when needed. Read without changing Vikunja or visible rows. Skip offline, slow
     or Save-Data connections, fresh copies and screens still drawing their rows. */
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
        try { saved.set(k.key, {...await k.load(), at: new Date().toISOString()}); } catch { /* retried after the next screen loads */ }
      }
    } finally { preloading = false; }
  },
  // Describe a background load as {hash, key, load}. Keep Vikunja's task objects separate from those on screen.
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
  /* Collapse rows removed by a refresh and fade in new rows. Keep marked rows in place until their batch clears.
     Return whether this load is still current. */
  async settle(ids, seq){
    if (this.view.loading) return seq === renderSeq;
    const now = new Set(ids), shown = [...this.view.groups.flatMap(g => g.tasks), ...this.view.checklists.flatMap(cl => cl.runs || [])].map(t => t.id);
    const gone = shown.filter(id => !now.has(id) && !this.lines[id] && !this.leaving[id]), was = new Set(shown), arrived = ids.filter(id => !was.has(id));
    // Find the elements in one pass over the page, not once per removed row. Closing a project's Done section can
    // remove 2,000 rows.
    const out = new Set(gone.map(String));
    if (gone.length) await collapseRows([...document.querySelectorAll('#view :is(.row:not(.step-line), .day-card)[data-id]')].filter(el => out.has(el.dataset.id)));
    if (seq !== renderSeq) return false;
    if (arrived.length) this.flash(arrived, 'arrived');
    return true;
  },
  /* Keep marked and held rows through list refreshes until their batch clears. On Today, also keep their previous
     groups when repeating tasks have advanced to a new date in Vikunja. */
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
  /* Load Today's tasks and cards with their open subtasks before assigning date groups. */
  async readToday(){
    const end = addDays(startOfDay(), 8);
    const t0 = startOfDay();
    const q = new URLSearchParams({filter: `done = false && due_date < '${end.toISOString()}'`, filter_timezone: TZ, sort_by: 'due_date', order_by: 'asc', expand: 'comment_count'});
    const qNew = new URLSearchParams({filter: `done = false && created >= '${t0.toISOString()}'`, filter_timezone: TZ, sort_by: 'created', order_by: 'desc', expand: 'comment_count'});
    // Also open steps you claimed in a checklist someone else started. These may have no due date yet.
    const qMine = new URLSearchParams({filter: `done = false && assignees in ${this.user?.username}`, filter_timezone: TZ, expand: 'comment_count'});
    const [all, allAdded, {index: runs, mine, open = []}, claimed] = await Promise.all([allPages('/tasks?' + q), allPages('/tasks?' + qNew), this.loadRunIndex(),
      this.checklistIds.size && this.user ? allPages('/tasks?' + qMine).catch(() => []) : []]);
    const tasks = all.filter(t => this.inToday(t, runs)), added = allAdded.filter(t => this.inToday(t, runs));
    const theirs = claimed.filter(t => !isSet(t.due_date) && runs[this.stepRun(t)] === false);
    const {rows, cards} = todayItems({tasks, added, mine, claimed: theirs}, this.user, t => this.isRunTask(t));
    const read = cards.size ? await this.readCards(cards, [...tasks, ...added, ...mine, ...claimed, ...open]) : {parents: [], steps: [], positions: {}};
    return {rows, cards, ...read};
  },
  /* Group Today's tasks using own for either visible or background task objects. Place cards by what brought them
     onto Today, or use their original rows if the parent cannot be read. Return {groups, cards, steps, positions}. */
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
  /* Load open project tasks in List view order with subtasks under each parent. Count Done separately and load its
     rows when opened. Without a readable List view, use creation order and disable reordering. */
  async loadProject(seq, r){
    if (!this.projById.has(r.id)) await this.loadProjects();
    const p = this.projById.get(r.id), open = p && doneOpen.all()[p.id];
    this.view.project = p || null;
    if (!p) { this.view.groups = []; return; }
    // If the Done section is open, reload as many Done tasks as it shows now. A new visit has none yet, so it loads
    // the latest DONE_PART.
    const d = await this.readProject(p, open && Math.max(DONE_PART, this.view.groups.find(g => g.key === 'done')?.tasks.length || 0));
    if (seq !== renderSeq) return;
    for (const t of [...d.tasks, ...d.read]) cache.set(t.id, t);
    const groups = [{key: 'open', cls: '', title: 'Open', tasks: d.list.map(t => this.keep(t)), heads: d.heads}, this.doneGroup(d.finished, d.count, open)];
    // Animate Done rows as an opened section when replacing a count-only cache, rather than fading them in as new
    // tasks.
    const shown = this.view.groups.find(g => g.key === 'done'), quiet = g => g.key === 'done' && shown && !shown.loaded;
    if (!await this.settle(groups.flatMap(g => quiet(g) ? [] : g.tasks.map(t => t.id)), seq)) return;
    Object.assign(this.positions, d.positions);
    for (const e of this.pending) if (e.kind === 'act' && e.op === 'position') this.positions[e.task] = e.pos;   // a move made while loading
    Object.assign(this.view, {project: d.project, listView: d.listView, groups: this.keepMarked(groups)});
    saved.set('project.last', p.id);                            // preloads now loads this project in the background
    this.saveProject();
    if (open && !d.finished) this.loadDoneSection(this.view.groups[1]);
  },
  /* Read project tasks, missing parent headings, positions and Done counts from Vikunja. Include up to withDone
     completed tasks when requested. */
  async readProject(p, withDone){
    const q = {filter_timezone: TZ, expand: 'comment_count'}, id = p.id;
    /* Use Vikunja's Done count outside checklist projects. Checklist projects need their tasks loaded first to
       exclude template and checklist steps. */
    const count = this.checklistIds.has(id) ? null : api(`/projects/${p.id}/tasks?` + new URLSearchParams({filter: 'done = true', per_page: 1})).then(d => d?.total ?? null, () => null);
    const done = withDone ? this.doneTasks(p, 0, withDone).catch(() => null) : null;
    let lv = listViewOf(p), tasks = null;
    // Look up project views again once if the cached List view was removed or cannot be read.
    for (let tries = 0; lv && !tasks && tries < 2; tries++) {
      try { tasks = await allPages(`/projects/${p.id}/views/${lv.id}/tasks?expand=subtasks&` + new URLSearchParams(q)); }
      catch (e) {
        if (!(e instanceof ApiError && [403, 404].includes(e.status))) throw e;
        await this.loadProjects(); p = this.projById.get(id) || p;
        const again = listViewOf(p); lv = again && again.id !== lv.id ? again : null;
      }
    }
    if (!tasks) { lv = null; tasks = await allPages(`/projects/${p.id}/tasks?` + new URLSearchParams({...q, filter: 'done = false'})); }
    /* Show a completed parent above its remaining open subtasks, reading missing parents in one request. Active
       checklists also show their steps as cards. Finished checklists belong in Done, and their unfinished steps
       stay off the open list. */
    const shown = this.onProjectList(tasks), headIds = doneParentIds(shown, p.id), given = new Map(tasks.map(t => [t.id, t])), missing = headIds.filter(id => !given.has(id));
    const read = missing.length ? await allPages('/tasks?' + new URLSearchParams({...q, filter: 'id in ' + missing.join(', ')})).catch(() => []) : [];
    const named = id => tasks.flatMap(t => t.related_tasks?.parenttask || []).find(x => x.id === id);
    const heads = headIds.map(id => given.get(id) || read.find(t => t.id === id) || named(id));
    const [n, finished] = await Promise.all([count, done]);
    // The List view returns each open task's subtasks, including done ones. Done subtasks belong in the Done section.
    const list = [...shown.filter(t => !t.done), ...heads], positions = {};
    if (lv) {
      for (const t of tasks) positions[t.id] = t.position || 0;
      // Place a missing parent heading at its first open subtask because completed parents have no readable
      // position in the view.
      for (const h of heads.filter(h => !given.has(h.id))) {
        const at = Math.min(...list.filter(t => !t.done && (t.related_tasks?.parenttask || []).some(x => x.id === h.id)).map(t => positions[t.id] || Infinity));
        positions[h.id] = at < Infinity ? at : 0;
      }
      // Use the positions that moves still waiting to be sent will give.
      for (const e of this.pending) if (e.kind === 'act' && e.op === 'position') positions[e.task] = e.pos;
    }
    return {project: p, listView: lv?.id || null, tasks, read, list, heads: headIds, positions, count: n, finished};
  },
  /* Build the Done section from a loaded part and total count, using own for row objects. Show the latest
     DONE_PART and offer another part at the end. */
  doneGroup(part, count, open, own = t => this.keep(t)){
    return {key: 'done', cls: 'done-sec', title: 'Done', fold: true, open: !!open, loading: false, loaded: !!part, per: DONE_PART, skip: part?.skip || 0,
      count: part ? counted(part, part.skip, count) : count, tasks: (part?.tasks || []).map(own)};
  },
  /* Load n completed tasks from index from, newest first, returning {tasks, total, skip}. Exclude templates and
     template or checklist steps before paging. Read all tasks in checklist projects so their pages and counts include
     only eligible Done rows. */
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
  // Open or close the Done section, loading it the first time it opens. Pocket remembers each project's choice.
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
      this.drawFrom(this.listGroups.find(x => x.key === 'done')?.before ?? 0);   // draw the first rows now and the rest in batches
      Object.assign(g, {tasks: part.tasks.map(t => this.keep(t)), loaded: true, per: DONE_PART, skip: part.skip, count: counted(part, part.skip, g.count)});
      this.saveProject();
    } catch (e) { g.open = false; this.say('Couldn\'t load the done tasks: ' + why(e), {place: 'done', cls: 'failed'}); }
    finally { g.loading = false; }
  },
  /* Describe the next Done page as {title, note}. Return null when all rows are shown or the section has not
     loaded. */
  moreOf(key){
    const g = this.view.groups.find(x => x.key === key);
    return g?.per && g.loaded !== false && typeof g.count === 'number' ? moreDone(g.count - g.tasks.length, g.per) : null;
  },
  /* Load the next part after the current list, counting excluded rows in the offset and omitting duplicates. Draw
     the new rows in batches. Keep focus on Show more, or move it to the first new row when the button disappears.
     New visits start at the latest part. */
  async showMore(key){
    const g = this.view.groups.find(x => x.key === key), p = this.view.project, s = this.searchQ.trim(), at = g?.tasks.length;
    if (!g || this.showingMore || !this.moreOf(key)) return;
    this.showingMore = key;
    try {
      const part = this.route.name === 'search' ? await this.foundDone(s, at + g.skip) : await this.doneTasks(p, at + g.skip);
      if (this.view.groups.find(x => x.key === key) !== g) return;                 // the group was replaced meanwhile by another screen or a reload
      const have = new Set(g.tasks.map(t => t.id)), add = part.tasks.filter(t => !have.has(t.id));
      this.drawFrom((this.listGroups.find(x => x.key === key)?.before ?? 0) + g.tasks.length);
      g.skip += part.skip; g.count = counted(part, g.skip, g.count);
      g.tasks.push(...add.map(t => this.keep(t)));
      if (add.length && !this.moreOf(key)) this.$nextTick(() => document.querySelector(`#view .row[data-id="${add[0].id}"] > button.body`)?.focus({preventScroll: true}));
    } catch (e) { this.say('Couldn\'t load the done tasks: ' + why(e), {place: 'more', cls: 'failed'}); }
    finally { this.showingMore = null; }
  },
  // Cache the visible project with its List view positions for offline opening.
  saveProject(){
    const p = this.view.project;
    if (!p || this.route.name !== 'project') return;
    const groups = keptGroups(this.view.groups), ids = groups.flatMap(g => g.tasks.map(t => t.id)).filter(id => id in this.positions);
    saved.set(viewKey(this.route), {groups, project: p, listView: this.view.listView, at: new Date().toISOString(),
      positions: Object.fromEntries(ids.map(id => [id, this.positions[id]]))});
  },
  /* Check for a newer Pocket alongside refreshes. Reload only when no drafts or actions would be lost, otherwise
     try on the next refresh or return. The server answers the version check in a few bytes. */
  async updateIfNew(){
    if (!LOADED || !this.signedIn || this.screen !== 'app') return;
    let res;
    // eslint-disable-next-line no-restricted-globals -- Pocket's own page, not Vikunja's API
    try { res = await fetch(new URL('.', location.href), {cache: 'no-store', headers: {'If-Modified-Since': LOADED.toUTCString()}}); }
    catch { return; }                                                          // offline, so there is nothing to check
    if (res.status !== 200) return;
    const busy = this.sheet.open || this.cap.text.trim() || this.runInsert.text.trim() || this.capPhotos.length || this.cap.busy || this.searchQ || this.movingOverdue || this.starting
      || this.pending.length || pendingSaves;
    if (!busy) location.reload();
  },
  async refresh(){
    this.updateIfNew();
    this.refreshing = true;
    this.people = null; this.access = {}; this.userKnown = {}; this.labelsLoaded = false;   // sharing and labels may have changed too
    // Reload the user's settings and the server's info (for example reminder emails), which may have changed in Vikunja
    // since Pocket opened.
    api('/user').then(u => { if (u?.id === this.user?.id) { this.user = u; saved.set('user', u); } }, () => {});
    api('/info', {auth: false}).then(i => { if (i) { this.info = i; saved.set('info', i); } }, () => {});
    try { await this.loadProjects(); await this.render(); } catch (e) { this.notify(e.message); } finally { this.refreshing = false; }
  },

  /* ---------- search ---------- */
  // Open search from the magnifier. The search box is focused inside the tap, because a phone opens its keyboard only
  // for focus set during a tap.
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
  /* Search titles, notes or task numbers. Show open tasks soonest first and page completed matches newest first.
     Exclude templates and their steps. Load open subtasks, assignees and positions for collapsed parent cards. */
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

  /* Load n completed search matches from index from, returning {tasks, list, total, skip} like doneTasks. */
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
  // Create a project from the New project sheet, inside another project if one is picked, and as a checklists project
  // if asked. Then open it.
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
      // The user is the admin (2) of a project they just created. Getting started shows only for a project's admin.
      if (np.checklists) { this.perms[p.id] = 2; saved.set('perms', this.perms); }
      // Open the new project, which shows it was created. A checklists project opens Checklists, where Getting started
      // says what to do next.
      this.go(np.checklists ? '#/checklists' : '#/project/' + p.id);
      if (np.checklists) this.say(`Created ${p.title}, for checklists.`, {place: 'checklists'}); else this.said = `Created ${p.title}`;
    } catch (e) {
      np.busy = false;
      this.say(e instanceof NetError ? 'Offline. You can create a project once you\'re back online.' : 'Not created: ' + e.message, {place: 'sheet:top', cls: 'failed'});
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
