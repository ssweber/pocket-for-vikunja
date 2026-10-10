// A project's order (src/js/order.js): its List view, positions as Vikunja's web app sets them, siblings, and a drag.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, dragPlace, listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks, SPACING } from '../../src/js/order.js';
import { nestSubtasks } from '../../src/js/lists.js';
import { component } from './fake.mjs';
import tasks from '../../src/js/app/tasks.js';
import quickadd from '../../src/js/app/quickadd.js';

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
  // 5 and 6 came from another project: no place in this list yet (0), after the others, by id.
  const sibs = [{ id: 1, pos: 100 }, { id: 2, pos: 200 }, { id: 5, pos: 0 }, { id: 6, pos: 0 }];
  assert.deepEqual(placeMove(sibs, 0, 2), [[5, 200 + SPACING], [6, 200 + 2 * SPACING], [1, 200 + 1.5 * SPACING]], 'between 5 and 6');
  assert.deepEqual(placeMove(sibs, 3, 0), [[6, 50]], 'one with none moved among those with one: only it');
});

test('siblings in their List view order: by position, those with none after, by id, and one waiting to be sent first', () => {
  const pos = { 1: 300, 2: 100, 3: 0, 4: 200 };
  const list = [{ id: 5 }, { id: 1 }, { id: 'pending-x', pending: true }, { id: 3 }, { id: 2 }, { id: 4 }];
  // First, where Vikunja puts a new task, so it doesn't jump there once it's sent.
  assert.deepEqual(ids([...list].sort(positionOrder(pos))), ['pending-x', 2, 4, 1, 3, 5]);
  // One waiting that was given its place (a subtask added after another) is in it already.
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
  // One with no position is after the others: after it means after the last that has one.
  assert.deepEqual(placeAfter([100, 0, 200], 0), [200 + SPACING]);
});

/* Quick add's box on a project's list: the task touched last is the cursor, and the box adds subtasks after it. A
   project's list here: Pack the van (Load chairs, Tables), Lights. `lit` is what each row reads: the one row lit, by
   its id. */
function projectList(){
  const app = component(tasks, quickadd);
  Object.assign(app, { route: { name: 'project', id: 1 }, cursor: null, lit: {}, deleting: [], capPhotos: [], checklistIds: new Set(), canWrite: () => true });
  const van = app.keep({ id: 10, title: 'Pack the van', project_id: 1, done: false, related_tasks: { subtask: [{ id: 11 }, { id: 12 }] } });
  const sub = (id, title) => app.keep({ id, title, project_id: 1, done: false, related_tasks: { parenttask: [{ id: 10 }] } });
  const chairs = sub(11, 'Load chairs'), tables = sub(12, 'Tables'), lights = app.keep({ id: 20, title: 'Lights', project_id: 1, done: false });
  app.view = { groups: [{ key: 'open', tasks: [van, chairs, tables, lights] }, { key: 'done', tasks: [] }], listView: 5, project: { id: 1, title: 'Move' } };
  app.positions = { 10: 1000, 11: 100, 12: 200, 20: 2000 };
  return { app, van, chairs, tables, lights };
}

test('the cursor on a task: subtasks go after its last; on a subtask, after it, under its parent', () => {
  const { app, van, chairs } = projectList();
  assert.equal(app.capW, 'cap');
  assert.equal(app.capPlaceholder, 'Add a task to Move');
  app.aim(van);
  assert.equal(app.capW, 'under');
  assert.deepEqual(app.capTarget, { to: 'Pack the van', after: '' });
  assert.deepEqual(app.lit, { 10: true }, 'its row is the one lit');
  assert.deepEqual(app.cursorPlaces(1), [200 + SPACING]);
  app.aim(chairs);
  assert.equal(app.cursorParent, van);
  assert.deepEqual(app.capTarget, { to: 'Pack the van', after: 'Load chairs' });
  assert.deepEqual(app.lit, { 11: true }, 'one row lit: the task\'s own goes dark');
  assert.deepEqual(app.cursorPlaces(2), [150, 175], 'between Load chairs and Tables');
  // Added one after another, each goes after the one before: the box keeps where the last went.
  app.cursor.after = { pos: 150, title: 'Rope' };
  assert.deepEqual(app.cursorPlaces(1), [175]);
  assert.equal(app.capTargetText, 'Add a subtask to Pack the van, after Rope');
  // No List view: no place to give, so Vikunja's own.
  app.view.listView = null;
  assert.equal(app.cursorPlaces(1), null);
});

test('a tick moves the cursor: to the task while it\'s open, to its parent once it\'s done, and a done task is never one', () => {
  const { app, van, chairs, lights } = projectList();
  app.aimAfterTick(chairs);
  assert.equal(app.cursorTask, chairs);
  chairs.done = true;
  app.aimAfterTick(chairs);
  assert.equal(app.cursorTask, van, 'a subtask done: its parent');
  lights.done = true;
  app.aimAfterTick(lights);
  assert.equal(app.cursor, null, 'a task done with no parent on the list: none');
  assert.deepEqual(app.lit, {}, 'and nothing lit');
  app.aim(van);
  van.done = true;
  assert.equal(app.capW, 'cap', 'done since: the box adds a task again');
});

test('only a task on this project\'s open list that you can change can be the cursor', () => {
  const { app, van } = projectList();
  app.route = { name: 'today' };
  app.aim(van);
  assert.equal(app.cursor, null, 'not on Today');
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
  // A run (a copy of a template) keeps its steps in its own order line: without one, the order they were made.
  const run = { ...parent, related_tasks: { ...parent.related_tasks, copiedfrom: [{ id: 1 }] }, description: '' };
  assert.deepEqual(ids(nestSubtasks([run, sub(11), sub(12), sub(13)], positionOrder(pos)).tasks), [10, 11, 12, 13]);
});

test('a task\'s siblings: those under the same parent, each with its subtasks; never another parent\'s', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map(id => ({ id }));
  const depth = { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0, 6: 1, 7: 0 };       // 1 > (2 > 3), 4;  5 > 6;  7
  assert.deepEqual(siblingBlocks(tasks, depth, 5).map(b => b.ids), [[1, 2, 3, 4], [5, 6], [7]], 'top level, each with all under it');
  assert.deepEqual(siblingBlocks(tasks, depth, 4).map(b => b.ids), [[2, 3], [4]], 'a subtask: its parent\'s subtasks only');
  assert.deepEqual(siblingBlocks(tasks, depth, 6).map(b => b.ids), [[6]], 'an only subtask: nowhere to go');
  assert.deepEqual(siblingBlocks(tasks, depth, 99), []);
});

test('dragging: the siblings it passes the middle of move aside, and it stays within them', () => {
  const blocks = [{ top: 0, height: 50 }, { top: 50, height: 150 }, { top: 200, height: 50 }];   // the second has subtasks
  assert.deepEqual(dragPlace(blocks, 0, 20), { dy: 20, shifts: [0, 0, 0], at: 0 }, 'not past the middle of the next');
  assert.deepEqual(dragPlace(blocks, 0, 110), { dy: 110, shifts: [0, -50, 0], at: 1 });
  assert.deepEqual(dragPlace(blocks, 0, 999), { dy: 200, shifts: [0, -50, -50], at: 2 }, 'drawn no lower than the last');
  assert.deepEqual(dragPlace(blocks, 2, -999), { dy: -200, shifts: [50, 50, 0], at: 0 });
  // A tall one (with subtasks) gets past a short last one.
  assert.equal(dragPlace(blocks, 1, 999).at, 2);
});
