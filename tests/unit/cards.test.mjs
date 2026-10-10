// The stacked card (src/js/cards.js, and app/cards.js on a pretend component): which tasks are cards on Today and what
// brought each, where each sits there, which subtask is its top row, its peek, opening it, and its count; a card in
// search; where a run goes next, the one rule its card and its screen go by, and the bottom box aimed at its step.
import { component, fakeVikunja } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardGroup, countdown, runTop, todayItems, urgentFirst } from '../../src/js/cards.js';
import { dueInfo } from '../../src/js/dates.js';
import { listItems, nestSubtasks, rowGestures, RUN_ROW } from '../../src/js/lists.js';
import { positionOrder } from '../../src/js/order.js';
import cards from '../../src/js/app/cards.js';
import views from '../../src/js/app/views.js';
import alerts from '../../src/js/app/alerts.js';
import tasks from '../../src/js/app/tasks.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';
import runs from '../../src/js/app/runs.js';
import claims from '../../src/js/app/claims.js';
import checklists from '../../src/js/app/checklists.js';
import actions from '../../src/js/app/actions.js';
import sheetPart from '../../src/js/app/sheet.js';
import { whereNext } from '../../src/js/checklists.js';

const NONE = '0001-01-01T00:00:00Z', me = { id: 1 }, other = { id: 2 };
const at = (d, h) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const under = (id, project = 5) => ({ parenttask: [{ id, project_id: project }] });
const task = (id, f = {}) => ({ id, title: 'Task ' + id, done: false, due_date: NONE, project_id: 5, created_by: me, assignees: [], related_tasks: {}, ...f });
const subs = (...list) => ({ subtask: list.map(([id, done = false]) => ({ id, done })) });
const ids = list => list.map(r => r.t.id);

test('a task due is a row; with open subtasks it is a card, dated by itself', () => {
  const { rows, cards } = todayItems({ tasks: [task(1, { due_date: at(8, 9) }), task(2, { due_date: at(8, 10), related_tasks: subs([3], [4, true]) }),
    task(5, { due_date: at(8, 11), related_tasks: subs([6, true]) })] }, me);
  assert.deepEqual(ids(rows), [1, 5], 'a task whose subtasks are all done is a row');
  assert.deepEqual([...cards.keys()], [2]);
  assert.equal(cards.get(2).when, at(8, 10));
  assert.equal(cardGroup(cards.get(2), false), 'dated');
});

test('a subtask due brings its task’s card, whoever’s it is, and opens it there only if it’s yours', () => {
  const { rows, cards } = todayItems({ tasks: [task(3, { due_date: at(8, 9), related_tasks: under(2) }), task(4, { due_date: at(9, 9), assignees: [me], related_tasks: under(7) })] }, me);
  assert.deepEqual(rows, [], 'subtasks are never rows of their own on Today');
  assert.deepEqual({ ...cards.get(2), from: undefined }, { when: at(8, 9), made: null, focus: null, project: 5, from: undefined });
  assert.equal(cards.get(7).focus, 4, 'yours: the card opens on it');
  assert.deepEqual(cards.get(2).from.map(t => t.id), [3], 'what brought it, to show as a row should its task not be readable');
});

test('a card sits by the earliest date that brought it: its own, or one of its subtasks’', () => {
  const { cards } = todayItems({ tasks: [task(2, { due_date: at(12, 9), related_tasks: subs([3], [4]) }), task(3, { due_date: at(9, 9), related_tasks: under(2) }),
    task(4, { due_date: at(10, 9), assignees: [me], related_tasks: under(2) })] }, me);
  assert.equal(cards.get(2).when, at(9, 9));
  assert.equal(cards.get(2).focus, 4);
});

test('undated, made today: a subtask of yours brings its task’s card, opened on it; someone else’s doesn’t', () => {
  const { rows, cards } = todayItems({ added: [
    task(3, { assignees: [me], created: at(8, 9), related_tasks: under(2) }), task(4, { assignees: [other], created: at(8, 10), related_tasks: under(6) }),
    task(5, { created_by: me, created: at(8, 8) }), task(8, { created_by: other, created: at(8, 8) }),
    task(9, { created_by: me, created: at(8, 7), related_tasks: subs([10]) }), task(11, { due_date: at(8, 20), created_by: me }),
  ] }, me);
  assert.deepEqual([...cards.keys()], [2, 9]);
  assert.deepEqual([cards.get(2).focus, cards.get(2).made, cards.get(2).when], [3, at(8, 9), null]);
  assert.equal(cardGroup(cards.get(2), false), 'nodate', 'under “Added today, no date”');
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[5, 'nodate']], 'yours, with no date; someone else’s, and one with a date, aren’t');
});

test('runs: yours in progress is a card under Checklist runs, one with no open step a row there; a step you’re on in someone else’s brings theirs', () => {
  const run = task(20, { related_tasks: subs([21, true], [22]) }), done = task(30, { related_tasks: subs([31, true]) });
  const { rows, cards } = todayItems({ mine: [run, done], claimed: [task(41, { assignees: [me], related_tasks: under(40, 9) })] }, me, t => [20, 30, 40].includes(t.id));
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[30, 'runs']]);
  assert.equal(cardGroup(cards.get(20), true), 'runs');
  assert.equal(cards.get(40).focus, 41);
  assert.equal(cards.get(40).project, 9);
});

test('a template that comes round is a row: its steps are done, and it’s started from there', () => {
  const tpl = task(50, { due_date: at(8, 9), labels: [{ title: 'template' }], related_tasks: subs([51, true], [52, true]) });
  assert.deepEqual(ids(todayItems({ tasks: [tpl] }, me).rows), [50]);
});

test('a card’s top row: the most urgent, overdue first, then due today, then the earliest date, then list order', () => {
  const now = new Date(2026, 9, 8, 12), day = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const order = (a, b) => a.pos - b.pos, s = (id, pos, due = NONE) => ({ id, pos, due_date: due });
  const list = [s(1, 1), s(2, 2, day(12, 9)), s(3, 3, day(8, 18)), s(4, 4, day(7, 9)), s(5, 5, day(8, 0)), s(6, 6, day(8, 9)), s(7, 7), s(8, 8, day(10, 9))];
  assert.deepEqual([...list].sort(urgentFirst(+now, order)).map(x => x.id), [4, 6, 5, 3, 8, 2, 1, 7],
    'late (yesterday, then 9 this morning), today (with no time, then 6 PM), then later dates, then the rest in list order');
});

test('a run’s card’s top row: the step a tick left it on until it has gone, then the run’s rule from there', () => {
  const steps = [{ id: 1 }, { id: 2 }, { id: 3 }], asked = [];
  const pick = from => { asked.push(from); return from === null ? 2 : 3; };
  assert.equal(runTop(steps, null, pick), 1, 'as it opens: the rule, from nowhere');
  assert.equal(runTop(steps, 1, pick), 0, 'left on its top row, still there (waiting for the batch, say)');
  assert.equal(runTop(steps.slice(1), 1, pick), 1, 'that one gone: the rule, from it');
  assert.equal(runTop(steps, null, () => null), 0, 'none by the rule: the first');
  assert.equal(runTop([], null, pick), -1);
  assert.deepEqual(asked, [null, 1]);
});

test('a run’s step’s countdown, to the minute, within a day', () => {
  const now = Date.parse(at(8, 9));
  assert.deepEqual(countdown(now + 65 * 6e4 + 1000, now), { text: 'in 1h 6m', late: false });
  assert.deepEqual(countdown(now - 12.5 * 6e4, now), { text: '12m late', late: true });
  assert.deepEqual(countdown(now + 1000, now), { text: 'in 1m', late: false }, 'never “in 0s”');
  assert.equal(countdown(now + 864e5 * 2, now), null, 'further off: its date says it');
});

// The component, with Today's cards: `parent` with its subtasks in the store, at their positions in its List view: 14,
// done, first, then Chairs, Tables and Lights.
const today = (...more) => {
  const app = component(cards, views, alerts, tasks, leaving, ...more);
  Object.assign(app, { cardPage: {}, cardOpen: {}, positions: { 11: 3, 12: 1, 13: 2, 14: 0.5 }, projById: new Map([[5, { id: 5, title: 'Café', hex_color: '' }]]), stepDone: (id, d) => d, stepPct: s => Math.round((s.percent_done || 0) * 100), checklistIds: new Set(), waitingByTask: new Map() });
  const parent = app.keep(task(10, { title: 'Pack the van', related_tasks: subs([11], [12], [13], [14, true]) }));
  for (const [id, title] of [[11, 'Lights'], [12, 'Chairs'], [13, 'Tables']]) app.keep(task(id, { title, related_tasks: under(10) }));
  app.view.cards = { 10: { when: null, made: null, focus: null } };
  return { app, parent, g: { cards: 'today', line: true } };
};

test('a card: its open subtasks, the most urgent first, collapsed to its top row with More under it, and its ring', () => {
  const { app, parent, g } = today(), c = app.cardOf(parent, g);
  assert.deepEqual(c.steps.map(s => s.title), ['Chairs', 'Tables', 'Lights'], 'none dated: its List view’s order');
  assert.deepEqual([c.step.title, c.rows.map(s => s.title), c.peek.title, c.more, c.open], ['Chairs', ['Chairs'], 'Tables', 2, false], 'its top row, and under it More (the next, and how many more, kept for it)');
  assert.deepEqual([c.ring.done, c.ring.total, c.ring.pct, c.ring.said], [1, 4, 25, '1 of 4 subtasks done, 25%'], 'its ring: the done one counted, and its figure worked out');
  assert.equal(c.ring.label, 'Complete “Pack the van” and its 3 open subtasks', 'what its tap does');
  assert.deepEqual([c.g.card, c.g.line, c.g.delete], [c, true, true], 'its rows know their card, are on one line, and have Delete, as Today’s rows do');
  assert.equal(app.cardOf(parent, { depth: {} }), null, 'only on a list with cards');
  assert.deepEqual(app.rowMeta(c.step, c.g).map(m => m.text), [], 'not which step it is, nor the project: those are on the card');
  app.tasks[11].due_date = new Date(Date.now() - 36e5).toISOString();
  assert.deepEqual(app.cardOf(parent, g).steps.map(s => s.title), ['Lights', 'Chairs', 'Tables'], 'Lights late: on top');
});

test('a card opened by its More lists every open subtask, and collapses again by its Less; with one open subtask, no footer', () => {
  const { app, parent, g } = today();
  app.openCard(app.cardOf(parent, g));
  let c = app.cardOf(parent, g);
  assert.deepEqual([c.open, c.rows.map(s => s.title), c.peek, c.folds], [true, ['Chairs', 'Tables', 'Lights'], null, true]);
  app.foldCard(c.id);
  c = app.cardOf(parent, g);
  assert.deepEqual([c.open, c.rows.length, c.peek.title], [false, 1, 'Tables'], 'collapsed: More back');
  app.openCard(c);
  app.resetCards();
  assert.equal(app.cardOf(parent, g).open, false, 'leaving the screen: collapsed');
  for (const id of [12, 13]) app.tasks[id].done = true;
  c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek, c.more], ['Lights', null, 0], 'one open subtask: no footer');
  app.openCard(c);
  assert.equal(app.cardOf(parent, g).open, false, 'nor anything to open');
});

test('in search, any open task with open subtasks is a card, collapsed; its subtasks found with it are on it, not rows of their own', () => {
  const { app, parent } = today(), g = { cards: 'found', delete: true };
  app.route = { name: 'search' };
  const c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek.title, c.g.line, c.g.delete], ['Chairs', 'Tables', undefined, true], 'its rows with their second line, as search’s are');
  assert.equal(app.cardOf({ ...parent, done: true }, g), null, 'not a done one');
  assert.equal(app.cardOf({ ...parent, labels: [{ title: 'template' }] }, g), null, 'nor a template');
  assert.equal(app.cardOf(app.tasks[11], g), null, 'nor one with no subtasks');
  const found = [parent, app.tasks[12], app.tasks[11], { id: 30 }, { id: 31 }, { id: 32 }];
  const depth = { 10: 0, 12: 1, 11: 1, 30: 0, 31: 1, 32: 2 };
  assert.deepEqual(listItems(found, depth, t => t.id === 10).map(t => t.id), [10, 30, 31, 32], 'a card’s subtasks are on it; another task’s, rows under it');
});

test('a card’s heading: its priority’s bars as its row shows them, only when it has one; said, its due date, its priority and its project', () => {
  const { app, parent } = today();
  assert.deepEqual([app.cardHead(parent).title, app.cardHead(parent).prio, app.cardHead(parent).due, app.cardHead(parent).said], ['Pack the van', 0, null, '1 of 4 subtasks done, 25%, Café'], 'no priority, no bars; no date, nothing at the right; its ring said');
  const urgent = { ...parent, priority: 4, due_date: at(8, 10) }, row = app.rowMeta(urgent, { depth: {} }).find(m => m.key === 'prio'), h = app.cardHead(urgent);
  assert.equal(h.prio, 4);
  assert.equal(row.label, 'Priority: Urgent');
  const when = dueInfo(urgent.due_date);
  assert.equal(h.said, `1 of 4 subtasks done, 25%, ${when.cls === 'overdue' ? 'Late: ' : 'Due '}${when.label}, ${row.label}, Café`, 'when, in words, its priority as its row says it, and its project');
  Object.assign(app, { isRunTask: t => t.id === 10, forText: t => t.assignees.length ? 'For you' : '' });
  assert.equal(app.cardHead(urgent).said.split(', ').pop(), 'Checklist run', 'a run’s for no one: what it is, instead of its project');
  assert.equal(app.cardHead({ ...urgent, assignees: [me] }).said.split(', ').pop(), 'For you', 'or who it’s for');
});

// rows-and-sheet-fixes-plan, part 4: the dot's room goes to a subtask's words.
test('a card’s header has its project’s dot, once: its rows leave theirs out, and a row in another project keeps its own', () => {
  const { app, parent, g } = today();
  app.projById = new Map([[5, { id: 5, title: 'Café', hex_color: '1d6b52' }], [6, { id: 6, title: 'Upkeep', hex_color: '3d85c6' }]]);
  const c = app.cardOf(parent, g);
  assert.equal(app.cardHead(parent, g).color, '#1d6b52', 'its header: its project’s colour');
  assert.equal(c.project, 5, 'the card knows its task’s project, for its rows');
  const w = app.rowWhen(c.step, c.g);
  assert.deepEqual([w.color, /Café/.test(w.said)], [null, false], 'a row of the card, in its project: no dot, nor its project said, as its header says it');
  assert.equal(app.rowWhen(c.step, { line: true, depth: {} }).color, '#1d6b52', 'the same task as a plain row: its dot');
  const far = app.keep(task(13, { title: 'Tables', project_id: 6, related_tasks: under(10) })), f = app.rowWhen(far, c.g);
  assert.deepEqual([f.color, f.said], ['#3d85c6', 'Upkeep'], 'a subtask in another project: its own dot, and its project said');
  assert.deepEqual(app.rowMeta(far, c.g).map(m => m.text), ['Upkeep'], 'not the task it’s under: that is its card');
  // In search a card's rows keep their second line, with no project on it but for one in another; the header has the dot.
  app.route = { name: 'search' };
  const found = app.cardOf(parent, { cards: 'found', delete: true });
  assert.equal(app.cardHead(parent, { cards: 'found' }).color, '#1d6b52', 'in search too');
  assert.deepEqual([app.rowMeta(found.step, found.g).map(m => m.text), app.rowMeta(far, found.g).map(m => [m.color, m.text])], [[], [['#3d85c6', 'Upkeep']]]);
  // On its project's own list no row says its project, nor does the header.
  app.route = { name: 'project' };
  assert.equal(app.cardHead(parent, { cards: 'list' }).color, null, 'not on its own project’s list');
  app.route = { name: 'today' };
  app.projById = new Map();
  assert.equal(app.cardHead(parent, g).color, null, 'a project Pocket doesn’t know: no dot');
});

test('on a project’s list a card is open, its rows the subtasks under it there, in its List view’s order, with those waiting to be sent', () => {
  const { app, parent } = today();
  app.route = { name: 'project' };
  const rope = { id: 'pending-x-0', pending: true, parent: 10, position: 2.5, title: 'Rope', project_id: 5, related_tasks: {} };
  const plain = app.keep(task(20)), deeper = app.keep(task(30, { related_tasks: under(12) }));
  const n = nestSubtasks([plain, app.tasks[11], parent, app.tasks[13], rope, app.tasks[12], deeper], positionOrder(app.positions));
  const g = { cards: 'list', delete: true, reorder: true, heads: [], ...n }, c = app.cardOf(parent, g);
  assert.deepEqual(c.rows.map(s => s.title), ['Chairs', 'Tables', 'Rope', 'Lights'], 'its subtasks there, one waiting to be sent among them');
  assert.deepEqual([c.open, c.folds, c.peek], [true, false, null], 'open, for good: no More, nor Less');
  assert.deepEqual([c.ring.done, c.ring.total, c.ring.pct], [1, 5, 20], 'counting the one waiting to be sent, at 0%');
  assert.deepEqual([c.g.delete, c.g.reorder, c.g.depth], [true, true, {}], 'its rows deleted and moved as the list’s');
  assert.equal(app.cardOf(plain, g), null, 'a task with no subtasks there: a row');
  assert.equal(app.cardOf(app.tasks[12], g), null, 'Chairs, with a subtask of its own: a row on the card, which opens its sheet');
  assert.ok(app.cardOf({ ...parent, done: true }, g), 'done, over subtasks still open: a card too');
  assert.deepEqual(listItems(n.tasks, n.depth, t => !!app.cardOf(t, g)).map(t => t.id), [10, 20], 'the card, with all under it on it, then the row');
});

test('ticked, a card’s top row stays until the batch clears, then the next comes up', () => {
  const { app, parent, g } = today();
  const c = app.cardOf(parent, g);
  assert.equal(c.step.title, 'Chairs');
  app.pinCard(c);
  app.tasks[12].done = true; app.leaving[12] = 'done';
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).peek.title, app.cardOf(parent, g).ring.done], ['Chairs', 'Tables', 2], 'done, still on top, counted');
  delete app.leaving[12];
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).peek.title, app.cardOf(parent, g).more], ['Tables', 'Lights', 1], 'the batch cleared: the next, up');
  for (const id of [11, 13]) app.tasks[id].done = true;
  const all = app.cardOf(parent, g);
  assert.deepEqual([all.closes, all.rows, all.peek, all.ring.open, all.ring.pct], [true, [], null, 0, 100], 'no open step left: it waits for Close, its ring full (nothing closes behind your back)');
  assert.equal(all.ring.label, 'Close “Pack the van”: all its subtasks are done');
});

/* A card is worked out from what's done, and a task is done the moment it's ticked, before Vikunja has answered and its
   row is marked: without more, a card's top row done drops off its card while the save is on its way, the next subtask
   comes up in its place, and then the done one is back, its gap after it (user, 2026-10-10, on a phone, where an
   answer takes longer than a frame: "the next subtask sorta races the animation, cuts it short, pulls up into its
   spot, THEN the 'undo' shows up"). So a row done in a list is held where it is from that moment (holdRow,
   leaving.js): by a tap or a full swipe, a task's subtask or a run's step, on a collapsed card or an opened one. */
test('a card’s top row done is still its top row from the tap, or the swipe’s let-go, until the batch clears, however long Vikunja takes to answer', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, parent, g } = today(actions), v = fakeVikunja(Object.values(app.tasks)), send = globalThis.fetch;
  Object.assign(app, { lines: {}, pending: [], perms: {}, render(){} });
  app.view.groups = [{ key: 'today', tasks: [parent] }];
  // Vikunja's answers, held back until answer().
  let held = [];
  const answer = () => { const go = held; held = []; go.forEach(ok => ok()); };
  globalThis.fetch = async (...a) => { await new Promise(ok => held.push(ok)); return send(...a); };
  const card = () => app.cardOf(parent, g), top = () => card().step.title, turn = () => new Promise(ok => setImmediate(ok));
  const over = async doing => { let done = false; doing.then(() => { done = true; }); while (!done) { answer(); await turn(); } };
  try {
    // Tapped: its tick.
    assert.deepEqual([top(), card().peek.title, card().more], ['Chairs', 'Tables', 2]);
    app.pinCard(card());
    let doing = app.toggleDone(app.tasks[12], ROW);
    await turn();
    assert.deepEqual([app.tasks[12].done, v.task(12).done], [true, false], 'done on the phone, nothing answered yet');
    assert.deepEqual([top(), card().peek.title, card().more], ['Chairs', 'Tables', 2], 'ticked: still on top, the next still under More');
    await over(doing);
    assert.deepEqual([top(), app.leaving, app.swept, v.task(12).done], ['Chairs', { 12: 'done' }, {}, true], 'answered: marked, and where it was');
    await app.clearBatch(true);
    assert.deepEqual([top(), card().peek.title, card().more], ['Tables', 'Lights', 1], 'the batch cleared: the next comes up, and not before');
    // A full swipe right, let go: its gap is its row's from that moment (drawn once the row has slid away: sweep).
    doing = app.setProgress(app.tasks[13], 100, ROW, { gap: true });
    await turn();
    assert.deepEqual([top(), card().peek.title, card().more, app.swept, v.task(13).done], ['Tables', 'Lights', 1, { 13: true }, false], 'let go: still on top, its gap its own, nothing answered yet');
    await over(doing);
    assert.deepEqual([top(), app.leaving, app.swept], ['Tables', { 13: 'done' }, { 13: true }]);
    await over(Promise.resolve(app.unmark(13)));
    assert.deepEqual([top(), app.tasks[13].done, app.leaving], ['Tables', false, {}], 'its Undo: open again, where it was');
    // On an opened card, its rows stay as they are, the done one among them.
    app.openCard(card());
    assert.deepEqual(card().rows.map(s => s.title), ['Tables', 'Lights']);
    doing = app.setProgress(app.tasks[13], 100, ROW, { gap: true });
    await turn();
    assert.deepEqual(card().rows.map(s => s.title), ['Tables', 'Lights'], 'no row gone from under the finger, to come back when Vikunja answers');
    await over(doing);
    await app.clearBatch(true);
    assert.deepEqual([top(), card().rows.map(s => s.title)], ['Lights', ['Lights']]);
    // Not saved: it's let go of, open, where it was, and its row says why.
    v.trouble = () => 500;
    doing = app.toggleDone(app.tasks[11], ROW);
    await turn();
    assert.deepEqual([top(), app.leaving[11]], ['Lights', 'done'], 'held while it\'s tried');
    await over(doing);
    assert.deepEqual([top(), app.leaving, app.swept, app.tasks[11].done], ['Lights', {}, {}, false], 'not saved: not held, not done');
    assert.match(app.toast.msg, /^Not saved: /);
  } finally { globalThis.fetch = send; }
});

// A plain row on Today done is held the same way, so a list loaded while its save is on its way treats it as it does a
// marked one: it keeps its row, though Vikunja's list no longer has it (keepMarked), and leaves it as it's shown,
// ticked, though Vikunja's copy of it is still open (keep).
test('a row ticked on Today is kept, ticked, by a list loaded before Vikunja has answered its tick', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app } = today(actions), row = app.keep(task(20, { title: 'Call the plumber' })), v = fakeVikunja([row]), send = globalThis.fetch;
  Object.assign(app, { lines: {}, pending: [], perms: {}, render(){} });
  app.view.groups = [{ key: 'today', tasks: [row] }];
  let held = [], done = false;
  globalThis.fetch = async (...a) => { await new Promise(ok => held.push(ok)); return send(...a); };
  try {
    const doing = app.toggleDone(row, ROW).then(() => { done = true; });
    assert.deepEqual([row.done, v.task(20).done, app.leaving], [true, false, { 20: 'done' }], 'held from the tap');
    assert.deepEqual(app.keepMarked([{ key: 'today', tasks: [] }])[0].tasks.map(t => t.id), [20], 'a list loaded meanwhile keeps its row');
    assert.deepEqual([app.keep({ ...v.task(20) }) === row, row.done], [true, true], 'and Vikunja\'s copy, open until it answers, doesn\'t untick it');
    while (!done) { held.splice(0).forEach(ok => ok()); await new Promise(ok => setImmediate(ok)); }
    await doing;
    assert.deepEqual(app.leaving, { 20: 'done' }, 'answered: marked');
  } finally { globalThis.fetch = send; }
});

// A run's step on its card goes through the outbox, which answers in its own time too: its row is held the same way.
test('a run’s card’s top step done is still its top row while the outbox takes it, and until the batch clears', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, parent, g } = today(actions);
  let taken = null;
  Object.assign(app, { isRunTask: t => t.id === 10, stepRun: t => t.id === 10 ? null : 10, act: () => new Promise(ok => { taken = ok; }) });
  const top = () => app.cardOf(parent, g).step.title;                        // (a run's steps in its order: Lights, Chairs, Tables)
  app.pinCard(app.cardOf(parent, g));
  const doing = app.toggleDone(app.tasks[11], ROW, { gap: true });           // a full swipe on its row
  assert.deepEqual([app.tasks[11].done, top(), app.swept], [true, 'Lights', { 11: true }], 'let go: done, and still on top, its gap its own');
  taken({ status: 'ok' });
  await doing;
  assert.deepEqual([top(), app.leaving], ['Lights', { 11: 'done' }]);
  await app.clearBatch(true);
  assert.equal(top(), 'Chairs', 'the batch cleared: the next in order');
  // One the outbox turns down goes back, and isn't held.
  app.pinCard(app.cardOf(parent, g));
  const failing = app.toggleDone(app.tasks[12], ROW);
  assert.deepEqual([top(), app.leaving[12]], ['Chairs', 'done']);
  taken({ status: 'error', error: {} });
  await failing;
  assert.deepEqual([top(), app.leaving, app.tasks[12].done], ['Chairs', {}, false]);
});

test('Today’s groups: a card by what brought it; one whose task can’t be read shows what brought it as rows', () => {
  const app = component(cards, views, alerts, tasks, leaving), now = new Date();
  const soon = new Date(now.getTime() + 36e5).toISOString(), made = now.toISOString();
  Object.assign(app, { view: { groups: [], cards: {} }, setBadge(){} });
  const dated = task(2, { related_tasks: subs([3]) }), undated = task(6, { related_tasks: subs([7]) }), lost = task(9, { due_date: soon, related_tasks: under(8) });
  const got = { rows: [{ t: task(1, { due_date: soon }), key: 'dated' }],
    cards: new Map([[2, { when: soon, made: null, focus: null, from: [] }], [6, { when: null, made, focus: 7, from: [] }], [8, { when: soon, made: null, focus: null, from: [lost] }]]),
    parents: [dated, undated], steps: [task(3), task(7)], positions: { 3: 1 } };
  const out = app.todayFrom(got, t => t), keys = Object.fromEntries(out.groups.map(g => [g.key, g.tasks.map(t => t.id)]));
  assert.deepEqual(keys.today.sort(), [1, 2, 9]);
  assert.deepEqual(keys.nodate, [6]);
  assert.deepEqual(out.cards, { 2: { when: soon, made: null, focus: null }, 6: { when: null, made, focus: 7 } });
  assert.deepEqual(out.steps.map(t => t.id), [3, 7]);
});

test('a finger on a card: its row swiped is that subtask’s slide, which keeps a run’s card on its top row; on its heading, nothing', () => {
  const app = component(progress), pinned = [], finished = [];
  Object.assign(app, { tasks: { 10: { id: 10 } }, cardOf: () => ({ id: 10 }), pinCard: c => pinned.push(c.id) });
  const card = (cls = '') => ({ dataset: { id: '10' }, matches: sel => sel.split(', ').some(c => cls.includes(c.slice(1))) });
  const s = { el: 'row', start: 0, finish: pct => finished.push(pct) };
  const g = app.cardGesture(card(), s);
  assert.equal(g.start, 0, 'its swipe');
  g.finish(null); g.finish(50);
  assert.deepEqual([pinned, finished], [[10], [null, 50]], 'pinned only by a slide that changed something');
  assert.deepEqual(app.cardGesture(card(), null), { el: null, reorder: null }, 'its heading: a swipe does nothing, not even a tap');
  const hold = { start(){} }, c = card();
  assert.deepEqual(app.cardGesture(c, null, hold), { el: c, reorder: hold }, 'on a project’s list, held: the card moved up or down');
  assert.equal(app.cardGesture(card('.deleted'), s), null, 'deleted: only its Restore');
  assert.equal(rowGestures({ depth: {}, card: {}, delete: true }), 'delete', 'a card’s row: its Delete, as its list’s rows');
});

test('the one-time hint goes on a card’s top row only', () => {
  const app = component(progress);
  app.hint = { at: 10 };
  const card = { id: 10, step: { id: 12 } };
  assert.deepEqual([app.hintOn({ id: 12 }, { card }), app.hintOn({ id: 13 }, { card }), app.hintOn({ id: 10 }, {})], [true, false, true]);
});

test('a row on Today, on one line: when it is due, short, its project’s dot, and the rest said to a screen reader', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const due = new Date(); due.setHours(23, 30, 0, 0);
  const t = app.keep(task(20, { title: 'Post the rota', due_date: due.toISOString(), priority: 3, project_id: 5, labels: [{ id: 1, title: 'Front' }], comment_count: 2 }));
  const w = app.rowWhen(t, { line: true, depth: {} });
  assert.equal(w.due.text, due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.equal(w.prio, 3, 'its priority, as bars before its time (one-concept-plan, part 4)');
  assert.ok(w.color, 'its project’s dot');
  assert.match(w.said, /^Due Today .*, Priority: High, Café$/, 'when in words, its priority and its project; not its label nor its comments');
  assert.equal(app.rowWhen({ ...t, priority: 0 }, { line: true, depth: {} }).prio, 0, 'no priority, no bars');
  // Due today with no time: "Today" under Overdue's heading and elsewhere, nothing under Today's, which says it.
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const u = app.keep(task(21, { title: 'Order the cups', due_date: day.toISOString(), project_id: 5 }));
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'overdue' }).due.text, 'Today');
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).due, null, 'under Today: no time, nothing');
  assert.match(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).said, /^Due Today/, 'a screen reader still hears it');
  assert.equal(app.rowWhen(t, { line: true, depth: {}, key: 'today' }).due.text, w.due.text, 'a time still shows');
  // Its attachments are a count, unsaid; photos still waiting to upload are work still to send, said.
  assert.doesNotMatch(app.rowWhen({ ...t, attachments: [{ id: 1 }] }, { line: true, depth: {} }).said, /Attachments/);
  app.waitingByTask.set(20, [{ key: 'f' }]);
  assert.match(app.rowWhen(t, { line: true, depth: {} }).said, /, Attachments, 1 waiting to upload$/);
  app.waitingByTask.delete(20);
  // A run's step counting down: its countdown at the right, as under its title elsewhere, and said.
  const soon = app.keep(task(22, { title: 'Proof the dough', due_date: new Date(Date.now() + 10 * 6e4 + 3e4).toISOString(), related_tasks: under(50) }));
  app.stepRun = x => x.id === 22 ? 50 : null;
  const s = app.rowWhen(soon, { line: true, depth: {}, key: 'today' });
  assert.deepEqual([s.due, s.said.split(', ')[0]], [{ text: 'in 11m', cls: 'today' }, 'Due in 11m']);
  assert.equal(app.rowMeta(soon, { depth: {} }).find(m => m.key === 'due').text, 'in 11m');
  assert.equal(app.cardHead(u, { key: 'today' }).due, null, 'a card’s heading the same');
  assert.equal(app.cardHead(u, { key: 'week' }).due.text, 'Today');
});

test('a run’s card has a heading like a task’s: its name without the day it was started, and when it’s due at the right', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const made = new Date(2026, 9, 8, 7, 30), day = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const run = task(30, { title: `Opening up · run 2 · ${day(made)}`, created: made.toISOString(), project_id: 5 });
  app.isRunTask = t => t.id === 30;
  assert.equal(app.cardHead(run).title, 'Opening up · run 2');
  assert.equal(app.cardHead({ ...run, title: `Opening up · Saturday · ${day(new Date(2026, 9, 6))}` }).title, 'Opening up · Saturday', 'started offline, made in Vikunja later');
  assert.equal(app.cardHead({ ...run, title: `Opening up · run 2 · ${day(new Date(2026, 8, 20))}` }).title, `Opening up · run 2 · ${day(new Date(2026, 8, 20))}`, 'not a day it was started: kept');
  assert.equal(app.cardHead({ ...run, title: 'Opening up' }).title, 'Opening up', 'a name of its own: kept whole');
  assert.equal(app.cardHead({ ...run, created: NONE }).title, run.title, 'not made yet: kept whole');
  assert.equal(app.cardHead(task(31, { title: `Pack the van · front · ${day(made)}`, created: made.toISOString() })).title, `Pack the van · front · ${day(made)}`, 'a task’s title as it is');
  // Due when its template was (started from Today), it shows that at the right, as a task's card does.
  const due = new Date(); due.setHours(23, 30, 0, 0);
  assert.equal(app.cardHead({ ...run, due_date: due.toISOString() }, { key: 'today' }).due.text, due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.equal(app.cardHead(run, { key: 'today' }).due, null, 'none: nothing at the right');
});

test('where a run goes next: the next open step in order, even counting down; before it, a timed step whose time has come', () => {
  const now = 1000, s = (id, f = {}) => ({ id, done: false, counting: false, dueAt: Infinity, ...f });
  const steps = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4, { counting: true, dueAt: 900 }), s(5)];
  assert.equal(whereNext(steps, now), 3, 'opening: the timed one whose time has come, 4, first');
  assert.equal(whereNext(steps, now, steps[3]), 4, 'after it: the next in order');
  assert.equal(whereNext(steps, now, steps[2]), 3, 'after a tick on 3: 4, next anyway');
  const later = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4)];
  assert.equal(whereNext(later, now), 1, 'opening: the first open in order, still counting down');
  assert.equal(whereNext(later, now, later[1]), 2, 'after it: the next');
  assert.equal(whereNext(later, now, later[2]), 3, 'after 3: 4, with 2 still counting down');
  assert.equal(whereNext(later, now, later[3]), 1, 'none after it: round to the first open');
  assert.equal(whereNext(later, 1600, later[2]), 1, 'its countdown at zero: 2, before 4');
  assert.equal(whereNext([s(1, { done: true }), s(2), s(3, { counting: true, dueAt: 5000 })], now, { id: 2 }), 2, 'one that starts counting down with this tick: next, with its countdown');
  assert.equal(whereNext([s(1, { counting: true, dueAt: 500 }), s(2, { counting: true, dueAt: 200 })], now), 0, 'two whose time has come: the first in order');
  assert.equal(whereNext([s(1, { done: true }), s(2)], now, { id: 2 }), -1, 'none open but the one ticked');
});

test('a run’s card on Today opens on the step its screen would, and goes by the same rule once the step ticked has gone', () => {
  const { app, parent, g } = today();
  app.isRunTask = t => t.id === 10;                                        // its steps in its order: Lights, Chairs, Tables, then 14, done
  const soon = m => new Date(Date.now() + m * 6e4).toISOString();
  app.tasks[11].due_date = soon(10); app.tasks[13].due_date = soon(20);   // Lights and Tables counting down
  const c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek.title, c.ring.said, c.ring.label], ['Lights', 'Chairs', '1 of 4 steps done, 25%', 'Finish “Pack the van”, with 3 steps not done'], 'the first in order, counting down; the next in order under it');
  app.pinCard(c);
  app.tasks[11].done = true; app.leaving[11] = 'done';
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'ticked, it stays until the batch clears');
  delete app.leaving[11];
  assert.equal(app.cardOf(parent, g).step.title, 'Chairs', 'then the next in order');
  app.tasks[13].due_date = soon(-1);
  app.resetCards();
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'a timed step whose time has come, before it');
});

// A run on its screen (runView, runs.js): A done a minute ago; B timed 30 minutes from A, counting down; C and D.
const runScreen = () => {
  const app = component(runs, claims, checklists, cards, views), now = Date.now(), NONE = '0001-01-01T00:00:00Z';
  const step = (id, title, f = {}) => ({ id, title, done: false, done_at: NONE, due_date: NONE, updated: new Date(now - 36e5).toISOString(), percent_done: 0, description: '',
    assignees: [], attachments: [], reactions: {}, comments: [], tpl: title, added: '', from: null, ...f });
  Object.assign(app, { user: me, pending: [], slow: [], perms: {}, clock: now, actTask: a => a.task,
    view: { run: { run: { id: 50, title: 'Opening up', done: false, project_id: 5, assignees: [me], created_by: me, comments: [] },
      steps: [step(51, 'A', { done: true, done_at: new Date(now - 6e4).toISOString(), reactions: { '✅': [me] } }), step(52, 'B', { tpl: 'B T#30m' }), step(53, 'C', { percent_done: .5 }), step(54, 'D')], at: null, last: null } } });
  return app;
};

test('a run’s screen opens on the next step in order, counting down, and a tick goes on to the next', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual([v.step.title, v.at], ['B', 1], 'B, counting down');
  assert.equal(v.card, undefined, 'no strip: its steps, listed, say where it is');
  assert.equal(app.nextStep(v.steps[1]), 2, 'ticked, on to C');
  assert.equal(app.nextStep(v.steps[2]), 3, 'C ticked, on to D, with B still counting down');
  app.showStep(0);                                                         // A tapped in the list
  assert.deepEqual([app.runView.step.title, app.runView.step.done], ['A', true], 'a done step comes on the card from its row');
});

test('the step card shows who’s on its step, as its row does, until it’s done', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual(app.rowSlot(v.step, { run: true }), v.step.slot);
  assert.equal(app.rowSlot(v.steps[0], { run: true }), null, 'done: its row and card say who did it instead');
});

/* The run's own row atop its screen (RUN_ROW): its ring from the steps as the screen has them, its tap (or a full swipe)
   asking to finish it there, with no way to open the run it's on; who it's for in its slot; who started it in its
   history: the summary once every step is done, and its ⋯. */
test('a run’s own row: its ring asks to finish it on its screen, its slot says who it’s for, and who started it is its history', async () => {
  const app = runScreen(), made = new Date(Date.now() - 36e5).toISOString(), calls = [];
  Object.assign(app.view.run.run, { created: made });
  Object.assign(app, { sheet: {}, route: { name: 'run' }, openSheet: k => { app.sheet = { kind: k }; }, closeSheet: () => calls.push('close'), finishRun: () => calls.push('finish'),
    reopenRun: id => calls.push('reopen ' + id) });
  const r = app.rowRing(app.runOwn, RUN_ROW);
  assert.deepEqual([r.done, r.total, r.pct, r.open, r.label], [1, 4, 38, 3, 'Finish “Opening up”, with 3 steps not done'], 'C at 50% counts, as on its card');
  assert.deepEqual(app.rowMeta(app.runOwn, RUN_ROW), [], 'nothing under its name');
  assert.equal(app.rowSlot(app.runOwn, RUN_ROW).label, 'For you');
  r.tap();
  assert.deepEqual([app.sheet.kind, app.sheet.complete.screen, app.sheet.complete.ask.head], ['complete', true, 'Finish this run with 3 steps not done?']);
  await app.confirmComplete();
  assert.deepEqual(calls, ['close', 'finish'], 'confirmed: finished as Finish run does');
  assert.match(app.runView.summary, /^Started by you at .+ · 1 of 4 done · 3 not done$/, 'in the summary, which shows once every step is done');
  for (const s of app.view.run.steps) s.done = true;
  assert.match(app.runView.summary, /^Started by you at .+ · 4 of 4 done$/);
  app.rowRing(app.runOwn, RUN_ROW).tap();
  assert.equal(calls.at(-1), 'finish', 'every step done: finished at once, with its Undo');
  assert.match(app.runStarted, /^Started by you, \w+ \d+, /);
  app.view.run.run.created_by = { id: 9, username: 'priya', name: 'Priya' };
  assert.match(app.runView.summary, /^Started by Priya at /);
});

test('a run’s bottom box aims at the card’s step; steps added go each after the last, until the card’s step changes', async () => {
  const app = runScreen(), added = [], aim = () => { const a = app.runAim; return [a.on.title, a.after, a.title, a.before]; };
  app.addStep = async f => { added.push(f); };
  app.showStep(2);                                                         // C tapped, on the card
  assert.deepEqual(aim(), ['C', 53, 'C', 54], 'after C, before D');
  const ids = await app.addSteps([{ title: 'X' }, { title: 'Y' }]);
  assert.deepEqual(added.map(f => [f.id, f.title, f.after, f.before]), [[ids[0], 'X', 53, 54], [ids[1], 'Y', 'pending-' + ids[0], 54]], 'a pasted list in order');
  assert.deepEqual(aim(), ['C', 'pending-' + ids[1], 'Y', 54], 'the next goes after Y, still before D');
  app.showStep(3);
  assert.deepEqual(aim(), ['D', 54, 'D', null], 'D on the card: after it, at the end');
  app.showStep(2);
  assert.deepEqual(aim(), ['C', 53, 'C', 54], 'back on C, from C again');
});

test('a run’s bottom box: every step done, after the last; none on a run finished or read only', () => {
  const app = runScreen();
  for (const s of app.view.run.steps) Object.assign(s, { done: true, done_at: new Date().toISOString() });
  assert.equal(app.runView.step, null, 'no step on the card');
  assert.deepEqual([app.runAim.on.title, app.runAim.before], ['D', null]);
  app.perms[5] = 0;
  assert.equal(app.runAim, null, 'read only');
  app.perms[5] = 1; app.view.run.run.done = true;
  assert.equal(app.runAim, null, 'finished');
});

test('Repeat copies the card’s step where the box aims, with an Undo that puts the aim back', async () => {
  const app = runScreen(), added = [], said = [];
  app.addStep = async f => { added.push(f); };
  app.showStep(2);                                                         // C tapped, on the card
  app.say = (text, o) => said.push({ text, ...o });
  app.dropStep = async () => false;                                        // still waiting: not sent
  await app.addSteps([{ title: 'X' }]);
  await app.repeatCard();
  assert.deepEqual([added[1].title, added[1].tpl, added[1].after, added[1].before], ['C', 'C', 'pending-' + added[0].id, 54], 'a copy of C, after X');
  assert.deepEqual([said[0].text, said[0].place, said[0].action.label], ['Repeated “C”', 'cap', 'Undo']);
  assert.equal(app.runAim.after, 'pending-' + added[1].id);
  await said[0].action.fn();
  assert.deepEqual([app.runAim.after, app.runAim.title, app.said], ['pending-' + added[0].id, 'X', 'Not repeated: C'], 'after X again');
});

/* A parent's ring (parent-tasks-plan, part 3; design rules 7 and 8): its tap never closes subtasks without asking, unless
   there's one, which has an Undo; with every subtask done, it's Close. */
const ringed = (c, list) => {
  if (c) c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(list), app = component(cards, tasks, leaving, actions, runs);
  Object.assign(app, { cardPage: {}, cardOpen: {}, positions: {}, lines: {}, pending: [], perms: {}, checklistIds: new Set(),
    openSheet(kind){ this.sheet = { kind, open: true }; }, closeSheet(){ this.sheet = { kind: '', open: false }; } });
  for (const t of list) app.keep(t);
  return { v, app };
};
const ROW = {}, parentOf = (...kids) => ({ id: 10, title: 'Pack the van', done: false, project_id: 5, related_tasks: { subtask: kids.map(k => ({ id: k.id, done: !!k.done })) } });
const kid = (id, f = {}) => ({ id, title: 'Kid ' + id, done: false, project_id: 5, related_tasks: under(10), ...f });

test('a parent’s ring with one open subtask: it and the parent completed at once, shown as a gap with Undo', async c => {
  const kids = [kid(11), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([v.task(10).done, v.task(11).done], [true, true]);
  assert.deepEqual([app.leaving, app.swept], [{ 10: 'done', 11: 'done' }, { 10: true }], 'its card a gap holding Undo until the batch clears');
  assert.equal(app.sheet.kind, undefined, 'nothing asked');
  await app.ringTap(app.tasks[10], ROW);                                     // its ring again, or the gap's Undo
  assert.deepEqual([v.task(10).done, v.task(11).done], [false, false], 'both open again');
});

test('a parent’s ring with more open subtasks asks first, listing them; confirmed, they and the parent are completed', async c => {
  const kids = [kid(11), kid(12), kid(13, { repeat_after: 86400, due_date: '2026-10-09T09:00:00Z' }), kid(14, { done: true })];
  const { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([app.sheet.kind, app.sheet.complete.n, app.sheet.complete.stay, app.sheet.complete.open.map(s => s.title)], ['complete', 2, 1, ['Kid 11', 'Kid 12', 'Kid 13']], 'Complete 2 open subtasks? The one that repeats stays');
  assert.deepEqual(app.sheet.complete.ask, {head: 'Complete “Pack the van”?', yes: 'Complete all 3',
    body: 'Its 2 open subtasks will be marked done too: Kid 11 and Kid 12. The one that repeats stays as it is.'}, 'named in a sentence');
  assert.equal(v.task(10).done, false, 'nothing done while it asks');
  app.cancelComplete();
  assert.equal(app.sheet.open, false, 'Cancel: back where it was');
  await app.ringTap(app.tasks[10], ROW);
  await app.confirmComplete();
  assert.deepEqual([10, 11, 12, 13].map(id => v.task(id).done), [true, true, true, false], 'the one that repeats left as it is');
});

test('the question asked from a task’s sheet goes back to that sheet however it’s closed, and Back then closes the sheet', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const kids = [kid(11), kid(12)], v = fakeVikunja([parentOf(...kids), ...kids]), app = component(cards, tasks, leaving, actions, runs, sheetPart);
  // the phone's history, as much of it as a sheet uses: its entry pushed, marked closed, or gone back from
  globalThis.history = { state: null, pushState(s){ this.state = s; }, replaceState(s){ this.state = s; } };
  document.getElementById = () => ({ querySelector: () => ({}) });
  const opened = [];
  Object.assign(app, { cardPage: {}, cardOpen: {}, positions: {}, lines: {}, pending: [], perms: {}, checklistIds: new Set(), $nextTick(){},
    openTask(id){ opened.push(id); this.openSheet('task'); this.sheet.show = true; } });
  for (const t of [parentOf(...kids), ...kids]) app.keep(t);
  const ask = sheet => { app.openSheet('task'); app.sheet.show = true; app.askComplete(app.tasks[10], sheet); assert.equal(app.sheet.kind, 'complete'); };
  ask(true);
  app.closeSheet();                                                          // the ×, the slide down, the shade, Escape
  assert.deepEqual([opened, app.sheet.kind, app.sheet.open], [[10], 'task', true], 'back on the task’s sheet, as Cancel goes');
  ask(true);
  history.state = null;                                                      // the phone's Back: the sheet's entry gone
  app.closeSheet();                                                          // (core.js's popstate)
  assert.deepEqual([opened, app.sheet.kind, history.state?.sheet], [[10, 10], 'task', true], 'the task’s sheet, with an entry of its own for Back');
  app.closeSheet();
  assert.equal(app.sheet.open, true, 'still showing as it slides down');
  c.mock.timers.tick(300);
  assert.deepEqual([app.sheet.open, history.state.sheet], [false, 'closed'], 'Back, or the ×, then closes the task’s sheet');
  ask(true);
  app.closeSheet(true);                                                      // confirmed, or a screen opened: closed outright
  assert.deepEqual([app.sheet.open, opened.length], [false, 2]);
  ask(false);                                                                // asked from a list: closing it closes it
  app.closeSheet(); c.mock.timers.tick(300);
  assert.deepEqual([app.sheet.open, opened.length, v.task(10).done], [false, 2, false]);
});

test('a parent with every subtask done waits for Close; a repeating one is done as before, its subtasks as they are', async c => {
  const kids = [kid(11, { done: true }), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  assert.equal(app.ringOf(app.tasks[10]).open, 0);
  await app.ringTap(app.tasks[10], ROW);                                     // Close
  assert.deepEqual([v.task(10).done, app.leaving[10], app.swept[10]], [true, 'done', true]);
  const open = [kid(21), kid(22)], rep = { ...parentOf(...open), id: 20, repeat_after: 86400, due_date: '2026-10-09T09:00:00Z' };
  const r = ringed(null, [rep, ...open]);
  await r.app.ringTap(r.app.tasks[20], ROW);
  assert.equal(r.app.sheet.kind, undefined, 'not asked: its subtasks aren\'t touched');
  assert.notEqual(r.v.task(20).due_date, '2026-10-09T09:00:00Z', 'on to its next date');
  assert.deepEqual([21, 22].map(id => r.v.task(id).done), [false, false]);
});

test('a run’s ring with steps not done asks first, and finishing it leaves them not done; a done parent’s ring opens it again', async c => {
  const kids = [kid(11), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  app.isRunTask = t => t.id === 10;
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([app.sheet.kind, app.sheet.complete.run, app.sheet.complete.n], ['complete', true, 1], 'Finish this run with 1 step not done?');
  assert.equal(app.ringOf(app.tasks[10]).label, 'Finish “Pack the van”, with 1 step not done');
  app.isRunTask = () => false;
  app.tasks[10].done = true;
  await app.ringTap(app.tasks[10], ROW);
  assert.equal(v.task(10).done, false, 'done elsewhere over a subtask still open: its ring opens it again');
  assert.equal(v.task(11).done, false);
});
