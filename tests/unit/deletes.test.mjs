// Tests for deleting a task (src/js/app/actions.js), against a fake Vikunja: the confirm, the held delete and its
// Undo, the parent's progress, and the sync state while a delete waits.
import './browser.mjs';
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import runs from '../../src/js/app/runs.js';
import acts, { stageContext } from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { OPS } from '../../src/js/ops/index.js';
import { figure } from '../../src/js/ops/stages.js';

test('deleting a task and its subtasks skips one already deleted, and stops at a refusal after counting what was deleted', async () => {
  const v = fakeVikunja([
      { id: 1, title: 'A' },
      { id: 3, title: 'C' },
    ]),
    app = component(tasks, actions);
  for (const id of [1, 2, 3]) app.row({ id, title: String(id) });
  app.view.groups = [{ key: 'today', tasks: [app.tasks[1], app.tasks[2], app.tasks[3]] }];
  v.trouble = r => (r.path === '/tasks/3' ? 403 : null);
  await assert.rejects(app.deleteTree([1, 2, 3]), e => e.deleted === 2);
  assert.deepEqual(
    app.view.groups[0].tasks.map(t => t.id),
    [3],
    'the deleted tasks have left the list',
  );
  assert.ok(!app.tasks[1] && !app.tasks[2] && app.tasks[3]);
});
// The parts needed to send a deletion are what is waiting and the outbox's acts (runs.js), on the fake component.
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The test controls the timers, so timers that have not fired yet (the Undo's, for example) don't keep Node waiting.
const deleting = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(
    tasks,
    actions,
    pick(sending.default ?? sending, 'refreshPending', 'keyWaiting', 'markSlow', 'sendEntry'),
    pick(acts, 'actEntry', 'sendActs', 'sendAct', 'wordsBack', 'giveBack'),
    pick(outbox, 'actTitle'),
    pick(runs, 'refreshRunTask'),
  );
  Object.assign(app, {
    user: { id: 1 },
    pending: [],
    failed: [],
    slow: [],
    canWrite: () => true,
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
  });
  Object.defineProperty(app, 'syncState', Object.getOwnPropertyDescriptor(outbox, 'syncState'));
  globalThis.confirm = () => true;
  return app;
};
const deletes = v => v.requests.filter(r => r.method === 'DELETE').map(r => +r.path.split('/')[2]);
// The tasks that a waiting delete deletes, so their rows are hidden.
const going = (app, ids) => ids.filter(id => app.beingDeleted(id));
test("deleting a subtask writes its parent's calculated progress in the same entry, once the deletion is sent", async t => {
  const v = fakeVikunja([
    { id: 1, title: 'Pack the van', percent_done: 0.5, related_tasks: { subtask: [{ id: 2 }, { id: 3, done: true }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } },
    { id: 3, title: 'Pack the plates', done: true, related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[2]);
  assert.equal(sync.all(1)[0].up, 1, 'the parent is queued to have its progress calculated again');
  assert.equal(v.task(1).percent_done, 0.5, 'nothing is written while Restore shows');
  await app.sendHeld(d.id);
  assert.deepEqual(deletes(v), [2]);
  assert.equal(v.task(1).percent_done, 1, 'the remaining subtask is done, so the parent is at 100%');
  assert.equal(OPS.delete.stages.at(-1), figure);
});
test("a subtask's deletion whose parent is already gone writes no progress, and is not an error", async () => {
  const v = fakeVikunja([{ id: 2, title: 'Pack the cups' }]),
    app = component(tasks, actions);
  const a = { id: uuid7(), op: 'delete', task: 2, ids: [2], up: 1, stage: 1 };
  await figure(a, stageContext(a, app).start());
  assert.deepEqual(
    v.requests.map(r => r.method + ' ' + r.path),
    ['GET /tasks/1'],
    'the parent is read, answers 404, and nothing is patched',
  );
});
/* Deleting a task with subtasks asks for confirmation first. askDelete reads which tasks go with it and asks on its
   own, so a row swiped to delete asks before it slides away (swipeDelete, app/progress.js). The deletion that follows
   does not ask again. */
test('deleting a task with subtasks asks first with the count, and answering no sends nothing', async t => {
  const v = fakeVikunja([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 4 }] } },
    { id: 3, title: 'Pack the plates', related_tasks: { parenttask: [{ id: 1 }] } },
    { id: 4, title: 'Wrap them', related_tasks: { parenttask: [{ id: 2 }] } },
    { id: 5, title: 'Lock up' },
  ]);
  const app = deleting(t),
    asked = [];
  let yes = false;
  globalThis.confirm = q => {
    asked.push(q);
    return yes;
  };
  for (const id of [1, 3, 5]) app.row(v.task(id));
  assert.deepEqual(
    [1, 3, 5].map(id => app.hasSubtasks(app.tasks[id])),
    [true, false, false],
    'the phone knows which tasks have subtasks',
  );
  assert.equal(app.hasSubtasks({ id: 1 }), true, 'the copy on screen also shows the subtasks');
  assert.equal(await app.askDelete(app.tasks[1]), null, 'answering no returns nothing');
  assert.deepEqual(asked, ['Delete “Pack the van” and its 2 subtasks, 1 more under them?']);
  assert.equal(await app.holdDelete(app.tasks[1]), null);
  assert.deepEqual(
    [sync.all(1).length, going(app, [1, 2, 3, 4]), deletes(v)],
    [0, [], []],
    'nothing is queued to send and nothing leaves the list',
  );
  yes = true;
  asked.length = 0;
  const tree = await app.askDelete(app.tasks[1]);
  assert.deepEqual([tree, asked.length], [[4, 2, 3, 1], 1], 'every level of subtasks is included, deepest first');
  const d = await app.holdDelete(app.tasks[1], null, tree);
  assert.deepEqual(
    [d.n, asked.length, sync.all(1)[0].ids],
    [3, 1, [4, 2, 3, 1]],
    'a deletion already asked about does not ask again',
  );
  await app.undoDelete(d.id);
  asked.length = 0;
  assert.deepEqual([await app.askDelete(app.tasks[5]), asked], [[5], []], 'a task with no subtasks is not asked about');
});
test('a deletion leaves the list at once and waits for its Undo, and Undo brings the task back', async t => {
  const v = fakeVikunja([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  assert.equal(d.n, 1, 'the deletion includes the subtask');
  assert.deepEqual(going(app, [1, 2]), [1, 2], 'both tasks leave the list');
  assert.deepEqual(deletes(v), [], 'nothing is sent while Undo shows');
  assert.equal(app.pending.length, 0, 'the deletion is not shown as waiting to send');
  await app.undoDelete(d.id);
  assert.deepEqual(going(app, [1, 2]), [], 'both tasks are back on the list');
  await app.sendHeld(); // the app goes to the background, with nothing left to send
  assert.deepEqual(deletes(v), []);
  assert.equal(sync.all(1).length, 0);
});
test('a deletion is sent deepest first once its Undo has gone, and the rows are dropped', async t => {
  const v = fakeVikunja([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  await app.sendHeld(d.id);
  assert.deepEqual(deletes(v), [2, 1]);
  assert.deepEqual(app.view.groups[0].tasks, []);
  assert.deepEqual(app.opsOn, {});
  assert.equal(sync.all(1).length, 0, 'nothing is left waiting');
  await app.undoDelete(d.id); // too late for Undo, so nothing happens
  assert.deepEqual(deletes(v), [2, 1]);
});
test('a deletion made offline waits in the outbox, off the list, and is sent once there is a connection', async t => {
  const v = fakeVikunja([{ id: 5, title: 'Call Jo' }]),
    app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(5))] }];
  await app.holdDelete(app.tasks[5]);
  v.trouble = r => (r.method === 'DELETE' ? 'offline' : null);
  await app.sendHeld(); // the app goes to the background while offline
  assert.deepEqual(going(app, [5]), [5], 'the task is still off the list');
  assert.equal(app.pending.length, 1, 'the deletion is shown as waiting to send');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.ok(!v.task(5), 'deleted in Vikunja');
  assert.deepEqual(app.opsOn, {});
});
test('a deletion that Vikunja refuses brings the row back and keeps the deletion to try again', async t => {
  const v = fakeVikunja([{ id: 6, title: 'Order cups' }]),
    app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(6))] }];
  const d = await app.holdDelete(app.tasks[6]);
  v.trouble = r => (r.method === 'DELETE' ? 403 : null);
  await app.sendHeld(d.id);
  assert.deepEqual(going(app, [6]), [], 'the row is back on the list');
  assert.equal(app.failed.length, 1);
  assert.match(app.toast.msg, /^Deleting “Order cups” couldn't be saved/);
  await sync.remove(app.failed[0].id);
});
test('the sync state is waiting while an Undo shows or offline, sending while sending, and idle when done', async t => {
  const v = fakeVikunja([
      { id: 7, title: 'Wipe the till' },
      { id: 8, title: 'Sweep up' },
    ]),
    app = deleting(t),
    seen = [];
  app.refreshPending();
  assert.equal(app.syncState, 'idle');
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(7)), app.row(v.task(8))] }];
  const d = await app.holdDelete(app.tasks[7]);
  assert.equal(app.syncState, 'waiting', 'the state is waiting while the deletion is held for its Undo');
  v.trouble = r => {
    if (r.method === 'DELETE') seen.push(app.syncState);
    return null;
  };
  await app.sendHeld(d.id);
  assert.deepEqual(seen, ['sending']);
  assert.equal(app.syncState, 'idle', 'the state is idle once everything is sent');
  await app.holdDelete(app.tasks[8]);
  v.trouble = r => (r.method === 'DELETE' ? 'offline' : null);
  await app.sendHeld();
  assert.equal(app.syncState, 'waiting', 'the state is waiting while offline');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.equal(app.syncState, 'idle');
});
