// The order of tasks in a project (src/js/order.js). It covers the project's List view, positions set the way Vikunja's
// web app sets them, sibling tasks, and dragging a task.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, clearOf, dragPlace, listViewOf, placeAfter, placeFirst, placeMove, positionOrder, siblingBlocks, SPACING } from '../../src/js/order.js';
import { nestSubtasks } from '../../src/js/lists.js';
import { component } from './fake.mjs';
import tasks from '../../src/js/app/tasks.js';
import quickadd from '../../src/js/app/quickadd.js';
import actions from '../../src/js/app/actions.js';

const ids = list => list.map(t => t.id);

test('the List view used is the first by its place, then id; none, null', () => {
  const views = [{ id: 9, view_kind: 'list', position: 200 }, { id: 4, view_kind: 'kanban', position: 50 }, { id: 7, view_kind: 'list', position: 200 }, { id: 8, view_kind: 'list', position: 100 }];
  assert.equal(listViewOf({ views }).id, 8);
  assert.equal(listViewOf({ views: views.filter(v => v.id !== 8) }).id, 7, 'same place: the lower id');
  assert.equal(listViewOf({ views: [{ id: 4, view_kind: 'kanban', position: 1 }] }), null);
  assert.equal(listViewOf(null), null);
});

test('a new position is half way between its neighbours, as the web app has it', () => {
  assert.equal(between(1000, 3000), 2000, 'between two');
  assert.equal(between(null, 3000), 1500, 'first: half the next one');
  assert.equal(between(3000, null), 3000 + SPACING, 'last: room after the one before');
  assert.equal(between(500, 500), 500.01, 'neighbours on the same position: a little after them');
  assert.equal(between(null, null), 0, 'alone');
});

test('a move writes the moved task only, between where it lands', () => {
  const sibs = [{ id: 1, pos: 100 }, { id: 2, pos: 200 }, { id: 3, pos: 300 }, { id: 4, pos: 400 }];
  assert.deepEqual(placeMove(sibs, 0, 2), [[1, 350]], 'down: between the third and the fourth');
  assert.deepEqual(placeMove(sibs, 3, 0), [[4, 50]], 'to the top');
  assert.deepEqual(placeMove(sibs, 1, 3), [[2, 400 + SPACING]], 'to the bottom');
  assert.deepEqual(placeMove(sibs, 2, 1), [[3, 150]], 'up one');
});

test('landing next to tasks with no position, they get positions after the last that has one first, in their order', () => {
  // Tasks 5 and 6 came from another project, so they have no position in this list yet (0). They sort after the others, by id.
  const sibs = [{ id: 1, pos: 100 }, { id: 2, pos: 200 }, { id: 5, pos: 0 }, { id: 6, pos: 0 }];
  assert.deepEqual(placeMove(sibs, 0, 2), [[5, 200 + SPACING], [6, 200 + 2 * SPACING], [1, 200 + 1.5 * SPACING]], 'between 5 and 6');
  assert.deepEqual(placeMove(sibs, 3, 0), [[6, 50]], 'one with none moved among those with one: only it');
});

test('siblings in their List view order: by position, those with none after, by id, and one waiting to be sent first', () => {
  const pos = { 1: 300, 2: 100, 3: 0, 4: 200 };
  const list = [{ id: 5 }, { id: 1 }, { id: 'pending-x', pending: true }, { id: 3 }, { id: 2 }, { id: 4 }];
  // A task waiting to be sent goes first, which is where Vikunja puts a new task. The task then doesn't jump after it is sent.
  assert.deepEqual(ids([...list].sort(positionOrder(pos))), ['pending-x', 2, 4, 1, 3, 5]);
  // A task waiting to be sent that already has a position (a subtask added after another) goes at that position.
  list.push({ id: 'pending-y', pending: true, position: 150 });
  assert.deepEqual(ids([...list].sort(positionOrder(pos))), ['pending-x', 2, 'pending-y', 4, 1, 3, 5]);
});

test('new subtasks go after the one given, before the next, each after the one before', () => {
  const sibs = [300, 100, 200];
  assert.deepEqual(placeAfter(sibs, 100), [150], 'between it and the next');
  assert.deepEqual(placeAfter(sibs, 100, 3), [150, 175, 187.5], 'several: each after the one before, all before the next');
  assert.deepEqual(placeAfter(sibs, null, 2), [300 + SPACING, 300 + 2 * SPACING], 'none given: after the last');
  assert.deepEqual(placeAfter(sibs, 300), [300 + SPACING], 'after the last');
  assert.deepEqual(placeAfter([], null, 2), [SPACING, 2 * SPACING], 'the first subtasks');
  // A task with no position sorts after the others, so placing a task after it means placing it after the last task that has a position.
  assert.deepEqual(placeAfter([100, 0, 200], 0), [200 + SPACING]);
});

test('a new line never takes a place another task of the view has: it moves half way to the place after it', () => {
  assert.deepEqual(clearOf([150, 175], new Set([100, 200])), [150, 175], 'free: as they were');
  assert.deepEqual(clearOf([SPACING], new Set([SPACING])), [SPACING * 1.5], 'a first subtask where a project\'s first task is: half a step on');
  assert.deepEqual(clearOf([150, 175], new Set([150]), 200), [162.5, 175], 'half way to the next of them');
  assert.deepEqual(clearOf([150, 175], new Set([175, 187.5]), 200), [150, 193.75], 'the last: towards what they\'re all before, until it\'s free');
});

test('subtasks added right under their task go ahead of its first, one after another; with none placed yet, as the first ones do', () => {
  assert.deepEqual(placeFirst([100, 200, 300]), [50]);
  assert.deepEqual(placeFirst([200, 0, 100], 3), [50, 75, 87.5], 'each after the one before, all ahead of the first');
  assert.deepEqual(placeFirst([], 2), [SPACING, 2 * SPACING], 'no subtasks yet');
  assert.deepEqual(placeFirst([0, 0]), [SPACING], 'none has a place: a place of 0 would be none too, and sort after the next one added');
});

/* Quick add's box on a project's list. The row the user nudged last is the cursor and is highlighted, and the box
   adds subtasks after it. A subtask added from the box then becomes the cursor. The project's list in these tests is
   Pack the van (with subtasks Load chairs and Tables), then Lights. `lit` is what each row reads. It holds the
   highlighted row by its id. */
function projectList(){
  const app = component(tasks, quickadd, { reorder: actions.reorder });
  Object.assign(app, { route: { name: 'project', id: 1 }, cursor: null, lit: {}, deleting: [], pendingTasks: [], capPhotos: [], checklistIds: new Set(), canWrite: () => true });
  const van = app.keep({ id: 10, title: 'Pack the van', project_id: 1, done: false, related_tasks: { subtask: [{ id: 11 }, { id: 12 }] } });
  const sub = (id, title) => app.keep({ id, title, project_id: 1, done: false, related_tasks: { parenttask: [{ id: 10 }] } });
  const chairs = sub(11, 'Load chairs'), tables = sub(12, 'Tables'), lights = app.keep({ id: 20, title: 'Lights', project_id: 1, done: false });
  app.view = { groups: [{ key: 'open', tasks: [van, chairs, tables, lights] }, { key: 'done', tasks: [] }], listView: 5, project: { id: 1, title: 'Move' } };
  app.positions = { 10: 1000, 11: 100, 12: 200, 20: 2000 };
  return { app, van, chairs, tables, lights };
}
// `added` is a line added from the box, as the outbox stores it. `waiting` is the row the list shows for it while it waits (pendingTasks).
const added = (id, title, position) => ({ id, items: [{ p: { title, position }, under: null }] });
const waiting = (e, parent) => e.items.map((x, i) => ({ id: `pending-${e.id}-${i}`, pending: true, entry: e.id, index: i, parent, title: x.p.title, position: x.p.position }));

test('the box walks through eligible rows and keeps its level when adding top-level tasks', () => {
  const {app, van, chairs, tables, lights} = projectList(), before = document.querySelectorAll;
  Object.assign(app, {lines: {}, subBoxW: '', $nextTick(){}});
  document.querySelectorAll = () => [van, chairs, tables, lights].map(t => ({dataset: {id: String(t.id)}}));
  try {
    app.boxMove('cap', -1); assert.equal(app.cursor.id, lights.id);
    app.boxMove('under', 1); assert.equal(app.cursor, null);
    lights.done = true;
    app.boxMove('cap', -1); assert.equal(app.cursor.id, tables.id, 'skip done rows');
    app.boxMove('under', -1); assert.equal(app.cursor.id, chairs.id);
    app.boxLevel(true);
    app.boxMove('cap', -1); assert.deepEqual(app.cursor, {id: van.id, under: null, out: true});
    app.boxMove('cap', 1); assert.equal(app.cursor, null, 'skip subtasks at the outer level');
    app.canWrite = () => false;
    app.boxMove('cap', -1); assert.equal(app.cursor, null, 'skip read-only rows');
  } finally { document.querySelectorAll = before; }
});

test('a sheet box skips done subtasks and stops at the first row and the foot', () => {
  const before = document.querySelectorAll, rows = [{id: 1}, {id: 2, done: true}, {id: 3}];
  const app = {subBoxW: 'sub', route: {name: 'project'}, sheet: {subAt: null}, subList: rows, isStepList: false, $nextTick(){},
    nudgedSub(id){ this.sheet.subAt = id; }, footHome(){ this.sheet.subAt = null; }};
  document.querySelectorAll = () => rows.map(t => ({dataset: {id: String(t.id)}}));
  try {
    const move = dir => quickadd.boxMove.call(app, 'sub', dir);
    move(-1); assert.equal(app.sheet.subAt, '1');
    move(-1); assert.equal(app.sheet.subAt, '1');
    move(1); assert.equal(app.sheet.subAt, null);
    move(1); assert.equal(app.sheet.subAt, null);
  } finally { document.querySelectorAll = before; }
});

test('the cursor on a task: subtasks go ahead of its first, as the box is right under it; on a subtask, after it, under its parent', () => {
  const { app, van, chairs } = projectList();
  assert.equal(app.capW, 'cap');
  assert.equal(app.capPlaceholder, 'Add a task to Move');
  app.aim(van);
  assert.equal(app.capW, 'under');
  assert.deepEqual(app.capTarget, { to: 'Pack the van', after: '' });
  assert.deepEqual(app.lit, { 10: true }, 'its row is the one lit');
  assert.equal(app.capPlaceholder, 'Subtask');
  assert.equal(app.capHomeSays, 'Add a task to Move', 'the place it left at the bottom says what the box says there');
  assert.deepEqual(app.cursorPlaces(2), [50, 75], 'ahead of Load chairs, one after the other');
  app.aim(chairs);
  assert.equal(app.cursorParent, van);
  assert.deepEqual(app.capTarget, { to: 'Pack the van', after: 'Load chairs' });
  assert.deepEqual(app.lit, { 11: true }, 'one row lit: the task\'s own goes dark');
  assert.deepEqual(app.cursorPlaces(2), [150, 175], 'between Load chairs and Tables');
  app.light(null);
  assert.deepEqual([app.capW, app.lit], ['cap', {}], 'the ×: a task again, and nothing lit');
});

test('a subtask added from the box is the cursor in its turn: the one row lit, the next after it, waiting and sent', () => {
  const { app, van, chairs } = projectList();
  app.aim(van);
  // "Rope" is added ahead of the task's first subtask. Its waiting row is highlighted at once, and the task's own row loses the highlight.
  const rope = added('e1', 'Rope', 50);
  app.aimAdded(rope, 0, van);
  assert.deepEqual(app.lit, { 'pending-e1-0': true });
  assert.deepEqual([app.capW, app.cursorParent, app.capTarget], ['under', van, { to: 'Pack the van', after: 'Rope' }], 'list and line agree');
  assert.deepEqual(app.cursorPlaces(1), [75], 'the next goes after it, before its row is even on the list');
  app.pendingTasks = waiting(rope, 10);
  assert.deepEqual(app.cursorPlaces(1), [75], 'and with it there');
  // The user nudges the task again, which was the row nudged before. It is highlighted again, the line names only the task, and its first subtask is Rope.
  app.aim(van);
  assert.deepEqual([app.lit, app.capTarget], [{ 10: true }, { to: 'Pack the van', after: '' }]);
  assert.deepEqual(app.cursorPlaces(1), [25], 'ahead of its first, the one waiting counted');
  // The user nudges a subtask and then adds one after it. The new subtask goes between it and the next, and the new subtask is highlighted.
  app.aim(chairs);
  const hooks = added('e2', 'Hooks', 150);
  app.aimAdded(hooks, 0, van);
  assert.deepEqual(app.cursorPlaces(1), [175], 'between Hooks and Tables');
  // After the subtask is sent, Vikunja gives it an id, and its row is still the highlighted one.
  const sent = app.keep({ id: 31, title: 'Hooks', project_id: 1, done: false, parent: 10 });
  app.view.groups[0].tasks.push(sent); app.positions[31] = 150; app.pendingTasks = waiting(rope, 10);
  app.aimSent([{ id: 31, was: 'pending-e2-0' }]);
  assert.deepEqual([app.lit, app.cursor, app.capTarget], [{ 31: true }, { id: 31, under: 10 }, { to: 'Pack the van', after: 'Hooks' }]);
  assert.deepEqual(app.cursorPlaces(1), [175], 'where the next goes hasn\'t moved');
  app.aimSent([{ id: 32, was: 'pending-e1-0' }]);
  assert.deepEqual(app.lit, { 31: true }, 'another row sent: the light stays');
  // The user nudges the row that was nudged before the add. That row is highlighted, and the line says the new subtask goes after it.
  app.aim(chairs);
  assert.deepEqual([app.lit, app.capTarget], [{ 11: true }, { to: 'Pack the van', after: 'Load chairs' }]);
  assert.deepEqual(app.cursorPlaces(1), [125], 'between Load chairs and Hooks, sent since');
});

test('a subtask that arrives done isn\'t lit: its task is, and the next go ahead of its first', () => {
  const { app, van, chairs } = projectList();
  app.aim(chairs);
  const e = { id: 'e1', items: [{ p: { title: 'Rope', position: 150 }, under: null }, { p: { title: 'Straps', position: 175, done: true }, under: null }] };
  app.aimAdded(e, 1, van);
  app.pendingTasks = waiting(e, 10);
  assert.deepEqual([app.lit, app.capTarget], [{ 10: true }, { to: 'Pack the van', after: '' }]);
  assert.deepEqual(app.cursorPlaces(1), [50]);
});

test('with no List view there\'s no place to give: the line names only the task, and the row touched or added is lit', () => {
  const { app, van, chairs } = projectList();
  app.view.listView = null;
  app.aim(chairs);
  assert.deepEqual([app.lit, app.capTarget, app.cursorPlaces(1)], [{ 11: true }, { to: 'Pack the van', after: '' }, null]);
  assert.equal(app.capTargetText, 'Add a subtask to Pack the van');
  app.aimAdded(added('e1', 'Rope', 0), 0, van);
  assert.deepEqual([app.lit, app.capTarget, app.cursorPlaces(1)], [{ 'pending-e1-0': true }, { to: 'Pack the van', after: '' }, null]);
});

test('the cursor\'s row ticked done keeps the box while it waits for the batch; gone, its task has it, and a done task is never one', () => {
  const { app, van, chairs } = projectList();
  app.aim(chairs);
  chairs.done = true; app.leaving[11] = 'done';
  assert.equal(app.cursorTask, chairs, 'ticked, in its place still: the box stays under it, and nothing moves');
  delete app.leaving[11];
  assert.equal(app.cursorTask, null, 'the batch has cleared');
  app.keepAim();
  assert.equal(app.cursorTask, van, 'a subtask done: its parent');
  assert.deepEqual(app.lit, { 10: true });
  app.aim(van);
  van.done = true;
  assert.equal(app.capW, 'cap', 'done since: the box adds a task again');
});

test('the cursor never points at a row that\'s gone: deleted or done, its task is lit; called off or turned down while waiting, too; moved, it stays lit', async () => {
  const { app, van, chairs, tables, lights } = projectList();
  // A deleted row leaves the lists while its Restore message shows, so the highlight moves to the task it was under. Restoring the row doesn't move the highlight back.
  app.aim(chairs);
  app.deleting = [11];
  assert.equal(app.capW, 'cap', 'until it\'s asked: nothing lit, and a task');
  app.keepAim();
  assert.deepEqual([app.lit, app.capTarget], [{ 10: true }, { to: 'Pack the van', after: '' }]);
  app.deleting = [];
  app.keepAim();
  assert.deepEqual(app.lit, { 10: true }, 'restored: not lit again behind your back');
  // A task marked done somewhere other than its tick on this list (its sheet, or the web app) behaves the same way.
  app.aim(tables);
  tables.done = true;
  app.keepAim();
  assert.deepEqual(app.lit, { 10: true });
  tables.done = false;
  // A task with no parent that leaves the list makes the box add a task to the project again.
  app.aim(lights);
  app.view.groups[0].tasks.pop();
  app.keepAim();
  assert.deepEqual([app.cursor, app.lit, app.capW], [null, {}, 'cap']);
  // If the parent task is deleted along with the row, there is no task to move the highlight to.
  app.aim(chairs);
  app.deleting = [10, 11, 12];
  app.keepAim();
  assert.deepEqual([app.cursor, app.lit], [null, {}]);
  app.deleting = [];
  // A row moved up or down among its siblings has not left the list. It stays highlighted, and the next subtask goes
  // after it at its new position, here between it and Load chairs. A moved task stays highlighted as well.
  Object.assign(app, { act: async () => ({ status: 'sent' }), saveProject(){} });
  app.aim(tables);
  await app.reorder(tables, [chairs, tables], 0, 5);
  assert.deepEqual([app.lit, app.capTarget, app.cursorPlaces(1)], [{ 12: true }, { to: 'Pack the van', after: 'Tables' }, [75]]);
  app.aim(van);
  await app.reorder(van, [van, lights], 1, 5);
  assert.deepEqual(app.lit, { 10: true });
  // "Rope" and then "Straps" are waiting to be sent in one go, and Straps is highlighted. Cancelling the line before
  // Straps leaves Straps highlighted. It is the same line, one position earlier, and its row's id comes from that
  // position. Cancelling Straps itself highlights its task.
  const e = { id: 'e1', items: [{ p: { title: 'Rope', position: 250 }, under: null }, { p: { title: 'Straps', position: 275 }, under: null }] };
  app.aimAdded(e, 1, van);
  e.items.shift(); app.pendingTasks = waiting(e, 10);
  app.aimCancelled('e1', 0);
  assert.deepEqual([app.lit, app.capTarget], [{ 'pending-e1-0': true }, { to: 'Pack the van', after: 'Straps' }]);
  app.aimCancelled('e2', 0);
  assert.deepEqual(app.lit, { 'pending-e1-0': true }, 'another list\'s line called off: nothing to do with it');
  app.pendingTasks = [];
  app.aimCancelled('e1', 0);
  assert.deepEqual([app.lit, app.capTarget], [{ 10: true }, { to: 'Pack the van', after: '' }]);
  // Vikunja rejected the line. It has left the outbox without a task being created for it.
  app.aimAdded(added('e3', 'Tarp', 300), 0, van);
  app.aimSent([]);
  assert.deepEqual(app.lit, { 10: true });
  // The task disappears while the line waits. Nothing is highlighted, and the box adds a task again.
  app.aimAdded(added('e4', 'Tarp', 300), 0, van);
  van.done = true;
  assert.equal(app.capW, 'cap');
  app.keepAim();
  assert.deepEqual([app.cursor, app.lit], [null, {}]);
});

/* The box goes back to adding a task once the highlighted row is out of sight (watchCursor). The browser's
   IntersectionObserver reports this. The test uses a fake one that reports whatever `see` gives it. */
test('the lit row out of sight: a task again; one just added past the screen\'s edge is stood in for by the row lit before, until it\'s seen', () => {
  const { app, van, chairs } = projectList();
  let tell;
  const seen = new Set(), see = (...rows) => tell(rows.map(([target, isIntersecting]) => ({ target, isIntersecting })));
  globalThis.IntersectionObserver = class { constructor(fn){ tell = es => fn(es.filter(e => seen.has(e.target))); } observe(el){ seen.add(el); } unobserve(el){ seen.delete(el); } };
  globalThis.window = globalThis;
  try {
    const row = id => ({ dataset: { id: String(id) } }), vanRow = row(10), chairsRow = row(11), ropeRow = row('pending-e1-0'), sentRow = row(31), hooksRow = row('pending-e2-0');
    // Each row's effect starts watching the row once the row is highlighted.
    app.aim(van); app.watchCursor(vanRow); see([vanRow, true]);
    app.aim(chairs); app.watchCursor(chairsRow); see([chairsRow, true]);
    see([vanRow, false]);
    assert.deepEqual(app.lit, { 11: true }, 'the row lit before, scrolled away: nothing to do with it any more');
    // "Rope" is added and its row renders below the edge of the screen. The box still adds subtasks while Load chairs is in sight.
    app.aimAdded(added('e1', 'Rope', 150), 0, van); app.watchCursor(ropeRow); see([ropeRow, false]);
    assert.deepEqual([app.lit, app.capW], [{ 'pending-e1-0': true }, 'under']);
    // The task is sent and its new row is still out of sight. The new row is watched, and Load chairs still stands in for it.
    app.view.groups[0].tasks.push(app.keep({ id: 31, title: 'Rope', project_id: 1, done: false, parent: 10 }));
    app.aimSent([{ id: 31, was: 'pending-e1-0' }]);
    app.watchCursor(sentRow); see([ropeRow, false], [sentRow, false]);
    assert.deepEqual([app.lit, app.capW], [{ 31: true }, 'under']);
    // Once Rope's row scrolls into sight, only that row is watched. Load chairs scrolling away changes nothing, and Rope scrolling away ends the cursor.
    see([sentRow, true]); see([chairsRow, false]);
    assert.deepEqual(app.lit, { 31: true });
    see([sentRow, false]);
    assert.deepEqual([app.cursor, app.lit, app.capW], [null, {}, 'cap']);
    // If the new row is never seen and the row standing in for it scrolls away, the box adds a task again.
    app.aim(chairs); app.watchCursor(chairsRow); see([chairsRow, true]);
    app.aimAdded(added('e2', 'Hooks', 150), 0, van); app.watchCursor(hooksRow); see([hooksRow, false]);
    assert.equal(app.capW, 'under');
    see([chairsRow, false]);
    assert.deepEqual([app.cursor, app.capW], [null, 'cap']);
  } finally { delete globalThis.IntersectionObserver; delete globalThis.window; }
});

test('only a task on this project\'s open list that you can change can be the cursor; on Today, a row of any group, or a card\'s', () => {
  const { app, van, chairs } = projectList();
  app.route = { name: 'search' };
  app.aim(van);
  assert.equal(app.cursor, null, 'not in search');
  // On Today, the groups hold the task as a card with its subtasks on it, not as separate rows. The box only adds subtasks there.
  app.route = { name: 'today' };
  const list = app.view;
  app.view = { groups: [{ key: 'overdue', tasks: [] }, { key: 'today', tasks: [van] }], listView: null };
  app.projById = new Map([[1, { id: 1, title: 'Move', views: [{ id: 5, view_kind: 'list', position: 1 }] }]]);
  app.aim(van);
  assert.deepEqual([app.cursor, app.capW, app.boxIn, app.canLevel], [{ id: 10, under: null }, 'under', true, false]);
  assert.equal(app.boxLevel(true), false, 'no level out on Today');
  // The positions come from the project's List view, which Today also reads its cards' positions from.
  assert.deepEqual([app.cursorListView, app.cursorPlaces(1)], [5, [50]], 'under the task: ahead of its first subtask, in the project\'s List view');
  app.aim(chairs);
  assert.deepEqual([app.cursor, app.cursorParent], [{ id: 11, under: 10 }, van], 'a card\'s row: under its task');
  assert.deepEqual(app.cursorPlaces(1), [150], 'after that row');
  app.projById.get(1).views = [];
  assert.deepEqual([app.cursorListView, app.cursorPlaces(1)], [null, null], 'a project with no List view: no place to give');
  app.aim(app.tasks[20]);
  assert.equal(app.cursor, null, 'a task Today doesn\'t show');
  app.view = list;
  app.route = { name: 'project', id: 1 };
  app.canWrite = () => false;
  app.aim(van);
  assert.equal(app.cursor, null, 'not read only');
  app.canWrite = () => true;
  app.aim({ id: 99, title: 'Elsewhere', project_id: 1, done: false });
  assert.equal(app.cursor, null, 'not one off the list');
  app.isRunTask = t => t.id === 10;
  app.aim(van);
  assert.equal(app.cursor, null, 'not a run');
});

test('a project\'s list: top-level tasks and each parent\'s subtasks in position order, a run\'s steps in its own order', () => {
  const parent = { id: 10, related_tasks: { subtask: [{ id: 11 }, { id: 12 }, { id: 13 }] } };
  const sub = id => ({ id, related_tasks: { parenttask: [{ id: 10 }] } });
  const pos = { 10: 200, 11: 30, 12: 10, 13: 0, 20: 100 };
  const { tasks, depth } = nestSubtasks([parent, sub(11), sub(12), sub(13), { id: 20 }], positionOrder(pos));
  assert.deepEqual(ids(tasks), [20, 10, 12, 11, 13]);
  assert.deepEqual(depth, { 20: 0, 10: 0, 12: 1, 11: 1, 13: 1 });
  // A checklist (a copy of a template) keeps its steps in its own order line. Without one, the steps are in the order they were created.
  const run = { ...parent, related_tasks: { ...parent.related_tasks, copiedfrom: [{ id: 1 }] }, description: '' };
  assert.deepEqual(ids(nestSubtasks([run, sub(11), sub(12), sub(13)], positionOrder(pos)).tasks), [10, 11, 12, 13]);
});

test('a task\'s siblings: those under the same parent, each with its subtasks; never another parent\'s', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map(id => ({ id }));
  const depth = { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0, 6: 1, 7: 0 };       // 1 has subtasks 2 and 4, and 2 has subtask 3. 5 has subtask 6. 7 has none
  assert.deepEqual(siblingBlocks(tasks, depth, 5).map(b => b.ids), [[1, 2, 3, 4], [5, 6], [7]], 'top level, each with all under it');
  assert.deepEqual(siblingBlocks(tasks, depth, 4).map(b => b.ids), [[2, 3], [4]], 'a subtask: its parent\'s subtasks only');
  assert.deepEqual(siblingBlocks(tasks, depth, 6).map(b => b.ids), [[6]], 'an only subtask: nowhere to go');
  assert.deepEqual(siblingBlocks(tasks, depth, 99), []);
});

test('dragging: the siblings it passes the middle of move aside, and it stays within them', () => {
  const blocks = [{ top: 0, height: 50 }, { top: 50, height: 150 }, { top: 200, height: 50 }];   // the second block has subtasks
  assert.deepEqual(dragPlace(blocks, 0, 20), { dy: 20, shifts: [0, 0, 0], at: 0 }, 'not past the middle of the next');
  assert.deepEqual(dragPlace(blocks, 0, 110), { dy: 110, shifts: [0, -50, 0], at: 1 });
  assert.deepEqual(dragPlace(blocks, 0, 999), { dy: 200, shifts: [0, -50, -50], at: 2 }, 'drawn no lower than the last');
  assert.deepEqual(dragPlace(blocks, 2, -999), { dy: -200, shifts: [50, 50, 0], at: 0 });
  // A tall block (one with subtasks) can move past a short block at the end.
  assert.equal(dragPlace(blocks, 1, 999).at, 2);
});

/* The box has two levels. Moved out one level, it adds a task after the cursor's task and all the subtasks under it. */
test('the box out a level adds a task after the cursor\'s task; in again, a subtask; Tab and Shift+Tab move it only when they can', () => {
  const { app, van, chairs } = projectList();
  assert.equal(app.boxLevel(true), false, 'at the bottom: no level to change');
  app.aim(chairs);
  assert.deepEqual([app.boxIn, app.boxOut, app.capW, app.capPlaceholder], [true, false, 'under', 'Subtask']);
  const key = shiftKey => { const e = { shiftKey, taken: false, preventDefault(){ this.taken = true; } }; app.boxTab(e); return e.taken; };
  assert.equal(key(false), false, 'Tab, as far in as it goes: the key moves the focus');
  assert.equal(key(true), true, 'Shift+Tab: out a level');
  assert.deepEqual([app.boxOut, app.capW, app.capPlaceholder, app.capTarget], [true, 'cap', 'Task', null]);
  assert.deepEqual(app.cursor, { id: 11, under: 10, out: true }, 'the cursor stays on its row');
  assert.deepEqual(app.outPlaces(2), [1500, 1750], 'after Pack the van, before Lights');
  assert.equal(key(true), false, 'Shift+Tab again: as far out as it goes');
  // A task added from there becomes the cursor while it waits to be sent, and the box stays out a level. The next task goes after it, and it can't have a subtask yet.
  const strap = added('e1', 'Strap it down', 1500);
  app.aimAddedOut(strap, 0);
  app.pendingTasks = waiting(strap, null).map(x => ({ ...x, child: false, project_id: 1 }));
  assert.deepEqual([app.boxOut, app.canIn, app.cursorTask.title], [true, false, 'Strap it down']);
  assert.deepEqual(app.outPlaces(1), [1750], 'after it, before Lights');
  assert.equal(key(false), false, 'Tab: it has no task to go under yet');
  // After the task is sent, the cursor is on its row and the box is still out a level. Pressing Tab then moves the box in, under the task.
  const sent = app.keep({ id: 30, title: 'Strap it down', project_id: 1, done: false });
  app.view.groups[0].tasks.push(sent); app.positions[30] = 1500; app.pendingTasks = [];
  app.aimSent([{ id: 30, was: 'pending-e1-0' }]);
  assert.deepEqual(app.cursor, { id: 30, under: null, out: true });
  assert.equal(key(false), true);
  assert.deepEqual([app.capW, app.cursorParent, app.capPlaceholder], ['under', sent, 'Subtask']);
  app.aim(van);
  assert.equal(app.boxOut, false, 'a nudge starts in again');
});

test('a place taken by another task of the view is stepped past: a task\'s first subtask where a project\'s first task is', () => {
  const { app, van } = projectList();
  app.positions = { 10: SPACING, 20: 2 * SPACING };
  van.related_tasks = {};
  app.view.groups[0].tasks = [van, app.tasks[20]];
  app.aim(van);
  assert.deepEqual(app.cursorPlaces(1), [SPACING * 1.5], 'not 65536, which the van itself has');
});
