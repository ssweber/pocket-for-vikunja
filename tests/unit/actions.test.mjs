// Tests for what happens to a task (src/js/app/actions.js), against a fake Vikunja. They check what is sent, what is
// on screen, and the undo. In a list, a row's tick waits for the batch to clear (leaving.js).
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import runs from '../../src/js/app/runs.js';
import outbox from '../../src/js/app/outbox.js';
import leaving from '../../src/js/app/leaving.js';
import lines from '../../src/js/app/lines.js';
import cards from '../../src/js/app/cards.js';
import alerts from '../../src/js/app/alerts.js';
import sheet from '../../src/js/app/sheet.js';
import views from '../../src/js/app/views.js';
import { todayGroups } from '../../src/js/lists.js';
import { movedDue } from '../../src/js/dates.js';
import { cache } from '../../src/js/util.js';
import { ACT_STEPS, ACTS, sync } from '../../src/js/sync.js';

const DAY = 86400;
const sub = (id, more = {}) => ({ id, title: 'Subtask ' + id, done: false, ...more });
// A parent with four subtasks: two open (one half done), one already done, and one that repeats. Completing a parent
// leaves the repeating subtask alone.
const family = () => {
  const subs = [sub(11), sub(12, { done: true }), sub(13, { repeat_after: DAY, due_date: '2026-10-07T09:00:00Z' }), sub(14, { percent_done: 0.5 })];
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.25, related_tasks: { subtask: subs } };
  return { parent, subs };
};
const patches = v => v.requests.filter(r => r.method === 'PATCH').map(r => [+r.path.split('/')[2], r.body]);
// The patches that are not a parent's calculated progress, which Pocket writes after its subtasks change (writeFigure).
const ticks = v => patches(v).filter(([, b]) => !('percent_done' in b && Object.keys(b).length === 1));
// A row in a list, for ticking from there. The test controls the batch's timer, so the batch doesn't clear by itself.
const ROW = {};
const listed = t => { t.mock.timers.enable({ apis: ['setTimeout'] }); return component(tasks, actions, leaving); };

test('ticking a parent leaves its subtasks as they are (parent-tasks-plan, part 3: its ring asks first)', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  const t = app.keep(parent);
  await app.toggleDone(t, ROW);
  assert.deepEqual(ticks(v), [[10, { done: true }]]);
  assert.deepEqual([11, 14].map(id => v.task(id).done), [false, false], 'its open subtasks stay open');
  assert.deepEqual([app.leaving, app.said], [{ 10: 'done' }, 'Done: Pack the van']);
});

test('a parent completed (close) closes its open subtasks, shown done in place with it, and its undo opens exactly those, its figure following', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  const t = app.keep(parent);
  await app.toggleDone(t, ROW, { close: true });
  await app.saveTask(10, null, () => null);                                  // the parent's progress write, after the subtasks
  assert.deepEqual(patches(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }], [10, { percent_done: 0.75 }]], 'its figure: three of four done');
  assert.equal(t.done, true);
  assert.equal(app.said, 'Closed Pack the van + 2 subtasks', 'a screen reader hears it');
  assert.deepEqual(app.toasts, [], 'nothing else is said: the row shows it');
  assert.deepEqual(app.leaving, { 10: 'done', 11: 'done', 14: 'done' }, 'in place with the subtasks closed, until the batch clears');
  assert.equal(v.task(13).done, false, 'a repeating subtask is left alone');
  assert.deepEqual(t.related_tasks.subtask.map(s => s.done), [true, true, false, true], 'its ring counts them done');

  v.requests.length = 0;
  await app.unmark(10);
  await app.saveTask(10, null, () => null);
  assert.deepEqual(app.leaving, {}, 'not leaving any more');
  assert.deepEqual(ticks(v), [[10, { done: false }], [11, { done: false }], [14, { done: false }]]);
  assert.equal(v.task(12).done, true, 'the subtask done before stays done');
  assert.equal(t.done, false);
  assert.deepEqual([v.task(10).percent_done, v.task(14).percent_done], [0.38, 0.5], 'its figure worked out again; the subtask\'s progress as it was');
  assert.deepEqual(t.related_tasks.subtask.map(s => s.done), [false, true, false, false]);
});

test('when the batch clears, a parent completed on Today leaves with the subtasks closed with it', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [10, 11, 13, 14].map(id => app.keep(v.task(id))) }];
  await app.toggleDone(app.tasks[10], ROW, { close: true });
  assert.equal(app.view.groups[0].tasks.length, 4, 'still there, in place');
  c.mock.timers.tick(2999);
  assert.equal(app.view.groups[0].tasks.length, 4, 'not before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [13], 'gone together; the repeating one stays');
  assert.deepEqual(app.leaving, {});
});

test('a subtask that fails to close stops the rest, and its row says so', async c => {
  const two = [sub(11), sub(14)], parent = { id: 10, title: 'Pack the van', done: false, related_tasks: { subtask: two } };
  const v = fakeVikunja([parent, ...two]), app = listed(c);
  v.trouble = r => r.method === 'PATCH' && r.path === '/tasks/11' ? 403 : null;
  await app.toggleDone(app.keep(parent), ROW, { close: true });
  assert.equal(v.task(10).done, true);
  assert.equal(v.task(14).done, false, 'stopped at the first that failed');
  assert.deepEqual([app.toast.msg, app.toast.row.id, app.toast.cls], ['Done: Pack the van — its 2 subtasks couldn\'t be closed', 10, 'failed']);
});

/* A tick that is not saved shows a message with Try again. In a list the message replaces the row for a few seconds,
   then the row returns to be ticked again. A task's own sheet has no row to give back, so the message appears at the
   top of the sheet and stays, with no timer, until the user tries again or the tick is saved. The test uses the real
   lines.js. */
test('a tick not saved from its own sheet says so at its top, with Try again, and stays until the tick is saved', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Wipe the menus', done: false }]), app = component(tasks, actions, lines);
  document.querySelectorAll = () => [];
  c.after(() => { delete document.querySelectorAll; });
  Object.assign(app, { lines: {}, sheet: { open: true, show: true, kind: 'task', lines: {}, task: structuredClone(v.task(1)) } });
  v.trouble = () => 'offline';
  await app.toggleDone(app.sheet.task, null, { sheet: true });
  assert.deepEqual([app.sheet.task.done, app.sheet.lines.top.text, app.sheet.lines.top.action.label], [false, 'Not saved: no connection', 'Try again']);
  c.mock.timers.tick(60000);
  assert.ok(app.sheet.lines.top, 'still there a minute on: it\'s the sheet\'s word that the tick didn\'t take');
  v.trouble = () => null;
  await app.toggleDone(app.sheet.task, null, { sheet: true });
  assert.deepEqual([v.task(1).done, app.sheet.lines.top], [true, undefined], 'ticked again and saved: the line goes with it');
});

test('completed from its sheet the same way: its subtasks closed, said under them, and Undo opens them again', async () => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = component(tasks, actions);
  app.sheet = { task: structuredClone(parent) };
  await app.toggleDone(app.sheet.task, null, { sheet: true, close: true });
  assert.deepEqual(ticks(v), [[10, { done: true }], [11, { done: true }], [14, { done: true }]]);
  assert.deepEqual([app.toast.msg, app.toast.place], ['Closed Pack the van + 2 subtasks', 'sheet:subtasks']);
  assert.deepEqual(app.sheet.task.related_tasks.subtask.map(s => s.done), [true, true, false, true], 'the sheet shows them done');
  assert.equal(app.sheet.dirty, true, 'the list is read again once the sheet closes');
  await app.toast.action.fn();
  assert.deepEqual([10, 11, 12, 14].map(id => v.task(id).done), [false, false, true, false]);
  assert.deepEqual(app.sheet.task.related_tasks.subtask.map(s => s.done), [false, true, false, false]);
  // A task with no subtasks shows no message, because the tick itself shows the change. Ticking it again opens it.
  const n = app.toasts.length;
  app.sheet.task = structuredClone(v.task(12));
  await app.sheetDone();
  assert.equal(v.task(12).done, false);
  assert.equal(app.toasts.length, n);
});

test('a done parent over its open subtasks on a project\'s list, ticked, is open again where it is, out of Done', async c => {
  const v = fakeVikunja([{ id: 10, title: 'Pack the van', done: true, related_tasks: { subtask: [sub(11)] } }, sub(11)]), app = listed(c);
  const head = app.keep(v.task(10)), kid = app.keep(v.task(11));
  app.route = { name: 'project', id: 1 };
  app.view.groups = [{ key: 'open', tasks: [kid, head], heads: [10] }, { key: 'done', loaded: false, count: 3, tasks: [] }];
  assert.equal(app.isHead(head), true);
  await app.toggleDone(head, ROW);
  assert.equal(v.task(10).done, false);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [11, 10], 'still on the open list');
  assert.equal(app.view.groups[1].count, 2, 'no longer counted as done');
  assert.deepEqual([app.leaving[10], app.said], ['open', 'Not done: Pack the van'], 'shown open, in place');
  assert.equal(v.task(11).done, false, 'its subtask as it was');
  await app.unmark(10);
  assert.equal(v.task(10).done, true, 'its tick again: done again');
  assert.equal(v.task(11).done, false, 'its subtask still open');
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [11, 10], 'it stays when the batch clears');
});
test('a parent completed on a project\'s list with a subtask left open (one that repeats) stays over it, done', async c => {
  const { parent, subs } = family(), v = fakeVikunja([parent, ...subs]), app = listed(c);
  Object.assign(app, { route: { name: 'project', id: 1 }, bothWays: true });
  const t = app.keep(parent), kids = [11, 13, 14].map(id => app.keep({ ...v.task(id), related_tasks: { parenttask: [{ id: 10 }] } }));
  app.view.groups = [{ key: 'open', tasks: [t, ...kids] }, { key: 'done', loaded: false, count: 1, tasks: [] }];
  await app.toggleDone(t, ROW, { close: true });
  assert.deepEqual(app.view.groups[0].heads, [10], 'a head over the repeating one');
  assert.equal(app.view.groups[1].count, 2, 'counted done');
  assert.deepEqual(app.leaving, { 10: 'done', 11: 'done', 14: 'done' });
  await app.unmark(10);
  assert.deepEqual([10, 11, 14].map(id => v.task(id).done), [false, false, false], 'its tick again: all open again');
  assert.equal(app.view.groups[1].count, 1);
  // Complete it again and let the batch clear. The parent stays, over the repeating subtask, and the closed tasks move to Done.
  await app.toggleDone(t, ROW, { close: true });
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks.map(t => t.id), [10, 13]);
  assert.equal(app.view.groups[1].count, 4, 'it and the two closed with it');
});

test('a tick not saved goes back, and its row says why, with Try again', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Call Jo', done: false }]), app = listed(c);
  v.trouble = () => 'offline';
  const t = app.keep(v.task(1));
  await app.toggleDone(t, ROW);
  assert.deepEqual(app.leaving, {}, 'not marked: it stays as it was');
  assert.equal(t.done, false);
  assert.equal(app.toast.msg, 'Not saved: no connection');
  assert.deepEqual([app.toast.row.id, app.toast.row.stays, app.toast.cls], [1, true, 'failed'], 'on its row, which stays');
  assert.equal(app.toast.action.label, 'Try again');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.equal(v.task(1).done, true, 'Try again ticks it');
});

test('a repeating task whose tick lost its reply is ticked once, not twice', async c => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const v = fakeVikunja([{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]), app = listed(c);
  cache.set(1, structuredClone(v.task(1)));
  v.trouble = r => r.method === 'PATCH' ? 'lost' : null;
  const t = app.keep(v.task(1));
  await app.toggleDone(t, ROW);
  assert.equal(patches(v).length, 1, 'not sent again: Vikunja\'s copy, read after, shows it moved on');
  assert.equal(Date.parse(v.task(1).due_date) - Date.parse(due), DAY * 1000);
  assert.deepEqual([t.done, t.due_date, app.leaving[1]], [true, due, 'done'], 'its row shows it done, with its date, until the batch clears');
  assert.match(app.said, /^Done: Water the plants\. It repeats, next /);
  // Tapping its tick before the batch clears restores its date.
  v.trouble = () => null;
  await app.unmark(1);
  assert.deepEqual([v.task(1).due_date, t.due_date, t.done], [due, due, false]);
});

test('a repeating task ticked in a list is back, open, with its next date once the batch clears', async c => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const v = fakeVikunja([{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(1))] }];
  await app.toggleDone(app.tasks[1], ROW);
  await app.clearBatch(true);
  const t = app.view.groups[0].tasks[0];
  assert.deepEqual([t?.done, t?.due_date], [false, v.task(1).due_date], 'still on the list');
  assert.equal(Date.parse(t.due_date) - Date.parse(due), DAY * 1000);
  // A task whose next date is past what Today shows leaves Today.
  v.task(1).repeat_after = 30 * DAY;
  app.tasks[1].repeat_after = 30 * DAY;
  await app.toggleDone(app.tasks[1], ROW);
  await app.clearBatch(true);
  assert.deepEqual(app.view.groups[0].tasks, []);
});

test('progress taken to 100% marks the task done, and its tick again puts back the progress it had', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]), app = listed(c);
  const t = app.keep(v.task(1));
  await app.setProgress(t, 100, ROW);
  assert.deepEqual(patches(v), [[1, { done: true }]], 'its progress is left as it was');
  assert.equal(v.task(1).done, true);
  await app.unmark(1);
  assert.deepEqual(patches(v).at(-1), [1, { done: false, percent_done: 0.4 }]);
  // The sheet (its row or its Progress line) behaves the same. The tick shows it, and ticking again restores the progress.
  const n = app.toasts.length;
  app.sheet = { task: structuredClone(v.task(1)) };
  await app.sheetProgress(app.sheet.task, 100);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done, app.toasts.length], [true, 0.4, n]);
  await app.sheetDone();
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.4]);
});

/* A full swipe right marks the task done and looks the same as a tick. The row finishes its swipe off the screen, then
   shows as done in its place, never as a gap, with the same mark as a tick. Tapping its tick undoes it. The row
   leaves the list when the batch clears. In a sheet, a subtask's row stays in place as done, with nothing marked. */
test('a full swipe is done as a tick is: its row done in place, never a gap, until the batch clears, and its tick puts back the progress it had', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 }, { id: 2, title: 'Sand it', done: false }]), app = listed(c);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(1)), app.keep(v.task(2))] }];
  await app.setProgress(app.tasks[1], 100, ROW);
  assert.deepEqual([app.leaving, app.isGap(app.tasks[1], { depth: {} }), v.task(1).done], [{ 1: 'done' }, false, true]);
  await app.unmark(1);
  assert.deepEqual(app.leaving, {});
  assert.deepEqual(patches(v).at(-1), [1, { done: false, percent_done: 0.5 }], 'its tick: open, at the progress it had');
  await app.setProgress(app.tasks[1], 100, ROW);
  await app.toggleDone(app.tasks[2], ROW);
  assert.deepEqual(app.leaving, { 1: 'done', 2: 'done' }, 'swiped or ticked: marked the same');
  await app.clearBatch(true);
  assert.deepEqual([app.view.groups[0].tasks, app.leaving], [[], {}], 'both gone with the batch');
  // A subtask in its parent's sheet is done where it is, with nothing marked.
  v.tasks.set(3, { id: 3, title: 'Prime it', done: false });
  const inSheet = { id: 3, title: 'Prime it', done: false };
  await app.setProgress(inSheet, 100, null, { sub: true });
  assert.deepEqual([app.leaving, inSheet.done, v.task(3).done], [{}, true, true]);
});

/* A row shows as done in place from the moment the user ticks it or releases the swipe, not from when Vikunja answers
   (toggleDone's holdRow). The mark replaces that once the save is made. Tapping its tick in the meantime waits for
   the answer and then undoes it. If the save fails, the row is released and shows a message with Try again. A
   deletion's gap is held the same way (gapNow) until the deletion is queued to send. */
test('a full swipe\'s row is held done before Vikunja answers; its tick tapped meanwhile undoes it once it has; not saved, the row says so', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 }, { id: 2, title: 'Sand it', done: false }]), app = listed(c), send = globalThis.fetch;
  // Vikunja's answers are held back until `answer()` is called.
  let held = [];
  const answer = () => { const go = held; held = null; go.forEach(ok => ok()); }, turn = () => new Promise(ok => setImmediate(ok));
  globalThis.fetch = async (...a) => { if (held) await new Promise(ok => held.push(ok)); return send(...a); };
  document.querySelectorAll = () => [];                                       // no rows to slide back in
  try {
    app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(1)), app.keep(v.task(2))] }];
    let setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual([app.leaving, app.tasks[1].done, v.task(1).done], [{ 1: 'done' }, true, false], 'held done from the let-go, with nothing answered yet');
    const tapped = app.unmark(1);
    await turn();
    assert.deepEqual([app.leaving, patches(v)], [{ 1: 'done' }, []], 'its tick tapped: nothing until the answer');
    answer();
    await setting; await tapped;
    assert.deepEqual(app.leaving, {}, 'answered: marked, and the tap was its undo');
    assert.deepEqual([v.task(1).done, v.task(1).percent_done, patches(v).length], [false, 0.5, 2], 'open again, at the progress it had');
    // If the save fails, the row is released and shows a message.
    v.trouble = () => 500;
    setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual(app.leaving, { 1: 'done' });
    await setting; await turn();
    assert.deepEqual([app.leaving, app.tasks[1].done], [{}, false], 'not held, and not done');
    assert.match(app.toast.msg, /^Not saved: /);
    assert.deepEqual([app.toast.row.id, app.toast.action.label], [1, 'Try again']);
    v.trouble = () => null; app.rowEl = () => ROW;                             // the row is on screen
    await app.toast.action.fn();
    assert.deepEqual([app.leaving, v.task(1).done], [{ 1: 'done' }, true], 'Try again: done, in its place');
    // A tapped tick is held the same way. Tapping it again before the answer undoes it once the answer arrives.
    await app.unmark(1);
    held = [];
    const ticking = app.toggleDone(app.tasks[1], ROW), again = app.unmark(1);
    assert.deepEqual([app.leaving, typeof again.then], [{ 1: 'done' }, 'function']);
    answer();
    await ticking; await again;
    assert.deepEqual([app.leaving, v.task(1).done, app.tasks[1].done], [{}, false, false], 'ticked and ticked again: open, and nothing left marked');
    // A deletion shows "Deleted" and Restore at once. If the user cancels (the confirmation is answered no), the row comes back.
    let said = null;
    const asked = new Promise(ok => { said = ok; });
    app.gapNow(2, asked);
    assert.deepEqual(app.leaving[2], 'deleted');
    said(false);
    await asked; await turn();
    assert.equal(app.leaving[2], undefined, 'called off: no gap');
  } finally { globalThis.fetch = send; delete document.querySelectorAll; }
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

/* Swiping a done row left opens it again at the progress where the user releases the swipe, the same as its tick
   would, in one save. Ticking it again makes it done. The sheet's row and Progress line behave the same. */
test('a done task swiped down is open again, at that progress, in one save', async c => {
  const v = fakeVikunja([{ id: 1, title: 'Paint the fence', done: true, percent_done: 0.4 }]), app = listed(c);
  const t = app.keep(v.task(1));
  await app.setProgress(t, 75, ROW);
  assert.deepEqual(patches(v), [[1, { done: false, percent_done: 0.75 }]]);
  assert.deepEqual([t.done, v.task(1).done, v.task(1).percent_done], [false, false, 0.75]);
  await app.toggleDone(t, null);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [true, 0.75], 'ticked again: done, its progress kept');
  app.sheet = { task: structuredClone(v.task(1)) };
  await app.sheetProgress(app.sheet.task, 50);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.5], 'from the sheet\'s bar too');
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
  const app = component(tasks, actions, cards);
  app.view.groups = [{ key: 'overdue', tasks: [1, 2, 3].map(id => app.keep(v.task(id))) }];
  assert.equal(app.overdueMovable, true);
  await app.moveOverdueToToday();
  assert.equal(v.task(1).due_date, at(7, 15), 'its time has passed today: the next whole hour');
  assert.equal(v.task(2).due_date, at(7, 18, 30));
  assert.equal(v.task(3).due_date, at(6, 8), 'a repeating task stays');
  assert.equal(app.toasts.at(-1).msg, 'Moved 2 to today. 1 repeating task stays. Tick it to move it to its next date.');
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
  // In its parent's sheet, the subtask's copy has no parent set, so `sub: true` tells the action it is a subtask.
  const inSheet = { id: 3, title: 'Wash them', done: false };
  v.tasks.set(3, structuredClone(inSheet));
  await app.toggleDone(inSheet, null, { sub: true });
  assert.deepEqual(app.toasts, []);
});

/* A parent's calculated progress is written right after one of its subtasks changes, by the same action, and only
   when the progress changes. */
test('a subtask ticked, or its progress set, writes its parent\'s worked-out figure right after; unchanged, nothing', async () => {
  const kid = id => ({ id, title: 'Step ' + id, done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } });
  const v = fakeVikunja([{ id: 1, title: 'Open up', percent_done: 0, related_tasks: { subtask: [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] } }, kid(2), kid(3), kid(4), kid(5)]);
  const app = component(tasks, actions), t = app.keep(v.task(2));
  await app.setProgress(t, 50, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { percent_done: 0.5 }], [1, { percent_done: 0.13 }]], 'one at 50% of four: 13%, after its own save');
  v.requests.length = 0;
  await app.toggleDone(t, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { done: true }], [1, { percent_done: 0.25 }]], 'done: 100% of it');
  v.requests.length = 0;
  await app.setProgress(app.keep(v.task(3)), 0, null);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[3, { percent_done: 0 }]], 'the figure unchanged: not written');
  // In its parent's sheet, the subtask's copy names no parent, so the sheet's task is its parent.
  v.requests.length = 0;
  app.sheet = { task: { id: 1, related_tasks: { subtask: [{ id: 4 }] } } };
  await app.toggleDone({ id: 4, title: 'Step 4', done: false }, null, { sub: true });
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[4, { done: true }], [1, { percent_done: 0.5 }]]);
});

// In a subtask's own sheet, setting progress by swiping its row or tapping a quarter in Details also writes the
// parent's progress.
test('a subtask\'s progress set in its own sheet writes its parent\'s figure right after', async () => {
  const kid = id => ({ id, title: 'Step ' + id, done: false, percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } });
  const v = fakeVikunja([{ id: 1, title: 'Open up', percent_done: 0, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }, kid(2), kid(3)]);
  const app = component(tasks, actions, sheet);
  Object.assign(app, { keepTemplate(){}, rowTitle: t => t.title, unsay(){} });
  app.sheet = { task: structuredClone(v.task(2)) };
  await app.sheetProgress(app.sheet.task, 50);
  await app.saveTask(1, null, () => null);
  assert.deepEqual(patches(v), [[2, { percent_done: 0.5 }], [1, { percent_done: 0.25 }]]);
});

test('a run\'s step: what changes it goes through the outbox, its run\'s figure written by the same entry, last', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Opening', percent_done: 0, related_tasks: { subtask: [{ id: 2, done: true }, { id: 3, percent_done: 0.5 }] } }, { id: 2, done: true }, { id: 3, percent_done: 0.5 }]);
  component(tasks, actions);
  for (const op of ['progress', 'done', 'skip', 'undone', 'doneNote']) assert.equal(ACTS[op].at(-1), 'figure', op + ': its last part');
  assert.equal(ACT_STEPS.figure({ op: 'finish', task: 1, run: 1 }), null, 'the run itself finished: nothing to work out');
  await ACT_STEPS.figure({ op: 'done', task: 2, run: 1 });
  assert.deepEqual(patches(v), [[1, { percent_done: 0.75 }]], 'one done, one at 50%');
  await ACT_STEPS.figure({ op: 'done', task: 2, run: 1 });
  assert.equal(patches(v).length, 1, 'sent again: the same, so nothing written');
});

// The parts needed to send a deletion are what is waiting and the outbox's acts (runs.js), on the fake component.
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The test controls the timers, so timers that have not fired yet (the Undo's, for example) don't keep Node waiting.
const deleting = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, pick(sending.default ?? sending, 'refreshPending', 'keyWaiting', 'markSlow', 'sendEntry'),
    pick(runs, 'sendActs', 'sendAct', 'applyAct', 'actWhat', 'actTitle', 'wordsBack', 'giveBack', 'refreshRunTask'));
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], canWrite: () => true, flushing: false, cap: {}, sheet: { task: null, sub: {} } });
  Object.defineProperty(app, 'syncState', Object.getOwnPropertyDescriptor(outbox, 'syncState'));
  globalThis.confirm = () => true;
  return app;
};
const deletes = v => v.requests.filter(r => r.method === 'DELETE').map(r => +r.path.split('/')[2]);

test('a subtask deleted: its parent\'s worked-out progress is written once the deletion is sent, in the same entry', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', percent_done: 0.5, related_tasks: { subtask: [{ id: 2 }, { id: 3, done: true }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }] } }, { id: 3, title: 'Pack the plates', done: true, related_tasks: { parenttask: [{ id: 1 }] } }]);
  const app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(2))] }];
  const d = await app.holdDelete(app.tasks[2]);
  assert.equal(sync.all(1)[0].up, 1, 'its parent, to work out again');
  assert.equal(v.task(1).percent_done, 0.5, 'nothing written while its Restore shows');
  await app.sendHeld(d.id);
  assert.deepEqual(deletes(v), [2]);
  assert.equal(v.task(1).percent_done, 1, 'the one left is done: 100%');
  assert.deepEqual(ACTS.delete.at(-1), 'figure');
});

/* Deleting a task with subtasks asks for confirmation first. askDelete reads which tasks go with it and asks on its
   own, so a row swiped to delete asks before it slides away (swipeDelete, app/progress.js). The deletion that follows
   does not ask again. */
test('deleting a task with subtasks asks first, saying how many go; said no, nothing is kept to send; asked beforehand, it isn\'t asked again', async t => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 4 }] } },
    { id: 3, title: 'Pack the plates', related_tasks: { parenttask: [{ id: 1 }] } }, { id: 4, title: 'Wrap them', related_tasks: { parenttask: [{ id: 2 }] } }, { id: 5, title: 'Lock up' }]);
  const app = deleting(t), asked = [];
  let yes = false;
  globalThis.confirm = q => { asked.push(q); return yes; };
  for (const id of [1, 3, 5]) app.keep(v.task(id));
  assert.deepEqual([1, 3, 5].map(id => app.hasSubtasks(app.tasks[id])), [true, false, false], 'as far as the phone knows');
  assert.equal(app.hasSubtasks({ id: 1 }), true, 'by the copy on screen too');
  assert.equal(await app.askDelete(app.tasks[1]), null, 'said no');
  assert.deepEqual(asked, ['Delete “Pack the van” and its 2 subtasks, 1 more under them?']);
  assert.equal(await app.holdDelete(app.tasks[1]), null);
  assert.deepEqual([sync.all(1).length, app.deleting, deletes(v)], [0, [], []], 'nothing kept to send, nothing off the list');
  yes = true; asked.length = 0;
  const tree = await app.askDelete(app.tasks[1]);
  assert.deepEqual([tree, asked.length], [[4, 2, 3, 1], 1], 'all the way down, deepest first');
  const d = await app.holdDelete(app.tasks[1], null, tree);
  assert.deepEqual([d.n, asked.length, sync.all(1)[0].ids], [3, 1, [4, 2, 3, 1]], 'asked about already: not again');
  await app.undoDelete(d.id);
  asked.length = 0;
  assert.deepEqual([await app.askDelete(app.tasks[5]), asked], [[5], []], 'one with none isn\'t asked about');
});

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
  await app.sendHeld();                                                       // the app goes to the background, with nothing left to send
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
  await app.undoDelete(d.id);                                                 // too late for Undo, so nothing happens
  assert.deepEqual(deletes(v), [2, 1]);
});

test('a deletion without a connection waits in the outbox, off the list, and goes once there is one', async t => {
  const v = fakeVikunja([{ id: 5, title: 'Call Jo' }]), app = deleting(t);
  app.view.groups = [{ key: 'today', tasks: [app.keep(v.task(5))] }];
  await app.holdDelete(app.tasks[5]);
  v.trouble = r => r.method === 'DELETE' ? 'offline' : null;
  await app.sendHeld();                                                       // the app goes to the background while offline
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
  for (const t of list) app.keep(v.task(t.id));
  return { v, app, seen, shown, at: (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(), key: id => app.todayKey(app.tasks[id]) };
};
const moveTo = (app, t, day, label) => app.reschedule(t, { label, due: day ? movedDue(t.due_date, day, new Date()) : ZERO });
const ZERO = '0001-01-01T00:00:00Z';
// The last message and where it appears: its text, its action's label, the id of the row it is on (or null) and the
// place it goes otherwise.
const said = app => { const s = app.toast; return [s.msg, s.action?.label ?? null, s.row?.id ?? null, s.place]; };

test('a row moved to a new date goes there at its own time, at once, said on its row with an Undo; off Today, by the add box', async c => {
  const { v, app, seen, shown, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() }, { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() },
    { id: 4, title: 'Fix the gate', due_date: new Date(2026, 9, 7, 17).toISOString(), created: new Date(2026, 8, 1).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1], app.tasks[4]); app.view.groups[0].tasks.push(app.tasks[2]); app.view.groups[3].tasks.push(app.tasks[3]);
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([app.tasks[1].due_date, key(1)], [at(9, 16), 'week'], 'moved on screen at once, before Vikunja answers');
  assert.equal(await going, true);
  assert.equal(v.task(1).due_date, at(9, 16), 'Friday at 4 PM: its time of day kept');
  assert.deepEqual(said(app), ['Moved to Fri 9', 'Undo', 1, 'cap'], 'said on its row, in its new place, with an Undo');
  assert.equal(app.toast.row.stays, true, 'the row is back once the line goes');
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.deepEqual([v.task(2).due_date, key(2)], [at(7, 15), 'today'], 'overdue to today: its time gone, the next whole hour');
  assert.deepEqual(said(app), ['Moved to today', 'Undo', 2, 'cap']);
  await moveTo(app, app.tasks[3], new Date(), 'Today');
  assert.deepEqual([v.task(3).due_date, key(3)], [at(7, 0), 'today'], 'no date: today, with no time');
  seen.delete(3);
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  assert.deepEqual([key(3), said(app)], ['week', ['Moved to tomorrow', 'Undo', null, 'cap']], 'still on Today, but its row scrolled out of sight: by the add box');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 19), 'Mon 19');
  assert.deepEqual([v.task(1).due_date, key(1)], [at(19, 16), null], 'past its next 7 days: off Today');
  assert.deepEqual(said(app), ['Moved to Mon 19', 'Undo', null, 'cap'], 'no row left to say it on: by the add box');
  seen.add(3);
  await moveTo(app, app.tasks[3], null, null);
  assert.deepEqual([v.task(3).due_date, key(3)], [ZERO, 'nodate'], 'its date taken off: under Added today, no date, made today');
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', 3, 'cap']);
  await moveTo(app, app.tasks[4], null, null);
  assert.equal(v.task(4).due_date, ZERO);
  assert.equal(shown(4), false, 'made before today, with no date: off Today');
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', null, 'cap']);
});

test('every date changed by a hold has an Undo, which puts back the date and the time it had', async c => {
  const { v, app, shown, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString(), created: new Date(2026, 8, 1).toISOString() },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() }, { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]); app.view.groups[0].tasks.push(app.tasks[2]); app.view.groups[3].tasks.push(app.tasks[3]);
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1), app.flashed.arrived], [at(7, 16), 'today', [1]], 'back today at 4 PM, lit up where it was');
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.equal(v.task(2).due_date, at(7, 15), 'its time gone by: the next whole hour');
  await app.toast.action.fn();
  assert.deepEqual([v.task(2).due_date, key(2)], [at(6, 9), 'overdue'], 'back overdue, at the time it had, not the hour it was given');
  await moveTo(app, app.tasks[1], null, null);
  assert.deepEqual([v.task(1).due_date, shown(1)], [ZERO, false], 'No date: off Today, not being made today');
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'its date and its time back, and it on Today');
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  await app.toast.action.fn();
  assert.deepEqual([v.task(3).due_date, key(3)], [ZERO, 'nodate'], 'one that had no date has none again');
  // Tapping Undo before Vikunja answers the move makes Undo wait for the answer, then restore the date.
  const real = globalThis.fetch;
  let answer;
  const held = new Promise(r => { answer = r; });
  globalThis.fetch = async (...a) => { await held; return real(...a); };
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await new Promise(setImmediate);
  assert.deepEqual(said(app), ['Moved to tomorrow', 'Undo', 1, 'cap'], 'said before it\'s saved');
  const undone = app.toast.action.fn();
  answer(); globalThis.fetch = real;
  assert.equal(await going, true);
  await undone;
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'moved, then moved back');
  // If the task changed elsewhere since the move, Undo leaves it as it is and shows a message.
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  const undo = app.toast.action;
  v.task(1).updated = new Date(2026, 9, 7, 14, 30).toISOString();
  await undo.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(9, 16), 'week'], 'not written over');
  assert.deepEqual([app.toast.msg, app.toast.place, app.toast.cls], ['1 task couldn\'t be moved back (changed since, or not saved) and is still due Fri 9.', 'cap', 'failed']);
});

test('a row moved and not saved goes back, its place saying so with Try again, and its Undo then does nothing', async c => {
  const { v, app, at, key } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  v.trouble = () => 'offline';
  assert.equal(await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9'), false);
  assert.deepEqual([app.tasks[1].due_date, key(1)], [at(7, 16), 'today'], 'back where it was');
  assert.deepEqual([app.toast.msg, app.toast.action.label, app.toast.cls], ['Not saved: no connection', 'Try again', 'failed']);
  const sent = v.requests.length;
  await app.toasts.at(-2).action.fn();
  assert.deepEqual([app.toasts.at(-2).msg, v.requests.length], ['Moved to Fri 9', sent], 'the Undo said with the move: nothing to put back');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(9, 16), 'week'], 'Try again: moved');
});

test('a card moved to a new date moves only its task\'s date; one whose subtask is due sooner stays, and says why; each with its Undo', async c => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const sub = (id, due) => ({ id, title: 'Sub ' + id, done: false, due_date: due, related_tasks: { parenttask: [{ id: id - 1 }] } });
  const { v, app, key } = onToday(c, [
    { id: 10, title: 'Paint the hall', due_date: at(7, 17), related_tasks: { subtask: [{ id: 11 }] } }, sub(11, ZERO),
    { id: 20, title: 'Fix the van', due_date: ZERO, related_tasks: { subtask: [{ id: 21 }] } }, sub(21, at(7, 18)),
  ], { 10: { when: at(7, 17), made: null, focus: null }, 20: { when: at(7, 18), made: null, focus: null } });
  app.view.groups[1].tasks.push(app.tasks[10], app.tasks[20]);
  await moveTo(app, app.tasks[10], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)], [at(9, 17), ZERO, at(9, 17), 'week'], 'its task\'s date only; the card goes with it');
  assert.deepEqual(said(app), ['Moved to Fri 9', 'Undo', 10, 'cap']);
  await app.toast.action.fn();
  assert.deepEqual([v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)], [at(7, 17), ZERO, at(7, 17), 'today'], 'Undo: the card back where it was');
  await moveTo(app, app.tasks[20], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual([v.task(20).due_date, v.task(21).due_date, key(20)], [at(9, 0), at(7, 18), 'today'], 'Friday, with no time; its subtask due today keeps it under Today');
  assert.deepEqual(said(app), ['Moved to Fri 9. Its subtask “Sub 21” is due sooner, so it stays here.', 'Undo', null, 'cap'], 'said by the add box, where the whole sentence fits, with its Undo');
  await app.toast.action.fn();
  assert.deepEqual([v.task(20).due_date, v.task(21).due_date, key(20)], [ZERO, at(7, 18), 'today'], 'Undo: its date off again, its subtask\'s as it was');
});

/* A title being edited, in the box in the sheet's own row or in a template's box over its card, is saved when the box
   loses focus. A sheet that is slid down or closed with the phone's Back doesn't take focus from the box, and on an
   iPhone there is no button to move the focus to. So leaving the sheet saves the title too, once, whichever happens
   first. */
test('a title being changed is saved when its sheet closes, however it closes, and once; emptied, it stays as it was', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Wipe the menus', project_id: 1 }, { id: 2, title: 'TEMPLATE: Opening', project_id: 1, done: true, labels: [{ id: 9, title: 'template' }] }]);
  const app = component(tasks, actions, views, sheet);
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
    assert.deepEqual(await sent(), [[1, { title: 'Wipe the menus and the tables' }]], 'saved as the sheet is left');
    assert.equal(app.sheet.titleEdit, false);
    app.saveTitle();                                                           // the box's blur comes later
    c.mock.timers.tick(300);                                                   // the sheet has closed
    app.saveTitle();                                                           // or the blur comes only now, as the box goes with the sheet
    assert.equal((await sent()).length, 1, 'once');
    // An emptied title stays as it was.
    open(1);
    app.editTitle();
    app.sheet.title = '   ';
    app.closeSheet(true);
    assert.equal((await sent()).length, 1, 'nothing sent for a title emptied');
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
  } finally { delete document.activeElement; delete document.getElementById; delete globalThis.history; }
});

/* On a desktop, Escape closes the innermost thing first. That is the task's ⋯ menu, wherever the focus is, and the
   focus then goes back to ⋯. Only after that does Escape close the sheet. With no sheet open it does nothing. */
test('Escape closes the task\'s menu before its sheet, the focus back on ⋯', () => {
  const app = component(sheet), did = [];
  document.getElementById = id => ({ focus: () => did.push('focus ' + id) });
  app.closeSheet = () => did.push('close');
  try {
    app.sheet = { open: true, menu: true };
    app.escapeKey();
    assert.deepEqual([app.sheet.menu, did], [false, ['focus d-more']], 'the menu first, the sheet left open');
    app.escapeKey();
    assert.deepEqual(did, ['focus d-more', 'close'], 'then the sheet');
    app.sheet = { open: false, menu: false };
    app.escapeKey();
    assert.equal(did.length, 2, 'nothing open: nothing done');
  } finally { delete document.getElementById; }
});

/* "Turn into its own task" (ownTask, in the ⋯ menu on a subtask's sheet) removes the subtask from under its parent and
   puts it right after the parent in the project's List view. The old parent's calculated progress is then written
   without the subtask. A message with an Undo appears at the top of the sheet, and Undo puts the subtask back under
   its parent where it was. It is not available for a checklist's step or a template's. */
test('a subtask made its own task leaves its parent, goes right after it, and the parent\'s progress is worked out without it; Undo puts it back', async () => {
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.5, project_id: 5, related_tasks: { subtask: [{ id: 11 }, { id: 12 }] } };
  const kid = (id, f = {}) => ({ id, title: 'Kid ' + id, done: false, percent_done: 0, project_id: 5, related_tasks: { parenttask: [{ id: 10, title: 'Pack the van', project_id: 5 }] }, ...f });
  const v = fakeVikunja([parent, kid(11, { done: true }), kid(12)]), app = component(tasks, actions), moves = [];
  Object.defineProperties(app, Object.getOwnPropertyDescriptors({
    positions: { 10: 1000, 11: 100, 12: 200 }, projById: new Map([[5, { id: 5, views: [{ id: 7, view_kind: 'list', position: 1 }] }]]), cursor: null,
    canEdit: true, checklistRole: null, get parentTask(){ return this.sheet.task?.related_tasks?.parenttask?.[0] || null; },
    showTask(t){ Object.assign(this.sheet.task, t); }, linkSubtask: sending.linkSubtask,
    act: async a => { moves.push([a.op, a.task, a.view, a.pos]); return { status: 'sent' }; } }));
  app.keep(v.task(10)); app.keep(v.task(12));
  app.sheet = { kind: 'task', task: structuredClone(v.task(12)) };
  app.checklistRole = 'step';
  assert.equal(app.canOwn, false, 'not a run\'s step');
  app.checklistRole = null;
  assert.equal(app.canOwn, true);
  await app.ownTask();
  assert.deepEqual([v.task(12).related_tasks.parenttask, v.task(10).related_tasks.subtask.map(s => s.id)], [[], [11]], 'out from under it, on both sides');
  assert.deepEqual(moves, [['position', 12, 7, 1000.01]], 'right after its old parent: its list not on screen to say what\'s next, a little after it');
  assert.deepEqual([app.sheet.task.related_tasks.parenttask, app.tasks[12].related_tasks.parenttask, app.canOwn], [[], [], false], 'on its sheet and its row');
  assert.deepEqual(patches(v).at(-1), [10, { percent_done: 1 }], 'its old parent\'s progress, without it');
  assert.deepEqual([app.toast.msg, app.toast.place, app.toast.action.label], ['No longer a subtask of “Pack the van”', 'sheet:top', 'Undo']);
  await app.toast.action.fn();
  assert.deepEqual([v.task(12).related_tasks.parenttask.map(p => p.id), v.task(10).related_tasks.subtask.map(s => s.id)], [[10], [11, 12]], 'Undo: under it again');
  assert.deepEqual([moves.at(-1), patches(v).at(-1)], [['position', 12, 7, 200], [10, { percent_done: 0.5 }]], 'where it was among the subtasks, and counted again');
  // If Vikunja refuses, a message with Try again appears and nothing changes.
  v.trouble = r => r.method === 'DELETE' ? 403 : null;
  await app.ownTask();
  assert.deepEqual([app.toast.action.label, app.toast.cls, v.task(12).related_tasks.parenttask.map(p => p.id), moves.length], ['Try again', 'failed', [10], 2]);
});
