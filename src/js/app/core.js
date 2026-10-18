// The Alpine component's data, and what Pocket does when it opens. Its methods are in the other files of app/.
import { grow, setApp, store, taskDrafts } from '../util.js';
import { sharedToken } from '../api.js';
import { currentRoute } from '../routing.js';
import { saved } from '../lists.js';
import { noneWaiting } from '../ops/index.js';

/* Share mutable state across app modules because a module cannot assign to another module's variable.
   onClosedSheet and closedAt identify a closed sheet's history entry. */
export const shared = { onClosedSheet: false, closedAt: '' };
// Every add box tracks its text, focus, cursor, disabled chips, list nesting, reminder and sending state. `adding`
// counts subtask batches still being sent.
export const newBox = () => ({
  text: '',
  focus: false,
  caret: 0,
  ignore: {},
  nest: false,
  flat: false,
  remind: false,
  busy: false,
  adding: 0,
});
// Give a template's add box the same row state as a step, with key '+'.
export const newStepBox = () => ({ ...newBox(), key: '+', keep: false, from: null });
export const blankSheet = kind => ({
  open: false,
  show: false,
  kind,
  loading: false,
  error: '',
  id: null,
  title: '',
  savedMsg: '',
  dirty: false,
  titleEdit: false,
  menu: false,
  editingDesc: false,
  descDraft: '',
  descBase: null,
  descConflict: null,
  descUnsaved: false,
  comments: null,
  commentsNote: '',
  commentDraft: '',
  commentBusy: false,
  sub: newBox(),
  assigning: false,
  assignName: '',
  project: null,
  start: null,
  subView: null,
  subAt: null,
  subAfter: null,
  subEnd: false,
  remindAt: false,
  checklistBusy: false,
  newTpl: null,
  addRows: [],
  addBox: newStepBox(),
  newProj: null,
  runEdit: null,
  stepEdit: null,
  asksEdit: null,
  from: null,
  projEdit: null,
  complete: null,
  lines: {},
}); // a place in the sheet ("notes") -> its message (lines.js)

export default () => ({
  // session
  server: location.origin, // Pocket is served by Vikunja itself (the plugin), so this is the server
  signedIn: false,
  ssoWindow: null, // the tab a single sign-on is happening in
  info: null,
  user: null,
  screen: '', // 'login' | 'app'
  login: { user: '', pass: '', totp: '', showTotp: false, err: '', busy: false, waiting: false },
  // data
  projects: [],
  projById: new Map(),
  checklistProjects: [],
  checklistIds: new Set(), // the projects for checklists, and their ids (setProjects)
  labels: [],
  labelsLoaded: false,
  tasks: {}, // the tasks on screen, one copy of each, by id (tasks.js)
  positions: {}, // task id -> its position in its project's List view, as last read or moved (order.js)
  // view
  route: currentRoute(),
  // cards maps Today's task ids to cards and what brought them onto Today. listView identifies the project view
  // whose order Pocket reads and writes. savedAt dates the cached screen. updating marks a background reload, and
  // behind shows when it takes over a second.
  view: {
    route: null,
    loading: true,
    error: '',
    bootFailed: false,
    groups: [],
    cards: {},
    project: null,
    savedAt: null,
    checklists: [],
    shownRun: null,
    listView: null,
    updating: false,
    behind: false,
  },
  // Draw long screens in batches, tracking the row limit and whether drawing is still in progress.
  drawTo: Infinity,
  drawing: false,
  refreshing: false,
  headerTucked: false, // the header has slid away while scrolling down
  searchQ: '',
  searchFrom: '', // what's typed in the search box, and the screen to go back to
  // Quick add and the sheet's subtask box share the same state and parsing methods.
  cap: newBox(),
  cursor: null, // the highlighted row quick add targets, as {id, under, wait} (quickadd.js)
  lit: {}, // id of the highlighted row -> true, so that row can read it (quickadd.js)
  shown: { at: '', groups: {} }, // the screen's lists, with stable objects while this screen is open (shownGroups, sending.js)
  // access maps <project id>:<username> to whether that person can see the project. userKnown records whether the
  // user exists.
  access: {},
  userKnown: {},
  people: null, // everyone you share a project with: [{user, pids}], loaded once signed in (loadPeople)
  // Cache how many other people can see each project, by project id, so private projects hide claim slots as soon
  // as Today opens. loadPeople refreshes these counts.
  seenBy: saved.get('seenBy') || {},
  sheet: blankSheet(''),
  picker: { open: false, loading: false, error: '', q: '' },
  toast: { show: false, msg: '', action: null, more: null, until: 0 },
  offline: false, // the last request couldn't reach Vikunja
  creatingProject: false,
  settingUp: false, // Set up checklists is making the project and its example
  startedHidden: (() => {
    try {
      return JSON.parse(store.get('started.hidden')) || {};
    } catch {
      return {};
    }
  })(), // project id -> Getting started hidden
  capPhotos: [], // photos to attach to the task in the add box (File objects)
  // Highlight tasks just added, just due or new on refresh. Index each kind by task id so one highlight redraws
  // only that row.
  flashed: { fresh: {}, due: {}, arrived: {} },
  movingOverdue: false, // "Move all to today" is saving
  showingMore: null, // key of the done list whose next batch is loading (showMore, views.js)
  pending: [], // this user's outbox entries, for the Outbox's rows
  failed: [], // outbox entries Vikunja refused, kept to retry or discard (outbox.js)
  leaving: {}, // task id -> 'done', 'open' or 'deleted': marked, in place until the batch clears (leaving.js)
  lines: {}, // task id -> the message in its row's place (lines.js)
  cardPage: {}, // a checklist card's id -> its pinned top step (pinCard, cards.js)
  cardAdded: {}, // task id -> subtasks added on Today this visit, as {id, after}, with null after for the top (cardRows)
  cardOpen: {}, // a card's id -> true, opened by its footer's More, on Today or in search
  slideClaim: {}, // task id -> temporary claim during a progress gesture (claimOnSlide)
  // The waiting files by task id, and the tasks with a slow op under that op's key, so rows read only their own state.
  waiting: noneWaiting(),
  opsOn: {}, // task id -> the ops waiting in the outbox that change it, in the order they will be sent (keyOps, tasks.js)
  // Track the swipe hint's row, whether to pick a row on the next screen, and whether this phone has dismissed the
  // hint.
  hint: { at: null, pick: false, done: store.get('hint.slide') === 'done' },
  places: {}, // a named spot on the screen ("overdue", "cap") -> its message (lines.js)
  said: '', // the latest message, which a screen reader announces
  waitShown: false, // an outbox entry has waited long enough to show the header's waiting button
  slow: [], // ids of outbox entries that have waited a while and show as waiting (sending.js)
  dropping: [], // keys of waiting files being cancelled, hidden meanwhile
  flushing: false,
  writing: 0, // changes on their way to Vikunja (api.js)
  unsent: null, // this user's outbox entries, including held and rejected entries, or null before loading
  starting: null, // a checklist being started, with its progress: {id, done, total}
  runFrom: '', // the last screen that wasn't a checklist, for the checklist's Back
  runInsert: newBox(), // the add box at the bottom of a checklist's screen (quick add's 'ins')
  runBoxAt: null, // step the add box is under on a checklist's screen, null for the bottom (runAim, runs.js; seatFoot, sheet.js)
  runBoxEnd: false, // that step is the last one, so the box at the bottom is already under it
  runDrafts: taskDrafts.get('run') || {}, // notes being written on a checklist or its steps: task id -> text
  perms: saved.get('perms') || {}, // project id -> your access to it, as Vikunja's max_permission: 0 read, 1 write, 2 admin
  projectFrom: '', // the last screen that wasn't a project or a run, for a project's Back
  clock: Date.now(), // the current time, updated every second while a checklist is on screen
  // runNow advances only when time changes what the checklist shows, so an idle checklist does not redraw every
  // second. runMemo caches the computed run. runG keeps one options object for step rows, and only its `at` changes,
  // when the card's step changes.
  runNow: Date.now(),
  runMemo: null,
  runG: { depth: {}, run: true, at: null, locked: false },
  todayDay: 0, // the day Today's groups were loaded for (alerts.js)
  groupedAt: 0, // when Today's tasks were last grouped, for the heading's date
  avatars: saved.get('avatars') || {}, // username -> {url, at}: people's pictures (claims.js)

  init() {
    setApp(this);
    window.addEventListener('hashchange', () => this.navigated());
    /* Give an open sheet its own history entry so Back closes it and keeps its drafts. When another control closes
       the sheet, mark the entry closed so Back can skip the duplicate screen. */
    window.addEventListener('popstate', () => {
      if (this.sheet.open && this.sheet.show && !history.state?.sheet) {
        this.closeSheet();
        return;
      }
      // Skip a closed sheet's duplicate entry only at the same address. A changed address may be a screen opened
      // by a link.
      if (shared.onClosedSheet && !history.state?.sheet && location.href === shared.closedAt) {
        shared.onClosedSheet = false;
        history.back();
        return;
      }
      shared.onClosedSheet = history.state?.sheet === 'closed';
      shared.closedAt = location.href;
    });

    // Links inside Pocket go through go(), so each screen is an entry the phone's Back returns through.
    document.addEventListener('click', e => {
      const a = e.target.closest?.('a[href^="#/"]');
      if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      this.go(a.getAttribute('href'));
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.sessionChanged(); // e.g. back from signing in
      if (this.signedIn && this.screen === 'app') this.catchUp();
      if (this.signedIn && this.screen === 'app' && !this.sheet.open) {
        this.render();
        this.updateIfNew();
      }
    });
    // Vikunja's web app (or a sign-in in another tab) changed the shared session.
    window.addEventListener('storage', e => {
      if (e.key === 'token' || e.key === null) this.sessionChanged();
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    window.addEventListener('online', () => this.flush());
    // Show pending entries as waiting immediately when the connection is lost, and catch up once it is back.
    this.$watch('offline', v => {
      this.markSlow();
      if (!v) this.catchUp();
    });
    // Expose sending state on the page so tests can wait until all changes reach Vikunja.
    Alpine.effect(() => {
      document.documentElement.dataset.sync = this.syncState;
    });
    // Clear marked rows and send held deletions when Pocket is hidden or closed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.foldLines();
        this.sendHeld();
      }
    });
    addEventListener('pagehide', () => {
      this.foldLines();
      this.sendHeld();
    });
    // Ending a toast also ends its Undo and sends any deletion waiting for that Undo.
    this.$watch('toast.show', v => {
      if (!v) this.toastGone(this.toast);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.flush();
    });
    setInterval(() => {
      if (this.pending.length && document.visibilityState === 'visible') this.flush();
    }, 30000);
    setInterval(() => {
      if (this.route.name === 'run' && document.visibilityState === 'visible') this.clock = Date.now();
      this.tickRun();
    }, 1000);
    setInterval(() => this.tickToday(), 60000);
    // Reload the visible run every 20 seconds to show steps completed by teammates.
    setInterval(() => {
      if (
        this.route.name === 'run' &&
        document.visibilityState === 'visible' &&
        !this.sheet.open &&
        !this.offline &&
        !this.view.loading
      )
        this.render();
    }, 20000);
    // Reset disabled chips when an add box is emptied.
    this.$watch('cap.text', v => {
      if (!v.trim()) {
        this.cap.ignore = {};
        this.cap.nest = false;
        this.cap.flat = false;
        this.cap.remind = false;
      }
    });
    this.$watch('sheet.sub.text', v => {
      if (!v.trim()) {
        this.sheet.sub.ignore = {};
        this.sheet.sub.remind = false;
      }
    });
    this.$watch('runInsert.text', v => {
      if (!v.trim()) this.runInsert.ignore = {};
    });
    // Announce changes to quick add's target on a project list after any sheet closes. Run screens announce their
    // card's step separately.
    this.$watch(
      () => !this.sheet.open && this.capTargetText,
      (v, was) => {
        if (this.route.name === 'project' && v !== false && (v || was)) this.said = v || this.capPlaceholder;
      },
    );
    // If the target row leaves the list, move quick add to its parent.
    this.$watch(
      () => !this.sheet.open && !!this.cursor && !this.cursorTask,
      gone => {
        if (gone) this.keepAim();
      },
    );
    // Keep the add box under its target row, or return it to the bottom.
    this.$watch(
      () => this.boxSeat?.key || '',
      () => this.seatBox(),
    );
    // Save drafts as they change so closing Pocket keeps unfinished text.
    this.$watch('runDrafts', v =>
      taskDrafts.set('run', Object.fromEntries(Object.entries(v).filter(([, x]) => x?.trim()))),
    );
    for (const [k, get] of [
      ['comment', () => this.sheet.commentDraft],
      ['sub', () => this.sheet.sub.text],
    ])
      this.$watch(get, v => {
        const id = this.sheet.id;
        if (this.sheet.kind === 'task' && id != null) taskDrafts.set(k + ':' + id, v);
      });
    this.$watch(
      () => (this.sheet.editingDesc ? this.sheet.descDraft : null),
      v => {
        const t = this.sheetTask;
        if (v !== null && t && this.sheet.kind === 'task')
          taskDrafts.set(
            'desc:' + this.sheet.id,
            v.trim() !== this.notesText(t).trim() ? { text: v, base: this.sheet.descBase } : null,
          );
      },
    );
    this.$watch(
      () => this.sheet.kind === 'newtpl' && this.sheet.newTpl,
      nt => {
        if (nt && !nt.made)
          taskDrafts.set('newtpl:' + nt.project.id, {
            name: nt.box.text,
            rows: nt.rows.map(r => ({ text: r.text, keep: r.keep, ignore: r.ignore })),
            add: nt.add.text,
          });
      },
    );
    this.$watch(
      () => this.sheet.kind === 'task' && this.checklistRole === 'template' && this.sheet.addBox.text,
      text => {
        if (text !== false) taskDrafts.set('addsteps:' + this.sheet.id, text.trim() ? [{ text }] : null);
      },
    );
    // Search once typing pauses.
    let searchTimer;
    this.$watch('searchQ', () => {
      clearTimeout(searchTimer);
      if (this.route.name === 'search') searchTimer = setTimeout(() => this.render(), 250);
    });
    // Each x-box directive handles its own suggestions and debounced username lookups (component.js).
    this.$nextTick(() => {
      this.initSwipe();
      this.initBatch();
      this.initProgressDrag();
      this.initSheetProgress();
      this.initHeader();
      // Match the list's bottom padding to the capture bar's height. While the box is in the list, use the height
      // of its placeholder at the bottom.
      const home = document.getElementById('cap-home'),
        bottom = new ResizeObserver(() => {
          const bar = this.$refs.captureBar,
            h = bar.classList.contains('inline') ? home.offsetHeight || null : bar.offsetHeight;
          if (h !== null) document.documentElement.style.setProperty('--cap-h', h + 'px');
        });
      bottom.observe(this.$refs.captureBar);
      bottom.observe(home);
      // Refit text boxes after rotation or keyboard resizing changes their width, and realign quick add's
      // highlights.
      const refit = () => {
        for (const id of ['in-capture', 'd-subin', 'run-in', 'd-desc-in']) {
          const el = document.getElementById(id);
          if (el?.offsetParent) {
            grow(el);
            el.dispatchEvent(new Event('scroll'));
          }
        }
      };
      (window.visualViewport || window).addEventListener('resize', refit);
      addEventListener('orientationchange', () => setTimeout(refit, 300));
      /* Keep fixed controls above a keyboard that overlays the page. --kb measures the covered area after panning,
         --kb-h reserves the keyboard's full height at the end of scrollers, and --vv-h limits text boxes to the
         visible height. When the keyboard resizes the page instead, both keyboard offsets are zero. */
      const vv = window.visualViewport;
      if (vv) {
        const kb = () => {
          const root = document.documentElement.style;
          root.setProperty('--kb', Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) + 'px');
          root.setProperty('--kb-h', Math.max(0, Math.round(innerHeight - vv.height)) + 'px');
          root.setProperty('--vv-h', Math.round(vv.height) + 'px');
        };
        vv.addEventListener('resize', kb);
        vv.addEventListener('scroll', kb);
        kb();
      }
    });
    if (sharedToken.get()) this.boot();
    else {
      this.showLogin('');
      this.probe();
    }
  },
});
