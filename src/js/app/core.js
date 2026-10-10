// The Alpine component's data, and what Pocket does when it opens. Its methods are in the other files of app/.
import {grow, setApp, store, taskDrafts} from '../util.js';
import {sharedToken} from '../api.js';
import {currentRoute} from '../routing.js';
import {saved} from '../lists.js';

/* What more than one part of the app changes. (A module can't assign to a variable of another module, so these are
   kept as properties of one object.)
     onClosedSheet: the history entry Pocket is on is a sheet's, closed now, at this address (closedAt).
     saveChain: changes to a task are saved one after another, in the order they were made. */
export const shared = {onClosedSheet: false, closedAt: '', saveChain: Promise.resolve()};
// An add box: its text, whether it has focus and where the cursor is (for suggestions), the chips tapped off, whether a
// pasted list goes under its first line, whether the 🔔 chip is on, whether it's sending, and how many lots of subtasks
// from it are on their way (addSubtasks).
export const newBox = () => ({text: '', focus: false, caret: 0, ignore: {}, nest: false, remind: false, busy: false, adding: 0});
export const blankSheet = kind => ({open: false, show: false, kind, loading: false, error: '', task: null, title: '', savedMsg: '', dirty: false,
  titleEdit: false, menu: false, editingDesc: false, descDraft: '', descBase: null, descConflict: null, descUnsaved: false, comments: null, commentsNote: '', commentDraft: '', commentBusy: false, sub: newBox(), subBusy: false, assigning: false, assignName: '',
  project: null, start: null, subPeople: {}, subLabels: {}, subView: null, remindAt: false, checklistBusy: false, newTpl: null, addRows: [], newProj: null, runEdit: null, stepEdit: null, from: null, projEdit: null, complete: null,
  lines: {}});                                 // a place in the sheet ("notes") -> its message (lines.js)

export default () => ({
  // session
  server: location.origin,                     // Pocket is served by Vikunja itself (the plugin), so this is the server
  mode: 'session',                             // 'session' (shared with Vikunja's web app) | 'token' (API token)
  token: '',                                   // the API token, in 'token' mode
  signedIn: false,
  ssoWindow: null,                             // the tab a single sign-on is happening in
  info: null, user: null,
  screen: '',                                  // 'login' | 'app'
  login: {method: 'token', user: '', pass: '', totp: '', token: '', showTotp: false, err: '', busy: false, waiting: false},
  // data
  projects: [], projById: new Map(),
  checklistProjects: [], checklistIds: new Set(),  // the projects for checklists, and their ids (setProjects)
  labels: [], labelsLoaded: false,
  tasks: {},                                   // the tasks on screen, one copy of each, by id (tasks.js)
  positions: {},                               // task id -> its position in its project's List view, as last read or moved (order.js)
  // view
  route: currentRoute(),
  // cards: Today's tasks shown as cards, by id: what brought each (cards.js)
  // listView: the id of the project's List view on screen, which its order is read from and moves are written to
  // savedAt: when the copy on screen was kept, while it's one kept on the phone; updating: it's being loaded afresh, behind
  // what's on screen; behind: that has taken over a second, which a line under the header says (views.js)
  view: {route: null, loading: true, error: '', bootFailed: false, groups: [], cards: {}, project: null, savedAt: null, checklists: [], run: null, listView: null, updating: false, behind: false},
  // How many of the screen's rows are drawn, and whether more are still to come, a batch at a time (drawFrom, views.js)
  drawTo: Infinity, drawing: false,
  refreshing: false,
  headerTucked: false,                         // the header has slid away while scrolling down
  searchQ: '', searchFrom: '',                 // what's typed in the search box, and the screen to go back to
  // The quick add box at the bottom: its text, and what's been tapped off (chips) or picked (under the first line). The
  // subtask box in a task's sheet is the same kind of box: sheet.sub. Both are read by the box methods (quick add).
  cap: newBox(),
  cursor: null,                                // on a project's list, the task quick add adds subtasks to: {id, after} (quickadd.js)
  // Who can see which project, for @username in quick add: access['<project id>:<name>'] is true or false once known,
  // and userKnown[name] whether that user exists. accessBlocked: an API token without Projects → Users search.
  access: {}, userKnown: {}, accessBlocked: false,
  people: null,                                // everyone you share a project with: [{user, pids}], loaded once signed in (loadPeople)
  // Project id -> how many people besides you can see it, kept on the phone and loaded again now and then (loadPeople),
  // so a claim slot shows only where someone else could take the task, from the moment Today opens (claimSlot).
  seenBy: saved.get('seenBy') || {},
  sheet: blankSheet(''),
  picker: {open: false, loading: false, error: '', q: ''},
  toast: {show: false, msg: '', action: null, more: null, until: 0},
  offline: false,                              // the last request couldn't reach Vikunja
  creatingProject: false,
  settingUp: false,                            // Set up checklists is making the project and its example
  startedHidden: (() => { try { return JSON.parse(store.get('started.hidden')) || {}; } catch { return {}; } })(),   // project id -> Getting started hidden
  capPhotos: [],                               // photos to attach to the task in the add box (File objects)
  flashed: {fresh: [], due: [], arrived: []},  // rows lit up for a moment: tasks just added, just come due, and new to the screen on a refresh (lines.js)
  movingOverdue: false,                        // "Move all to today" is saving
  showingMore: null,                           // the list of done tasks whose next part is being read: its key (showMore, views.js)
  pending: [],                                 // this user's outbox entries, for the "Waiting to send" rows
  failed: [],                                  // those Vikunja turned down, kept to try again or drop (outbox.js)
  deleting: [],                                // ids of tasks being deleted (removeTask), hidden from the lists meanwhile
  leaving: {},                                 // task id -> 'done', 'open' or 'deleted': marked, in place until the batch clears (leaving.js)
  swept: {},                                   // task id -> true: done by a full swipe, a gap with Undo in its place meanwhile (leaving.js)
  lines: {},                                   // task id -> the message in its row's place (lines.js)
  cardPage: {},                                // a run's card id -> the step a tick left on its top row (app/cards.js)
  cardOpen: {},                                // a card's id -> true, opened by its footer's More, on Today or in search
  slideClaim: null,                            // a task or step whose progress is being slid, which you'll be doing (claimOnSlide)
  // The one-time hint to swipe right (progress.js): the row (or card) it's on, on this screen; whether to pick one as
  // the screen is first drawn; and whether it has done its job, on this phone.
  hint: {at: null, pick: false, done: store.get('hint.slide') === 'done'},
  places: {},                                  // a place on the screen ("overdue", "cap") -> its message (lines.js)
  said: '',                                    // the last of those, for a screen reader
  waitShown: false,                            // something has waited a while: the header's button says so
  slow: [],                                    // ids of the outbox entries that have waited a while, which look waiting (sending.js)
  dropping: [],                                // keys of waiting files being cancelled, hidden meanwhile
  flushing: false,
  writing: 0,                                  // changes on their way to Vikunja (api.js, saveTask)
  unsent: null,                                // this user's outbox entries, held and turned down too; null until read
  starting: null,                              // a run being set up: {id, done, total}, for its progress
  runFrom: '',                                 // the last screen that wasn't a run, for a run's Back
  runInsert: newBox(),                          // the bottom box on a run's screen (quick add's 'ins'), apart from quick add's own text
  runAdded: null,                              // where the last steps from it went, which the next go after (runAim, runs.js)
  runDrafts: taskDrafts.get('run') || {},     // notes being written on a run or its steps: task id -> text
  perms: saved.get('perms') || {},             // project id -> your access to it, as Vikunja's max_permission: 0 read, 1 write, 2 admin
  projectFrom: '',                             // the last screen that wasn't a project or a run, for a project's Back
  clock: Date.now(),                           // now, every second while a run is on screen, for its countdowns
  todayDay: 0,                                 // the day Today's groups were loaded for (alerts.js)
  groupedAt: 0,                                // when they were last placed in groups, for the heading's date
  avatars: saved.get('avatars') || {},         // username -> {url, at}: people's pictures (claims.js)

  init(){
    setApp(this);
    window.addEventListener('hashchange', () => this.navigated());
    /* An open sheet has a history entry of its own, so the phone's Back closes the sheet (keeping what was written), not
       the screen under it. A sheet closed another way leaves its entry marked closed; Back from there would show the same
       screen, so it goes back once more, to the screen before. */
    window.addEventListener('popstate', () => {
      if (this.sheet.open && this.sheet.show && !history.state?.sheet) { this.closeSheet(); return; }
      // Back from a closed sheet's entry lands on the same screen, at the same address: once more. (A new address is a
      // screen opened another way, a link say, which also comes here.)
      if (shared.onClosedSheet && !history.state?.sheet && location.href === shared.closedAt) { shared.onClosedSheet = false; history.back(); return; }
      shared.onClosedSheet = history.state?.sheet === 'closed'; shared.closedAt = location.href;
    });

    // Links inside Pocket go through go(), so each screen is an entry the phone's Back returns through.
    document.addEventListener('click', e => {
      const a = e.target.closest?.('a[href^="#/"]');
      if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault(); this.go(a.getAttribute('href'));
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.sessionChanged();                                                  // e.g. back from signing in
      if (this.signedIn && this.screen === 'app' && !this.sheet.open) { this.render(); this.updateIfNew(); }
    });
    // Vikunja's web app (or a sign-in in another tab) changed the shared session.
    window.addEventListener('storage', e => { if (e.key === 'token' || e.key === null) this.sessionChanged(); });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    window.addEventListener('online', () => this.flush());
    // Without a connection, what's waiting looks it at once.
    this.$watch('offline', () => this.markSlow());
    // Where sending stands, on the page itself, so a test can wait until everything has reached Vikunja.
    Alpine.effect(() => { document.documentElement.dataset.sync = this.syncState; });
    // Rows marked done or deleted go as Pocket is put away or closed, and a deletion is sent, so it isn't left waiting.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { this.foldLines(); this.sendHeld(); } });
    addEventListener('pagehide', () => { this.foldLines(); this.sendHeld(); });
    // A message going, by its own timer or anything else, ends its Undo: a deletion waiting for it is sent then.
    this.$watch('toast.show', v => { if (!v) this.toastGone(this.toast); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.flush(); });
    setInterval(() => { if (this.pending.length && document.visibilityState === 'visible') this.flush(); }, 30000);
    setInterval(() => { if (this.route.name === 'run' && document.visibilityState === 'visible') this.clock = Date.now(); this.tickRun(); }, 1000);
    setInterval(() => this.tickToday(), 60000);
    // A run on screen is fetched again every 20 seconds, so a step a teammate ticked shows as done, by them.
    setInterval(() => { if (this.route.name === 'run' && document.visibilityState === 'visible' && !this.sheet.open && !this.offline && !this.view.loading) this.render(); }, 20000);
    // A date without a time is late only once its day is over; quick add gives it the user's default due time.
    // An emptied add box starts afresh: no chips tapped off.
    this.$watch('cap.text', v => { if (!v.trim()) { this.cap.ignore = {}; this.cap.nest = false; this.cap.remind = false; } });
    this.$watch('sheet.sub.text', v => { if (!v.trim()) { this.sheet.sub.ignore = {}; this.sheet.sub.remind = false; } });
    this.$watch('runInsert.text', v => { if (!v.trim()) this.runInsert.ignore = {}; });
    // What quick add's box adds to, said to a screen reader as it changes on a project's list: not behind a sheet, but
    // as the sheet that changed it closes. (On a run, the step card's step is said as it changes, and the box's label
    // names where a step goes.)
    this.$watch(() => !this.sheet.open && this.capTargetText, (v, was) => { if (this.route.name === 'project' && v !== false && (v || was)) this.said = v || this.capPlaceholder; });
    // What's being written is kept on the phone as it's typed, so closing Pocket doesn't lose it.
    this.$watch('runDrafts', v => taskDrafts.set('run', Object.fromEntries(Object.entries(v).filter(([, x]) => x?.trim()))));
    for (const [k, get] of [['comment', () => this.sheet.commentDraft], ['sub', () => this.sheet.sub.text]])
      this.$watch(get, v => { const t = this.sheet.task; if (this.sheet.kind === 'task' && t) taskDrafts.set(k + ':' + t.id, v); });
    this.$watch(() => this.sheet.editingDesc ? this.sheet.descDraft : null, v => {
      const t = this.sheet.task;
      if (v !== null && t && this.sheet.kind === 'task') taskDrafts.set('desc:' + t.id, v.trim() !== this.notesText(t).trim() ? {text: v, base: this.sheet.descBase} : null);
    });
    this.$watch(() => this.sheet.kind === 'newtpl' && this.sheet.newTpl, nt => { if (nt && !nt.made) taskDrafts.set('newtpl:' + nt.project.id, {name: nt.box.text, rows: nt.rows}); });
    this.$watch(() => this.sheet.kind === 'task' && this.checklistRole === 'template' && this.sheet.addRows, rows => { if (rows) taskDrafts.set('addsteps:' + this.sheet.task.id, rows.some(r => r.text.trim()) ? rows : null); });
    // Search once typing pauses.
    let searchTimer;
    this.$watch('searchQ', () => { clearTimeout(searchTimer); if (this.route.name === 'search') searchTimer = setTimeout(() => this.render(), 250); });
    // And the boxes that aren't in a list of rows: a run's insert box, a template's name and a step being changed.
    for (const w of ['cap', 'sub', 'under', 'ins', 'tname', 'edit']) {
      // Once typing pauses, find out whether each @username can see the task's project.
      let accessTimer;
      this.$watch(`accessQuery('${w}')`, q => { clearTimeout(accessTimer); if (q) accessTimer = setTimeout(() => this.checkAccess(w), 500); });
      // Starting an @username or *label: load what to suggest.
      this.$watch(`boxToken('${w}')`, tk => {
        if (tk?.kind === 'label') this.loadLabels().catch(() => {});
        if (tk?.kind === 'assignee') this.loadPeople().catch(() => {});
      });
    }
    this.$nextTick(() => {
      this.initSwipe();
      this.initBatch();
      this.initProgressDrag();
      this.initSheetProgress();
      this.initHeader();
      // Keep the list's bottom padding in step with the capture bar as it grows.
      new ResizeObserver(() => document.documentElement.style.setProperty('--cap-h', this.$refs.captureBar.offsetHeight + 'px')).observe(this.$refs.captureBar);
      // Turning the phone, or the keyboard opening or closing, changes the boxes' width: each fits its text again, and
      // quick add's highlights stay over the words they mark.
      const refit = () => { for (const id of ['in-capture', 'd-subin']) { const el = document.getElementById(id); if (el?.offsetParent) { grow(el); el.dispatchEvent(new Event('scroll')); } } };
      (window.visualViewport || window).addEventListener('resize', refit);
      addEventListener('orientationchange', () => setTimeout(refit, 300));
      /* The keyboard covers the bottom of the page without making it shorter (Chrome on Android and Safari on iPhone
         both do this), so what's fixed to the bottom, like the toasts, would be under it: --kb is how much it hides. */
      const vv = window.visualViewport;
      if (vv) {
        const kb = () => document.documentElement.style.setProperty('--kb', Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) + 'px');
        vv.addEventListener('resize', kb); vv.addEventListener('scroll', kb); kb();
      }
    });
    if (store.get('mode') === 'token' && store.get('token')) { this.mode = 'token'; this.token = store.get('token'); }
    if (this.mode === 'token' || sharedToken.get()) this.boot();
    else { this.showLogin(''); this.probe(); }
  },
});
