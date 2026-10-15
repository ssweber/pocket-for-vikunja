// Tests for what happens to a task (src/js/app/actions.js), against a fake Vikunja. They check what is sent, what is
// on screen, and the undo. In a list, a row's tick waits for the batch to clear (leaving.js).
import { fakeVikunja, component, sendStages } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks, { copyOf, TASK } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import runs from '../../src/js/app/runs.js';
import acts, { stageContext } from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import leaving from '../../src/js/app/leaving.js';
import lines from '../../src/js/app/lines.js';
import cards from '../../src/js/app/cards.js';
import alerts from '../../src/js/app/alerts.js';
import sheet from '../../src/js/app/sheet.js';
import views from '../../src/js/app/views.js';
import checklists from '../../src/js/app/checklists.js';
import { todayGroups } from '../../src/js/lists.js';
import { movedDue } from '../../src/js/dates.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { OPS } from '../../src/js/ops/index.js';
import { figure } from '../../src/js/ops/stages.js';

const DAY = 86400;
const sub = (id, more = {}) => ({ id, title: 'Subtask ' + id, done: false, ...more });
// A parent with four subtasks: two open (one half done), one already done, and one that repeats. Completing a parent
// leaves the repeating subtask alone.
const family = () => {
  const subs = [sub(11), sub(12, { done: true }), sub(13, { repeat_after: DAY, due_date: '2026-10-07T09:00:00Z' }), sub(14, { percent_done: 0.5 })];
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.25, related_tasks: { subtask: subs } };
  return { parent, subs };
};
// The patches Vikunja received. A request the relay answered from what it kept never reached Vikunja.
const patches = v => v.requests.filter(r => r.method === 'PATCH' && !r.replayed).map(r => [+r.path.split('/')[2], r.body]);
// The patches that are not a parent's calculated progress, which Pocket writes after its subtasks change (writeFigure).
const ticks = v => patches(v).filter(([, b]) => !('percent_done' in b && Object.keys(b).length === 1));
// A row in a list, for ticking from there. The test controls the batch's timer, so the batch doesn't clear by itself.
const ROW = {};
const listed = t => { t.mock.timers.enable({ apis: ['setTimeout'] }); return component(tasks, actions, leaving); };
// Open task `t` in the sheet, as openTask does once it has Vikunja's copy. The sheet holds the id and reads the row.
const opened = (app, t, more = {}) => { app.change(w => w.put([structuredClone(t)], TASK)); app.row(structuredClone(t)); app.sheet = { ...more, id: t.id }; return app.sheetTask; };

test('ticking a parent leaves its subtasks as they are', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  const t = app.row(parent);
  await app.toggleDone(t, ROW);
  assert.deepEqual(ticks(v), [[10, { done: true }]]);
  assert.deepEqual([11, 14].map(id => v.task(id).done), [false, false], 'its open subtasks stay open');
  assert.deepEqual([app.leaving, app.said], [{ 10: 'done' }, 'Done: Pack the van']);
});

test('completing a parent with close closes its open subtasks, and undo opens exactly those again', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  const t = app.row(parent);
  await app.toggleDone(t, ROW, { close: true });
  await app.saveTask(10, null, () => null);                                  // the parent's progress write, after the subtasks
  assert.deepEqual(patches(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }], [10, { percent_done: 0.75 }]], 'the parent\'s progress is 75%, three of four subtasks done');
  assert.equal(t.done, true);
  assert.equal(app.said, 'Closed Pack the van + 2 subtasks', 'a screen reader announces the close');
  assert.deepEqual(app.toasts, [], 'no toast appears, because the row shows the change');
  assert.deepEqual(app.leaving, { 10: 'done', 11: 'done', 14: 'done' }, 'the parent and the closed subtasks stay in place, marked done, until the batch clears');
  assert.equal(v.task(13).done, false, 'a repeating subtask is left alone');
  assert.deepEqual(t.related_tasks.subtask.map(s => app.subRow(s).done), [true, true, false, true], 'the ring counts them as done, from their own rows');

  v.requests.length = 0;
  await app.unmark(10);
  await app.saveTask(10, null, () => null);
  assert.deepEqual(app.leaving, {}, 'no row is marked any more');
  assert.deepEqual(ticks(v), [[10, { done: false }], [11, { done: false }], [14, { done: false }]]);
  assert.equal(v.task(12).done, true, 'the subtask that was done before stays done');
  assert.equal(t.done, false);
  assert.deepEqual([v.task(10).percent_done, v.task(14).percent_done], [0.38, 0.5], 'the parent\'s progress is calculated again, and the subtask\'s progress is unchanged');
  assert.deepEqual(t.related_tasks.subtask.map(s => app.subRow(s).done), [false, true, false, false]);
});

test('when the batch clears, a parent completed on Today leaves with the subtasks closed with it', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [10, 11, 13, 14].map(id => app.row(v.task(id))) }];
  await app.toggleDone(app.tasks[10], ROW, { close: true });
  assert.equal(app.view.groups[0].tasks.length, 4, 'the rows are still in place');
  c.mock.timers.tick(2999);
  assert.equal(app.view.groups[0].tasks.length, 4, 'the batch does not clear before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [13], 'the rows leave together, and the repeating subtask stays');
  assert.deepEqual(app.leaving, {});
});

test('a subtask that fails to close stops the rest, and the row shows a message', async c => {
  const two = [sub(11), sub(14)], parent = { id: 10, title: 'Pack the van', done: false, related_tasks: { subtask: two } };
  const v = fakeVikunja([parent, ...two]), app = listed(c);
  v.trouble = r => r.method === 'PATCH' && r.path === '/tasks/11' ? 403 : null;
  await app.toggleDone(app.row(parent), ROW, { close: true });
  assert.equal(v.task(10).done, true);
  assert.equal(v.task(14).done, false, 'closing stopped at the first subtask that failed');
  assert.deepEqual([app.toast.msg, app.toast.row.id, app.toast.cls], ['Done: Pack the van — its 2 subtasks couldn\'t be closed', 10, 'failed']);
});

/* A tick that is not saved shows a message with Try again. In a list the message replaces the row for a few seconds,
   then the row returns to be ticked again. A task's own sheet has no row to give back, so the message appears at the
   top of the sheet and stays, with no timer, until the user tries again or the tick is saved. The test uses the real
   lines.js. */
test('a tick that fails in its own sheet shows a message with Try again at the top, until the tick is saved', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Wipe the menus', done: false }]), app = component(tasks, actions, lines);
  document.querySelectorAll = () => [];
  c.after(() => { delete document.querySelectorAll; });
  app.lines = {}; opened(app, v.task(1), { open: true, show: true, kind: 'task', lines: {} });
  v.trouble = () => 'offline';
  await app.toggleDone(app.sheetTask, null, { sheet: true });
  assert.deepEqual([app.sheetTask.done, app.sheet.lines.top.text, app.sheet.lines.top.action.label], [false, 'Not saved: no connection', 'Try again']);
  c.mock.timers.tick(60000);
  assert.ok(app.sheet.lines.top, 'the message is still there a minute later, because the sheet has no row to give back');
  v.trouble = () => null;
  await app.toggleDone(app.sheetTask, null, { sheet: true });
  assert.deepEqual([v.task(1).done, app.sheet.lines.top], [true, undefined], 'ticking again and saving removes the message');
});

test('completing a parent from its sheet closes its subtasks, shows a message under them, and Undo opens them again', async () => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = component(tasks, actions);
  opened(app, parent);
  await app.toggleDone(app.sheetTask, null, { sheet: true, close: true });
  assert.deepEqual(ticks(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }]]);
  assert.deepEqual([app.toast.msg, app.toast.place], ['Closed Pack the van + 2 subtasks', 'sheet:subtasks']);
  assert.deepEqual(app.sheetTask.related_tasks.subtask.map(s => app.subRow(s).done), [true, true, false, true], 'the sheet shows the subtasks as done');
  assert.equal(app.sheet.dirty, true, 'the list is read again once the sheet closes');
  await app.toast.action.fn();
  assert.deepEqual([10, 11, 12, 14].map(id => v.task(id).done), [false, false, true, false]);
  assert.deepEqual(app.sheetTask.related_tasks.subtask.map(s => app.subRow(s).done), [false, true, false, false]);
  // A task with no subtasks shows no message, because the tick itself shows the change. Ticking it again opens it.
  const n = app.toasts.length;
  opened(app, v.task(12));
  await app.sheetDone();
  assert.equal(v.task(12).done, false);
  assert.equal(app.toasts.length, n);
});

test('ticking a done parent that is above open subtasks on a project\'s list opens it again in place', async c => {
  const v = fakeVikunja([{ id: 10, title: 'Pack the van', done: true, related_tasks: { subtask: [sub(11)] } }, sub(11)]), app = listed(c);
  const head = app.row(v.task(10)), kid = app.row(v.task(11));
  app.route = { name: 'project', id: 1 };
  app.view.groups = [{ key: 'open', tasks: [kid, head], heads: [10] }, { key: 'done', loaded: false, count: 3, tasks: [] }];
  assert.equal(app.isHead(head), true);
  await app.toggleDone(head, ROW);
  assert.equal(v.task(10).done, false);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [11, 10], 'the parent is still on the open list');
  assert.equal(app.view.groups[1].count, 2, 'the Done count no longer includes it');
  assert.deepEqual([app.leaving[10], app.said], ['open', 'Not done: Pack the van'], 'the row shows it open, in place');
  assert.equal(v.task(11).done, false, 'the subtask is unchanged');
  await app.unmark(10);
  assert.equal(v.task(10).done, true, 'tapping the tick again makes the parent done again');
  assert.equal(v.task(11).done, false, 'the subtask is still open');
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [11, 10], 'the parent stays when the batch clears');
});
test('a parent completed on a project\'s list stays above its open repeating subtask, marked done', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  Object.assign(app, { route: { name: 'project', id: 1 }, bothWays: true });
  const t = app.row(parent), kids = [11, 13, 14].map(id => app.row({ ...v.task(id), related_tasks: { parenttask: [{ id: 10 }] } }));
  app.view.groups = [{ key: 'open', tasks: [t, ...kids] }, { key: 'done', loaded: false, count: 1, tasks: [] }];
  await app.toggleDone(t, ROW, { close: true });
  assert.deepEqual(app.view.groups[0].heads, [10], 'the parent is a head above the repeating subtask');
  assert.equal(app.view.groups[1].count, 2, 'the Done count includes the closed tasks');
  assert.deepEqual(app.leaving, { 10: 'done', 11: 'done', 14: 'done' });
  await app.unmark(10);
  assert.deepEqual([10, 11, 14].map(id => v.task(id).done), [false, false, false], 'tapping the tick again opens all three tasks');
  assert.equal(app.view.groups[1].count, 1);
  // Complete it again and let the batch clear. The parent stays, over the repeating subtask, and the closed tasks move to Done.
  await app.toggleDone(t, ROW, { close: true });
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [10, 13]);
  assert.equal(app.view.groups[1].count, 4, 'the Done count includes the parent and the two subtasks closed with it');
});

test('a tick that is not saved goes back, and the row shows why with Try again', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Call Jo', done: false }]), app = listed(c);
  v.trouble = () => 'offline';
  const t = app.row(v.task(1));
  await app.toggleDone(t, ROW);
  assert.deepEqual(app.leaving, {}, 'the row is not marked and stays as it was');
  assert.equal(t.done, false);
  assert.equal(app.toast.msg, 'Not saved: no connection');
  assert.deepEqual([app.toast.row.id, app.toast.row.stays, app.toast.cls], [1, true, 'failed'], 'the message is on the task\'s row, which stays');
  assert.equal(app.toast.action.label, 'Try again');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).done, true, 'Try again ticks it');
});

test('a repeating task whose tick lost its reply is ticked once, not twice', async c => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const v = fakeVikunja([{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]), app = listed(c);
  app.change(w => w.put([structuredClone(v.task(1))], TASK));
  v.trouble = r => r.method === 'PATCH' ? 'lost' : null;
  const t = app.row(v.task(1));
  await app.toggleDone(t, ROW);
  assert.equal(patches(v).length, 1, 'the tick is not sent again, because Vikunja\'s copy, read afterwards, shows the task moved on');
  assert.equal(Date.parse(v.task(1).due_date) - Date.parse(due), DAY * 1000);
  assert.deepEqual([t.done, t.due_date, app.leaving[1]], [true, due, 'done'], 'the row shows the task done, with its old date, until the batch clears');
  assert.match(app.said, /^Done: Water the plants\. It repeats, next /);
  // Tapping its tick before the batch clears restores its date.
  v.trouble = () => null;
  await app.unmark(1);
  assert.deepEqual([v.task(1).due_date, t.due_date, t.done], [due, due, false]);
});

test('a repeating task ticked in a list returns open with its next date once the batch clears', async c => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const v = fakeVikunja([{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1))] }];
  await app.toggleDone(app.tasks[1], ROW);
  await app.clearBatch(true);
  const t = app.view.groups[0].tasks[0];
  assert.deepEqual([t?.done, t?.due_date], [false, v.task(1).due_date], 'the task is still on the list');
  assert.equal(Date.parse(t.due_date) - Date.parse(due), DAY * 1000);
  // A task whose next date is past what Today shows leaves Today.
  v.task(1).repeat_after = 30 * DAY;
  app.tasks[1].repeat_after = 30 * DAY;
  await app.toggleDone(app.tasks[1], ROW);
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks, []);
});

test('setting progress to 100% marks the task done, and tapping its tick restores the earlier progress', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]), app = listed(c);
  const t = app.row(v.task(1));
  await app.setProgress(t, 100, ROW);
  assert.deepEqual(patches(v), [[1, { done: true }]], 'the progress value is left as it was');
  assert.equal(v.task(1).done, true);
  await app.unmark(1);
  assert.deepEqual(patches(v).at(-1), [1, { done: false, percent_done: 0.4 }]);
  // The sheet (its row or its Progress line) behaves the same. The tick shows it, and ticking again restores the progress.
  const n = app.toasts.length;
  opened(app, v.task(1));
  await app.sheetProgress(app.sheetTask, 100);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done, app.toasts.length], [true, 0.4, n]);
  await app.sheetDone();
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.4]);
});

/* A full swipe right marks the task done and looks the same as a tick. The row finishes its swipe off the screen, then
   shows as done in its place, never as a gap, with the same mark as a tick. Tapping its tick undoes it. The row
   leaves the list when the batch clears. In a sheet, a subtask's row stays in place as done, with nothing marked. */
test('a full swipe marks the task done like a tick, in place and never as a gap, and tapping its tick undoes it', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 }, { id: 2, title: 'Sand it', done: false }]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
  await app.setProgress(app.tasks[1], 100, ROW);
  assert.deepEqual([app.leaving, app.isGap(app.tasks[1], { depth: {} }), v.task(1).done], [{ 1: 'done' }, false, true]);
  await app.unmark(1);
  assert.deepEqual(app.leaving, {});
  assert.deepEqual(patches(v).at(-1), [1, { done: false, percent_done: 0.5 }], 'tapping the tick opens the task again at the progress it had');
  await app.setProgress(app.tasks[1], 100, ROW);
  await app.toggleDone(app.tasks[2], ROW);
  assert.deepEqual(app.leaving, { 1: 'done', 2: 'done' }, 'a swiped row and a ticked row are marked the same way');
  await app.clearBatch(true);
  assert.deepEqual([app.view.groups[0].tasks, app.leaving], [[], {}], 'both rows leave with the batch');
  // A subtask in its parent's sheet is done where it is, with nothing marked. The sheet's subtask rows are their own.
  v.tasks.set(3, { id: 3, title: 'Prime it', done: false });
  v.tasks.set(4, { id: 4, title: 'Paint the shed', related_tasks: { subtask: [{ id: 3 }] } });
  opened(app, { id: 4, title: 'Paint the shed', related_tasks: { subtask: [{ id: 3, title: 'Prime it', done: false }] } });
  app.subRows(app.sheetTask);
  await app.setProgress(app.subRow(app.sheetTask.related_tasks.subtask[0]), 100, null, { sub: true });
  assert.deepEqual([app.leaving, app.subRow(app.sheetTask.related_tasks.subtask[0]).done, app.sheetTask.related_tasks.subtask[0].done, v.task(3).done], [{}, true, false, true],
    'the subtask\'s row is done, and the parent\'s list of its subtasks is left as Vikunja gave it');
});

/* A row shows as done in place from the moment the user ticks it or releases the swipe, not from when Vikunja answers
   (toggleDone's holdRow). The mark replaces that once the save is made. Tapping its tick in the meantime waits for
   the answer and then undoes it. If the save fails, the row is released and shows a message with Try again. A
   deletion's gap is held the same way (gapNow) until the deletion is queued to send. */
test('a swiped row is held done before Vikunja answers, and a tick tapped meanwhile undoes it after the answer', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 }, { id: 2, title: 'Sand it', done: false }]), app = listed(c), send = globalThis.fetch;
  // Vikunja's answers are held back until `answer()` is called.
  let held = [];
  const answer = () => { const go = held; held = null; go.forEach(ok => ok()); }, turn = () => new Promise(ok => setImmediate(ok));
  globalThis.fetch = async (...a) => { if (held) await new Promise(ok => held.push(ok)); return send(...a); };
  document.querySelectorAll = () => [];                                       // no rows to slide back in
  try {
    app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
    let setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual([app.leaving, app.tasks[1].done, v.task(1).done], [{ 1: 'done' }, true, false], 'the row is held done from the moment of release, before Vikunja has answered');
    const tapped = app.unmark(1);
    await turn();
    assert.deepEqual([app.leaving, patches(v)], [{ 1: 'done' }, []], 'tapping the tick sends nothing until Vikunja answers');
    answer();
    await setting; await tapped;
    assert.deepEqual(app.leaving, {}, 'after the answer the tap undoes the mark');
    assert.deepEqual([v.task(1).done, v.task(1).percent_done, patches(v).length], [false, 0.5, 2], 'the task is open again at the progress it had');
    // If the save fails, the row is released and shows a message.
    v.trouble = () => 500;
    setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual(app.leaving, { 1: 'done' });
    await setting; await turn();
    assert.deepEqual([app.leaving, app.tasks[1].done], [{}, false], 'the row is released and the task is not done');
    assert.match(app.toast.msg, /^Not saved: /);
    assert.deepEqual([app.toast.row.id, app.toast.action.label], [1, 'Try again']);
    v.trouble = () => null; app.rowEl = () => ROW;                             // the row is on screen
    await app.toast.action.fn();
    assert.deepEqual([app.leaving, v.task(1).done], [{ 1: 'done' }, true], 'Try again marks the task done, in its place');
    // A tapped tick is held the same way. Tapping it again before the answer undoes it once the answer arrives.
    await app.unmark(1);
    held = [];
    const ticking = app.toggleDone(app.tasks[1], ROW), again = app.unmark(1);
    assert.deepEqual([app.leaving, typeof again.then], [{ 1: 'done' }, 'function']);
    answer();
    await ticking; await again;
    assert.deepEqual([app.leaving, v.task(1).done, app.tasks[1].done], [{}, false, false], 'ticking twice leaves the task open and nothing marked');
    // A deletion shows "Deleted" and Restore at once. If the user cancels (the confirmation is answered no), the row comes back.
    let said = null;
    const asked = new Promise(ok => { said = ok; });
    app.gapNow(2, asked);
    assert.deepEqual(app.leaving[2], 'deleted');
    said(false);
    await asked; await turn();
    assert.equal(app.leaving[2], undefined, 'cancelling the deletion leaves no gap');
  } finally { globalThis.fetch = send; delete document.querySelectorAll; }
});

test('progress below 100% is saved as it is, and a failed save goes back and shows a message on the row', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]), app = component(tasks, actions);
  const t = app.row(v.task(1));
  await app.setProgress(t, 70, null);
  assert.equal(v.task(1).percent_done, 0.7);
  assert.deepEqual(app.toasts, [], 'no message appears, because sliding the progress back is the undo');
  assert.equal(app.said, 'Progress of Paint the fence set to 70%', 'a screen reader announces the progress');

  v.trouble = () => 500;
  await app.setProgress(t, 90, null);
  assert.equal(t.percent_done, 0.7);
  assert.match(app.toast.msg, /^Not saved: /);
  assert.equal(app.toast.row.id, 1);
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).percent_done, 0.9, 'Try again sets it');
});

/* Swiping a done row left opens it again at the progress where the user releases the swipe, the same as its tick
   would, in one save. Ticking it again makes it done. The sheet's row and Progress line behave the same. */
test('swiping a done task down opens it again at that progress in one save', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: true, percent_done: 0.4 }]), app = listed(c);
  const t = app.row(v.task(1));
  await app.setProgress(t, 75, ROW);
  assert.deepEqual(patches(v), [[1, { done: false, percent_done: 0.75 }]]);
  assert.deepEqual([t.done, v.task(1).done, v.task(1).percent_done], [false, false, 0.75]);
  await app.toggleDone(t, null);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [true, 0.75], 'ticking again makes the task done and keeps its progress');
  opened(app, v.task(1));
  await app.sheetProgress(app.sheetTask, 50);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.5], 'the sheet\'s progress bar behaves the same way');
});

test('saves to a task go one after another, in the order they were made', async () => {
  const v = fakeVikunja([{ id: 1, title: 'A', done: false }]), app = component(tasks, actions);
  const order = [], fetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { order.push('sent ' + o.body); await new Promise(r => setTimeout(r, 20)); const res = await fetch(url, o); order.push('back ' + o.body); return res; };
  await Promise.all([app.saveTask(1, { title: 'B' }), app.saveTask(1, { title: 'C' })]);
  assert.deepEqual(order, ['sent {"title":"B"}', 'back {"title":"B"}', 'sent {"title":"C"}', 'back {"title":"C"}']);
  assert.equal(v.task(1).title, 'C');
  assert.equal(copyOf(1).title, 'C', 'Vikunja\'s copy is its latest');
});

test('deleting a task and its subtasks skips one already deleted, and stops at a refusal after counting what was deleted', async () => {
  const v = fakeVikunja([{ id: 1, title: 'A' }, { id: 3, title: 'C' }]), app = component(tasks, actions);
  for (const id of [1, 2, 3]) app.row({ id, title: String(id) });
  app.view.groups = [{ key: 'today', tasks: [app.tasks[1], app.tasks[2], app.tasks[3]] }];
  v.trouble = r => r.path === '/tasks/3' ? 403 : null;
  await assert.rejects(app.deleteTree([1, 2, 3]), e => e.deleted === 2);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [3], 'the deleted tasks have left the list');
  assert.ok(!app.tasks[1] && !app.tasks[2] && app.tasks[3]);
});

test('Move all to today moves each overdue task to today at its time, or with no time if that time has passed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
    { id: 3, title: 'Repeats', due_date: at(6, 8), repeat_after: DAY },
  ]);
  const app = component(tasks, actions, cards);
  app.view.groups = [{ key: 'overdue', tasks: [1, 2, 3].map(id => app.row(v.task(id))) }];
  assert.equal(app.overdueMovable, true);
  await app.moveOverdueToToday();
  assert.equal(v.task(1).due_date, at(7, 0), 'a time that has passed today becomes today with no time');
  assert.equal(v.task(2).due_date, at(7, 18, 30));
  assert.equal(v.task(3).due_date, at(6, 8), 'a repeating task stays where it is');
  assert.equal(app.toasts.at(-1).msg, 'Moved 2 to today. 1 repeating task stays. Tick it to move it to its next date.');
  assert.equal(app.toast.place, 'overdue', 'the message appears under the Overdue heading');
  await app.toast.action.fn();
  assert.equal(v.task(1).due_date, at(5, 9));
  assert.equal(v.task(2).due_date, at(6, 18, 30));
});

test('ticking a subtask or setting its progress shows only on its row, with no message, and the row stays in place', async () => {
  const kid = { id: 2, title: 'Pack the cups', done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } };
  const v = fakeVikunja([kid]), app = component(tasks, actions), t = app.row(kid);
  await app.setProgress(t, 50, null);
  assert.equal(v.task(2).percent_done, 0.5);
  await app.toggleDone(t, null);
  assert.equal(v.task(2).done, true);
  await app.toggleDone(t, null);
  assert.equal(v.task(2).done, false);
  assert.deepEqual(app.toasts, [], 'no messages');
  // In its parent's sheet, the subtask's copy has no parent set, so `sub: true` tells the action it is a subtask.
  const inSheet = { id: 3, title: 'Wash them', done: false };
  v.tasks.set(3, structuredClone(inSheet));
  await app.toggleDone(inSheet, null, { sub: true });
  assert.deepEqual(app.toasts, []);
});

/* A parent's calculated progress is written right after one of its subtasks changes, by the same action, and only
   when the progress changes. */
test('ticking a subtask or setting its progress writes its parent\'s calculated progress right after, if it changed', async () => {
  const kid = id => ({ id, title: 'Step ' + id, done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } });
  const v = fakeVikunja([{ id: 1, title: 'Open up', percent_done: 0, related_tasks: { subtask: [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] } }, kid(2), kid(3), kid(4), kid(5)]);
  const app = component(tasks, actions), t = app.row(v.task(2));
  await app.setProgress(t, 50, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { percent_done: 0.5 }], [1, { percent_done: 0.13 }]], 'one subtask at 50% of four gives 13%, written after the subtask\'s own save');
  v.requests.length = 0;
  await app.toggleDone(t, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { done: true }], [1, { percent_done: 0.25 }]], 'a done subtask counts as 100%');
  v.requests.length = 0;
  await app.setProgress(app.row(v.task(3)), 0, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[3, { percent_done: 0 }]], 'an unchanged parent progress is not written');
  // In its parent's sheet, the subtask's copy names no parent, so the sheet's task is its parent.
  v.requests.length = 0;
  opened(app, { id: 1, related_tasks: { subtask: [{ id: 4, title: 'Step 4', done: false }] } });
  await app.toggleDone(app.sheetTask.related_tasks.subtask[0], null, { sub: true });
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[4, { done: true }], [1, { percent_done: 0.5 }]]);
});

// In a subtask's own sheet, setting progress by swiping its row or tapping a quarter in Details also writes the
// parent's progress.
test('setting a subtask\'s progress in its own sheet writes its parent\'s progress right after', async () => {
  const kid = id => ({ id, title: 'Step ' + id, done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } });
  const v = fakeVikunja([{ id: 1, title: 'Open up', percent_done: 0, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }, kid(2), kid(3)]);
  const app = component(tasks, actions, sheet);
  Object.assign(app, { keepTemplate(){}, rowTitle: t => t.title, unsay(){} });
  opened(app, v.task(2));
  await app.sheetProgress(app.sheetTask, 50);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { percent_done: 0.5 }], [1, { percent_done: 0.25 }]]);
});

test('a change to a checklist step goes through the outbox, and the same entry writes the checklist\'s progress last', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Opening', percent_done: 0, related_tasks: { subtask: [{ id: 2, done: true }, { id: 3, percent_done: 0.5 }] } }, { id: 2, done: true }, { id: 3, percent_done: 0.5 }]);
  const app = component(tasks, actions), send = a => figure(a, stageContext(a, app).start()), entry = () => ({ id: uuid7(), op: 'done', task: 2, run: 1, stage: 3 });
  for (const op of ['progress', 'done', 'skip', 'undone', 'doneNote']) assert.equal(OPS[op].stages.at(-1), figure, op + ': the progress write is the last part');
  await send({ id: uuid7(), op: 'finish', task: 1, run: 1, stage: 2 });
  assert.equal(v.requests.length, 0, 'a finished checklist has no progress to calculate');
  const a = entry();
  await send(a);
  assert.deepEqual(patches(v), [[1, { percent_done: 0.75 }]], 'one step done and one at 50% give 75%');
  await send(a);
  assert.equal(patches(v).length, 1, 'the same entry sent again sends the same body with the same key, and the relay answers it');
  await send(entry());
  assert.equal(patches(v).length, 1, 'a new entry finds the progress already right, so nothing is written');
});

// The parts needed to send a deletion are what is waiting and the outbox's acts (runs.js), on the fake component.
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The test controls the timers, so timers that have not fired yet (the Undo's, for example) don't keep Node waiting.
const deleting = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, pick(sending.default ?? sending, 'refreshPending', 'keyWaiting', 'markSlow', 'sendEntry'),
    pick(acts, 'sendActs', 'sendAct', 'wordsBack', 'giveBack'), pick(outbox, 'actTitle'), pick(runs, 'refreshRunTask'));
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], slow: [], canWrite: () => true, flushing: false, cap: {}, sheet: { id: null, sub: {} } });
  Object.defineProperty(app, 'syncState', Object.getOwnPropertyDescriptor(outbox, 'syncState'));
  globalThis.confirm = () => true;
  return app;
};
const deletes = v => v.requests.filter(r => r.method === 'DELETE').map(r => +r.path.split('/')[2]);
// The tasks that a waiting delete deletes, so their rows are hidden.
const going = (app, ids) => ids.filter(id => app.beingDeleted(id));

test('deleting a subtask writes its parent\'s calculated progress in the same entry, once the deletion is sent', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', percent_done: 0.5, related_tasks: { subtask: [{ id: 2 }, { id: 3, done: true }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }, { id: 3, title: 'Pack the plates', done: true, related_tasks: { parenttask: [{ id: 1 }] } }]);
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

test('a subtask\'s deletion whose parent is already gone writes no progress, and is not an error', async () => {
  const v = fakeVikunja([{ id: 2, title: 'Pack the cups' }]), app = component(tasks, actions);
  const a = { id: uuid7(), op: 'delete', task: 2, ids: [2], up: 1, stage: 1 };
  await figure(a, stageContext(a, app).start());
  assert.deepEqual(v.requests.map(r => r.method + ' ' + r.path), ['GET /tasks/1'], 'the parent is read, answers 404, and nothing is patched');
});

/* Deleting a task with subtasks asks for confirmation first. askDelete reads which tasks go with it and asks on its
   own, so a row swiped to delete asks before it slides away (swipeDelete, app/progress.js). The deletion that follows
   does not ask again. */
test('deleting a task with subtasks asks first with the count, and answering no sends nothing', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 4 }] } },
    { id: 3, title: 'Pack the plates', related_tasks: { parenttask: [{ id: 1 }] } }, { id: 4, title: 'Wrap them', related_tasks: { parenttask: [{ id: 2 }] } }, { id: 5, title: 'Lock up' }]);
  const app = deleting(t), asked = [];
  let yes = false;
  globalThis.confirm = q => { asked.push(q); return yes; };
  for (const id of [1, 3, 5]) app.row(v.task(id));
  assert.deepEqual([1, 3, 5].map(id => app.hasSubtasks(app.tasks[id])), [true, false, false], 'the phone knows which tasks have subtasks');
  assert.equal(app.hasSubtasks({ id: 1 }), true, 'the copy on screen also shows the subtasks');
  assert.equal(await app.askDelete(app.tasks[1]), null, 'answering no returns nothing');
  assert.deepEqual(asked, ['Delete “Pack the van” and its 2 subtasks, 1 more under them?']);
  assert.equal(await app.holdDelete(app.tasks[1]), null);
  assert.deepEqual([sync.all(1).length, going(app, [1, 2, 3, 4]), deletes(v)], [0, [], []], 'nothing is queued to send and nothing leaves the list');
  yes = true; asked.length = 0;
  const tree = await app.askDelete(app.tasks[1]);
  assert.deepEqual([tree, asked.length], [[4, 2, 3, 1], 1], 'every level of subtasks is included, deepest first');
  const d = await app.holdDelete(app.tasks[1], null, tree);
  assert.deepEqual([d.n, asked.length, sync.all(1)[0].ids], [3, 1, [4, 2, 3, 1]], 'a deletion already asked about does not ask again');
  await app.undoDelete(d.id);
  asked.length = 0;
  assert.deepEqual([await app.askDelete(app.tasks[5]), asked], [[5], []], 'a task with no subtasks is not asked about');
});

test('a deletion leaves the list at once and waits for its Undo, and Undo brings the task back', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  assert.equal(d.n, 1, 'the deletion includes the subtask');
  assert.deepEqual(going(app, [1, 2]), [1, 2], 'both tasks leave the list');
  assert.deepEqual(deletes(v), [], 'nothing is sent while Undo shows');
  assert.equal(app.pending.length, 0, 'the deletion is not shown as waiting to send');
  await app.undoDelete(d.id);
  assert.deepEqual(going(app, [1, 2]), [], 'both tasks are back on the list');
  await app.sendHeld();                                                       // the app goes to the background, with nothing left to send
  assert.deepEqual(deletes(v), []);
  assert.equal(sync.all(1).length, 0);
});

test('a deletion is sent deepest first once its Undo has gone, and the rows are dropped', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1)), app.row(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[1]);
  await app.sendHeld(d.id);
  assert.deepEqual(deletes(v), [2, 1]);
  assert.deepEqual(app.view.groups[0].tasks, []);
  assert.deepEqual(app.opsOn, {});
  assert.equal(sync.all(1).length, 0, 'nothing is left waiting');
  await app.undoDelete(d.id);                                                 // too late for Undo, so nothing happens
  assert.deepEqual(deletes(v), [2, 1]);
});

test('a deletion made offline waits in the outbox, off the list, and is sent once there is a connection', async t => {
  const v = fakeVikunja([{ id: 5, title: 'Call Jo' }]), app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(5))] }];
  await app.holdDelete(app.tasks[5]);
  v.trouble = r => r.method === 'DELETE' ? 'offline' : null;
  await app.sendHeld();                                                       // the app goes to the background while offline
  assert.deepEqual(going(app, [5]), [5], 'the task is still off the list');
  assert.equal(app.pending.length, 1, 'the deletion is shown as waiting to send');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.ok(!v.task(5), 'deleted in Vikunja');
  assert.deepEqual(app.opsOn, {});
});

test('a deletion that Vikunja refuses brings the row back and keeps the deletion to try again', async t => {
  const v = fakeVikunja([{ id: 6, title: 'Order cups' }]), app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(6))] }];
  const d = await app.holdDelete(app.tasks[6]);
  v.trouble = r => r.method === 'DELETE' ? 403 : null;
  await app.sendHeld(d.id);
  assert.deepEqual(going(app, [6]), [], 'the row is back on the list');
  assert.equal(app.failed.length, 1);
  assert.match(app.toast.msg, /^Deleting “Order cups” couldn't be saved/);
  await sync.remove(app.failed[0].id);
});

test('the sync state is waiting while an Undo shows or offline, sending while sending, and idle when done', async t => {
  const v = fakeVikunja([{ id: 7, title: 'Wipe the till' }, { id: 8, title: 'Sweep up' }]), app = deleting(t), seen = [];
  app.refreshPending();
  assert.equal(app.syncState, 'idle');
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(7)), app.row(v.task(8))] }];
  const d = await app.holdDelete(app.tasks[7]);
  assert.equal(app.syncState, 'waiting', 'the state is waiting while the deletion is held for its Undo');
  v.trouble = r => { if (r.method === 'DELETE') seen.push(app.syncState); return null; };
  await app.sendHeld(d.id);
  assert.deepEqual(seen, ['sending']);
  assert.equal(app.syncState, 'idle', 'the state is idle once everything is sent');
  await app.holdDelete(app.tasks[8]);
  v.trouble = r => r.method === 'DELETE' ? 'offline' : null;
  await app.sendHeld();
  assert.equal(app.syncState, 'waiting', 'the state is waiting while offline');
  v.trouble = () => null;
  await app.sendActs(app.pending[0].id);
  assert.equal(app.syncState, 'idle');
});

/* Holding a row or card on Today and moving it to a new date (app/throw.js). Move all to today does the same one task
   at a time. Each move has an Undo for a few seconds that restores the date and time the task had. There is no screen
   here. `seen` holds the tasks whose row is in sight once the task is in its new place (rowSeen). That decides where
   the message with the Undo appears, on the task's row or by the add box. */
const onToday = (c, list, cardsBy = {}) => {
  c?.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const v = fakeVikunja(list), app = component(tasks, actions, cards, alerts, sending), seen = new Set(list.map(t => t.id));
  const shown = id => app.listBase.some(g => g.tasks.some(t => t.id === id));       // whether the task is on one of Today's lists as drawn
  Object.assign(app, { setBadge(){}, lines: {}, positions: {}, route: { name: 'today' }, pending: [], flashed: {}, flash(ids, kind){ this.flashed[kind] = ids; },
    $nextTick: async () => {}, rowSeen: id => seen.has(id) && shown(id) });
  app.view = { groups: todayGroups(), cards: cardsBy };
  for (const t of list) app.row(v.task(t.id));
  return { v, app, seen, shown, at: (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(), key: id => app.todayKey(app.tasks[id]) };
};
const moveTo = (app, t, day, label) => app.reschedule(t, { label, due: day ? movedDue(t.due_date, day, new Date()) : ZERO });
const ZERO = '0001-01-01T00:00:00Z';
// The last message and where it appears: its text, its action's label, the id of the row it is on (or null) and the
// place it goes otherwise.
const said = app => { const s = app.toast; return [s.msg, s.action?.label ?? null, s.row?.id ?? null, s.place]; };

test('moving a row to a new date keeps its time of day, moves it at once, and shows an Undo on its row or by the add box', async c => {
  const { v, app, seen, shown, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() }, { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() },
    { id: 4, title: 'Fix the gate', due_date: new Date(2026, 9, 7, 17).toISOString(), created: new Date(2026, 8, 1).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1], app.tasks[4]); app.view.groups[0].tasks.push(app.tasks[2]); app.view.groups[3].tasks.push(app.tasks[3]);
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([app.tasks[1].due_date, key(1)], [at(9, 16), 'week'], 'the task moves on screen at once, before Vikunja answers');
  assert.equal(await going, true);
  assert.equal(v.task(1).due_date, at(9, 16), 'the task moves to Friday and keeps its time of day, 4 PM');
  assert.deepEqual(said(app), ['Moved to Fri 9', 'Undo', 1, 'cap'], 'the message with Undo appears on the row, in its new position');
  assert.equal(app.toast.row.stays, true, 'the row returns once the message goes');
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.deepEqual([v.task(2).due_date, key(2)], [at(7, 0), 'today'], 'an overdue task moves to today with no time, because its time has passed');
  assert.deepEqual(said(app), ['Moved to today', 'Undo', 2, 'cap']);
  await moveTo(app, app.tasks[3], new Date(), 'Today');
  assert.deepEqual([v.task(3).due_date, key(3)], [at(7, 0), 'today'], 'a task with no date moves to today with no time');
  seen.delete(3);
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  assert.deepEqual([key(3), said(app)], ['week', ['Moved to tomorrow', 'Undo', null, 'cap']], 'the task is still on Today but its row is scrolled out of sight, so the message appears by the add box');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 19), 'Mon 19');
  assert.deepEqual([v.task(1).due_date, key(1)], [at(19, 16), null], 'a date past the next 7 days takes the task off Today');
  assert.deepEqual(said(app), ['Moved to Mon 19', 'Undo', null, 'cap'], 'with no row left, the message appears by the add box');
  seen.add(3);
  await moveTo(app, app.tasks[3], null, null);
  assert.deepEqual([v.task(3).due_date, key(3)], [ZERO, 'nodate'], 'removing the date puts a task created today under Added today, no date');
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', 3, 'cap']);
  await moveTo(app, app.tasks[4], null, null);
  assert.equal(v.task(4).due_date, ZERO);
  assert.equal(shown(4), false, 'a task created before today with no date is off Today');
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', null, 'cap']);
});

test('every date changed by a hold has an Undo that restores the date and time the task had', async c => {
  const { v, app, shown, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString(), created: new Date(2026, 8, 1).toISOString() },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() }, { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]); app.view.groups[0].tasks.push(app.tasks[2]); app.view.groups[3].tasks.push(app.tasks[3]);
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1), app.flashed.arrived], [at(7, 16), 'today', [1]], 'the task is back today at 4 PM and highlighted where it was');
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.equal(v.task(2).due_date, at(7, 0), 'a time that has passed becomes today with no time');
  await app.toast.action.fn();
  assert.deepEqual([v.task(2).due_date, key(2)], [at(6, 9), 'overdue'], 'Undo makes the task overdue again at its old time');
  await moveTo(app, app.tasks[1], null, null);
  assert.deepEqual([v.task(1).due_date, shown(1)], [ZERO, false], 'No date takes the task off Today');
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'Undo restores the date and time, and the task is back on Today');
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  await app.toast.action.fn();
  assert.deepEqual([v.task(3).due_date, key(3)], [ZERO, 'nodate'], 'a task that had no date has none again');
  // Tapping Undo before Vikunja answers the move makes Undo wait for the answer, then restore the date.
  const real = globalThis.fetch;
  let answer;
  const held = new Promise(r => { answer = r; });
  globalThis.fetch = async (...a) => { await held; return real(...a); };
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await new Promise(setImmediate);
  assert.deepEqual(said(app), ['Moved to tomorrow', 'Undo', 1, 'cap'], 'the message appears before the move is saved');
  const undone = app.toast.action.fn();
  answer(); globalThis.fetch = real;
  assert.equal(await going, true);
  await undone;
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'the task is moved and then moved back');
  // If the task changed elsewhere since the move, Undo leaves it as it is and shows a message.
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  const undo = app.toast.action;
  v.task(1).updated = new Date(2026, 9, 7, 14, 30).toISOString();
  await undo.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(9, 16), 'week'], 'Undo does not overwrite the newer change');
  assert.deepEqual([app.toast.msg, app.toast.place, app.toast.cls], ['1 task couldn\'t be moved back (changed since, or not saved) and is still due Fri 9.', 'cap', 'failed']);
});

test('a move that is not saved goes back and shows a message with Try again, and its Undo then does nothing', async c => {
  const { v, app, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  v.trouble = () => 'offline';
  assert.equal(await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9'), false);
  assert.deepEqual([app.tasks[1].due_date, key(1)], [at(7, 16), 'today'], 'the task is back where it was');
  assert.deepEqual([app.toast.msg, app.toast.action.label, app.toast.cls], ['Not saved: no connection', 'Try again', 'failed']);
  const sent = v.requests.length;
  await app.toasts.at(-2).action.fn();
  assert.deepEqual([app.toasts.at(-2).msg, v.requests.length], ['Moved to Fri 9', sent], 'the Undo from the move has nothing to restore');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(9, 16), 'week'], 'Try again moves the task');
});

test('moving a card changes only its task\'s date, and a card with a sooner subtask stays and says why', async c => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const sub = (id, due) => ({ id, title: 'Sub ' + id, done: false, due_date: due, related_tasks: { parenttask: [{ id: id - 1 }] } });
  const { v, app, key } = onToday(c, [
    { id: 10, title: 'Paint the hall', due_date: at(7, 17), related_tasks: { subtask: [{ id: 11 }] } }, sub(11, ZERO),
    { id: 20, title: 'Fix the van', due_date: ZERO, related_tasks: { subtask: [{ id: 21 }] } }, sub(21, at(7, 18)),
  ], { 10: { when: at(7, 17), made: null, focus: null }, 20: { when: at(7, 18), made: null, focus: null } });
  app.view.groups[1].tasks.push(app.tasks[10], app.tasks[20]);
  await moveTo(app, app.tasks[10], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)], [at(9, 17), ZERO, at(9, 17), 'week'], 'only the task\'s date changes, and the card moves with it');
  assert.deepEqual(said(app), ['Moved to Fri 9', 'Undo', 10, 'cap']);
  await app.toast.action.fn();
  assert.deepEqual([v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)], [at(7, 17), ZERO, at(7, 17), 'today'], 'Undo puts the card back where it was');
  await moveTo(app, app.tasks[20], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([v.task(20).due_date, v.task(21).due_date, key(20)], [at(9, 0), at(7, 18), 'today'], 'the task moves to Friday with no time, and its subtask due today keeps it under Today');
  assert.deepEqual(said(app), ['Moved to Fri 9. Its subtask “Sub 21” is due sooner, so it stays here.', 'Undo', null, 'cap'], 'the message with Undo appears by the add box, where the whole sentence fits');
  await app.toast.action.fn();
  assert.deepEqual([v.task(20).due_date, v.task(21).due_date, key(20)], [ZERO, at(7, 18), 'today'], 'Undo removes the task\'s date again and leaves the subtask\'s date as it was');
});

/* A title being edited, in the box in the sheet's own row or in a template's box over its card, is saved when the box
   loses focus. A sheet that is slid down or closed with the phone's Back doesn't take focus from the box, and on an
   iPhone there is no button to move the focus to. So leaving the sheet saves the title too, once, whichever happens
   first. */
test('a title being edited is saved once when its sheet closes, however it closes, and an empty title is not saved', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Wipe the menus', project_id: 1 }, { id: 2, title: 'TEMPLATE: Opening', project_id: 1, done: true, labels: [{ id: 9, title: 'template' }] },
    { id: 3, title: 'Order cups', project_id: 2, labels: [{ id: 9, title: 'template' }] }]);
  const app = component(tasks, actions, views, sheet, checklists);
  app.checklistIds = new Set([1]);
  globalThis.history = { state: null, pushState(s){ this.state = s; }, replaceState(s){ this.state = s; } };
  document.getElementById = () => ({ querySelector: () => ({}) });
  Object.defineProperty(app, 'canEdit', { get: () => true });
  Object.assign(app, { picker: {}, $nextTick(){}, keepTemplate(){}, aim(){}, unsay(){} });
  const open = id => { app.openSheet('task'); app.sheet.show = true; app.showTask(structuredClone(v.task(id))); };
  const sent = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); return patches(v); };
  try {
    open(1);
    app.editTitle();
    app.sheet.title = 'Wipe the menus and the tables ';
    app.closeSheet();                                                          // closed by sliding down or the phone's Back, so the box keeps the focus
    assert.deepEqual(await sent(), [[1, { title: 'Wipe the menus and the tables' }]], 'the title is saved as the sheet is left');
    assert.equal(app.sheet.titleEdit, false);
    app.saveTitle();                                                           // the box's blur comes later
    c.mock.timers.tick(300);                                                   // the sheet has closed
    app.saveTitle();                                                           // or the blur comes only now, as the box goes with the sheet
    assert.equal((await sent()).length, 1, 'the title is saved only once');
    // An emptied title stays as it was.
    open(1);
    app.editTitle();
    app.sheet.title = '   ';
    app.closeSheet(true);
    assert.equal((await sent()).length, 1, 'an emptied title sends nothing');
    // A title that is not being edited has nothing to save.
    open(1);
    app.closeSheet(true);
    assert.equal((await sent()).length, 1);
    // A template's name is edited in the box over its card, which has focus. It is saved with "TEMPLATE: " kept in front.
    open(2);
    document.activeElement = { id: 'd-title' };
    app.sheet.title = 'Opening up';
    app.closeSheet(true);
    assert.deepEqual((await sent())[1], [2, { title: 'TEMPLATE: Opening up' }]);
    // A task labelled "template" outside a Checklists project is an ordinary task, and its title is saved as typed.
    open(3);
    app.sheet.title = 'Order cups and lids';
    app.closeSheet(true);
    assert.deepEqual((await sent())[2], [3, { title: 'Order cups and lids' }]);
  } finally { delete document.activeElement; delete document.getElementById; delete globalThis.history; }
});

/* On a desktop, Escape closes the innermost thing first. That is the task's ⋯ menu, wherever the focus is, and the
   focus then goes back to ⋯. Only after that does Escape close the sheet. With no sheet open it does nothing. */
test('Escape closes the task\'s menu before its sheet and moves the focus back to ⋯', () => {
  const app = component(sheet), did = [];
  document.getElementById = id => ({ focus: () => did.push('focus ' + id) });
  app.closeSheet = () => did.push('close');
  try {
    app.sheet = { open: true, menu: true };
    app.escapeKey();
    assert.deepEqual([app.sheet.menu, did], [false, ['focus d-more']], 'Escape closes the menu first and leaves the sheet open');
    app.escapeKey();
    assert.deepEqual(did, ['focus d-more', 'close'], 'the next Escape closes the sheet');
    app.sheet = { open: false, menu: false };
    app.escapeKey();
    assert.equal(did.length, 2, 'with nothing open, Escape does nothing');
  } finally { delete document.getElementById; }
});

/* "Turn into its own task" (ownTask, in the ⋯ menu on a subtask's sheet) removes the subtask from under its parent and
   puts it right after the parent in the project's List view. The old parent's calculated progress is then written
   without the subtask. A message with an Undo appears at the top of the sheet, and Undo puts the subtask back under
   its parent where it was. It is not available for a checklist's step or a template's. */
test('turning a subtask into its own task moves it right after its parent, and Undo puts it back', async () => {
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.5, project_id: 5, related_tasks: { subtask: [{ id: 11 }, { id: 12 }] } };
  const kid = (id, f = {}) => ({ id, title: 'Kid ' + id, done: false, percent_done: 0, project_id: 5, related_tasks: { parenttask: [{ id: 10, title: 'Pack the van', project_id: 5 }] }, ...f });
  const v = fakeVikunja([parent, kid(11, { done: true }), kid(12)]), app = component(tasks, actions), moves = [];
  Object.defineProperties(app, Object.getOwnPropertyDescriptors({
    positions: { 10: 1000, 11: 100, 12: 200 }, projById: new Map([[5, { id: 5, views: [{ id: 7, view_kind: 'list', position: 1 }] }]]), cursor: null,
    canEdit: true, checklistRole: null, get parentTask(){ return this.sheetTask?.related_tasks?.parenttask?.[0] || null; },
    showTask(){}, linkSubtask: sending.linkSubtask,
    act: async a => { moves.push([a.op, a.task, a.view, a.pos]); return { status: 'sent' }; } }));
  app.row(v.task(10)); opened(app, v.task(12), { kind: 'task' });
  app.checklistRole = 'step';
  assert.equal(app.canOwn, false, 'a checklist\'s step cannot become its own task');
  app.checklistRole = null;
  assert.equal(app.canOwn, true);
  await app.ownTask();
  assert.deepEqual([v.task(12).related_tasks.parenttask, v.task(10).related_tasks.subtask.map(s => s.id)], [[], [11]], 'the subtask is removed from the parent, and the parent no longer lists it');
  assert.deepEqual(moves, [['position', 12, 7, 1000.01]], 'the task goes right after its old parent, a little after it, because the list is not on screen to give the next position');
  assert.deepEqual([app.sheetTask === app.tasks[12], app.tasks[12].related_tasks.parenttask, app.canOwn], [true, [], false], 'the sheet reads the row, which shows it without a parent');
  assert.deepEqual(patches(v).at(-1), [10, { percent_done: 1 }], 'the old parent\'s progress is calculated without the task');
  assert.deepEqual([app.toast.msg, app.toast.place, app.toast.action.label], ['No longer a subtask of “Pack the van”', 'sheet:top', 'Undo']);
  await app.toast.action.fn();
  assert.deepEqual([v.task(12).related_tasks.parenttask.map(p => p.id), v.task(10).related_tasks.subtask.map(s => s.id)], [[10], [11, 12]], 'Undo puts the subtask under its parent again');
  assert.deepEqual([moves.at(-1), patches(v).at(-1)], [['position', 12, 7, 200], [10, { percent_done: 0.5 }]], 'Undo restores the subtask\'s position among the subtasks and counts it in the progress again');
  // If Vikunja refuses, a message with Try again appears and nothing changes.
  v.trouble = r => r.method === 'DELETE' ? 403 : null;
  await app.ownTask();
  assert.deepEqual([app.toast.action.label, app.toast.cls, v.task(12).related_tasks.parenttask.map(p => p.id), moves.length], ['Try again', 'failed', [10], 2]);
});

/* Moving a task to another project (moveTask, from "Move to another project" in the ⋯ menu or the Project row under
   Details) takes its subtasks at every level, where Vikunja's web app moves only the task. The message has an Undo,
   which puts the task and each subtask that moved back in the project it came from. */
const twoProjects = c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const t = (id, project_id, subs = []) => ({ id, title: 'Task ' + id, done: false, project_id, related_tasks: { subtask: subs.map(([id, project_id]) => ({ id, project_id })) } });
  // Task 10 has the subtasks 11 and 12, and 11 has the subtask 13. Subtask 12 is already in the other project.
  const v = fakeVikunja([t(10, 5, [[11, 5], [12, 6]]), t(11, 5, [[13, 5]]), t(12, 6), t(13, 5)]), app = component(tasks, actions);
  Object.defineProperties(app, Object.getOwnPropertyDescriptors({
    projById: new Map([[5, { id: 5, title: 'Inbox' }], [6, { id: 6, title: 'Errands' }]]), canEdit: true, checklistRole: null,
    save: sheet.save, showTask(){} }));
  opened(app, v.task(10), { kind: 'task' });
  return { v, app, where: () => [10, 11, 12, 13].map(id => v.task(id).project_id) };
};
test('moving a task to another project takes its subtasks at every level, and Undo puts each back', async c => {
  const { v, app, where } = twoProjects(c);
  await app.moveTask(6, 'sheet:top');
  assert.deepEqual(patches(v), [[10, { project_id: 6 }], [11, { project_id: 6 }], [13, { project_id: 6 }]], 'the subtask already there is not sent');
  assert.deepEqual([app.sheetTask.project_id, where()], [6, [6, 6, 6, 6]]);
  assert.deepEqual([app.toast.msg, app.toast.place, app.toast.action.label], ['Moved to Errands, with its 2 subtasks', 'sheet:top', 'Undo']);
  v.requests.length = 0;
  await app.toast.action.fn();
  assert.deepEqual(patches(v), [[10, { project_id: 5 }], [11, { project_id: 5 }], [13, { project_id: 5 }]]);
  assert.deepEqual([where(), app.sheetTask.project_id, app.said], [[5, 5, 6, 5], 5, 'Moved back to Inbox'], 'the subtask that was in the other project all along stays there');
});

test('a move that stops at a subtask says so, and Undo moves back only what moved', async c => {
  const { v, app, where } = twoProjects(c);
  v.trouble = r => r.method === 'PATCH' && r.path === '/tasks/13' ? 403 : null;
  await app.moveTask(6);
  assert.deepEqual(where(), [6, 6, 6, 5]);
  assert.match(app.toast.msg, /^Moved, but not all its subtasks: /);
  assert.deepEqual([app.toast.place, app.toast.cls, app.toast.action.label], ['sheet:props', 'failed', 'Undo'], 'from the Project row, the message is under that row');
  v.requests.length = 0;
  await app.toast.action.fn();
  assert.deepEqual([patches(v), where()], [[[10, { project_id: 5 }], [11, { project_id: 5 }]], [5, 5, 6, 5]]);
});

test('a move Vikunja refuses leaves the subtasks where they are', async c => {
  const { v, app, where } = twoProjects(c);
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await app.moveTask(6);
  assert.deepEqual([patches(v).map(([id]) => id), where()], [[10], [5, 5, 6, 5]], 'only the task itself was tried');
  assert.deepEqual([app.toast.place, app.toast.cls, app.toast.action.label], ['sheet:top', 'failed', 'Try again']);
});

test('a template, a checklist and their steps cannot move to another project, and a read-only task cannot either', async c => {
  const { v, app } = twoProjects(c);
  for (const role of ['template', 'tplstep', 'run', 'step']) {
    app.checklistRole = role;
    assert.equal(app.canMove, false, role);
    await app.moveTask(6);
  }
  assert.deepEqual(v.requests, [], 'nothing is sent');
  app.checklistRole = 'candidate';
  assert.equal(app.canMove, true, 'a plain task in a checklist project can move out of it');
  app.canEdit = false;
  assert.equal(app.canMove, false);
});

const settled = () => new Promise(r => setImmediate(r));
test('a tick puts the user\'s ✅ on the task and an untick takes it off, except in a project only they can see and on a repeating task', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Order the cups', done: false, project_id: 7 }, { id: 2, title: 'Book the dentist', done: false, project_id: 8 },
    { id: 3, title: 'Water the plants', done: false, project_id: 7, due_date: '2026-10-07T09:00:00Z', repeat_after: DAY }]), app = listed(c);
  app.seenBy = { 7: 2, 8: 0 };
  for (const id of [1, 2, 3]) await app.toggleDone(app.row(v.task(id)), null, { quiet: true });
  await settled();
  assert.deepEqual([1, 2, 3].map(id => v.task(id).reactions?.['✅']?.map(u => u.id) || null), [[1], null, null]);
  await app.toggleDone(app.tasks[1], null, { quiet: true });
  await settled();
  assert.deepEqual(v.task(1).reactions['✅'], [], 'unticking takes the ✅ off');
});

test('a task ticked on Today joins Done today when the batch clears, newest first, and a checklist\'s step does not', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Order the cups', done: false }, { id: 2, title: 'Fix the till', done: true }, { id: 3, title: 'Take the croissants out', done: false }]), app = listed(c);
  app.route = { name: 'today' };
  app.stepRun = t => t.id === 3 ? 9 : null;
  app.tickRunStep = async t => { t.done = true; };
  app.view.groups = [{ key: 'today', tasks: [app.row(v.task(1))] }, { key: 'donetoday', tasks: [app.row(v.task(2))] }];
  await app.toggleDone(app.tasks[1], ROW);
  assert.deepEqual(app.view.groups[1].tasks.map(t => t.id), [2], 'Done today waits for the batch');
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups.map(g => g.tasks.map(t => t.id)), [[], [1, 2]]);
  app.intoDoneToday([3]);
  assert.deepEqual(app.view.groups[1].tasks.map(t => t.id), [1, 2]);
});

test('Done today holds what the user ticked, what is assigned to them, what is in a project only they see, and checklists they started', () => {
  const app = component(views);
  Object.assign(app, { user: { id: 1 }, seenBy: { 7: 2, 8: 0 }, isRunTask: t => !!t.run });
  const mine = { id: 1 }, other = { id: 2 };
  const cases = [[{ project_id: 7, reactions: { '✅': [mine] } }, true], [{ project_id: 7, reactions: { '✅': [other] } }, false], [{ project_id: 7, assignees: [mine] }, true],
    [{ project_id: 8 }, true], [{ project_id: 7 }, false], [{ project_id: 7, run: true, created_by: mine }, true], [{ project_id: 7, run: true, created_by: other }, false]];
  assert.deepEqual(cases.map(([t]) => app.doneByMe(t)), cases.map(([, want]) => want));
});

test('Done today keeps only what was done today, also in a copy of Today saved on an earlier day', () => {
  const app = component(tasks, actions, cards, alerts, sending), now = new Date(), yesterday = new Date(now - 864e5).toISOString();
  Object.assign(app, { route: { name: 'today' }, pending: [], view: { groups: todayGroups(), cards: {} } });
  app.view.groups.find(g => g.key === 'donetoday').tasks = [{ id: 1, done: true, done_at: yesterday }, { id: 2, done: true, done_at: now.toISOString() }, { id: 3, done: true }];
  assert.deepEqual(app.listBase.find(g => g.key === 'donetoday').tasks.map(t => t.id), [2, 3], 'a task just ticked, with no time yet, stays');
});

test('a template gets no ✅ when it is saved done, even if Vikunja\'s reply leaves its labels out', async c => {
  const label = [{ id: 4, title: 'template' }], due = '2026-10-20T09:00:00Z';
  const v = fakeVikunja([{ id: 1, title: 'TEMPLATE: Opening up', done: false, due_date: due, project_id: 7, labels: label }, { id: 2, title: 'Order cups', done: false, project_id: 8, labels: label }]);
  const app = listed(c);
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(checklists));
  Object.assign(app, { seenBy: { 7: 2, 8: 2 }, checklistIds: new Set([7]) });
  const t = app.row(v.task(1));
  app.change(w => w.put([{ ...v.task(1) }], TASK));
  delete v.task(1).labels;                       // the reply to the save has no labels
  await app.saveTask(1, { done: true });
  await settled();
  assert.equal(t.done, true);
  assert.equal(v.task(1).reactions, undefined);
  app.row(v.task(2));
  await app.saveTask(2, { done: true });
  await settled();
  assert.deepEqual(v.task(2).reactions?.['✅']?.map(u => u.id), [1], 'a task labelled "template" outside a Checklists project gets the ✅');
});

test('finishing a checklist puts the user\'s ✅ on it, and reopening it takes the ✅ off', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Closing up · Oct 14', done: false }]);
  const app = component(tasks, actions);
  await sendStages(app, { op: 'finish', task: 1, run: 1 });
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅'].map(u => u.id)], [true, [1]]);
  await sendStages(app, { op: 'reopen', task: 1, run: 1 });
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅']], [false, []]);
});

test('a task that quick add made already done gets the user\'s ✅, as a tick would', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Order the cups', done: true, project_id: 7 }]), app = component(tasks, actions, leaving, sending);
  c.mock.timers.enable({ apis: ['setTimeout'] });
  app.seenBy = { 7: 2 };
  app.arrivedDone(app.row(v.task(1)), v.task(1));
  await settled();
  assert.deepEqual(v.task(1).reactions['✅'].map(u => u.id), [1]);
});

test('the ✅ requests go out in the order the ticks saved, so a slow untick doesn\'t take off the next tick\'s ✅', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Order the cups', done: false, project_id: 7 }]), app = listed(c), request = globalThis.fetch;
  app.seenBy = { 7: 2 };
  app.row(v.task(1));
  let release;
  globalThis.fetch = (url, args) => url.endsWith('/reactions/delete') && !release ? new Promise(r => { release = () => request(url, args).then(r); }) : request(url, args);
  for (const done of [true, false, true]) { await app.saveTask(1, { done }); await settled(); }
  release();
  for (let i = 0; i < 5; i++) await settled();
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅'].map(u => u.id)], [true, [1]]);
});
