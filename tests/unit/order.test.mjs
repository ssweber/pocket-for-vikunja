// A project's order (src/js/order.js): its List view, positions as Vikunja's web app sets them, siblings, and a drag.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, dragPlace, listViewOf, placeMove, positionOrder, siblingBlocks, SPACING } from '../../src/js/order.js';
import { nestSubtasks } from '../../src/js/lists.js';

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

test('siblings in their List view order: by position, those with none after, by id, and one waiting to be sent last', () => {
  const pos = { 1: 300, 2: 100, 3: 0, 4: 200 };
  const list = [{ id: 5 }, { id: 1 }, { id: 'pending-x', pending: true }, { id: 3 }, { id: 2 }, { id: 4 }];
  assert.deepEqual(ids([...list].sort(positionOrder(pos))), [2, 4, 1, 3, 5, 'pending-x']);
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
