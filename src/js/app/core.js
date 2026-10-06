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
// pasted list goes under its first line, whether the 🔔 chip is on, and whether it's sending.
const newBox = () => ({text: '', focus: false, caret: 0, ignore: {}, nest: false, remind: false, busy: false});
export const blankSheet = kind => ({open: false, show: false, kind, loading: false, error: '', task: null, title: '', savedMsg: '', dirty: false,
  pct: null, menu: false, editingDesc: false, descDraft: '', descBase: null, descConflict: null, descUnsaved: false, comments: null, commentsNote: '', commentDraft: '', commentBusy: false, sub: newBox(), subBusy: false, assigning: false, assignName: '',
  project: null, start: null, subPeople: {}, remindAt: false, checklistBusy: false, newTpl: null, addRows: [], newProj: null, runEdit: null, stepEdit: null, from: null, projEdit: null});

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
  labels: [], labelsLoaded: false,
  // view
  route: currentRoute(),
  view: {route: null, loading: true, error: '', bootFailed: false, groups: [], project: null, savedAt: null, checklists: [], run: null},
  refreshing: false,
  headerTucked: false,                         // the header has slid away while scrolling down
  searchQ: '', searchFrom: '',                 // what's typed in the search box, and the screen to go back to
  // The quick add box at the bottom: its text, and what's been tapped off (chips) or picked (under the first line). The
  // subtask box in a task's sheet is the same kind of box: sheet.sub. Both are read by the box methods (quick add).
  cap: newBox(),
  // Who can see which project, for @username in quick add: access['<project id>:<name>'] is true or false once known,
  // and userKnown[name] whether that user exists. accessBlocked: an API token without Projects → Users search.
  access: {}, userKnown: {}, accessBlocked: false,
  people: null,                                // everyone you share a project with: [{user, pids}], loaded on the first @
  sheet: blankSheet(''),
  picker: {open: false, loading: false, error: '', q: ''},
  toast: {show: false, msg: '', action: null, more: null, until: 0},
  offline: false,                              // the last request couldn't reach Vikunja
  creatingProject: false,
  capPhotos: [],                               // photos to attach to the task in the add box (File objects)
  fresh: [],                                   // tasks just added: their rows light up briefly, to show where they went
  movingOverdue: false,                        // "Move all to today" is saving
  pending: [],                                 // this user's outbox entries, for the "Waiting to send" rows
  dropping: [],                                // keys of waiting files being cancelled, hidden meanwhile
  flushing: false,
  starting: null,                              // a run being set up: {id, done, total}, for its progress
  runFrom: '',                                 // the last screen that wasn't a run, for a run's Back
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
    // What's being written is kept on the phone as it's typed, so closing Pocket doesn't lose it.
    this.$watch('runDrafts', v => taskDrafts.set('run', Object.fromEntries(Object.entries(v).filter(([, x]) => x?.trim()))));
    for (const [k, get] of [['comment', () => this.sheet.commentDraft], ['sub', () => this.sheet.sub.text]])
      this.$watch(get, v => { const t = this.sheet.task; if (this.sheet.kind === 'task' && t) taskDrafts.set(k + ':' + t.id, v); });
    this.$watch(() => this.sheet.editingDesc ? this.sheet.descDraft : null, v => {
      const t = this.sheet.task;
      if (v !== null && t && this.sheet.kind === 'task') taskDrafts.set('desc:' + t.id, v.trim() !== this.notesText(t).trim() ? {text: v, base: this.sheet.descBase} : null);
    });
    this.$watch(() => this.sheet.kind === 'newtpl' && this.sheet.newTpl, nt => { if (nt && !nt.made) taskDrafts.set('newtpl:' + nt.project.id, {name: nt.name, rows: nt.rows}); });
    this.$watch(() => this.sheet.kind === 'task' && this.checklistRole === 'template' && this.sheet.addRows, rows => { if (rows) taskDrafts.set('addsteps:' + this.sheet.task.id, rows.some(r => r.text.trim()) ? rows : null); });
    // Search once typing pauses.
    let searchTimer;
    this.$watch('searchQ', () => { clearTimeout(searchTimer); if (this.route.name === 'search') searchTimer = setTimeout(() => this.render(), 250); });
    for (const w of ['cap', 'sub']) {
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
    });
    if (store.get('mode') === 'token' && store.get('token')) { this.mode = 'token'; this.token = store.get('token'); }
    if (this.mode === 'token' || sharedToken.get()) this.boot();
    else { this.showLogin(''); this.probe(); }
  },
});
