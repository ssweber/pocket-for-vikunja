// Tests for moving a task's date on Today and Move all (src/js/app/actions.js), against a fake Vikunja: the row moves
// at once, the change waits offline, and Undo puts the date back.
import './browser.mjs';
import { collected, DAY, patches } from './actions-helpers.mjs';
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks, { started, TASK } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import acts, { undosKept } from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import cards from '../../src/js/app/cards.js';
import alerts from '../../src/js/app/alerts.js';
import { todayGroups } from '../../src/js/lists.js';
import { movedDue } from '../../src/js/dates.js';
import { sync } from '../../src/js/sync.js';

test('Move all to today moves each overdue task to today at its time, or with no time if that time has passed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
    { id: 3, title: 'Repeats', due_date: at(6, 8), repeat_after: DAY },
  ]);
  const app = overdueApp(t);
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
// Move all to today queues one `due` op for each task, so it needs the outbox and its sender, which is emptied after the test.
const overdueApp = t => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const app = component(tasks, actions, cards, sending, acts, outbox);
  return Object.assign(app, {
    user: { id: 1 },
    pending: [],
    failed: [],
    slow: [],
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
    places: {},
    endPlace() {},
    aimSent() {},
    toasts: [{}],
  });
};
test('Move all made offline shows its message at once, and moves each task once when the connection is back', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
    { id: 3, title: 'Order cups', due_date: at(6, 10) },
  ]);
  const app = overdueApp(t);
  app.change(w =>
    w.read(
      [1, 2, 3].map(id => structuredClone(v.task(id))),
      TASK,
      started(),
    ),
  );
  app.view.groups = [{ key: 'overdue', tasks: [1, 2, 3].map(id => app.row(v.task(id))) }];
  app.offline = true;
  await app.moveOverdueToToday();
  // The unit tests have no IndexedDB, so the outbox is kept in memory, and Pocket also asks to be kept open.
  const moved = app.toasts.find(x => x.msg === 'Moved 3 to today');
  assert.deepEqual([moved.action.label, moved.place], ['Undo', 'overdue']);
  assert.deepEqual(
    [[1, 2, 3].map(id => app.tasks[id].due_date), sync.all(1).length, v.requests.length],
    [[at(7, 0), at(7, 18, 30), at(7, 0)], 3, 0],
    'the rows move at once, and the moves wait',
  );
  // Vikunja refuses the second task's move, which stays in the Outbox. The others are moved once each.
  app.offline = false;
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/2' ? 403 : null);
  await app.flush();
  assert.deepEqual(
    [v.task(1).due_date, v.task(2).due_date, v.task(3).due_date, app.tasks[2].due_date],
    [at(7, 0), at(6, 18, 30), at(7, 0), at(6, 18, 30)],
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.action?.label, app.failed.map(e => e.task)],
    ["Moving “Evening one” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox', [2]],
  );
  assert.deepEqual(
    patches(v).map(([id]) => id),
    [1, 2, 3],
    'one request for each task',
  );
  // Undo moves each task back, leaves the refused move out of the Outbox, and leaves a task whose date changed since.
  v.trouble = () => null;
  v.task(3).due_date = at(8, 10);
  await moved.action.fn();
  assert.deepEqual(
    [v.task(1).due_date, v.task(2).due_date, v.task(3).due_date, sync.all(1).length],
    [at(5, 9), at(6, 18, 30), at(8, 10), 0],
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.place, app.toast.cls],
    ['Not undone: 1 task has changed since then. It stays due today.', 'overdue', 'failed'],
  );
});
/* Holding a row or card on Today and moving it to a new date (app/throw.js). Each move is a `due` op sent through the
   outbox, as Move all to today's are. Each move has an Undo for a few seconds that restores the date and time the task
   had. There is no screen here. `seen` holds the tasks whose row is in sight once the task is in its new place
   (rowSeen). That decides where the message with the Undo appears, on the task's row or by the add box. The outbox is
   emptied after each test. */
const onToday = (c, list, cardsBy = {}) => {
  c?.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  c?.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const v = fakeVikunja(list),
    app = component(tasks, actions, cards, alerts, sending, acts, outbox),
    seen = new Set(list.map(t => t.id));
  const shown = id => app.listBase.some(g => g.tasks.some(t => t.id === id)); // whether the task is on one of Today's lists as drawn
  Object.assign(app, {
    setBadge() {},
    lines: {},
    positions: {},
    route: { name: 'today' },
    pending: [],
    failed: [],
    slow: [],
    user: { id: 1 },
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
    places: {},
    endPlace() {},
    aimSent() {},
    toasts: [{}],
    flashed: {},
    flash(ids, kind) {
      this.flashed[kind] = ids;
    },
    $nextTick: async () => {},
    rowSeen: id => seen.has(id) && shown(id),
  });
  app.view = { groups: todayGroups(), cards: cardsBy };
  for (const t of list) app.row(v.task(t.id));
  return {
    v,
    app,
    seen,
    shown,
    at: (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(),
    key: id => app.todayKey(app.tasks[id]),
  };
};
const moveTo = (app, t, day, label) =>
  app.reschedule(t, { label, due: day ? movedDue(t.due_date, day, new Date()) : ZERO });
const ZERO = '0001-01-01T00:00:00Z';
// The last message and where it appears: its text, its action's label, the id of the row it is on (or null) and the
// place it goes otherwise.
const said = app => {
  const s = app.toast;
  return [s.msg, s.action?.label ?? null, s.row?.id ?? null, s.place];
};
// The last message with an Undo. Offline, a message that the phone couldn't keep the move follows it.
const lastUndo = app => app.toasts.findLast(x => x.action?.label === 'Undo');
test('moving a row to a new date keeps its time of day, moves it at once, and shows an Undo on its row or by the add box', async c => {
  const { v, app, seen, shown, at, key } = onToday(c, [
    { id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() },
    { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() },
    {
      id: 4,
      title: 'Fix the gate',
      due_date: new Date(2026, 9, 7, 17).toISOString(),
      created: new Date(2026, 8, 1).toISOString(),
    },
  ]);
  app.view.groups[1].tasks.push(app.tasks[1], app.tasks[4]);
  app.view.groups[0].tasks.push(app.tasks[2]);
  app.view.groups[3].tasks.push(app.tasks[3]);
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual(
    [app.tasks[1].due_date, key(1)],
    [at(9, 16), 'week'],
    'the task moves on screen at once, before Vikunja answers',
  );
  assert.equal(await going, true);
  assert.equal(v.task(1).due_date, at(9, 16), 'the task moves to Friday and keeps its time of day, 4 PM');
  assert.deepEqual(
    said(app),
    ['Moved to Fri 9', 'Undo', 1, 'cap'],
    'the message with Undo appears on the row, in its new position',
  );
  assert.equal(app.toast.row.stays, true, 'the row returns once the message goes');
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.deepEqual(
    [v.task(2).due_date, key(2)],
    [at(7, 0), 'today'],
    'an overdue task moves to today with no time, because its time has passed',
  );
  assert.deepEqual(said(app), ['Moved to today', 'Undo', 2, 'cap']);
  await moveTo(app, app.tasks[3], new Date(), 'Today');
  assert.deepEqual(
    [v.task(3).due_date, key(3)],
    [at(7, 0), 'today'],
    'a task with no date moves to today with no time',
  );
  seen.delete(3);
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  assert.deepEqual(
    [key(3), said(app)],
    ['week', ['Moved to tomorrow', 'Undo', null, 'cap']],
    'the task is still on Today but its row is scrolled out of sight, so the message appears by the add box',
  );
  await moveTo(app, app.tasks[1], new Date(2026, 9, 19), 'Mon 19');
  assert.deepEqual(
    [v.task(1).due_date, key(1)],
    [at(19, 16), null],
    'a date past the next 7 days takes the task off Today',
  );
  assert.deepEqual(
    said(app),
    ['Moved to Mon 19', 'Undo', null, 'cap'],
    'with no row left, the message appears by the add box',
  );
  seen.add(3);
  await moveTo(app, app.tasks[3], null, null);
  assert.deepEqual(
    [v.task(3).due_date, key(3)],
    [ZERO, 'nodate'],
    'removing the date puts a task created today under Added today, no date',
  );
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', 3, 'cap']);
  await moveTo(app, app.tasks[4], null, null);
  assert.equal(v.task(4).due_date, ZERO);
  assert.equal(shown(4), false, 'a task created before today with no date is off Today');
  assert.deepEqual(said(app), ['Removed its due date', 'Undo', null, 'cap']);
});
test('every date changed by a hold has an Undo that restores the date and time the task had', async c => {
  const { v, app, shown, at, key } = onToday(c, [
    {
      id: 1,
      title: 'Call the plumber',
      due_date: new Date(2026, 9, 7, 16).toISOString(),
      created: new Date(2026, 8, 1).toISOString(),
    },
    { id: 2, title: 'Order milk', due_date: new Date(2026, 9, 6, 9).toISOString() },
    { id: 3, title: 'No date yet', due_date: ZERO, created: new Date(2026, 9, 7, 9).toISOString() },
  ]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  app.view.groups[0].tasks.push(app.tasks[2]);
  app.view.groups[3].tasks.push(app.tasks[3]);
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(1).due_date, key(1), app.flashed.arrived],
    [at(7, 16), 'today', [1]],
    'the task is back today at 4 PM and highlighted where it was',
  );
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.equal(v.task(2).due_date, at(7, 0), 'a time that has passed becomes today with no time');
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(2).due_date, key(2)],
    [at(6, 9), 'overdue'],
    'Undo makes the task overdue again at its old time',
  );
  await moveTo(app, app.tasks[1], null, null);
  assert.deepEqual([v.task(1).due_date, shown(1)], [ZERO, false], 'No date takes the task off Today');
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(1).due_date, key(1)],
    [at(7, 16), 'today'],
    'Undo restores the date and time, and the task is back on Today',
  );
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  await app.toast.action.fn();
  assert.deepEqual([v.task(3).due_date, key(3)], [ZERO, 'nodate'], 'a task that had no date has none again');
  // Undo tapped before Vikunja answers the move is sent after it, and restores the date.
  const real = globalThis.fetch;
  let answer;
  const held = new Promise(r => {
    answer = r;
  });
  globalThis.fetch = async (...a) => {
    await held;
    return real(...a);
  };
  const going = moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await new Promise(setImmediate);
  assert.deepEqual(said(app), ['Moved to tomorrow', 'Undo', 1, 'cap'], 'the message appears before the move is saved');
  const undone = app.toast.action.fn();
  answer();
  globalThis.fetch = real;
  assert.equal(await going, true);
  await undone;
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'the task is moved and then moved back');
  // A change to the task's title since the move doesn't stop Undo. A change to its date does, and Undo says so.
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  v.task(1).title = 'Call the plumber about the boiler';
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'Undo puts the date back');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  const undo = app.toast.action;
  v.task(1).due_date = at(10, 16);
  await undo.fn();
  assert.deepEqual(
    [v.task(1).due_date, app.tasks[1].due_date, key(1)],
    [at(10, 16), at(10, 16), 'week'],
    'Undo leaves the newer date, and the row shows it',
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.place, app.toast.cls],
    ['Not undone: “Call the plumber about the boiler” has changed since then. It stays due Fri 9.', 'cap', 'failed'],
  );
});
test('a move made offline shows at once and waits, Undo takes it back without sending, and a later move replaces it', async c => {
  const { v, app, at, key } = onToday(c, [
    { id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() },
  ]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  app.offline = true;
  assert.equal(await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9'), true);
  // The unit tests have no IndexedDB, so the outbox is kept in memory, and Pocket also asks to be kept open.
  const moved = app.toasts.find(x => x.msg === 'Moved to Fri 9');
  assert.deepEqual(
    [app.tasks[1].due_date, key(1), moved.action.label, moved.row.id],
    [at(9, 16), 'week', 'Undo', 1],
    'the row moves, and the message is the same as online',
  );
  await moved.action.fn();
  assert.deepEqual(
    [app.tasks[1].due_date, key(1), sync.all(1).length, v.requests.length],
    [at(7, 16), 'today', 0, 0],
    'Undo takes the move out of the outbox',
  );
  await moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual(
    sync.all(1).map(e => [e.was, e.due]),
    [[at(7, 16), at(9, 16)]],
    'the second move takes the place of the first',
  );
  app.offline = false;
  await app.flush();
  assert.deepEqual([v.requests.filter(r => r.method === 'PATCH').length, v.task(1).due_date], [1, at(9, 16)]);
});
test('a move Vikunja refuses goes back and shows a message with Try again, and its Undo then does nothing', async c => {
  const { v, app, at, key } = onToday(c, [
    { id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() },
  ]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  v.trouble = () => 403;
  assert.equal(await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9'), false);
  assert.deepEqual(
    [app.tasks[1].due_date, key(1), sync.all(1).length],
    [at(7, 16), 'today', 0],
    'the task is back where it was, and the move is not kept',
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.action.label, app.toast.cls],
    ["Moving a task couldn't be saved: HTTP 403 from the fake.", 'Try again', 'failed'],
  );
  const sent = v.requests.length;
  await app.toasts.at(-2).action.fn();
  assert.deepEqual(
    [app.toasts.at(-2).msg, v.requests.length],
    ['Moved to Fri 9', sent],
    'the Undo from the move has nothing to restore',
  );
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.deepEqual([v.task(1).due_date, key(1)], [at(9, 16), 'week'], 'Try again moves the task');
});
test("moving a card changes only its task's date, and a card with a sooner subtask stays and says why", async c => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const sub = (id, due) => ({
    id,
    title: 'Sub ' + id,
    done: false,
    due_date: due,
    related_tasks: { parenttask: [{ id: id - 1 }] },
  });
  const { v, app, key } = onToday(
    c,
    [
      { id: 10, title: 'Paint the hall', due_date: at(7, 17), related_tasks: { subtask: [{ id: 11 }] } },
      sub(11, ZERO),
      { id: 20, title: 'Fix the van', due_date: ZERO, related_tasks: { subtask: [{ id: 21 }] } },
      sub(21, at(7, 18)),
    ],
    { 10: { when: at(7, 17), made: null, focus: null }, 20: { when: at(7, 18), made: null, focus: null } },
  );
  app.view.groups[1].tasks.push(app.tasks[10], app.tasks[20]);
  await moveTo(app, app.tasks[10], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual(
    [v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)],
    [at(9, 17), ZERO, at(9, 17), 'week'],
    "only the task's date changes, and the card moves with it",
  );
  assert.deepEqual(said(app), ['Moved to Fri 9', 'Undo', 10, 'cap']);
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)],
    [at(7, 17), ZERO, at(7, 17), 'today'],
    'Undo puts the card back where it was',
  );
  await moveTo(app, app.tasks[20], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual(
    [v.task(20).due_date, v.task(21).due_date, key(20)],
    [at(9, 0), at(7, 18), 'today'],
    'the task moves to Friday with no time, and its subtask due today keeps it under Today',
  );
  assert.deepEqual(
    said(app),
    ['Moved to Fri 9. Its subtask “Sub 21” is due sooner, so it stays here.', 'Undo', null, 'cap'],
    'the message with Undo appears by the add box, where the whole sentence fits',
  );
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(20).due_date, v.task(21).due_date, key(20)],
    [ZERO, at(7, 18), 'today'],
    "Undo removes the task's date again and leaves the subtask's date as it was",
  );
});
test('Undo of a move that replaced an earlier one puts the row, or the card, where the date before both puts it', async c => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const { app, key } = onToday(
    c,
    [
      { id: 1, title: 'Call the plumber', due_date: at(7, 16) },
      { id: 2, title: 'No date yet', due_date: ZERO, created: at(7, 9) },
      { id: 10, title: 'Paint the hall', due_date: at(7, 17), related_tasks: { subtask: [{ id: 11 }] } },
      { id: 11, title: 'Sub 11', done: false, due_date: ZERO, related_tasks: { parenttask: [{ id: 10 }] } },
    ],
    { 10: { when: at(7, 17), made: null, focus: null } },
  );
  app.view.groups[1].tasks.push(app.tasks[1], app.tasks[10]);
  app.view.groups[3].tasks.push(app.tasks[2]);
  app.offline = true;
  const back = [];
  for (const id of [1, 2, 10]) {
    await moveTo(app, app.tasks[id], new Date(2026, 9, 8), 'Tomorrow');
    await moveTo(app, app.tasks[id], new Date(2026, 9, 9), 'Fri 9');
    await lastUndo(app).action.fn();
    back.push([app.tasks[id].due_date, key(id)]);
  }
  assert.deepEqual(back, [
    [at(7, 16), 'today'],
    [ZERO, 'nodate'],
    [at(7, 17), 'today'],
  ]);
  assert.deepEqual(
    [app.view.cards[10].when, sync.all(1).length],
    [at(7, 17), 0],
    "the card's date is worked out again, and nothing is left to send",
  );
});
test('a task moved again after Move all keeps its new date when Move all is undone, and the message counts it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
  ]);
  const app = overdueApp(t);
  Object.assign(app, {
    lines: {},
    positions: {},
    flashed: {},
    flash() {},
    $nextTick: async () => {},
    rowSeen: () => true,
    view: { groups: todayGroups(), cards: {} },
  });
  app.change(w =>
    w.read(
      [1, 2].map(id => structuredClone(v.task(id))),
      TASK,
      started(),
    ),
  );
  app.view.groups[0].tasks.push(...[1, 2].map(id => app.row(v.task(id))));
  app.offline = true;
  await app.moveOverdueToToday();
  const moved = app.toasts.find(x => x.msg === 'Moved 2 to today');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await moved.action.fn();
  assert.deepEqual(
    [app.tasks[1].due_date, app.tasks[2].due_date, sync.all(1).map(e => [e.task, e.was, e.due])],
    [at(9, 0), at(6, 18, 30), [[1, at(5, 9), at(9, 0)]]],
    'the task moved since keeps its move, and the other goes back',
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.place],
    ['Not undone: 1 task has changed since then. It stays due today.', 'overdue'],
  );
});
test('Undo of Move all shows the old dates at once, while the moves are still being sent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 7, 14, 20) });
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const v = fakeVikunja([
    { id: 1, title: 'Morning one', due_date: at(5, 9) },
    { id: 2, title: 'Evening one', due_date: at(6, 18, 30) },
  ]);
  const app = overdueApp(t);
  app.change(w =>
    w.read(
      [1, 2].map(id => structuredClone(v.task(id))),
      TASK,
      started(),
    ),
  );
  app.view.groups = [{ key: 'overdue', tasks: [1, 2].map(id => app.row(v.task(id))) }];
  // Vikunja's answers wait until `answer()`, so the outbox stays busy sending the first move.
  const real = globalThis.fetch;
  let answer,
    asked = 0;
  const held = new Promise(r => {
    answer = r;
  });
  globalThis.fetch = async (...a) => {
    asked++;
    await held;
    return real(...a);
  };
  try {
    const moving = app.moveOverdueToToday();
    while (!asked) await new Promise(setImmediate);
    const undoing = app.toasts.find(x => x.msg === 'Moved 2 to today').action.fn();
    assert.deepEqual(
      [app.tasks[1].due_date, app.tasks[2].due_date],
      [at(5, 9), at(6, 18, 30)],
      'the rows show the old dates at once',
    );
    answer();
    await moving;
    await undoing;
    assert.deepEqual(
      [v.task(1).due_date, v.task(2).due_date, app.tasks[1].due_date, sync.all(1).length],
      [at(5, 9), at(6, 18, 30), at(5, 9), 0],
    );
  } finally {
    globalThis.fetch = real;
  }
});
// The messages end, and their Undos with them. act() reads the last message, so a blank one is left.
const messagesGone = app => app.toasts.splice(0, Infinity, { msg: '' });
test('Pocket forgets what it kept to undo a move once its Undo has gone, or has run', async c => {
  const { app } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  await collected(); // what earlier tests kept
  const n = undosKept();
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await collected();
  assert.equal(undosKept(), n + 1);
  messagesGone(app);
  await collected();
  assert.equal(undosKept(), n, 'its message has gone');
  app.offline = true;
  await moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 10), 'Sat 10');
  await collected();
  assert.equal(undosKept(), n + 2, 'a move that replaced another keeps both Undos');
  await lastUndo(app).action.fn();
  messagesGone(app);
  await collected();
  assert.equal(undosKept(), n, "one Undo has run, and the other's message has gone");
});
