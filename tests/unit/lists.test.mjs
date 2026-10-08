// The lists Pocket shows (src/js/lists.js): their order, and subtasks under their parents.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneParentIds, nestSubtasks, soonestFirst, todayGroups, todayOrder, viewKey } from '../../src/js/lists.js';

const ids = list => list.map(t => t.id);
const NONE = '0001-01-01T00:00:00Z';                        // Vikunja's "no date"

test('soonest first: dated by date, then undated by priority, then newest', () => {
  const list = [
    { id: 1, due_date: NONE, priority: 0 },
    { id: 2, due_date: '2026-10-09T09:00:00Z' },
    { id: 3, due_date: NONE, priority: 3 },
    { id: 4, due_date: '2026-10-08T09:00:00Z' },
    { id: 5, due_date: null, priority: 0 },
  ];
  assert.deepEqual(ids(soonestFirst(list)), [4, 2, 3, 5, 1]);
  assert.deepEqual(ids(list), [1, 2, 3, 4, 5], 'the list given is left as it was');
});

const parentOf = (id, ...parents) => ({ id, related_tasks: { parenttask: parents.map(p => ({ id: p })) } });
const withSubs = (id, ...subs) => ({ id, related_tasks: { subtask: subs.map(s => ({ id: s })) } });

test('each subtask straight after its parent, in the parent\'s order, with its depth', () => {
  const list = [parentOf(4, 1), withSubs(1, 3, 4), parentOf(5, 4), parentOf(3, 1), { id: 2 }];
  list[0].related_tasks.subtask = [{ id: 5 }];
  const { tasks, depth } = nestSubtasks(list);
  assert.deepEqual(ids(tasks), [1, 3, 4, 5, 2]);
  assert.deepEqual(depth, { 1: 0, 3: 1, 4: 1, 5: 2, 2: 0 });
});

test('a subtask whose parent isn\'t in the list stays where it was, at the top', () => {
  const { tasks, depth } = nestSubtasks([{ id: 1 }, parentOf(2, 99), { id: 3 }]);
  assert.deepEqual(ids(tasks), [1, 2, 3]);
  assert.equal(depth[2], 0);
});

test('a done parent with open subtasks is found, and shown over them, not left out with them at the top', () => {
  const sub = (id, parent, more = {}) => ({ id, done: false, related_tasks: { parenttask: [{ id: parent, done: true, project_id: 1 }] }, ...more });
  // As a project's List view gives it: its open tasks, and their subtasks, done ones too (8, under 6, and done).
  const view = [{ id: 1 }, sub(2, 9), sub(3, 9), sub(4, 7, { related_tasks: { parenttask: [{ id: 7, done: true, project_id: 2 }] } }),
    { id: 6, related_tasks: { subtask: [{ id: 8 }] } }, { id: 8, done: true, related_tasks: { parenttask: [{ id: 6, done: false, project_id: 1 }] } }, sub(5, 8)];
  assert.deepEqual(doneParentIds(view, 1), [9, 8], 'not a parent in another project; one the view gave, under an open task, too');
  const head = { id: 9, done: true, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } };
  const { tasks, depth } = nestSubtasks([...view.filter(t => !t.done), head, view[5]]);
  assert.deepEqual(ids(tasks), [1, 4, 6, 8, 5, 9, 2, 3]);
  assert.deepEqual([depth[9], depth[2], depth[3], depth[8], depth[5]], [0, 1, 1, 1, 2]);
});

test('a task waiting to be sent goes under the parent it names', () => {
  const { tasks, depth } = nestSubtasks([{ id: 'w1', parent: 3 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(ids(tasks), [3, 'w1', 4]);
  assert.equal(depth.w1, 1);
});

test('tasks that are each other\'s subtasks are each shown once', () => {
  const a = { id: 1, related_tasks: { parenttask: [{ id: 2 }], subtask: [{ id: 2 }] } };
  const b = { id: 2, related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 1 }] } };
  const { tasks } = nestSubtasks([a, b]);
  assert.deepEqual(ids(tasks).sort(), [1, 2]);
});

test('a template\'s steps go in their order: by id, with no order line', () => {
  const tpl = { id: 1, labels: [{ title: 'template' }], description: '', related_tasks: { subtask: [{ id: 9 }, { id: 3 }] } };
  const { tasks } = nestSubtasks([tpl, parentOf(9, 1), parentOf(3, 1)]);
  assert.deepEqual(ids(tasks), [1, 3, 9]);
});

test('the key a list is saved under, for opening it offline', () => {
  assert.equal(viewKey({ name: 'project', id: 7, showDone: false }), 'project.7.open');
  assert.equal(viewKey({ name: 'project', id: 7, showDone: true }), 'project.7.done');
  assert.equal(viewKey({ name: 'run', id: 12 }), 'run.12');
  assert.equal(viewKey({ name: 'today' }), 'today');
});

test('Today\'s groups, in order, each new', () => {
  assert.deepEqual(todayGroups().map(g => g.key), ['overdue', 'today', 'runs', 'nodate', 'week']);
  assert.notEqual(todayGroups()[0].tasks, todayGroups()[0].tasks);
});

test('Today’s groups in their order, a task not sent yet already in its place', () => {
  const at = h => `2026-10-07T${String(h).padStart(2, '0')}:00:00Z`;
  const overdue = [{ id: 1, priority: 0, due_date: at(8) }, { id: 2, priority: 3, due_date: at(9) }, { id: 3, priority: 0, due_date: at(7) }];
  assert.deepEqual(ids(overdue.sort(todayOrder.overdue)), [2, 3, 1], 'the most urgent, then the longest overdue');
  const today = [{ id: 4, due_date: at(15) }, { id: 'pending-a', pending: true, due_date: at(12) }, { id: 5, due_date: at(10) }];
  assert.deepEqual(ids(today.sort(todayOrder.today)), [5, 'pending-a', 4], 'soonest first');
  const added = [{ id: 6, created: at(9) }, { id: 7, created: at(11) }, { id: 'pending-b', pending: true }];
  assert.deepEqual(ids(added.sort(todayOrder.nodate)), ['pending-b', 7, 6], 'newest first, one not sent yet before them');
});

