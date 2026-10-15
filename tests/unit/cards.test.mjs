// Tests for the stacked card (src/js/cards.js, and app/cards.js on a fake component). They cover which tasks become
// cards on Today and what brought each, where each card sits, which subtask is its top row, its peek, opening it and
// its count. They also cover a card in search, where a checklist goes next (one rule shared by its card and its
// screen), and the add box at the bottom aimed at a checklist's step.
import { component, fakeVikunja } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardGroup, cardRows, countdown, runTop, todayItems, urgentFirst } from '../../src/js/cards.js';
import { dueInfo, shortTime } from '../../src/js/dates.js';
import { listItems, nestSubtasks, rowGestures, RUN_ROW, saved } from '../../src/js/lists.js';
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
import quickadd from '../../src/js/app/quickadd.js';
import { countText, runShows, whereNext } from '../../src/js/checklists.js';
import { watching } from './reactive.mjs';

const NONE = '0001-01-01T00:00:00Z', me = { id: 1 }, other = { id: 2 };
const at = (d, h) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const under = (id, project = 5) => ({ parenttask: [{ id, project_id: project }] });
const task = (id, f = {}) => ({ id, title: 'Task ' + id, done: false, due_date: NONE, project_id: 5, created_by: me, assignees: [], related_tasks: {}, ...f });
const subs = (...list) => ({ subtask: list.map(([id, done = false]) => ({ id, done })) });
const ids = list => list.map(r => r.t.id);

test('a task due today is a row, or a card dated by its own date if it has open subtasks', () => {
  const { rows, cards } = todayItems({ tasks: [task(1, { due_date: at(8, 9) }), task(2, { due_date: at(8, 10), related_tasks: subs([3], [4, true]) }),
    task(5, { due_date: at(8, 11), related_tasks: subs([6, true]) })] }, me);
  assert.deepEqual(ids(rows), [1, 5], 'a task whose subtasks are all done is a row');
  assert.deepEqual([...cards.keys()], [2]);
  assert.equal(cards.get(2).when, at(8, 10));
  assert.equal(cardGroup(cards.get(2), false), 'dated');
});

test('a due subtask brings its task’s card, and the card opens on the subtask only if it is yours', () => {
  const { rows, cards } = todayItems({ tasks: [task(3, { due_date: at(8, 9), related_tasks: under(2) }), task(4, { due_date: at(9, 9), assignees: [me], related_tasks: under(7) })] }, me);
  assert.deepEqual(rows, [], 'subtasks are never separate rows on Today');
  assert.deepEqual({ ...cards.get(2), from: undefined }, { when: at(8, 9), made: null, focus: null, project: 5, from: undefined });
  assert.equal(cards.get(7).focus, 4, 'for a subtask assigned to you, the card opens on it');
  assert.deepEqual(cards.get(2).from.map(t => t.id), [3], 'the card keeps the subtasks that brought it, to show them as rows if its task cannot be read');
});

test('a card is dated by the earliest date that brought it, its own or a subtask’s', () => {
  const { cards } = todayItems({ tasks: [task(2, { due_date: at(12, 9), related_tasks: subs([3], [4]) }), task(3, { due_date: at(9, 9), related_tasks: under(2) }),
    task(4, { due_date: at(10, 9), assignees: [me], related_tasks: under(2) })] }, me);
  assert.equal(cards.get(2).when, at(9, 9));
  assert.equal(cards.get(2).focus, 4);
});

test('an undated subtask created today brings its task’s card if it is yours, but not if it is someone else’s', () => {
  const { rows, cards } = todayItems({ added: [
    task(3, { assignees: [me], created: at(8, 9), related_tasks: under(2) }), task(4, { assignees: [other], created: at(8, 10), related_tasks: under(6) }),
    task(5, { created_by: me, created: at(8, 8) }), task(8, { created_by: other, created: at(8, 8) }),
    task(9, { created_by: me, created: at(8, 7), related_tasks: subs([10]) }), task(11, { due_date: at(8, 20), created_by: me }),
  ] }, me);
  assert.deepEqual([...cards.keys()], [2, 9]);
  assert.deepEqual([cards.get(2).focus, cards.get(2).made, cards.get(2).when], [3, at(8, 9), null]);
  assert.equal(cardGroup(cards.get(2), false), 'nodate', 'under “Added today, no date”');
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[5, 'nodate']], 'only your undated task is a row, not someone else’s task or a task with a date');
});

test('under Checklists, your checklist in progress is a card, one with no open step is a row, and a claimed step brings its checklist', () => {
  const run = task(20, { related_tasks: subs([21, true], [22]) }), done = task(30, { related_tasks: subs([31, true]) });
  const { rows, cards } = todayItems({ mine: [run, done], claimed: [task(41, { assignees: [me], related_tasks: under(40, 9) })] }, me, t => [20, 30, 40].includes(t.id) ? 'run' : null);
  assert.deepEqual(rows.map(r => [r.t.id, r.key]), [[30, 'runs']]);
  assert.equal(cardGroup(cards.get(20), true), 'runs');
  assert.equal(cards.get(40).focus, 41);
  assert.equal(cards.get(40).project, 9);
});

test('a repeating template is a row, and a checklist is started from it', () => {
  const tpl = task(50, { due_date: at(8, 9), labels: [{ title: 'template' }], related_tasks: subs([51, true], [52, true]) });
  assert.deepEqual(ids(todayItems({ tasks: [tpl] }, me, () => 'template').rows), [50]);
  const open = { ...tpl, related_tasks: subs([51], [52, true]) };
  assert.deepEqual([...todayItems({ tasks: [open] }, me, () => 'template').cards.keys()], [], 'a template with an open step is still a row');
  assert.deepEqual([...todayItems({ tasks: [open] }, me).cards.keys()], [50], 'a task labelled "template" outside a Checklists project is a card like any other');
});

test('a card’s top row is the most urgent subtask: overdue, then due today, then the earliest date, then list order', () => {
  const now = new Date(2026, 9, 8, 12), day = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const order = (a, b) => a.pos - b.pos, s = (id, pos, due = NONE) => ({ id, pos, due_date: due });
  const list = [s(1, 1), s(2, 2, day(12, 9)), s(3, 3, day(8, 18)), s(4, 4, day(7, 9)), s(5, 5, day(8, 0)), s(6, 6, day(8, 9)), s(7, 7), s(8, 8, day(10, 9))];
  assert.deepEqual([...list].sort(urgentFirst(+now, order)).map(x => x.id), [4, 6, 5, 3, 8, 2, 1, 7],
    'order is late (yesterday, then 9 this morning), today (no time, then 6 PM), later dates, then the rest in list order');
});

test('a card’s subtasks sort by the calendar day on a 23-hour day, so 12:30 AM tomorrow comes after today', () => {
  const was = process.env.TZ; process.env.TZ = 'America/New_York';   // 8 March 2026 has 23 hours there
  try {
    const day = (d, h, m = 0) => new Date(2026, 2, d, h, m).toISOString(), s = (id, due = NONE) => ({ id, pos: id, due_date: due });
    const list = [s(1), s(2, day(9, 0, 30)), s(3, day(8, 0)), s(4, day(8, 9))];
    assert.deepEqual(list.sort(urgentFirst(+new Date(2026, 2, 8, 12), (a, b) => a.pos - b.pos)).map(x => x.id), [4, 3, 2, 1]);
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test('a checklist card’s top row stays on the ticked step until it leaves, then follows the checklist’s rule', () => {
  const steps = [{ id: 1 }, { id: 2 }, { id: 3 }], asked = [];
  const pick = from => { asked.push(from); return from === null ? 2 : 3; };
  assert.equal(runTop(steps, null, pick), 1, 'when the card opens, the rule picks from the start');
  assert.equal(runTop(steps, 1, pick), 0, 'the card stays on its top row while that step is still there, for example waiting for the batch');
  assert.equal(runTop(steps.slice(1), 1, pick), 1, 'once that step has left, the rule picks from it');
  assert.equal(runTop(steps, null, () => null), 0, 'if the rule picks nothing, the first step is the top row');
  assert.equal(runTop([], null, pick), -1);
  assert.deepEqual(asked, [null, 1]);
});

test('a checklist step’s countdown is shown to the minute, within a day', () => {
  const now = Date.parse(at(8, 9));
  assert.deepEqual(countdown(now + 65 * 6e4 + 1000, now), { text: 'in 1h 6m', late: false });
  assert.deepEqual(countdown(now - 12.5 * 6e4, now), { text: '12m late', late: true });
  assert.deepEqual(countdown(now + 1000, now), { text: 'in 1m', late: false }, 'never “in 0s”');
  assert.equal(countdown(now + 864e5 * 2, now), null, 'a step further off than a day shows its date instead of a countdown');
});

// The component with Today's cards. `parent` has its subtasks in the store, at their positions in its List view:
// 14 (done) first, then Chairs, Tables and Lights.
const today = (...more) => {
  const app = component(cards, views, alerts, tasks, leaving, ...more);
  Object.assign(app, { cardPage: {}, cardOpen: {}, cardAdded: {}, positions: { 11: 3, 12: 1, 13: 2, 14: 0.5 }, projById: new Map([[5, { id: 5, title: 'Café', hex_color: '' }]]), checklistIds: new Set(), waitingByTask: new Map() });
  const parent = app.row(task(10, { title: 'Pack the van', related_tasks: subs([11], [12], [13], [14, true]) }));
  for (const [id, title] of [[11, 'Lights'], [12, 'Chairs'], [13, 'Tables']]) app.row(task(id, { title, related_tasks: under(10) }));
  app.view.cards = { 10: { when: null, made: null, focus: null } };
  return { app, parent, g: { cards: 'today', line: true } };
};

test('subtasks added from Today’s box go where the box was, under the header or under the nudged row', () => {
  const s = [['Chairs', 1], ['Tables', 2], ['Lights', 3]].map(([title, id]) => ({ id, title })), t = id => ({ id, title: 'new ' + id });
  let r = cardRows(s, [{ t: t('p1'), after: null }], false);
  assert.deepEqual([r.rows.map(x => x.title), r.step.title, r.peek.title, r.more], [['new p1', 'Chairs'], 'Chairs', 'Tables', 2], 'under the header, the new subtask is on top, above the most urgent, and the rest are under More');
  r = cardRows(s, [{ t: t('p1'), after: null }, { t: t('p2'), after: 'p1' }], false);
  assert.deepEqual(r.rows.map(x => x.title), ['new p1', 'new p2', 'Chairs'], 'each new subtask goes under the one added before it');
  r = cardRows(s, [{ t: t('p1'), after: 1 }], false);
  assert.deepEqual(r.rows.map(x => x.title), ['Chairs', 'new p1'], 'the new subtask goes under the nudged row');
  r = cardRows(s, [{ t: t('p1'), after: 2 }], true);
  assert.deepEqual([r.rows.map(x => x.title), r.list.length, r.peek, r.more], [['Chairs', 'Tables', 'new p1', 'Lights'], 4, null, 0], 'an open card shows every row, with the new subtask after its row');
  r = cardRows(s, [{ t: s[2], after: null }], false);
  assert.deepEqual([r.rows.map(x => x.title), r.more], [['Lights', 'Chairs'], 1], 'a subtask that was sent and is now among the subtasks appears once, where it was added');
  r = cardRows(s, [{ t: t('p1'), after: 'gone' }], false);
  assert.deepEqual(r.rows.map(x => x.title), ['new p1', 'Chairs'], 'if the row it went under has left, the new subtask goes on top');
  r = cardRows([], [{ t: t('p1'), after: null }], false);
  assert.deepEqual([r.rows.map(x => x.title), r.step.title, r.peek, r.more], [['new p1'], 'new p1', null, 0], 'a task with no subtasks before becomes a card of the subtask just added');
});

test('on Today, a subtask added from the box appears on its card at once, and stays until the screen is left', () => {
  const { app, parent, g } = today();
  Object.defineProperty(app, 'pendingTasks', { get: () => [{ id: 'pending-e-0', pending: true, title: 'Rope', parent: 10 }], configurable: true });
  app.cardAdded = { 10: [{ id: 'pending-e-0', after: null }] };
  let c = app.cardOf(parent, g);
  assert.deepEqual([c.rows.map(s => s.title), c.rows[0].pending, c.n, c.more, c.peek.title], [['Rope', 'Chairs'], true, 4, 2, 'Tables'], 'the waiting row is on top, above the most urgent, and the card is one row taller');
  app.cardAdded[10][0].id = 15;
  app.row(task(15, { title: 'Rope', related_tasks: under(10) }));
  c = app.cardOf(parent, g);
  assert.deepEqual([c.rows.map(s => s.title), c.rows[0].pending, c.n], [['Rope', 'Chairs'], undefined, 4], 'once sent, its task takes the waiting row’s place');
  app.cardAdded[10].push({ id: 'pending-e-1', after: 15 });
  Object.defineProperty(app, 'pendingTasks', { get: () => [{ id: 'pending-e-1', pending: true, title: 'Tape', parent: 10 }], configurable: true });
  assert.deepEqual(app.cardOf(parent, g).rows.map(s => s.title), ['Rope', 'Tape', 'Chairs'], 'the next added subtask goes under it');
  app.view.cards = {};
  assert.equal(app.cardOf(parent, g).rows.length, 3, 'the card stays for the subtasks added to it, whatever brought it');
  app.resetCards();
  assert.equal(app.cardOf(parent, g), null, 'leaving the screen restores Today as it was');
});

test('a card lists its open subtasks most urgent first, collapsed to its top row with More under it, and has a ring', () => {
  const { app, parent, g } = today(), c = app.cardOf(parent, g);
  assert.deepEqual(c.steps.map(s => s.title), ['Chairs', 'Tables', 'Lights'], 'with no dates, the subtasks follow the List view’s order');
  assert.deepEqual([c.step.title, c.rows.map(s => s.title), c.peek.title, c.more, c.open], ['Chairs', ['Chairs'], 'Tables', 2, false], 'the card shows its top row, and More shows the next subtask and how many more there are');
  assert.deepEqual([c.ring.done, c.ring.total, c.ring.pct, c.ring.said], [1, 4, 25, '1 of 4 subtasks done, 25%'], 'the ring counts the done subtask and calculates the percentage');
  assert.equal(c.ring.label, 'Complete “Pack the van” and its 3 open subtasks', 'the ring has a label that names what tapping it does');
  assert.deepEqual([c.g.card, c.g.line, c.g.delete], [c, true, true], 'the rows know their card, show on one line, and have Delete, as Today’s rows do');
  assert.equal(app.cardOf(parent, { depth: {} }), null, 'cards exist only on a list with cards');
  assert.deepEqual(app.rowMeta(c.step, c.g).map(m => m.text), [], 'the row does not show which step it is or the project, because the card does');
  app.tasks[11].due_date = new Date(Date.now() - 36e5).toISOString();
  assert.deepEqual(app.cardOf(parent, g).steps.map(s => s.title), ['Lights', 'Chairs', 'Tables'], 'a late Lights subtask moves to the top');
});

test('More opens a card to every open subtask and Less collapses it, and a card with one open subtask has neither', () => {
  const { app, parent, g } = today();
  assert.deepEqual([app.itemClass(parent, g), app.itemClass(parent, { depth: {} })], ['has-card has-tab', ''], 'the card’s item has the classes has-card and has-tab, and a row’s item has neither');
  app.openCard(app.cardOf(parent, g));
  let c = app.cardOf(parent, g);
  assert.deepEqual([c.open, c.rows.map(s => s.title), c.peek, c.folds], [true, ['Chairs', 'Tables', 'Lights'], null, true]);
  assert.equal(app.itemClass(parent, g), 'has-card has-tab', 'an open card’s item keeps has-tab, because its footer is Less');
  app.foldCard(c.id);
  c = app.cardOf(parent, g);
  assert.deepEqual([c.open, c.rows.length, c.peek.title], [false, 1, 'Tables'], 'after collapsing, More is back');
  app.openCard(c);
  app.resetCards();
  assert.equal(app.cardOf(parent, g).open, false, 'leaving the screen collapses the card');
  for (const id of [12, 13]) app.tasks[id].done = true;
  c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek, c.more, app.itemClass(parent, g)], ['Lights', null, 0, 'has-card'], 'with one open subtask, the card has no More or Less, and its item has no has-tab');
  app.openCard(c);
  assert.equal(app.cardOf(parent, g).open, false, 'there is nothing to open');
});

test('in search, an open task with open subtasks is a collapsed card, and the subtasks found with it are on it', () => {
  const { app, parent } = today(checklists), g = { cards: 'found', delete: true };
  Object.assign(app, { route: { name: 'search' }, checklistIds: new Set([7]) });
  const c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek.title, c.g.line, c.g.delete], ['Chairs', 'Tables', undefined, true], 'the card’s rows keep their second line, as search rows do');
  assert.equal(app.cardOf({ ...parent, done: true }, g), null, 'a done task is not a card');
  assert.equal(app.cardOf({ ...parent, project_id: 7, due_date: at(8, 9), labels: [{ title: 'template' }] }, g), null, 'a template is not a card');
  assert.notEqual(app.cardOf({ ...parent, labels: [{ title: 'template' }] }, g), null, 'a task labelled "template" outside a Checklists project is a card');
  assert.equal(app.cardOf(app.tasks[11], g), null, 'a task with no subtasks is not a card');
  const found = [parent, app.tasks[12], app.tasks[11], { id: 30 }, { id: 31 }, { id: 32 }];
  const depth = { 10: 0, 12: 1, 11: 1, 30: 0, 31: 1, 32: 2 };
  assert.deepEqual(listItems(found, depth, t => t.id === 10).map(t => t.id), [10, 30, 31, 32], 'a card’s subtasks are on the card, and another task’s subtasks are rows under it');
});

test('a card’s heading shows priority bars only when there is a priority, and announces progress, due date, priority and project', () => {
  const { app, parent } = today();
  assert.deepEqual([app.cardHead(parent).title, app.cardHead(parent).prio, app.cardHead(parent).due, app.cardHead(parent).said], ['Pack the van', 0, null, '1 of 4 subtasks done, 25%, Café'], 'with no priority there are no bars, with no date nothing shows at the right, and the announcement includes the ring');
  const urgent = { ...parent, priority: 4, due_date: at(8, 10) }, row = app.rowMeta(urgent, { depth: {} }).find(m => m.key === 'prio'), h = app.cardHead(urgent);
  assert.equal(h.prio, 4);
  assert.equal(row.label, 'Priority: Urgent');
  const when = dueInfo(urgent.due_date);
  assert.equal(h.said, `1 of 4 subtasks done, 25%, ${when.cls === 'overdue' ? 'Late: ' : 'Due '}${when.label}, ${row.label}, Café`, 'the announcement gives the due date in words, the priority as the row words it, and the project');
  Object.assign(app, { isRunTask: t => t.id === 10, forText: t => t.assignees.length ? 'For you' : '' });
  assert.equal(app.cardHead(urgent).said.split(', ').pop(), 'Checklist', 'a checklist for no one is announced as Checklist instead of its project');
  assert.equal(app.cardHead({ ...urgent, assignees: [me] }).said.split(', ').pop(), 'For you', 'a checklist for someone is announced with who it is for');
});

// The card's header shows the project dot, so its rows leave the dot out and give that space to the subtask's text.
test('a card’s header shows the project dot once, its rows leave the dot out, and a row in another project keeps it', () => {
  const { app, parent, g } = today();
  app.projById = new Map([[5, { id: 5, title: 'Café', hex_color: '1d6b52' }], [6, { id: 6, title: 'Upkeep', hex_color: '3d85c6' }]]);
  const c = app.cardOf(parent, g);
  assert.equal(app.cardHead(parent, g).color, '#1d6b52', 'the header shows the project’s colour');
  assert.equal(c.project, 5, 'the card knows its task’s project, so its rows can leave the dot out');
  const w = app.rowWhen(c.step, c.g);
  assert.deepEqual([w.color, /Café/.test(w.said)], [null, false], 'a card row in the card’s project shows no dot and does not announce the project, because the header does');
  assert.equal(app.rowWhen(c.step, { line: true, depth: {} }).color, '#1d6b52', 'the same task as a plain row shows the dot');
  app.change(w => w.base(task(13, { title: 'Tables', project_id: 6, related_tasks: under(10) })));
  const far = app.tasks[13], f = app.rowWhen(far, c.g);
  assert.deepEqual([f.color, f.said], ['#3d85c6', 'Upkeep'], 'a subtask in another project shows its own dot and announces its project');
  assert.deepEqual(app.rowMeta(far, c.g).map(m => m.text), ['Upkeep'], 'the row does not name the task above it, because the card does');
  // In search a card's rows keep their second line. It shows no project unless the subtask is in a different one. The header has the dot.
  app.route = { name: 'search' };
  const found = app.cardOf(parent, { cards: 'found', delete: true });
  assert.equal(app.cardHead(parent, { cards: 'found' }).color, '#1d6b52', 'the header shows the dot in search too');
  assert.deepEqual([app.rowMeta(found.step, found.g).map(m => m.text), app.rowMeta(far, found.g).map(m => [m.color, m.text])], [[], [['#3d85c6', 'Upkeep']]]);
  // On the task's own project list, neither the rows nor the header show the project.
  app.route = { name: 'project' };
  assert.equal(app.cardHead(parent, { cards: 'list' }).color, null, 'the header shows no dot on its own project’s list');
  app.route = { name: 'today' };
  app.projById = new Map();
  assert.equal(app.cardHead(parent, g).color, null, 'a project Pocket does not know has no dot');
});

test('on a project’s list a card is always open, with its subtasks in List view order, including those waiting to be sent', () => {
  const { app, parent } = today();
  app.route = { name: 'project' };
  const rope = { id: 'pending-x-0', pending: true, parent: 10, position: 2.5, title: 'Rope', project_id: 5, related_tasks: {} };
  const plain = app.row(task(20)), deeper = app.row(task(30, { related_tasks: under(12) }));
  const n = nestSubtasks([plain, app.tasks[11], parent, app.tasks[13], rope, app.tasks[12], deeper], positionOrder(app.positions));
  const g = { cards: 'list', delete: true, reorder: true, heads: [], ...n }, c = app.cardOf(parent, g);
  assert.deepEqual(c.rows.map(s => s.title), ['Chairs', 'Tables', 'Rope', 'Lights'], 'the card lists the subtasks under it in the project, including one waiting to be sent');
  assert.deepEqual([c.open, c.folds, c.peek], [true, false, null], 'the card stays open, with no More or Less');
  assert.deepEqual([c.ring.done, c.ring.total, c.ring.pct], [1, 5, 20], 'the ring counts the subtask waiting to be sent, at 0%');
  assert.deepEqual([c.g.delete, c.g.reorder, c.g.depth], [true, true, {}], 'the card’s rows delete and move as the list’s rows do');
  assert.equal(app.cardOf(plain, g), null, 'a task with no subtasks there is a row');
  assert.equal(app.cardOf(app.tasks[12], g), null, 'Chairs has a subtask of its own, so it is a row on the card and opens its sheet');
  assert.ok(app.cardOf({ ...parent, done: true }, g), 'a done task above subtasks that are still open is also a card');
  assert.deepEqual(listItems(n.tasks, n.depth, t => !!app.cardOf(t, g)).map(t => t.id), [10, 20], 'the card holds everything under it, then comes the row');
});

test('a ticked top row stays on the card until the batch clears, and then the next subtask moves up', () => {
  const { app, parent, g } = today();
  const c = app.cardOf(parent, g);
  assert.equal(c.step.title, 'Chairs');
  app.pinCard(c);
  app.tasks[12].done = true; app.leaving[12] = 'done';
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).peek.title, app.cardOf(parent, g).ring.done], ['Chairs', 'Tables', 2], 'the done row stays on top and is counted');
  delete app.leaving[12];
  assert.deepEqual([app.cardOf(parent, g).step.title, app.cardOf(parent, g).peek.title, app.cardOf(parent, g).more], ['Tables', 'Lights', 1], 'after the batch clears, the next subtask moves up');
  for (const id of [11, 13]) app.tasks[id].done = true;
  const all = app.cardOf(parent, g);
  assert.deepEqual([all.closes, all.rows, all.peek, all.ring.open, all.ring.pct], [true, [], null, 0, 100], 'with no open step left, the card waits for Close and its ring is full, so nothing closes without a tap');
  assert.equal(all.ring.label, 'Close “Pack the van”: all its subtasks are done');
});

/* A card is worked out from what is done, and a task counts as done the moment the user ticks it, before Vikunja
   answers and before its row is marked. Without a hold, a card's top row would drop off the card while the save is on
   its way, the next subtask would move up in its place, and then the done row would come back with its Undo. On a
   phone, where an answer takes longer than a frame, the next subtask raced the animation and cut it short. So a row
   done in a list stays where it is from that moment (holdRow, leaving.js). This covers a tap or a full swipe, a
   task's subtask or a checklist's step, on a collapsed card or an open one. */
test('a done top row stays the card’s top row from the tap or swipe until the batch clears, however long Vikunja takes', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, parent, g } = today(actions), v = fakeVikunja(Object.values(app.tasks)), send = globalThis.fetch;
  Object.assign(app, { lines: {}, pending: [], perms: {}, render(){} });
  app.view.groups = [{ key: 'today', tasks: [parent] }];
  // Vikunja's answers are held back until answer() is called.
  let held = [];
  const answer = () => { const go = held; held = []; go.forEach(ok => ok()); };
  globalThis.fetch = async (...a) => { await new Promise(ok => held.push(ok)); return send(...a); };
  const card = () => app.cardOf(parent, g), top = () => card().step.title, turn = () => new Promise(ok => setImmediate(ok));
  const over = async doing => { let done = false; doing.then(() => { done = true; }); while (!done) { answer(); await turn(); } };
  try {
    // Tapping the tick.
    assert.deepEqual([top(), card().peek.title, card().more], ['Chairs', 'Tables', 2]);
    app.pinCard(card());
    let doing = app.toggleDone(app.tasks[12], ROW);
    await turn();
    assert.deepEqual([app.tasks[12].done, v.task(12).done], [true, false], 'the task is done on the phone before Vikunja has answered');
    assert.deepEqual([top(), card().peek.title, card().more], ['Chairs', 'Tables', 2], 'the ticked row stays on top and the next subtask stays under More');
    await over(doing);
    assert.deepEqual([top(), app.leaving, v.task(12).done], ['Chairs', { 12: 'done' }, true], 'after Vikunja answers, the row is marked and stays where it was');
    await app.clearBatch(true);
    assert.deepEqual([top(), card().peek.title, card().more], ['Tables', 'Lights', 1], 'the next subtask moves up when the batch clears, and not before');
    // A full swipe right, once released, is held as done from that moment, the same as a tick.
    doing = app.setProgress(app.tasks[13], 100, ROW);
    await turn();
    assert.deepEqual([top(), card().peek.title, card().more, app.leaving, v.task(13).done], ['Tables', 'Lights', 1, { 13: 'done' }, false], 'after the swipe is released, the row stays on top as done before Vikunja has answered');
    await over(doing);
    assert.deepEqual([top(), app.leaving], ['Tables', { 13: 'done' }]);
    await over(Promise.resolve(app.unmark(13)));
    assert.deepEqual([top(), app.tasks[13].done, app.leaving], ['Tables', false, {}], 'tapping the tick opens the row again, where it was');
    // On an opened card the rows stay as they are, including the done one.
    app.openCard(card());
    assert.deepEqual(card().rows.map(s => s.title), ['Tables', 'Lights']);
    doing = app.setProgress(app.tasks[13], 100, ROW);
    await turn();
    assert.deepEqual(card().rows.map(s => s.title), ['Tables', 'Lights'], 'no row leaves the card and comes back when Vikunja answers');
    await over(doing);
    await app.clearBatch(true);
    assert.deepEqual([top(), card().rows.map(s => s.title)], ['Lights', ['Lights']]);
    // If the save fails, the row is released, open, where it was, and shows a message saying why.
    v.trouble = () => 500;
    doing = app.toggleDone(app.tasks[11], ROW);
    await turn();
    assert.deepEqual([top(), app.leaving[11]], ['Lights', 'done'], 'the row is held while the save is tried');
    await over(doing);
    assert.deepEqual([top(), app.leaving, app.tasks[11].done], ['Lights', {}, false], 'after a failed save, the row is released and not done');
    assert.match(app.toast.msg, /^Not saved: /);
  } finally { globalThis.fetch = send; }
});

// A plain row on Today that is done is held the same way. A list loaded while its save is on its way then treats the
// row like a marked one. It keeps the row, though Vikunja's list no longer has it (keepMarked). It also keeps the row
// ticked, though Vikunja's copy of the task is still open (keep).
test('a row ticked on Today stays ticked in a list loaded before Vikunja has answered the tick', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app } = today(actions), row = app.row(task(20, { title: 'Call the plumber' })), v = fakeVikunja([row]), send = globalThis.fetch;
  Object.assign(app, { lines: {}, pending: [], perms: {}, render(){} });
  app.view.groups = [{ key: 'today', tasks: [row] }];
  let held = [], done = false;
  globalThis.fetch = async (...a) => { await new Promise(ok => held.push(ok)); return send(...a); };
  try {
    const doing = app.toggleDone(row, ROW).then(() => { done = true; });
    assert.deepEqual([row.done, v.task(20).done, app.leaving], [true, false, { 20: 'done' }], 'the row is held from the tap');
    assert.deepEqual(app.keepMarked([{ key: 'today', tasks: [] }])[0].tasks.map(t => t.id), [20], 'a list loaded meanwhile keeps the row');
    assert.deepEqual([app.row({ ...v.task(20) }) === row, row.done], [true, true], 'Vikunja\'s copy, still open until it answers, does not untick the row');
    while (!done) { held.splice(0).forEach(ok => ok()); await new Promise(ok => setImmediate(ok)); }
    await doing;
    assert.deepEqual(app.leaving, { 20: 'done' }, 'after Vikunja answers, the row is marked');
  } finally { globalThis.fetch = send; }
});

// A checklist's step on its card goes through the outbox, which also answers in its own time, so the row is held the
// same way.
test('a done top step of a checklist card stays the top row while the outbox takes it, and until the batch clears', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, parent, g } = today(actions);
  let taken = null;
  // As act does, the tick is in the outbox at once, and shows on the step's row through its op. Sending answers later.
  const outbox = list => { app.pending = list; app.change(w => w.keyOps()); };
  const act = f => { outbox([...app.pending, { kind: 'act', id: 'tick' + f.task, ...f }]); return new Promise(ok => { taken = ok; }); };
  Object.assign(app, { isRunTask: t => t.id === 10, stepRun: t => t.id === 10 ? null : 10, act, pending: [], failed: [] });
  const top = () => app.cardOf(parent, g).step.title;                        // the checklist's steps in order: Lights, Chairs, Tables
  app.pinCard(app.cardOf(parent, g));
  const doing = app.toggleDone(app.tasks[11], ROW);                           // a tick, or a full swipe on its row
  assert.deepEqual([app.tasks[11].done, top(), app.leaving], [true, 'Lights', { 11: 'done' }], 'after release, the step is done and still on top');
  taken({ status: 'offline', entry: 'tick11' });
  await doing;
  assert.deepEqual([top(), app.leaving], ['Lights', { 11: 'done' }]);
  await app.clearBatch(true);
  assert.equal(top(), 'Chairs', 'after the batch clears, the next step in order is on top');
  // If the outbox rejects the change, the row goes back and is not held.
  app.pinCard(app.cardOf(parent, g));
  const failing = app.toggleDone(app.tasks[12], ROW);
  assert.deepEqual([top(), app.leaving[12]], ['Chairs', 'done']);
  outbox(app.pending.filter(e => e.id !== 'tick12'));                      // Vikunja refused it, and it left the outbox
  taken({ status: 'error', error: {} });
  await failing;
  assert.deepEqual([top(), app.leaving, app.tasks[12].done], ['Chairs', {}, false]);
});

test('Today’s groups place a card by what brought it, and show the brought-in tasks as rows if the card’s task cannot be read', () => {
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

test('swiping a card’s row slides that subtask, and swiping the card’s heading does nothing', () => {
  const app = component(progress), pinned = [], finished = [];
  Object.assign(app, { tasks: { 10: { id: 10 } }, cardOf: () => ({ id: 10 }), pinCard: c => pinned.push(c.id) });
  const card = (cls = '') => ({ dataset: { id: '10' }, matches: sel => sel.split(', ').some(c => cls.includes(c.slice(1))) });
  const s = { el: 'row', start: 0, finish: pct => finished.push(pct) };
  const g = app.cardGesture(card(), s);
  assert.equal(g.start, 0, 'the row swipes from 0%');
  g.finish(null); g.finish(50);
  assert.deepEqual([pinned, finished], [[10], [null, 50]], 'the card is pinned only by a slide that changed something');
  assert.deepEqual(app.cardGesture(card(), null), { el: null, reorder: null }, 'swiping the heading does nothing, not even a tap');
  const hold = { start(){} }, c = card();
  assert.deepEqual(app.cardGesture(c, null, hold), { el: c, reorder: hold }, 'on a project’s list, holding the card lets it move up or down');
  assert.equal(app.cardGesture(card('.deleted'), s), null, 'a deleted card allows only Restore');
  assert.equal(rowGestures({ depth: {}, card: {}, delete: true }), 'delete', 'a card’s row has Delete, as the list’s rows do');
});

test('the one-time hint goes on a card’s top row only', () => {
  const app = component(progress);
  app.hint = { at: 10 };
  const card = { id: 10, step: { id: 12 } };
  assert.deepEqual([app.hintOn({ id: 12 }, { card }), app.hintOn({ id: 13 }, { card }), app.hintOn({ id: 10 }, {})], [true, false, true]);
});

test('a row on Today shows a short due time and the project dot on one line, and a screen reader hears the rest', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const due = new Date(); due.setHours(23, 30, 0, 0);
  const t = app.row(task(20, { title: 'Post the rota', due_date: due.toISOString(), priority: 3, project_id: 5, labels: [{ id: 1, title: 'Front' }], comment_count: 2 }));
  const w = app.rowWhen(t, { line: true, depth: {} });
  const full = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(w.due.text, shortTime(full), 'the time is short, “11:30p” where the phone writes “11:30 PM”');
  assert.equal(w.prio, 3, 'the priority shows as bars before the time');
  assert.ok(w.color, 'the project dot shows');
  assert.match(w.said, /^Due Today .*, Priority: High, Café$/, 'the announcement has the due date in words, the priority and the project, but not the labels or comments');
  assert.equal(w.said.split(', ')[0], 'Due Today ' + full, 'a screen reader hears the time in full');
  assert.equal(app.rowWhen({ ...t, priority: 0 }, { line: true, depth: {} }).prio, 0, 'with no priority there are no bars');
  // A task due today with no time shows "Today" under the Overdue heading and in other groups. It shows nothing under the Today heading, which already says it.
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const u = app.row(task(21, { title: 'Order the cups', due_date: day.toISOString(), project_id: 5 }));
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'overdue' }).due.text, 'Today');
  assert.equal(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).due, null, 'under Today a task with no time shows nothing');
  assert.match(app.rowWhen(u, { line: true, depth: {}, key: 'today' }).said, /^Due Today/, 'a screen reader still hears the date');
  assert.equal(app.rowWhen(t, { line: true, depth: {}, key: 'today' }).due.text, w.due.text, 'a task with a time still shows it');
  // A screen reader does not hear the attachment count. It does hear photos still waiting to upload, because they are work still to send.
  assert.doesNotMatch(app.rowWhen({ ...t, attachments: [{ id: 1 }] }, { line: true, depth: {} }).said, /Attachments/);
  app.waiting.files[20] = 1;
  assert.match(app.rowWhen(t, { line: true, depth: {} }).said, /, Attachments, 1 waiting to upload$/);
  delete app.waiting.files[20];
  // A checklist step that is counting down shows its countdown at the right, as it does under its title elsewhere, and a screen reader hears it.
  const soon = app.row(task(22, { title: 'Proof the dough', due_date: new Date(Date.now() + 10 * 6e4 + 3e4).toISOString(), related_tasks: under(50) }));
  app.stepRun = x => x.id === 22 ? 50 : null;
  const s = app.rowWhen(soon, { line: true, depth: {}, key: 'today' });
  assert.deepEqual([s.due, s.said.split(', ')[0]], [{ text: 'in 11m', cls: 'today' }, 'Due in 11m']);
  assert.equal(app.rowMeta(soon, { depth: {} }).find(m => m.key === 'due').text, 'in 11m');
  assert.equal(app.cardHead(u, { key: 'today' }).due, null, 'a card’s heading follows the same rule');
  assert.equal(app.cardHead(u, { key: 'week' }).due.text, 'Today');
});

test('a checklist card’s heading shows its name without the start day, and the due time at the right, like a task’s', () => {
  const { app } = today();
  app.route = { name: 'today' };
  const made = new Date(2026, 9, 8, 7, 30), day = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const run = task(30, { title: `Opening up · ${day(made)} · #2`, created: made.toISOString(), project_id: 5 });
  app.isRunTask = t => t.id === 30;
  assert.equal(app.cardHead(run).title, 'Opening up · #2');
  assert.equal(app.cardHead({ ...run, title: `Opening up · ${day(new Date(2026, 9, 6))} · Saturday` }).title, 'Opening up · Saturday', 'a checklist started offline and created in Vikunja later also loses its start day');
  assert.equal(app.cardHead({ ...run, title: `Opening up · ${day(new Date(2026, 8, 20))} · #2` }).title, `Opening up · ${day(new Date(2026, 8, 20))} · #2`, 'a date that is not the start day is kept');
  assert.equal(app.cardHead({ ...run, title: `Opening up · run 2 · ${day(made)}` }).title, 'Opening up · run 2', 'a title with the start day last is read the same way');
  assert.equal(app.cardHead({ ...run, title: 'Opening up' }).title, 'Opening up', 'a title with no start day is kept whole');
  assert.equal(app.cardHead({ ...run, created: NONE }).title, run.title, 'a checklist with no creation date keeps its whole title');
  assert.equal(app.cardHead(task(31, { title: `Pack the van · front · ${day(made)}`, created: made.toISOString() })).title, `Pack the van · front · ${day(made)}`, 'a task’s title is kept as it is');
  // A checklist is due when its template was due (started from Today). The card shows that time at the right, as a task's card does.
  const due = new Date(); due.setHours(23, 30, 0, 0);
  const full = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), h = app.cardHead({ ...run, due_date: due.toISOString() }, { key: 'today' });
  assert.equal(h.due.text, shortTime(full), 'the time is short, as a row on Today has it');
  assert.match(h.said, new RegExp(`Due Today ${full}`), 'a screen reader hears the time in full');
  assert.equal(app.cardHead(run, { key: 'today' }).due, null, 'with no due date, nothing shows at the right');
});

test('a checklist goes next to the next open step in order, unless a timed step has come due first', () => {
  const now = 1000, s = (id, f = {}) => ({ id, done: false, counting: false, dueAt: Infinity, ...f });
  const steps = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4, { counting: true, dueAt: 900 }), s(5)];
  assert.equal(whereNext(steps, now), 3, 'on opening, the timed step 4 whose time has come goes first');
  assert.equal(whereNext(steps, now, steps[3]), 4, 'after step 4, the next in order');
  assert.equal(whereNext(steps, now, steps[2]), 3, 'after a tick on step 3, step 4 is next anyway');
  const later = [s(1, { done: true }), s(2, { counting: true, dueAt: 1600 }), s(3), s(4)];
  assert.equal(whereNext(later, now), 1, 'on opening, the first open step in order goes first, even while counting down');
  assert.equal(whereNext(later, now, later[1]), 2, 'after that step, the next in order');
  assert.equal(whereNext(later, now, later[2]), 3, 'after step 3, step 4 is next, while step 2 is still counting down');
  assert.equal(whereNext(later, now, later[3]), 1, 'with no step after it, the first open step is next');
  assert.equal(whereNext(later, 1600, later[2]), 1, 'when the countdown reaches zero, step 2 goes before step 4');
  assert.equal(whereNext([s(1, { done: true }), s(2), s(3, { counting: true, dueAt: 5000 })], now, { id: 2 }), 2, 'a step that starts counting down with this tick is next, with its countdown');
  assert.equal(whereNext([s(1, { counting: true, dueAt: 500 }), s(2, { counting: true, dueAt: 200 })], now), 0, 'when two steps are due, the first in order goes first');
  assert.equal(whereNext([s(1, { done: true }), s(2)], now, { id: 2 }), -1, 'no step is next when only the ticked step is open');
});

test('a checklist card on Today opens on the step its screen would, and follows the same rule once the ticked step leaves', () => {
  const { app, parent, g } = today();
  app.isRunTask = t => t.id === 10;                                        // the steps in order: Lights, Chairs, Tables, then 14 (done)
  const soon = m => new Date(Date.now() + m * 6e4).toISOString();
  app.tasks[11].due_date = soon(10); app.tasks[13].due_date = soon(20);   // Lights and Tables are counting down
  const c = app.cardOf(parent, g);
  assert.deepEqual([c.step.title, c.peek.title, c.ring.said, c.ring.label], ['Lights', 'Chairs', '1 of 4 steps done, 25%', 'Finish “Pack the van”, with 3 steps not done'], 'the card opens on the first step in order, even counting down, with the next step under it');
  app.pinCard(c);
  app.tasks[11].done = true; app.leaving[11] = 'done';
  assert.equal(app.cardOf(parent, g).step.title, 'Lights', 'a ticked step stays on top until the batch clears');
  delete app.leaving[11];
  assert.equal(app.cardOf(parent, g).step.title, 'Chairs', 'then the next step in order is on top');
  app.tasks[13].due_date = soon(-1);
  app.resetCards();
  assert.equal(app.cardOf(parent, g).step.title, 'Tables', 'a timed step whose time has come goes before the next step in order');
});

// A checklist on its screen (runView, runs.js). A was done a minute ago. B is timed 30 minutes after A and is counting down. C and D have no time.
// The screen holds ids (view.shownRun) and reads the checklist and its steps from tasks.
const runScreen = () => {
  const app = component(tasks, runs, claims, checklists, cards, views), now = Date.now(), NONE = '0001-01-01T00:00:00Z';
  // A step as Vikunja gives it. Its template step's title is the title of the task it was copied from.
  const step = (id, title, f = {}, tpl = title) => ({ id, title, done: false, done_at: NONE, due_date: NONE, updated: new Date(now - 36e5).toISOString(), percent_done: 0, description: '',
    assignees: [], attachments: [], reactions: {}, comments: [], related_tasks: { copiedfrom: [{ id: id - 40, title: tpl }] }, ...f });
  for (const t of [{ id: 50, title: 'Opening up', done: false, project_id: 5, assignees: [me], created_by: me, comments: [] },
    step(51, 'A', { done: true, done_at: new Date(now - 6e4).toISOString(), reactions: { '✅': [me] } }), step(52, 'B', {}, 'B T#30m'), step(53, 'C', { percent_done: .5 }), step(54, 'D')]) app.row(t);
  Object.assign(app, { user: me, pending: [], slow: [], perms: {}, clock: now, runNow: now, runMemo: null, runG: { depth: {}, run: true, at: null, locked: false }, actTask: a => a.task,
    view: { shownRun: { id: 50, steps: [51, 52, 53, 54], at: null, last: null } } });
  return app;
};
const stepsOn = app => app.view.shownRun.steps.map(id => app.tasks[id]);

/* A checklist's screen holds ids and reads the checklist and its steps from tasks, the objects every list shows. So a
   step ticked on Today shows on the screen at once, and the screen is saved as its ids and Vikunja's copies. */
test('a checklist\'s screen reads its steps by id, so a step ticked in a list shows on it at once', () => {
  const app = runScreen();
  assert.deepEqual([Object.keys(app.view.shownRun), app.runTask], [['id', 'steps', 'at', 'last'], app.tasks[50]]);
  app.saveRun();
  const kept = saved.get('run.50');
  assert.deepEqual([kept.shownRun.steps, kept.tasks.map(t => t.id)], [[51, 52, 53, 54], [50, 51, 52, 53, 54]], 'the saved screen is its ids and the tasks it reads');
  assert.equal(app.runView.steps[2].done, false);
  app.change(w => w.edit(53, { done: true }));                                            // C ticked on Today's card
  assert.equal(app.runView.steps[2].done, true);
});

test('a checklist screen opens on the next step in order, and ticking a step moves on to the next', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual([v.step.title, v.at], ['B', 1], 'the screen opens on B, which is counting down');
  assert.equal(v.card, undefined, 'there is no strip, because the listed steps show where it is');
  assert.equal(app.nextStep(v.steps[1]), 2, 'after B is ticked, C is next');
  assert.equal(app.nextStep(v.steps[2]), 3, 'after C is ticked, D is next, while B is still counting down');
  app.showStep(0);                                                         // tap A in the list
  assert.deepEqual([app.runView.step.title, app.runView.step.done], ['A', true], 'tapping a done step in the list puts it on the card');
});

/* Keeps the cost of each row low. A checklist is worked out once per change, not once for each binding that reads it
   and not once a second. A step that nothing happened to stays the same object, so its row has nothing to redo. The
   test uses Alpine's reactivity (reactive.mjs), as the phone does. */
test('a checklist is calculated once while nothing changes, and a tick recalculates it with only that step as a new object', c => {
  const { Alpine } = watching(c), app = Alpine.reactive(runScreen());
  let worked = 0;
  const work = app.workOutRun; app.workOutRun = function(){ worked++; return work.call(this); };
  const v = app.runView;
  assert.equal(app.runView, v, 'reading it again returns the same object');
  assert.deepEqual([app.runRows.at, app.runRows.locked, worked], [1, false, 1], 'the rows\' options include the step on the card');
  const g = app.runRows;
  app.clock += 1000;                                                       // a second passes
  assert.deepEqual([app.runView, worked], [v, 1], 'a second later, nothing is recalculated');
  app.pending = [{ kind: 'act', id: 'a1', run: 50, task: 53, op: 'done', at: new Date().toISOString() }];   // C is ticked and waiting to be sent
  app.change(w => w.keyOps());
  const w = app.runView;
  assert.notEqual(w, v, 'a tick recalculates the checklist at once');
  assert.equal(worked, 2);
  assert.deepEqual(w.steps.map((s, i) => s === v.steps[i]), [true, true, false, true], 'only the ticked step is a new object');
  assert.equal(w.steps[2].done, true);
  app.showStep(3);
  assert.deepEqual([app.runRows === g, app.runRows.at, app.runView.step.title], [true, 3, 'D'], 'putting a step on the card keeps the rows\' options the same object and moves its `at`');
  assert.deepEqual(app.runView.steps.map((s, i) => s === w.steps[i]), [true, true, true, true], 'no step is a new object');
});

/* A checklist's screen is worked out for runNow. tickRun moves runNow on at most once a second, and only when the time
   has changed something the checklist shows (runShows, checklists.js). B is due 30 minutes after A, which was done a
   minute ago. */
test('time passing recalculates a checklist only when a countdown\'s text changes or a step\'s time comes', c => {
  const { Alpine } = watching(c), app = Alpine.reactive(Object.defineProperties(runScreen(), Object.getOwnPropertyDescriptors(alerts))), t0 = app.runNow;
  c.mock.timers.enable({ apis: ['Date'], now: t0 });
  Object.assign(app, { route: { name: 'run' }, keepAwake(){}, chime(){}, notify(){} });
  globalThis.document.visibilityState = 'visible';
  const v = app.runView;
  assert.equal(v.steps[1].countText, 'in 29m');
  for (let s = 1; s <= 59; s++) { c.mock.timers.setTime(t0 + s * 1000); app.tickRun(); }
  assert.equal(app.runView, v, 'after 59 seconds the countdown still reads "in 29m" and the checklist is the same object');
  c.mock.timers.setTime(t0 + 60000); app.tickRun();
  const w = app.runView;
  assert.deepEqual([w === v, w.steps[1].countText], [false, 'in 28m'], 'after a minute the countdown text changes, so the checklist is recalculated');
  assert.deepEqual(w.steps.map((s, i) => s === v.steps[i]), [true, false, true, true], 'only the step counting down is a new object');
  // In the last minute the countdown changes every second. When the step's time comes, the checklist moves to it.
  c.mock.timers.setTime(t0 + 29 * 60000 - 5000); app.tickRun();
  assert.equal(app.runView.steps[1].countText, 'in 5s');
  c.mock.timers.setTime(t0 + 29 * 60000 - 4000); app.tickRun();
  assert.equal(app.runView.steps[1].countText, 'in 4s');
  app.view.shownRun.at = 2;                                                 // C is on the card
  c.mock.timers.setTime(t0 + 29 * 60000 + 2000); app.tickRun();
  assert.deepEqual([app.runView.steps[1].late, app.runView.steps[1].countText], [true, '2s late']);
});

test('a checklist shows the time through each countdown\'s text, whether a step is due, and the day', () => {
  const now = new Date(2026, 9, 7, 14, 20).getTime(), steps = [{ id: 1, done: true, dueAt: now - 5000 }, { id: 2, done: false, dueAt: now + 18 * 60000 }, { id: 3, done: false, dueAt: Infinity }];
  const at = ms => runShows(steps, now + ms);
  assert.equal(at(0), at(59000), 'the result is the same for the 59 seconds the text stays the same');
  assert.notEqual(at(0), at(60000), 'the text changes to "in 17m"');
  assert.notEqual(at(18 * 60000 - 3000), at(18 * 60000 - 2000), 'the result changes each second of the last minute');
  assert.notEqual(at(18 * 60000 - 1), at(18 * 60000), 'the result changes when the step\'s time comes');
  assert.notEqual(at(18 * 60000), at(18 * 60000 + 1), 'the result changes when the step goes late');
  assert.equal(runShows([steps[0], steps[2]], now), runShows([steps[0], steps[2]], now + 3600000), 'with no step due later, the result is the same all day');
  assert.notEqual(runShows([], now), runShows([], now + 10 * 3600000), 'the result changes when the day changes');
  assert.equal(countText(18 * 60000), 'in 18m');
  assert.equal(countText(-12 * 60000 - 30000), '12m late');
});

test('the step card shows who is doing the step, as its row does, until the step is done', () => {
  const app = runScreen(), v = app.runView;
  assert.deepEqual(app.rowSlot(v.step, { run: true }), v.step.slot);
  assert.equal(app.rowSlot(v.steps[0], { run: true }), null, 'a done step has no slot, because its row and card show who did it instead');
});

/* The checklist's own row at the top of its screen (RUN_ROW). Its ring is calculated from the steps as the screen has
   them. Tapping the ring, or a full swipe, asks to finish the checklist there, because the user is already on it and
   has no way to open it. Its slot shows who it is for. Who started it is in the summary, which the screen shows once
   the checklist is finished or every step is done, and in its ⋯ sheet. */
test('a checklist’s own row asks to finish it from its ring, shows who it is for in its slot, and shows who started it in the summary', async () => {
  const app = runScreen(), made = new Date(Date.now() - 36e5).toISOString(), calls = [];
  Object.assign(app.tasks[50], { created: made });
  Object.assign(app, { sheet: {}, route: { name: 'run' }, openSheet: k => { app.sheet = { kind: k }; }, closeSheet: () => calls.push('close'), finishRun: () => calls.push('finish'),
    reopenRun: id => calls.push('reopen ' + id) });
  const r = app.rowRing(app.runOwn, RUN_ROW);
  assert.deepEqual([r.done, r.total, r.pct, r.open, r.label], [1, 4, 38, 3, 'Finish “Opening up”, with 3 steps not done'], 'step C at 50% counts, as on the card');
  assert.deepEqual(app.rowMeta(app.runOwn, RUN_ROW), [], 'nothing is shown under the name');
  assert.equal(app.rowSlot(app.runOwn, RUN_ROW).label, 'For you');
  r.tap();
  assert.deepEqual([app.sheet.kind, app.sheet.complete.screen, app.sheet.complete.ask.head], ['complete', true, 'Finish this checklist with 3 steps not done?']);
  await app.confirmComplete();
  assert.deepEqual(calls, ['close', 'finish'], 'confirming finishes the checklist, as Finish checklist does');
  assert.match(app.runView.summary, /^Started by you at .+ · 1 of 4 done · 3 not done$/, 'the summary shows who started it');
  for (const s of stepsOn(app)) s.done = true;
  assert.match(app.runView.summary, /^Started by you at .+ · 4 of 4 done$/);
  app.rowRing(app.runOwn, RUN_ROW).tap();
  assert.equal(calls.at(-1), 'finish', 'with every step done, the ring finishes the checklist at once, with an Undo');
  assert.match(app.runStarted, /^Started by you, \w+ \d+, /);
  app.tasks[50].created_by = { id: 9, username: 'priya', name: 'Priya' };
  assert.match(app.runView.summary, /^Started by Priya at /);
});

test('a checklist’s add box adds after the last step, or after the step it is under, and then moves under what was added', async () => {
  const app = runScreen(), added = [], aim = () => { const a = app.runAim; return [a.above.title, a.after, a.before]; };
  app.addStep = async f => { added.push(f); };
  app.seatFoot = () => {};
  app.showStep(2);                                                         // tap C, which puts it on the card
  assert.deepEqual(aim(), ['D', 54, null], 'at the bottom, the box adds after the last step, whatever is on the card');
  app.runBoxAt = 52;                                                       // nudge B, which puts the box under it
  assert.deepEqual(aim(), ['B', 52, 53], 'after B, before C');
  const a = app.runAim, ids = await app.addSteps([{ title: 'X' }, { title: 'Y' }], { after: a.after, before: a.before, follow: true });
  assert.deepEqual(added.map(f => [f.id, f.title, f.after, f.before]), [[ids[0], 'X', 52, 53], [ids[1], 'Y', 'pending-' + ids[0], 53]], 'a pasted list is added in order');
  assert.equal(app.runBoxAt, 'pending-' + ids[1], 'the box is under the last of them, so the next goes after it');
  app.showStep(3);
  assert.equal(app.runBoxAt, 'pending-' + ids[1], 'putting another step on the card leaves the box where it is');
});

test('a checklist’s add box goes after the last step when every step is done, and is absent when finished or read-only', () => {
  const app = runScreen();
  for (const s of stepsOn(app)) Object.assign(s, { done: true, done_at: new Date().toISOString() });
  assert.equal(app.runView.step, null, 'no step on the card');
  assert.deepEqual([app.runAim.above.title, app.runAim.before], ['D', null]);
  app.perms[5] = 0;
  assert.equal(app.runAim, null, 'a read-only checklist has no box');
  app.perms[5] = 1; app.tasks[50].done = true;
  assert.equal(app.runAim, null, 'a finished checklist has no box');
});

test('Repeat copies the step above the box right after it, whatever is on the card, with an Undo', async () => {
  const app = runScreen(), added = [], said = [];
  app.addStep = async f => { added.push(f); };
  app.seatFoot = () => {};
  app.showStep(2);                                                         // tap C, which puts it on the card
  app.say = (text, o) => said.push({ text, ...o });
  app.dropStep = async () => false;                                        // the step is still waiting, so it is not sent
  app.runBoxAt = 51;                                                       // the box is under A
  await app.repeatAbove();
  assert.deepEqual([added[0].title, added[0].tpl, added[0].after, added[0].before], ['A', 'A', 51, 52], 'the copy of A goes right after A');
  assert.equal(app.runBoxAt, 51, 'the box stays where it was');
  assert.equal(app.runView.step.title, 'C', 'the card keeps its step');
  assert.deepEqual([said[0].text, said[0].place, said[0].action.label], ['Repeated “A”', 'cap', 'Undo']);
  await said[0].action.fn();
  assert.equal(app.said, 'Not repeated: A');
  app.runBoxAt = null;                                                     // the box is at the bottom
  await app.repeatAbove();
  assert.deepEqual([added[1].title, added[1].after, added[1].before], ['D', 54, null], 'at the bottom, the copy is of the last step and goes at the end');
});

/* A nudge on a step's row (nudged, app/quickadd.js) moves the add box and nothing else. The fake page has the four
   steps' rows, all in sight. navigator.vibrate stands in for the phone's vibration. The box at the bottom is already
   under the last step, so a nudge there is recorded as the end of the list, which highlights the row. */
test('a nudge on a checklist’s step moves the add box under it and leaves the card’s step', () => {
  const app = runScreen(), felt = [], rows = [51, 52, 53, 54].map(id => ({ dataset: { id: String(id) }, getBoundingClientRect: () => ({ top: 100, bottom: 150 }) }));
  Object.assign(app, { nudged: quickadd.nudged, nudgedStep: sheetPart.nudgedStep, lastRow: sheetPart.lastRow, route: { name: 'run' }, $refs: {}, $nextTick(){}, seatFoot(){} });
  document.getElementById = () => null;
  document.querySelector = sel => rows.find(r => sel.includes(`data-id="${r.dataset.id}"`)) || null;
  document.querySelectorAll = () => rows;
  navigator.vibrate = p => felt.push(p);
  globalThis.innerHeight = 800;
  try {
    const now = () => [app.runBoxAt, app.runBoxEnd, app.runView.step.title, felt.length];
    app.nudged('53');
    assert.deepEqual(now(), [53, false, 'B', 1], 'the box goes under C, the card keeps B, and the phone vibrates');
    app.nudged('53');
    assert.deepEqual(now(), [53, false, 'B', 1], 'nudging the same step again changes nothing and does not vibrate');
    app.nudged('54');
    assert.deepEqual(now(), [54, true, 'B', 2], 'the last step is nudged like any other, and the box at the bottom is already under it');
    assert.deepEqual([app.runAim.above.title, app.runAim.before], ['D', null], 'what is added goes at the end, and Repeat copies the last step');
    app.nudged('54');
    assert.equal(felt.length, 2, 'nudging the last step again does not vibrate');
  } finally { delete document.getElementById; document.querySelector = () => null; delete document.querySelectorAll; delete navigator.vibrate; delete globalThis.innerHeight; }
});

/* Tapping a parent's ring never closes subtasks without asking, unless only one subtask is open, which gets an
   Undo. With every subtask done, the tap closes the parent. */
const ringed = (c, list) => {
  if (c) c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(list), app = component(cards, tasks, leaving, actions, runs);
  Object.assign(app, { cardPage: {}, cardOpen: {}, positions: {}, lines: {}, pending: [], perms: {}, checklistIds: new Set(),
    openSheet(kind){ this.sheet = { kind, open: true }; }, closeSheet(){ this.sheet = { kind: '', open: false }; } });
  for (const t of list) app.row(t);
  return { v, app };
};
const ROW = {}, parentOf = (...kids) => ({ id: 10, title: 'Pack the van', done: false, project_id: 5, related_tasks: { subtask: kids.map(k => ({ id: k.id, done: !!k.done })) } });
const kid = (id, f = {}) => ({ id, title: 'Kid ' + id, done: false, project_id: 5, related_tasks: under(10), ...f });

test('tapping the ring of a parent with one open subtask completes both at once, and tapping it again undoes that', async c => {
  const kids = [kid(11), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([v.task(10).done, v.task(11).done], [true, true]);
  assert.deepEqual([app.leaving, app.isGap(app.tasks[10], { depth: {}, cards: 'list' })], [{ 10: 'done', 11: 'done' }, false], 'the card stays in place as done, never a gap, until the batch clears');
  assert.equal(app.sheet.kind, undefined, 'no question is asked');
  await app.ringTap(app.tasks[10], ROW);                                     // tapping its ring again undoes it
  assert.deepEqual([v.task(10).done, v.task(11).done], [false, false], 'both tasks are open again');
});

test('tapping the ring of a parent with more open subtasks asks first and lists them, and confirming completes them all', async c => {
  const kids = [kid(11), kid(12), kid(13, { repeat_after: 86400, due_date: '2026-10-09T09:00:00Z' }), kid(14, { done: true })];
  const { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([app.sheet.kind, app.sheet.complete.n, app.sheet.complete.stay, app.sheet.complete.open.map(s => s.title)], ['complete', 2, 1, ['Kid 11', 'Kid 12', 'Kid 13']], 'the question offers to complete 2 open subtasks, and the repeating subtask stays');
  assert.deepEqual(app.sheet.complete.ask, {head: 'Complete “Pack the van”?', yes: 'Complete all 3',
    body: 'Its 2 open subtasks will be marked done too: Kid 11 and Kid 12. The one that repeats stays as it is.'}, 'the question names the subtasks in a sentence');
  assert.equal(v.task(10).done, false, 'nothing is done while the question is open');
  app.cancelComplete();
  assert.equal(app.sheet.open, false, 'Cancel closes the question and returns to where the user was');
  await app.ringTap(app.tasks[10], ROW);
  await app.confirmComplete();
  assert.deepEqual([10, 11, 12, 13].map(id => v.task(id).done), [true, true, true, false], 'the repeating subtask is left as it is');
});

test('closing the question asked from a task’s sheet returns to that sheet, and Back then closes the sheet', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const kids = [kid(11), kid(12)], v = fakeVikunja([parentOf(...kids), ...kids]), app = component(cards, tasks, leaving, actions, runs, sheetPart);
  // the phone's history, as far as a sheet uses it: an entry is pushed, marked closed, or gone back from
  globalThis.history = { state: null, pushState(s){ this.state = s; }, replaceState(s){ this.state = s; } };
  document.getElementById = () => ({ querySelector: () => ({}) });
  const opened = [];
  Object.assign(app, { cardPage: {}, cardOpen: {}, positions: {}, lines: {}, pending: [], perms: {}, checklistIds: new Set(), $nextTick(){},
    openTask(id){ opened.push(id); this.openSheet('task'); this.sheet.show = true; } });
  for (const t of [parentOf(...kids), ...kids]) app.row(t);
  const ask = sheet => { app.openSheet('task'); app.sheet.show = true; app.askComplete(app.tasks[10], sheet); assert.equal(app.sheet.kind, 'complete'); };
  ask(true);
  app.closeSheet();                                                          // the ×, sliding down, tapping the dimmed background, or Escape
  assert.deepEqual([opened, app.sheet.kind, app.sheet.open], [[10], 'task', true], 'closing the question returns to the task’s sheet, as Cancel does');
  ask(true);
  history.state = null;                                                      // the phone's Back removes the sheet's entry
  app.closeSheet();                                                          // core.js handles popstate
  assert.deepEqual([opened, app.sheet.kind, history.state?.sheet], [[10, 10], 'task', true], 'the task’s sheet returns with a separate history entry for Back');
  app.closeSheet();
  assert.equal(app.sheet.open, true, 'the sheet is still showing while it slides down');
  c.mock.timers.tick(300);
  assert.deepEqual([app.sheet.open, history.state.sheet], [false, 'closed'], 'Back, or the ×, then closes the task’s sheet');
  ask(true);
  app.closeSheet(true);                                                      // confirmed, or a screen was opened, so the sheet closes outright
  assert.deepEqual([app.sheet.open, opened.length], [false, 2]);
  ask(false);                                                                // asked from a list, so closing the question closes the sheet
  app.closeSheet(); c.mock.timers.tick(300);
  assert.deepEqual([app.sheet.open, opened.length, v.task(10).done], [false, 2, false]);
});

test('a parent with every subtask done waits for Close, and a repeating parent moves on without touching its subtasks', async c => {
  const kids = [kid(11, { done: true }), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  assert.equal(app.ringOf(app.tasks[10]).open, 0);
  await app.ringTap(app.tasks[10], ROW);                                     // the tap closes the parent
  assert.deepEqual([v.task(10).done, app.leaving[10], app.cardOf(app.tasks[10], { depth: {}, cards: 'found' })?.closes], [true, 'done', true], 'after closing, the card stays as done until the batch clears');
  const open = [kid(21), kid(22)], rep = { ...parentOf(...open), id: 20, repeat_after: 86400, due_date: '2026-10-09T09:00:00Z' };
  const r = ringed(null, [rep, ...open]);
  await r.app.ringTap(r.app.tasks[20], ROW);
  assert.equal(r.app.sheet.kind, undefined, 'no question is asked, because the subtasks are not touched');
  assert.notEqual(r.v.task(20).due_date, '2026-10-09T09:00:00Z', 'the parent moves on to its next date');
  assert.deepEqual([21, 22].map(id => r.v.task(id).done), [false, false]);
});

test('the ring of a checklist with steps not done asks first and leaves them not done, and a done parent’s ring opens it again', async c => {
  const kids = [kid(11), kid(12, { done: true })], { v, app } = ringed(c, [parentOf(...kids), ...kids]);
  app.isRunTask = t => t.id === 10;
  await app.ringTap(app.tasks[10], ROW);
  assert.deepEqual([app.sheet.kind, app.sheet.complete.run, app.sheet.complete.n], ['complete', true, 1], 'Finish this checklist with 1 step not done?');
  assert.equal(app.ringOf(app.tasks[10]).label, 'Finish “Pack the van”, with 1 step not done');
  app.isRunTask = () => false;
  app.tasks[10].done = true;
  await app.ringTap(app.tasks[10], ROW);
  assert.equal(v.task(10).done, false, 'tapping the ring of a done parent that has an open subtask opens the parent again');
  assert.equal(v.task(11).done, false);
});

/* Keeps a change waiting to be sent from redrawing every row (rule 10, docs/development.md). A ring reads its steps'
   own rows, and a tick waiting to be sent changes only its step's row (keyOps), so no ring searches the outbox. */
test('a change waiting to be sent recalculates only the rings of the checklists whose steps it changes', c => {
  const { Alpine, flush } = watching(c), app = Alpine.reactive(component(tasks, runs, cards, checklists));
  Object.assign(app, { checklistIds: new Set([7]), pending: [] });
  const finished = Array.from({ length: 20 }, (_, i) => app.row({ id: i + 1, project_id: 7, title: 'Closing up', done: true, description: '',
    related_tasks: { copiedfrom: [{ id: 99 }], subtask: [{ id: 100 + i, done: false, description: '' }] } }));
  for (let i = 0; i < 20; i++) app.row({ id: 100 + i, project_id: 7, title: 'Step', done: false, description: '', related_tasks: { parenttask: [{ id: i + 1 }] } });
  const worked = [];
  for (const t of finished) Alpine.effect(() => { app.rowRing(t, { depth: {} }); worked.push(t.id); });
  worked.length = 0;
  const outbox = list => { app.pending = list; app.change(w => w.keyOps()); flush(); };
  outbox([{ kind: 'act', id: 'n', op: 'note', task: 999, run: 998 }]);
  assert.deepEqual(worked, [], 'a comment on another checklist recalculates no ring');
  outbox([{ kind: 'act', id: 'n', op: 'note', task: 999, run: 998 }, { kind: 'act', id: 'd', op: 'done', task: 103, run: 4 }]);
  assert.deepEqual([worked, app.ringOf(finished[3]).done], [[4], 1], 'a tick waiting to be sent recalculates its own checklist\'s ring');
});
