// What's done to a task (src/js/app/actions.js), against a pretend Vikunja: what's sent, what's on screen, and the Undo.
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import runs from '../../src/js/app/runs.js';
import outbox from '../../src/js/app/outbox.js';
import { cache } from '../../src/js/util.js';
import { sync } from '../../src/js/sync.js';

const DAY = 86400;
const sub = (id, more = {}) => ({ id, title: 'Subtask ' + id, done: false, ...more });
// A parent with four subtasks: two open (one half done), one done already, and one that repeats (which a parent's tick
// leaves alone).
const family = () => {
  const subs = [sub(11), sub(12, { done: true }), sub(13, { repeat_after: DAY, due_date: '2026-10-07T09:00:00Z' }), sub(14, { percent_done: 0.5 })];
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.25, related_tasks: { subtask: subs } };
  return { parent, subs };
};
const patches = v => v.requests.filter(r => r.method === 'PATCH').map(r => [+r.path.split('/')[2], r.body]);

test('ticking a parent closes its open subtasks, says "Closed", and Undo opens exactly those again, progress as it was', async () => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = component(tasks, actions);
  const t = app.keep(parent);
  await app.toggleDone(t, null);
  assert.deepEqual(patches(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }]]);
  assert.equal(t.done, true);
  assert.equal(app.toast.msg, 'Closed Pack the van + 2 subtasks');
  assert.deepEqual([app.toast.row.text, app.toast.row.title, app.toast.row.more], ['Closed', 'Pack the van', '+ 2 subtasks'], 'its row\'s line');
  assert.deepEqual(app.toast.row.hide, [11, 14], 'the subtasks closed go with its row');
  assert.equal(v.task(13).done, false, 'a repeating subtask is left alone');
  assert.deepEqual(t.related_tasks.subtask.map(s => s.done), [true, true, false, true], 'its row counts them done');

  v.requests.length = 0;
  await app.toast.action.fn();
  assert.deepEqual(patches(v), [[10, { done: false }], [11, { done: false }], [14, { done: false }]]);
  assert.equal(v.task(12).done, true, 'the subtask done before stays done');
  assert.equal(t.done, false);
  assert.deepEqual([v.task(10).percent_done, v.task(14).percent_done], [0.25, 0.5], 'progress as it was');
  assert.deepEqual(t.related_tasks.subtask.map(s => s.done), [false, true, false, false]);
});

test('a subtask that fails to close stops the rest, and the message says so', async () => {
  const two = [sub(11), sub(14)], parent = { id: 10, title: 'Pack the van', done: false, related_tasks: { subtask: two } };
  const v = fakeVikunja([parent, ...two]), app = component(tasks, actions);
  v.trouble = r => r.method === 'PATCH' && r.path === '/tasks/11' ? 403 : null;
  await app.toggleDone(app.keep(parent), null);
  assert.equal(v.task(10).done, true);
  assert.equal(v.task(14).done, false, 'stopped at the first that failed');
  assert.equal(app.toast.msg, 'Done: Pack the van — its 2 subtasks couldn\'t be closed');
});

test('the sheet\'s tick goes the same way: its subtasks closed, said under them, and Undo opens them again', async () => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = component(tasks, actions);
  app.sheet = { task: structuredClone(parent) };
  await app.sheetDone();
  assert.deepEqual(patches(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }]]);
  assert.deepEqual([app.toast.msg, app.toast.place], ['Closed Pack the van + 2 subtasks', 'sheet:subtasks']);
  assert.deepEqual(app.sheet.task.related_tasks.subtask.map(s => s.done), [true, true, false, true], 'the sheet shows them done');
  assert.equal(app.sheet.dirty, true, 'the list is read again once the sheet closes');
  await app.toast.action.fn();
  assert.deepEqual([10, 11, 12, 14].map(id => v.task(id).done), [false, false, true, false]);
  assert.deepEqual(app.sheet.task.related_tasks.subtask.map(s => s.done), [false, true, false, false]);
  // A task with none: its tick says nothing, it shows on the tick; ticked again, it's not done.
  const n = app.toasts.length;
  app.sheet.task = structuredClone(v.task(12));
  await app.sheetDone();
  assert.equal(v.task(12).done, false);
  assert.equal(app.toasts.length, n);
});

test('a done parent over its open subtasks on a project\'s list, ticked, is open again where it is, out of Done', async () => {
  const v = fakeVikunja([{ id: 10, title: 'Pack the van', done: true, related_tasks: { subtask: [sub(11)] } }, sub(11)]), app = component(tasks, actions);
  const head = app.keep(v.task(10)), kid = app.keep(v.task(11));
  app.route = { name: 'project', id: 1 };
  app.view.groups = [{ key: 'open', tasks: [kid, head], heads: [10] }, { key: 'done', loaded: false, count: 3, tasks: [] }];
  assert.equal(app.isHead(head), true);
  await app.toggleDone(head, null);
  assert.equal(v.task(10).done, false);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [11, 10], 'still on the open list');
  assert.equal(app.view.groups[1].count, 2, 'no longer counted as done');
  assert.deepEqual([app.toast.row.text, app.toast.row.stays], ['Not done:', true], 'its line gives the row back');
  assert.equal(v.task(11).done, false, 'its subtask as it was');
  await app.toast.action.fn();
  assert.equal(v.task(10).done, true, 'Undo: done again');
});
test('a parent ticked on a project\'s list with a subtask left open (one that repeats) stays over it, done', async () => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = component(tasks, actions);
  app.route = { name: 'project', id: 1 };
  const t = app.keep(parent), kids = [11, 13, 14].map(id => app.keep({ ...v.task(id), related_tasks: { parenttask: [{ id: 10 }] } }));
  app.view.groups = [{ key: 'open', tasks: [t, ...kids] }, { key: 'done', loaded: false, count: 1, tasks: [] }];
  await app.toggleDone(t, null);
  assert.deepEqual(app.view.groups[0].heads, [10], 'a head over the repeating one');
  assert.equal(app.view.groups[1].count, 2, 'counted done');
  assert.deepEqual([app.toast.row.stays, app.toast.row.hide], [true, [11, 14]], 'its row comes back when its line goes; those closed go with it');
  await app.toast.action.fn();
  assert.deepEqual([10, 11, 14].map(id => v.task(id).done), [false, false, false], 'Undo: all open again');
  assert.equal(app.view.groups[1].count, 1);
});

test('a tick not saved goes back, and its row says why, with Try again', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Call Jo', done: false }]), app = component(tasks, actions);
  v.trouble = () => 'offline';
  const t = app.keep(v.task(1));
  await app.toggleDone(t, null);
  assert.equal(t.done, false);
  assert.equal(app.toast.msg, 'Not saved: no connection');
  assert.deepEqual([app.toast.row.id, app.toast.row.stays, app.toast.cls], [1, true, 'failed'], 'on its row, which stays');
  assert.equal(app.toast.action.label, 'Try again');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).done, true, 'Try again ticks it');
});

test('a repeating task whose tick lost its reply is ticked once, not twice', async () => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const v = fakeVikunja([{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]), app = component(tasks, actions);
  cache.set(1, structuredClone(v.task(1)));
  v.trouble = r => r.method === 'PATCH' ? 'lost' : null;
  const t = app.keep(v.task(1));
  await app.toggleDone(t, null);
  assert.equal(patches(v).length, 1, 'not sent again: Vikunja\'s copy, read after, shows it moved on');
  assert.equal(Date.parse(v.task(1).due_date) - Date.parse(due), DAY * 1000);
  assert.equal(t.due_date, v.task(1).due_date, 'its row shows the next date');
  assert.match(app.toast.msg, /^Repeats · next /);
  assert.deepEqual([app.toast.row.id, app.toast.row.stays], [1, true], 'on its row, which stays, with its next date');
  // Undo puts its date back.
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).due_date, due);
});

test('progress taken to 100% marks the task done, and Undo puts back the progress it had', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]), app = component(tasks, actions);
  const t = app.keep(v.task(1));
  await app.setProgress(t, 100, null);
  assert.deepEqual(patches(v), [[1, { done: true }]], 'its progress is left as it was');
  assert.equal(v.task(1).done, true);
  await app.toast.action.fn();
  assert.deepEqual(patches(v).at(-1), [1, { done: false, percent_done: 0.4 }]);
  // From the sheet's bar, the same, shown by its tick: ticked again, it's back with the progress it had.
  const n = app.toasts.length;
  app.sheet = { task: structuredClone(v.task(1)) };
  await app.sheetProgress(app.sheet.task, 100);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done, app.toasts.length], [true, 0.4, n]);
  await app.sheetDone();
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.4]);
});

test('progress below 100% is saved as it is, shown on its bar alone; not saved, it goes back and its row says so', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]), app = component(tasks, actions);
  const t = app.keep(v.task(1));
  await app.setProgress(t, 70, null);
  assert.equal(v.task(1).percent_done, 0.7);
  assert.deepEqual(app.toasts, [], 'no message: sliding it back is the undo');
  assert.equal(app.said, 'Progress of Paint the fence set to 70%', 'a screen reader hears it');

  v.trouble = () => 500;
  await app.setProgress(t, 90, null);
  assert.equal(t.percent_done, 0.7);
  assert.match(app.toast.msg, /^Not saved: /);
  assert.equal(app.toast.row.id, 1);
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).percent_done, 0.9, 'Try again sets it');
});

test('saves to a task go one after another, in the order they were made', async () => {
  const v = fakeVikunja([{ id: 1, title: 'A', done: false }]), app = component(tasks, actions);
  const order = [], fetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { order.push('sent ' + o.body); await new Promise(r => setTimeout(r, 20)); const res = await fetch(url, o); order.push('back ' + o.body); return res; };
  await Promise.all([app.saveTask(1, { title: 'B' }), app.saveTask(1, { title: 'C' })]);
  assert.deepEqual(order, ['sent {"title":"B"}', 'back {"title":"B"}', 'sent {"title":"C"}', 'back {"title":"C"}']);
  assert.equal(v.task(1).title, 'C');
  assert.equal(cache.get(1).title, 'C', 'Vikunja\'s last copy is kept');
});

test('deleting a task and its subtasks: one already gone is fine, a refusal stops and says how many went', async () => {
  const v = fakeVikunja([{ id: 1, title: 'A' }, { id: 3, title: 'C' }]), app = component(tasks, actions);
  for (const id of [1, 2, 3]) app.keep({ id, title: String(id) });
  app.view.groups = [{ key: 'today', tasks: [app.tasks[1], app.tasks[2], app.tasks[3]] }];
  v.trouble = r => r.path === '/tasks/3' ? 403 : null;
  await assert.rejects(app.deleteTree([1, 2, 3]), e => e.deleted === 2);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [3], 'what went is off the list');
  assert.ok(!app.tasks[1] && !app.tasks[2] && app.tasks[3]);
});

test('Move all to today: each overdue task to today at its own time, or the next hour if that has passed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
    { id: 3, title: 'Repeats', due_date: at(6, 8), repeat_after: DAY },
  ]);
  const app = component(tasks, actions);
  app.view.groups = [{ key: 'overdue', tasks: [1, 2, 3].map(id => app.keep(v.task(id))) }];
  assert.equal(app.overdueMovable, true);
  await app.moveOverdueToToday();
  assert.equal(v.task(1).due_date, at(7, 15), 'its time has passed today: the next whole hour');
  assert.equal(v.task(2).due_date, at(7, 18, 30));
  assert.equal(v.task(3).due_date, at(6, 8), 'a repeating task stays');
  assert.equal(app.toasts.at(-1).msg, 'Moved 2 to today. 1 repeating task stays: tick it to move on to the next date.');
  assert.equal(app.toast.place, 'overdue', 'said under the Overdue heading');
  await app.toast.action.fn();
  assert.equal(v.task(1).due_date, at(5, 9));
  assert.equal(v.task(2).due_date, at(6, 18, 30));
});

test('a subtask\'s tick and progress show on its row only: no message, and its row stays where it is', async () => {
  const kid = { id: 2, title: 'Pack the cups', done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } };
  const v = fakeVikunja([kid]), app = component(tasks, actions), t = app.keep(kid);
  await app.setProgress(t, 50, null);
  assert.equal(v.task(2).percent_done, 0.5);
  await app.toggleDone(t, null);
  assert.equal(v.task(2).done, true);
  await app.toggleDone(t, null);
  assert.equal(v.task(2).done, false);
  assert.deepEqual(app.toasts, [], 'no messages');
  // In its parent's sheet, a subtask's copy has no parent of its own: it's said to be one.
  const inSheet = { id: 3, title: 'Wash them', done: false };
  v.tasks.set(3, structuredClone(inSheet));
  await app.toggleDone(inSheet, null, { sub: true });
  assert.deepEqual(app.toasts, []);
});

// The parts a deletion is sent with: what's waiting, and the outbox's acts (runs.js), on the pretend component.
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// Its timers are the test's, so the ones still to come (the Undo's own, say) don't keep Node waiting.
const deleting = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, pick(sending.default ?? sending, 'refreshPending', 'sendEntry'),
    pick(runs, 'sendActs', 'sendAct', 'applyAct', 'actWhat', 'actTitle', 'wordsBack', 'giveBack', 'refreshRunTask'));
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], canWrite: () => true, flushing: false, cap: {}, sheet: { task: null, sub: {} } });
  Object.defineProperty(app, 'syncState', Object.getOwnPropertyDescriptor(outbox, 'syncState'));
  globalThis.confirm = () => true;
  return app;
};
const deletes = v => v.requests.filter(r => r.method === 'DELETE').map(r => +r.path.split('/')[2]);

test('a deletion waits for its Undo: off the list at once, nothing sent, and Undo brings it back', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(1)), app.keep(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  assert.equal(d.n, 1, 'with its subtask');
  assert.deepEqual(app.deleting.sort(), [1, 2], 'off the list');
  assert.deepEqual(deletes(v), [], 'not sent while its Undo shows');
  assert.equal(app.pending.length, 0, 'nor said to be waiting to send');
  await app.undoDelete(d.id);
  assert.deepEqual(app.deleting, [], 'back on the list');
  await app.sendHeld();                                                       // Pocket put away: nothing left to send
  assert.deepEqual(deletes(v), []);
  assert.equal(sync.all(1).length, 0);
});

test('a deletion is sent once its Undo has gone, deepest first, and its rows are forgotten', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(1)), app.keep(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  await app.sendHeld(d.id);
  assert.deepEqual(deletes(v), [2, 1]);
  assert.deepEqual(app.view.groups[0].tasks, []);
  assert.deepEqual(app.deleting, []);
  assert.equal(sync.all(1).length, 0, 'nothing left waiting');
  await app.undoDelete(d.id);                                                 // too late for Undo: nothing happens
  assert.deepEqual(deletes(v), [2, 1]);
});

test('a deletion without a connection waits in the outbox, off the list, and goes once there is one', async t => {
  const v = fakeVikunja([{ id: 5, title: 'Call Jo' }]), app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(5))] }];
  await app.holdDelete(app.tasks[5]);
  v.trouble = r => r.method === 'DELETE' ? 'offline' : null;
  await app.sendHeld();                                                       // put away while offline
  assert.deepEqual(app.deleting, [5], 'still off the list');
  assert.equal(app.pending.length, 1, 'shown as waiting to send');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.ok(!v.task(5), 'deleted in Vikunja');
  assert.deepEqual(app.deleting, []);
});

test('a deletion Vikunja turns down brings the row back, kept to try again', async t => {
  const v = fakeVikunja([{ id: 6, title: 'Order cups' }]), app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(6))] }];
  const d = await app.holdDelete(app.tasks[6]);
  v.trouble = r => r.method === 'DELETE' ? 403 : null;
  await app.sendHeld(d.id);
  assert.deepEqual(app.deleting, [], 'back on the list');
  assert.equal(app.failed.length, 1);
  assert.match(app.toast.msg, /^Deleting “Order cups” couldn't be saved/);
  await sync.remove(app.failed[0].id);
});

test('the page says where sending stands: waiting while an Undo shows or offline, sending, then idle', async t => {
  const v = fakeVikunja([{ id: 7, title: 'Wipe the till' }, { id: 8, title: 'Sweep up' }]), app = deleting(t), seen = [];
  app.refreshPending();
  assert.equal(app.syncState, 'idle');
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(7)), app.keep(v.task(8))] }];
  const d = await app.holdDelete(app.tasks[7]);
  assert.equal(app.syncState, 'waiting', 'held for its Undo');
  v.trouble = r => { if (r.method === 'DELETE') seen.push(app.syncState); return null; };
  await app.sendHeld(d.id);
  assert.deepEqual(seen, ['sending']);
  assert.equal(app.syncState, 'idle', 'all there');
  await app.holdDelete(app.tasks[8]);
  v.trouble = r => r.method === 'DELETE' ? 'offline' : null;
  await app.sendHeld();
  assert.equal(app.syncState, 'waiting', 'no connection');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.equal(app.syncState, 'idle');
});
