// Tests for deleting a task (src/js/app/actions.js), against a fake Vikunja: the confirm, the held delete and its
// Undo, the deletes sent at once, the parent's progress, and the sync state while a delete waits.
import './browser.mjs';
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks, { copyOf, started } from '../../src/js/app/tasks.js';
import { TASK } from '../../src/js/tasks.js';
import sending from '../../src/js/app/sending.js';
import runs from '../../src/js/app/runs.js';
import checklists from '../../src/js/app/checklists.js';
import acts, { stageContext } from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import { api } from '../../src/js/api.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { OPS } from '../../src/js/ops/index.js';
import { figure } from '../../src/js/ops/stages.js';
import { SAMPLES } from './samples.mjs';

/* The app with every part a delete sent at once goes through, signed in, with Vikunja's tasks read into the store and
   each given a row. */
const sender = (v, ...more) => {
  const app = component(tasks, acts, sending, outbox, runs, actions, ...more);
  Object.assign(app, {
    user: { id: 1 },
    pending: [],
    failed: [],
    slow: [],
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
    view: { groups: [], shownRun: null },
    places: {},
    endPlace() {},
    closeSheet() {},
    back() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  const list = [...v.tasks.values()].map(t => structuredClone(t)),
    at = started();
  app.change(w => w.read(list, TASK, at));
  for (const t of list) app.row(copyOf(t.id));
  return app;
};
/* Run `deleting`, one of the ways Pocket deletes, with Vikunja holding each DELETE until a read of task `id` has
   run. The read overlaps the delete, so it is thrown away, and Vikunja's copy of the task keeps its title though a
   teammate changed it. Returns what `deleting` returns. */
async function readDuring(app, v, id, deleting) {
  const real = globalThis.fetch;
  let go, came;
  const gate = new Promise(ok => (go = ok)),
    arrived = new Promise(ok => (came = ok));
  globalThis.fetch = async (url, o = {}) => {
    if (o.method === 'DELETE') {
      came();
      await gate;
    }
    return real(url, o);
  };
  const out = deleting();
  await arrived;
  const was = copyOf(id).title;
  v.task(id).title = 'Renamed by a teammate';
  const at = started(),
    t = await api('/tasks/' + id);
  app.change(w => w.read([t], TASK, at));
  assert.equal(copyOf(id).title, was, 'a read of the task while the delete runs is thrown away');
  globalThis.fetch = real;
  go();
  return out;
}
// The tasks Pocket has no copy and no row of.
const forgotten = (app, ids) => ids.filter(id => !copyOf(id) && !app.tasks[id]);
const subtasksOf = id => copyOf(id).related_tasks.subtask.map(s => s.id);

const packing = () =>
  fakeVikunja([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } },
    { id: 3, title: 'Pack the plates', related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
// The add box's Undo, after Vikunja refused a later line, deletes the tasks its lines made (submitCapture).
test("the Undo of tasks just added deletes each, and their parent's copy stops listing them", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = packing(),
    app = sender(v);
  await readDuring(app, v, 1, () => app.deleteNow([[3], [2]]));
  assert.deepEqual([v.task(2), v.task(3)], [undefined, undefined]);
  assert.deepEqual([forgotten(app, [2, 3]), subtasksOf(1)], [[2, 3], []]);
});

test("a task already deleted in Vikunja counts as deleted, and Pocket's copies stop listing it", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = packing(),
    app = sender(v);
  v.tasks.delete(3);
  const r = await app.deleteNow([[3]]);
  assert.equal(r.status, 'sent');
  assert.deepEqual([forgotten(app, [3]), subtasksOf(1)], [[3], [2]]);
});

const template = () =>
  fakeVikunja([
    { id: 1, title: 'TEMPLATE: Closing', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Mop', related_tasks: { parenttask: [{ id: 1 }] } },
    { id: 3, title: 'Lock up', related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
// A template's sheet, open on template 1, whose steps are 2 and 3.
const templateSheet = v => {
  const app = sender(v, checklists);
  Object.assign(app.sheet, { id: 1, kind: 'task', open: true });
  for (const [k, value] of Object.entries({
    checklistRole: 'template',
    subtasks: [app.tasks[2], app.tasks[3]],
    canEdit: true,
  }))
    Object.defineProperty(app, k, { value, configurable: true });
  app.keepTemplate = () => {};
  app.role = t => (t.id === 1 ? 'template' : 'tplstep');
  globalThis.confirm = () => true;
  return app;
};
test('a template deleted from its sheet goes with its steps, with no Restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = template(),
    app = templateSheet(v);
  await readDuring(app, v, 1, () => app.deleteTask());
  assert.deepEqual([...v.tasks.keys()], []);
  assert.deepEqual(forgotten(app, [1, 2, 3]), [1, 2, 3]);
  assert.equal(app.toasts.at(-1).msg, 'Deleted, with 2 steps');
});

test("a step removed from a template leaves the template's copy", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = template(),
    app = templateSheet(v);
  await readDuring(app, v, 1, () => app.removeStep(0));
  assert.deepEqual([forgotten(app, [2]), subtasksOf(1)], [[2], [3]]);
  assert.equal(app.toasts.at(-1).msg, 'Step removed');
});

// Checklist 1, on its screen, with step 2 done and step 3 added during the checklist.
const closing = () =>
  fakeVikunja([
    { id: 1, title: 'Closing', percent_done: 0.5, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Mop', done: true, related_tasks: { parenttask: [{ id: 1 }] } },
    { id: 3, title: 'Wipe the menus', related_tasks: { parenttask: [{ id: 1 }] } },
  ]);
const onRun = v => {
  const app = sender(v);
  app.view.shownRun = { id: 1, steps: [2, 3] };
  app.route = { name: 'run', id: 1 };
  return app;
};
test('a checklist deleted from its sheet goes with its steps, with no Restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = closing(),
    app = onRun(v);
  await readDuring(app, v, 1, () => app.deleteRun(1, { deleted: true }));
  assert.deepEqual([...v.tasks.keys()], []);
  assert.deepEqual(forgotten(app, [1, 2, 3]), [1, 2, 3]);
  assert.equal(app.toasts.at(-1).msg, 'Checklist deleted');
});

test("a step added during a checklist is deleted, and the checklist's copy stops listing it", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = closing(),
    app = onRun(v);
  const ok = await readDuring(app, v, 1, () =>
    app.deleteAddedStep({ id: 3, title: 'Wipe the menus', added: 'Inserted', done: false }, false, true),
  );
  assert.equal(ok, true);
  assert.deepEqual([forgotten(app, [3]), subtasksOf(1)], [[3], [2]]);
  assert.equal(v.task(1).percent_done, 1, "the delete's last stage writes the checklist's progress");
});

// A delete with no Restore takes the changes waiting on its tasks out of the outbox, since they can't be made now.
test('a checklist deleted while a tick on its step waits takes the tick out of the outbox', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = closing(),
    app = onRun(v);
  app.offline = true;
  await app.act({ op: 'undone', task: 2, run: 1 });
  app.offline = false;
  await app.deleteRun(1);
  assert.deepEqual([sync.all(1), v.requests.filter(r => r.method === 'PATCH')], [[], []], 'only the deletes are sent');
  assert.deepEqual([...v.tasks.keys()], []);
});

test('a change waiting on a task the delete leaves alone stays, and is sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = closing(),
    app = onRun(v);
  app.offline = true;
  await app.act({ op: 'undone', task: 2, run: 1 });
  app.offline = false;
  await app.deleteNow([[3]]);
  assert.deepEqual(
    [sync.all(1), v.task(2).done, v.tasks.has(3)],
    [[], false, false],
    'the untick of step 2 reaches Vikunja, and step 3 is deleted',
  );
});

/* A start of template 7 that Vikunja refused partway has made the checklist and its steps. Deleting the template then
   cancels the start, whose Cancel stages delete what it made, since the template's tree doesn't hold those tasks. */
test('a template deleted while a refused start of it waits deletes the checklist the start made', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(structuredClone(SAMPLES.startRun.tasks));
  v.labels.push(...SAMPLES.startRun.labels);
  const app = sender(v);
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  // Vikunja refuses the checklist's people, after the copies are made.
  v.trouble = r => (r.method === 'PUT' && /assignees/.test(r.path) ? 403 : null);
  assert.equal((await app.act({ id: uuid7(), ...SAMPLES.startRun.fields(OPS) })).status, 'error');
  assert.deepEqual([...v.tasks.keys()], [7, 8, 9, 101, 102, 103]);
  v.trouble = () => null;
  await app.deleteNow([[8, 9, 7]]);
  assert.deepEqual([[...v.tasks.keys()], sync.all(1)], [[], []]);
});

// A step Vikunja made but refused to link under the checklist isn't among the checklist's steps the delete deletes.
test('a checklist deleted while a refused add of a step waits deletes the step the add made', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(structuredClone(SAMPLES.addStep.tasks)),
    app = sender(v);
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  v.trouble = r => (r.method === 'POST' && r.path === '/tasks/1/relations' ? 403 : null);
  assert.equal((await app.act({ id: uuid7(), ...SAMPLES.addStep.fields(OPS) })).status, 'error');
  assert.deepEqual([...v.tasks.keys()], [1, 2, 3, 101]);
  v.trouble = () => null;
  await app.deleteNow([[2, 3, 1]]);
  assert.deepEqual([[...v.tasks.keys()], sync.all(1)], [[], []]);
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
    pick(acts, 'actEntry', 'sendActs', 'sendAct', 'giveBack'),
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
