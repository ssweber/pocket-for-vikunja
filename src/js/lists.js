// How Pocket's lists are built, sorted and drawn, and the copies saved so Pocket can open without a connection.
import { store } from './util.js';
import { addDays, isLate, isSet, startOfDay } from './dates.js';
import { stepsOf } from './checklists.js';

// The lists Pocket last loaded, shown when it opens without a connection. Sign-out clears them.
export const saved = {
  get(k) {
    try {
      return JSON.parse(store.get('saved.' + k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    return store.set('saved.' + k, JSON.stringify(v));
  },
  clear() {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('pocket.saved.')) localStorage.removeItem(k);
    } catch {}
  },
};
/* A screen is saved as the ids of its tasks, and the store's copies, saved beside it, give the tasks (app/tasks.js).
   The store keeps the copies of the kept screens' tasks: Today, Checklists, the last KEPT_PROJECTS projects opened and
   the last KEPT_RUNS checklists opened. */
export const KEPT_PROJECTS = 5,
  KEPT_RUNS = 8;
const projectKey = id => viewKey({ name: 'project', id }),
  runKey = id => 'run.' + id;
export const keptScreens = () => [
  'today',
  'checklists',
  ...(saved.get('projects.recent') || []).map(projectKey),
  ...(saved.get('runs.recent') || []).map(runKey),
];
/* The kept screen saved on the phone whose tasks were loaded longest ago (its `at`), or undefined when none is saved.
   Each screen loads when it is opened, so this is usually the one opened longest ago. A screen with no time counts as
   oldest. */
export const oldestScreen = () => {
  let oldest,
    when = Infinity;
  for (const k of keptScreens()) {
    const s = saved.get(k),
      at = Date.parse(s?.at) || 0;
    if (s && at < when) [oldest, when] = [k, at];
  }
  return oldest;
};
/* Delete the saved screens of the projects and checklists no longer kept, and `project.last`, which nothing reads. A
   screen saved before it fell out of the kept lists, or saved under an older key, would stay on the phone for good. */
export const dropUnkept = () => {
  const kept = new Set(keptScreens().map(k => 'pocket.saved.' + k));
  try {
    for (const k of Object.keys(localStorage))
      if (/^pocket\.saved\.(project\.(\d+\..+|last)|run\.\d+)$/.test(k) && !kept.has(k)) localStorage.removeItem(k);
  } catch {}
};
// Put project or checklist `id` first among those last opened, and forget the saved screens of those no longer kept.
export const opened = (kind, id) => {
  const [list, n, key] =
      kind === 'run' ? ['runs.recent', KEPT_RUNS, runKey] : ['projects.recent', KEPT_PROJECTS, projectKey],
    ids = [id, ...(saved.get(list) || []).filter(x => x !== id)];
  for (const x of ids.slice(n)) store.del('saved.' + key(x));
  saved.set(list, ids.slice(0, n));
};
const idsOf = list => (list || []).map(t => t?.id ?? t);
// A screen as it is saved: its groups, its cards' steps and its checklists hold the ids of their tasks.
export const savedScreen = s => ({
  ...s,
  ...(s.groups && { groups: s.groups.map(g => ({ ...g, tasks: idsOf(g.tasks) })) }),
  ...(s.steps && { steps: idsOf(s.steps) }),
  ...(s.checklists && {
    checklists: s.checklists.map(cl => ({ ...cl, runs: idsOf(cl.runs), finished: idsOf(cl.finished) })),
  }),
});
/* The ids of the tasks saved screen `s` shows, with the templates Checklists lists, whose sheets open from their
   copies. A screen saved before screens were saved as ids holds whole tasks, and gives null, so it is ignored. */
export const screenIds = s => {
  if (!s) return [];
  const ids = [
    ...(s.groups || []).flatMap(g => [...(g.tasks || []), ...(g.left || []).map(l => l.id)]),
    ...(s.steps || []),
    ...(s.tasks || []),
    ...(s.checklists || []).flatMap(cl => [
      ...(cl.runs || []),
      ...(cl.finished || []),
      ...(cl.templates || []).map(t => t.id),
    ]),
    ...(s.shownRun ? [s.shownRun.id, ...(s.shownRun.steps || [])] : []),
  ];
  return ids.every(Number.isInteger) ? ids : null;
};
// Sort a list's open tasks. Dated tasks come first, soonest first. Undated tasks follow, sorted by priority and then
// newest first.
export const soonestFirst = tasks => [
  ...tasks.filter(t => isSet(t.due_date)).sort((a, b) => new Date(a.due_date) - new Date(b.due_date)),
  ...tasks.filter(t => !isSet(t.due_date)).sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.id - a.id),
];
/* A screen's row options, beyond what every row does (tick, claim, open, swipe progress):
   - `delete`: swiping left at 0% deletes the task.
   - `reorder`: holding a row lets the user drag it up or down. Only a project's list has this, because only it has
     an order.
   - `reschedule`: holding a row on Today moves it to another date (app/throw.js), because Today is ordered by date.
     Search results have no order, so holding a row there does nothing.
   - `clamp`: Today cuts each title to one line, so every row is the same height and the screen fits more rows.
   - `cards`: a task with open subtasks or steps is a stacked card (cardOf, app/cards.js). Cards are collapsed on
     Today ('today') and in search ('found'), and open on a project's list ('list'). A list of done tasks has none.
   A list's options live on its group `g`. Each row copies them onto its element for the gesture code (rowGestures).
   A task's sheet gives its subtasks delete and reorder in sheet/task.html. */
export const screenRows = name =>
  ({
    project: { cards: 'list', delete: true, reorder: true },
    search: { cards: 'found', delete: true },
    today: { cards: 'today', clamp: true, delete: true, reschedule: true },
  })[name] || {};
/* Options for a task's own row at the top of its sheet (sheet/task-card.html). The task can be deleted from there,
   which closes the sheet, but it can't be moved. `own` makes the row's tick, swipe and title act on the sheet's task.
   Under the title the row shows only OWN_META (due date, priority, repeats, next reminder). The task's project,
   checklist and parent are in the path above the row, and its labels, comments and files are in the sheet below. */
export const SHEET_ROW = { depth: {}, delete: true, own: true };
export const OWN_META = ['due', 'prio', 'rep', 'rem'];
/* Options for a checklist's own row at the top of its screen. It replaces the header's name and shows the ring, the
   name and who the checklist is for, with nothing under the name, so the top is no taller than the old header. `top`
   means the ring and the swipe finish the checklist (runRing, runRowGesture), and a tap opens its sheet. */
export const RUN_ROW = { depth: {}, top: true };
/* The rows of a list with cards. `tasks` and `depth` come from nestSubtasks. A card's subtasks are drawn on the card,
   so they are left out of the rows. The subtasks of any other task follow it as indented rows. */
export const listItems = (tasks, depth, isCard) => {
  const out = [];
  let under = -1; // the depth of the card whose subtasks are being skipped
  for (const t of tasks) {
    const d = depth[t.id] || 0;
    if (under >= 0 && d > under) continue;
    out.push(t);
    under = isCard(t) ? d : -1;
  }
  return out;
};
// A list's gesture options as a string for the row's data-gestures attribute. The gesture code (progress.js) reads the
// element and can't reach the list's `g`.
export const rowGestures = g => ['delete', 'reorder', 'reschedule'].filter(k => g?.[k]).join(' ');
// The ids of a task's parents. A task waiting to be sent has its parent in `parent`.
export const parentIds = t => (t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id));
/* Nest subtasks under their parents. Returns {tasks, depth, kids}:
   - `tasks` is the list with each subtask straight after its parent, when the parent is in the list.
   - `depth` maps a task id to how many parents it has above it in the list.
   - `kids` maps a task id to its subtasks, in order.
   The subtasks of a parent that `own` says has its own order (a template or checklist) follow its order line. When
   `order` is given (positionOrder, order.js), it sorts the top-level tasks and the other subtasks. Without it they
   stay in the order they came. */
export const nestSubtasks = (tasks, order = null, own = () => false) => {
  const ids = new Map(tasks.map(t => [t.id, t])),
    kids = new Map(),
    top = [];
  for (const t of tasks) {
    const p = parentIds(t).find(id => id !== t.id && ids.has(id));
    if (p === undefined) top.push(t);
    else kids.set(p, [...(kids.get(p) || []), t]);
  }
  for (const [p, list] of kids) {
    const parent = ids.get(p),
      mine = own(parent);
    if (order && !mine) {
      list.sort(order);
      continue;
    }
    const line = (mine ? stepsOf(parent) : parent.related_tasks?.subtask || []).map(s => s.id),
      at = t => {
        const i = line.indexOf(t.id);
        return i < 0 ? line.length : i;
      };
    list.sort((a, b) => at(a) - at(b));
  }
  if (order) top.sort(order);
  const out = [],
    depth = {};
  const walk = (t, d) => {
    if (t.id in depth) return;
    depth[t.id] = d;
    out.push(t);
    for (const k of kids.get(t.id) || []) walk(k, d + 1);
  };
  for (const t of top) walk(t, 0);
  for (const t of tasks) walk(t, 0); // tasks that are each other's subtasks have no top-level parent to follow
  return { tasks: out, depth, kids };
};
/* The ids of done parents that a project's open list shows anyway, struck through, above their open subtasks. Without
   them those subtasks would sit at the top level as if they had no parent. A parent can be done with open subtasks
   when it is ticked in Vikunja's web app, or when a subtask under it is reopened. `tasks` is what the List view
   returned: open tasks and their subtasks, including done ones. Only parents in project `pid` count. */
export const doneParentIds = (tasks, pid) => {
  const open = new Set(tasks.filter(t => !t.done).map(t => t.id)),
    out = new Set();
  for (const t of tasks)
    if (!t.done)
      for (const p of t.related_tasks?.parenttask || [])
        if (p.done && p.project_id === pid && !open.has(p.id)) out.add(p.id);
  return [...out];
};
/* A screen's groups as saved on the phone. A project's Done group keeps its count but not its tasks, which load when
   the group is opened. Saving thousands of done tasks would fill the phone's storage, and they would all be drawn on
   every open. */
export const keptGroups = groups =>
  groups.map(g => (g.key === 'done' ? { ...g, tasks: [], loaded: false, loading: false } : g));
/* Done tasks are shown a part at a time, most recently done first: DONE_PART in a project's Done, FOUND_PART among
   search's done matches, with a row at the end for the next part (moreOf, app/views.js). Nobody scrolls through
   thousands of done tasks. The user opens the list to untick one, or to see what was done lately. */
export const DONE_PART = 100,
  FOUND_PART = 50;
/* Rows are drawn in batches, so the first screenful takes the same time however long the lists are. FIRST_ROWS are
   drawn at once, enough to fill a phone. The rest are drawn after the first paint, list by list (drawFrom,
   app/views.js). drawnOf returns the part of `list` to draw when `to` rows of the screen are drawn and `before` rows
   come before this list. */
export const FIRST_ROWS = 20;
export const drawnOf = (list, before, to) =>
  to >= before + list.length ? list : list.slice(0, Math.max(0, to - before));
/* How much time a batch of rows gets, once `drawn` rows are on the screen. The first few screens (NEAR_ROWS) get one
   frame (FRAME_MS), because the user may scroll to them at once. After that a batch gets about a second (LATER_MS), so
   the rest is drawn in a few long batches, with taps and scrolls answered between them. Each frame has a fixed cost
   on a phone, so thousands of rows in small batches add up. Drawing 2,000 done tasks that way took twice as long as
   drawing them at once (measured at 4x CPU slowdown). */
export const FRAME_MS = 40,
  LATER_MS = 1000,
  NEAR_ROWS = 3 * FIRST_ROWS;
export const batchMs = drawn => (drawn < NEAR_ROWS ? FRAME_MS : LATER_MS);
// How many rows the next batch draws, from the last batch (`rows` rows in `ms`). It aims for about `budget` ms of work,
// with at least 4 rows and at most twice the last batch.
export const nextBatch = (rows, ms, budget) =>
  Math.max(4, Math.min(rows * 2, Math.round((rows * budget) / Math.max(ms, 1))));
/* Whether two groups from listGroups would draw the same. Every field must be equal. Lists are compared item by item,
   maps of lists (kids) list by list, and objects (depth) entry by entry. When the groups would draw the same, the
   group already drawn is kept, so a reload that changed nothing doesn't redraw any rows. */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameField = (a, b) =>
  a === b ||
  (Array.isArray(a)
    ? Array.isArray(b) && sameList(a, b)
    : a instanceof Map
      ? b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && sameField(v, b.get(k)))
      : !!a &&
        !!b &&
        typeof a === 'object' &&
        typeof b === 'object' &&
        !Array.isArray(b) &&
        !(b instanceof Map) &&
        sameKeys(a, b, (x, y) => x === y));
const sameKeys = (a, b, same) => {
  const ks = Object.keys(a);
  return ks.length === Object.keys(b).length && ks.every(k => k in b && same(a[k], b[k]));
};
export const sameGroup = (a, b) => !!a && !!b && sameKeys(a, b, sameField);
/* Copy `from` into `to`, a watched object, one entry at a time. A row that reads one entry by its id (g.depth[t.id],
   opsOn[t.id]) is then redrawn only when that entry changes. Replacing the whole object would redraw every
   row on the screen. */
export function intoKeys(to, from, raw = x => x) {
  const was = raw(to);
  for (const k of Object.keys(was)) if (!(k in from)) delete to[k];
  for (const k of Object.keys(from)) if (was[k] !== from[k]) to[k] = from[k];
  return to;
}
/* Write group `from` into `to`, the watched object the screen draws (shownGroups, app/sending.js). Only the fields
   that differ change, and `depth` and `kids` are written entry by entry. A row that reads g.cards, g.depth[t.id] or
   g.kids.get(t.id) is then redrawn only when that value changed. `raw` reads `to` without Alpine recording the reads.
   The comparison is not something a screen shows, so nothing should re-run when `to` changes. */
export function intoGroup(to, from, raw = x => x) {
  const was = raw(to);
  for (const k of Object.keys(was)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) {
    if (k === 'depth' && was.depth && v) intoKeys(to.depth, v, raw);
    else if (k === 'kids' && was.kids instanceof Map && v instanceof Map) {
      const m = raw(was.kids);
      for (const id of [...m.keys()]) if (!v.has(id)) to.kids.delete(id);
      for (const [id, list] of v) if (!m.has(id) || !sameField(raw(m.get(id)), list)) to.kids.set(id, list);
    } else if (!sameField(raw(was[k]), v)) to[k] = v;
  }
  return to;
}
export const viewKey = r =>
  r.name === 'project' ? `project.${r.id}.${r.showDone ? 'done' : 'open'}` : r.name === 'run' ? 'run.' + r.id : r.name;
/* A row moved to another date on Today leaves a gap where it was until the batch clears (leaveGap, app/actions.js).
   The gap is a placeholder among the group's rows, not the task, because every row of a task reads the same marks
   (`leaving`, `flashed`) by its id. Its id is its own, so its mark is too. */
export const isMovedGap = t => t.gapOf !== undefined;
// Whether task `t` has the label with id `id`.
export const hasLabel = (t, id) => !!t?.labels?.some(l => l.id === id);
/* Today can be narrowed to a project or a label (`only`, {kind: 'project' | 'label', id, title, hex_color}), and each
   can be set to show all, only the user's or none of its tasks there (`todayFilter`). todayKey names one in
   todayFilter: "p2" for project 2, "l5" for label 5. */
export const todayKey = o => (o.kind === 'project' ? 'p' : 'l') + o.id;
// Whether task `t` is in project or label `o`.
export const inOnly = (t, o) => (o.kind === 'project' ? t?.project_id === o.id : hasLabel(t, o.id));
/* The label a search is for, without its *: "errands" for "*errands" or `*"on hold"`, "" for "*" alone, and null for
   a search of titles and notes. */
export const searchedLabel = q => {
  if (!q.startsWith('*')) return null;
  return q
    .slice(1)
    .trim()
    .replace(/^"(.*)"$/, '$1');
};
export const projectGroupKey = id => 'project:' + id;
/* The open tasks with label `label`, as search shows them: a group for each project, named after it. `tasks` are
   soonest first, so the project with the soonest task comes first. */
export const projectGroups = (tasks, label, projById) => {
  const by = new Map();
  for (const t of tasks) by.set(t.project_id, [...(by.get(t.project_id) || []), t]);
  return [...by].map(([id, list]) => ({
    key: projectGroupKey(id),
    cls: '',
    title: projById.get(id)?.title || '',
    project: id,
    label,
    tasks: list,
  }));
};
/* The index of the gap a moved row left among its group's rows. The gap goes under the row that was above it
   (`after`), or at its old index (`at`) once that row has gone too. */
export const gapIndex = (tasks, { after, at }) => {
  const i = after === null ? 0 : tasks.findIndex(t => t.id === after) + 1;
  return i > 0 || after === null ? i : Math.min(at, tasks.length);
};
/* Sort comparisons for Today's groups. Overdue sorts by priority, then longest overdue first. Today and Next 7 days
   sort soonest first. "Added today, no date" sorts newest first, with tasks waiting to be sent (no `created`) before
   all the others. A task just added sorts where the next load will put it, not at the bottom. `at` returns the
   {due_date, created} to sort a task by, so a card can be sorted by the subtask that put it on Today (todayAt). */
const made = t => (t.created ? +new Date(t.created) : Infinity);
export const todayOrder = (at = t => t) => {
  const due = t => +new Date(at(t).due_date),
    born = t => made(at(t));
  return {
    overdue: (a, b) => (b.priority || 0) - (a.priority || 0) || due(a) - due(b),
    today: (a, b) => due(a) - due(b),
    week: (a, b) => due(a) - due(b),
    nodate: (a, b) => born(b) - born(a),
  };
};
/* Which of Today's groups a task due `due` goes in: 'overdue', 'today', 'week' (the next 7 days), null for 8 or more
   days ahead, or 'nodate'. Every place that sorts a date into Today's groups asks here, so a waiting row and the same
   task once sent land in the same group. addDays, not 24 hours, finds each midnight, so a 23- or 25-hour day is right. */
export const TODAY_DAYS = 8;
export function dayGroup(due, now = new Date()) {
  if (!isSet(due)) return 'nodate';
  if (isLate(due, now)) return 'overdue';
  const d = new Date(due),
    t0 = startOfDay(now);
  return d < addDays(t0, 1) ? 'today' : d < addDays(t0, TODAY_DAYS) ? 'week' : null;
}
// The dates Today sorts a task by. A card uses the dates of the subtask that put it on Today (`cards` by task id, from
// todayItems). Any other task uses its own.
export const todayAt =
  (cards = {}) =>
  t =>
    cards[t.id] ? { due_date: cards[t.id].when, created: cards[t.id].made || t.created } : t;
// Today's groups. "Added today, no date" shows tasks added without a date until midnight, so they don't vanish into a
// project. "Done today" is folded at the bottom, as a project's Done is (doneByMe, app/views.js).
export const todayGroups = () => [
  { key: 'overdue', cls: 'overdue', title: 'Overdue', tasks: [] },
  { key: 'today', cls: 'today', title: 'Today', tasks: [] },
  { key: 'runs', cls: '', title: 'Checklists', tasks: [] },
  { key: 'nodate', cls: '', title: 'Added today, no date', tasks: [] },
  { key: 'week', cls: '', title: 'Next 7 days', tasks: [] },
  { key: 'donetoday', cls: 'done-sec', title: 'Done today', fold: true, open: false, tasks: [] },
];
