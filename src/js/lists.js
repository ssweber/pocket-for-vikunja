// How Pocket's lists are built, ordered and drawn, and the copies kept for opening without a connection.
import {store} from './util.js';
import {isSet} from './dates.js';
import {hasOwnOrder, stepsOf} from './checklists.js';

// The lists Pocket last loaded, shown when it opens without a connection. Cleared on sign-out.
export const saved = {
  get(k){ try { return JSON.parse(store.get('saved.' + k)); } catch { return null; } },
  set(k, v){ store.set('saved.' + k, JSON.stringify(v)); },
  clear(){ try { for (const k of Object.keys(localStorage)) if (k.startsWith('pocket.saved.')) localStorage.removeItem(k); } catch {} },
};
// Open tasks in a list: dated first, soonest first, then undated, by priority and then newest first.
export const soonestFirst = tasks => [...tasks.filter(t => isSet(t.due_date)).sort((a,b) => new Date(a.due_date) - new Date(b.due_date)),
  ...tasks.filter(t => !isSet(t.due_date)).sort((a,b) => (b.priority||0) - (a.priority||0) || b.id - a.id)];
/* A screen's row options, beyond what every row does (tick, claim, open, swipe progress). `delete`: swiping left at
   0% deletes. `reorder`: holding a row lets it move up or down, on a project's list, which has an order. `reschedule`:
   holding a row on Today, which is ordered by date, moves it to another date (app/throw.js). Search results have no
   order, so a hold there does nothing. `line`: Today's rows are one line (rowWhen, app/views.js). `cards`: a task with
   open subtasks or steps is a stacked card (cardOf, app/cards.js), collapsed on Today ('today') and in search
   ('found'), open on a project's list ('list'), and never on a list of done tasks. A list's options live on its group
   `g`, and each row writes them on its element for the gesture code (rowGestures). A task's sheet gives its subtasks
   delete and reorder in sheet/task.html. */
export const screenRows = name => ({project: {cards: 'list', delete: true, reorder: true}, search: {cards: 'found', delete: true}, today: {cards: 'today', line: true, delete: true, reschedule: true}}[name] || {});
/* Options for a task's own row at the top of its sheet (sheet/task-card.html). It can be deleted there, which closes
   the sheet, but not moved. `own` makes its tick, swipe and title act on the sheet's task. Under its title it shows
   only OWN_META (due date, priority, repeats, next reminder): its project, run or parent are in the path above it, and
   its labels, comments and files in the sheet below. */
export const SHEET_ROW = {depth: {}, delete: true, own: true};
export const OWN_META = ['due', 'prio', 'rep', 'rem'];
/* Options for a run's own row at the top of its screen, where the header's name was: its ring, its name and who it's
   for, with nothing under the name, so the top is no taller than before. `top`: its ring and swipe finish the run
   (runRing, runRowGesture), and a tap opens its sheet. */
export const RUN_ROW = {depth: {}, top: true};
/* The rows of a list with cards. `tasks` and `depth` come from nestSubtasks. A card's subtasks are drawn on the card,
   so they are left out. Any other task's subtasks follow it as indented rows. */
export const listItems = (tasks, depth, isCard) => {
  const out = [];
  let under = -1;                                // the depth of the card whose subtasks are being skipped
  for (const t of tasks) {
    const d = depth[t.id] || 0;
    if (under >= 0 && d > under) continue;
    out.push(t);
    under = isCard(t) ? d : -1;
  }
  return out;
};
// A list's gesture options as a string for the row's data-gestures attribute, since the gesture code (progress.js)
// reads the element and can't reach the list's `g`.
export const rowGestures = g => ['delete', 'reorder', 'reschedule'].filter(k => g?.[k]).join(' ');
// The ids of a task's parents. A task not yet sent names its parent in `parent`.
export const parentIds = t => t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id);
/* Nest subtasks under their parents. Returns {tasks: the list with each subtask straight after its parent when the
   parent is in the list, depth: task id -> how many parents above it in the list, kids: task id -> its subtasks in
   order}. A template's or run's subtasks follow its own order line. Given `order` (positionOrder, order.js), top-level
   tasks and other subtasks are sorted by it. Without it they stay as they came. */
export const nestSubtasks = (tasks, order = null) => {
  const ids = new Map(tasks.map(t => [t.id, t])), kids = new Map(), top = [];
  for (const t of tasks) {
    const p = parentIds(t).find(id => id !== t.id && ids.has(id));
    if (p === undefined) top.push(t); else kids.set(p, [...(kids.get(p) || []), t]);
  }
  for (const [p, list] of kids) {
    if (order && !hasOwnOrder(ids.get(p))) { list.sort(order); continue; }
    const line = stepsOf(ids.get(p)).map(s => s.id), at = t => { const i = line.indexOf(t.id); return i < 0 ? line.length : i; };
    list.sort((a, b) => at(a) - at(b));
  }
  if (order) top.sort(order);
  const out = [], depth = {};
  const walk = (t, d) => { if (t.id in depth) return; depth[t.id] = d; out.push(t); for (const k of kids.get(t.id) || []) walk(k, d + 1); };
  for (const t of top) walk(t, 0);
  for (const t of tasks) walk(t, 0);             // tasks that are each other's subtasks have no top-level parent to follow
  return {tasks: out, depth, kids};
};
/* The ids of done parents that a project's open list shows anyway, struck through over their open subtasks, so those
   subtasks don't sit at the top level as if they had no parent. A parent ends up done with open subtasks when it is
   ticked in Vikunja's web app, or a subtask is reopened under it. `tasks` is what the List view gave: open tasks and
   their subtasks, done ones included. Only parents in project `pid` count. */
export const doneParentIds = (tasks, pid) => {
  const open = new Set(tasks.filter(t => !t.done).map(t => t.id)), out = new Set();
  for (const t of tasks) if (!t.done) for (const p of t.related_tasks?.parenttask || []) if (p.done && p.project_id === pid && !open.has(p.id)) out.add(p.id);
  return [...out];
};
/* A screen's groups as saved on the phone. A project's Done group keeps its count but not its tasks, which are loaded
   when it is opened. Thousands of done tasks would fill the phone's storage and be drawn again on every open. */
export const keptGroups = groups => groups.map(g => g.key === 'done' ? {...g, tasks: [], loaded: false, loading: false} : g);
/* Done tasks are shown a part at a time, most recently done first: DONE_PART in a project's Done, FOUND_PART among
   search's done matches, with a row at the end for the next part (moreOf, app/views.js). Nobody scrolls through
   thousands. They come to untick one, or to see what was done lately. */
export const DONE_PART = 100, FOUND_PART = 50;
/* Rows are drawn in batches, so the first screenful takes the same time however long the lists are: FIRST_ROWS at
   once, enough to fill a phone, then the rest after the first paint, list by list (drawFrom, app/views.js). drawnOf
   gives the part of `list` to draw when `to` rows of the screen are drawn and `before` rows come before this list. */
export const FIRST_ROWS = 20;
export const drawnOf = (list, before, to) => to >= before + list.length ? list : list.slice(0, Math.max(0, to - before));
/* How much work a batch of rows gets, `drawn` rows in: a frame's worth (FRAME_MS) for the first few screens
   (NEAR_ROWS), which a finger may scroll to at once, then about a second's (LATER_MS), so the rest is drawn in a few
   long batches with taps and scrolls answered between them. Each frame has a fixed cost on a phone, so thousands of
   rows in small batches add up: 2,000 done tasks took twice as long that way as drawing them at once (measured at 4x
   CPU slowdown). */
export const FRAME_MS = 40, LATER_MS = 1000, NEAR_ROWS = 3 * FIRST_ROWS;
export const batchMs = drawn => drawn < NEAR_ROWS ? FRAME_MS : LATER_MS;
// How many rows the next batch draws, from the last batch (`rows` rows in `ms`): about `budget` ms of work, at least 4
// rows, and at most twice the last.
export const nextBatch = (rows, ms, budget) => Math.max(4, Math.min(rows * 2, Math.round(rows * budget / Math.max(ms, 1))));
/* Whether two groups from listGroups would draw the same: every field equal, lists item by item, maps of lists (kids)
   list by list, objects (depth) entry by entry. When they would, the group already drawn is kept, so a reload that
   changed nothing gives the rows nothing to do. */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameField = (a, b) => a === b || (Array.isArray(a) ? Array.isArray(b) && sameList(a, b)
  : a instanceof Map ? b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && sameField(v, b.get(k)))
  : !!a && !!b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b) && !(b instanceof Map) && sameKeys(a, b, (x, y) => x === y));
const sameKeys = (a, b, same) => { const ks = Object.keys(a); return ks.length === Object.keys(b).length && ks.every(k => k in b && same(a[k], b[k])); };
export const sameGroup = (a, b) => !!a && !!b && sameKeys(a, b, sameField);
/* Copy `from` into `to`, a watched object, one entry at a time. A row that reads one entry by its id (g.depth[t.id],
   waiting.claims[t.id]) is then redrawn only when its own entry changes, where replacing the object would redraw every
   row on the screen. */
export function intoKeys(to, from, raw = x => x){
  const was = raw(to);
  for (const k of Object.keys(was)) if (!(k in from)) delete to[k];
  for (const k of Object.keys(from)) if (was[k] !== from[k]) to[k] = from[k];
  return to;
}
/* Write group `from` into `to`, the watched object the screen draws (shownGroups, app/sending.js), changing only the
   fields that differ, and `depth` and `kids` entry by entry. A row reading g.cards, g.depth[t.id] or g.kids.get(t.id)
   is then redrawn only when that changed. `raw` reads `to` without Alpine recording the reads: the comparison here is not
   something a screen shows, so nothing should re-run when `to` changes. */
export function intoGroup(to, from, raw = x => x){
  const was = raw(to);
  for (const k of Object.keys(was)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) {
    if (k === 'depth' && was.depth && v) intoKeys(to.depth, v, raw);
    else if (k === 'kids' && was.kids instanceof Map && v instanceof Map) {
      const m = raw(was.kids);
      for (const id of [...m.keys()]) if (!v.has(id)) to.kids.delete(id);
      for (const [id, list] of v) if (!m.has(id) || !sameField(raw(m.get(id)), list)) to.kids.set(id, list);
    }
    else if (!sameField(raw(was[k]), v)) to[k] = v;
  }
  return to;
}
export const viewKey = r => r.name === 'project' ? `project.${r.id}.${r.showDone ? 'done' : 'open'}` : r.name === 'run' ? 'run.' + r.id : r.name;
/* Sort comparisons for Today's groups: Overdue by priority, then longest overdue first; Today and Next 7 days soonest
   first; "Added today, no date" newest first, with unsent tasks (no `created`) before all. A task just added sorts
   where the next load will put it, not at the bottom. `at` gives the {due_date, created} to sort a task by, so a card
   can go by the subtask that put it on Today (todayAt). */
const made = t => t.created ? +new Date(t.created) : Infinity;
export const todayOrder = (at = t => t) => {
  const due = t => +new Date(at(t).due_date), born = t => made(at(t));
  return {
    overdue: (a, b) => (b.priority || 0) - (a.priority || 0) || due(a) - due(b),
    today: (a, b) => due(a) - due(b),
    week: (a, b) => due(a) - due(b),
    nodate: (a, b) => born(b) - born(a),
  };
};
// The dates Today sorts a task by: its own, or for a card those of the subtask that put it there (`cards` by task id, from todayItems).
export const todayAt = (cards = {}) => t => cards[t.id] ? {due_date: cards[t.id].when, created: cards[t.id].made || t.created} : t;
// Today's groups. "Added today, no date" keeps tasks added without a date in view until midnight, so they don't vanish into a project.
export const todayGroups = () => [{key:'overdue', cls:'overdue', title:'Overdue', tasks:[]}, {key:'today', cls:'today', title:'Today', tasks:[]},
  {key:'runs', cls:'', title:'Checklists', tasks:[]}, {key:'nodate', cls:'', title:'Added today, no date', tasks:[]}, {key:'week', cls:'', title:'Next 7 days', tasks:[]}];
