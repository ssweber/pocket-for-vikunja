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
import leaving from '../../src/js/app/leaving.js';
import { isMovedGap, todayGroups } from '../../src/js/lists.js';
import { movedDue } from '../../src/js/dates.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import views from '../../src/js/app/views.js';
import { startOfDay } from '../../src/js/dates.js';

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
  const app = component(tasks, actions, cards, sending, acts, outbox, leaving);
  t.after(async () => {
    app.clearNow();
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
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
   outbox, as Move all to today's are. The row shows at its new place at once, and leaves a gap where it was, with an
   Undo that restores the date and time the task had, until the batch clears (leaveGap). There is no screen here. The
   gaps are read from the rows Today would draw (listBase). The outbox, and the batch, are emptied after each test. */
const onToday = (c, list, cardsBy = {}, apis = ['Date']) => {
  c?.mock.timers.enable({ apis, now: new Date(2026, 9, 7, 14, 20) });
  const v = fakeVikunja(list),
    app = component(tasks, actions, cards, alerts, sending, acts, outbox, leaving);
  c?.after(async () => {
    app.clearNow();
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
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
  });
  app.view = { groups: todayGroups(), cards: cardsBy };
  for (const t of list) app.row(v.task(t.id));
  return {
    v,
    app,
    shown,
    at: (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString(),
    key: id => app.todayKey(app.tasks[id]),
    // The ids on Today's group `k` as drawn, a gap as its words.
    rows: k => app.listBase.find(g => g.key === k).tasks.map(t => (isMovedGap(t) ? t.text : t.id)),
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
// Every gap on Today's rows, as [the group's key, its words].
const gaps = app => app.listBase.flatMap(g => g.tasks.filter(isMovedGap).map(t => [g.key, t.text]));
// Tap the last gap task `id` left, which undoes its move. Returns what the Undo returns.
const tapGap = (app, id) => app.unmark(app.listBase.flatMap(g => g.tasks).findLast(t => t.gapOf === id).id);
test('a row thrown from Next 7 days to Today leaves a gap saying Moved to Today, and the task shows in Today', async c => {
  const { v, app, at, key, rows } = onToday(c, [
    { id: 1, title: 'Order milk', due_date: new Date(2026, 9, 9, 9).toISOString() },
    { id: 2, title: 'Call the plumber', due_date: new Date(2026, 9, 10, 16).toISOString() },
    { id: 3, title: 'Fix the gate', due_date: new Date(2026, 9, 11, 17).toISOString() },
  ]);
  app.view.groups[4].tasks.push(app.tasks[1], app.tasks[2], app.tasks[3]);
  const going = moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.deepEqual(
    [app.tasks[2].due_date, key(2), rows('week'), rows('today')],
    [at(7, 16), 'today', [1, 'Moved to Today', 3], [2]],
    'the row is in Today at once, and its gap is where it was',
  );
  assert.equal(app.said, 'Moved to Today: Call the plumber', 'a screen reader hears where it went');
  assert.equal(await going, true);
  assert.equal(v.task(2).due_date, at(7, 16), 'the task moves to today and keeps its time of day, 4 PM');
  assert.deepEqual(app.toasts, [{}], 'nothing else is said, and the row in Today has no message');
  // Each date names its day in the gap it leaves, Tomorrow and No date as their chips do.
  await moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await moveTo(app, app.tasks[3], null, null);
  assert.deepEqual(
    rows('week'),
    ['Moved to Tomorrow', 1, 'Moved to Today', 'Moved to No date'],
    'each gap stays under the row that was above its row',
  );
});
test('the gap leaves with the batch, and stays while a finger is down', async c => {
  const { app, rows } = onToday(
    c,
    [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 10, 16).toISOString() }],
    {},
    ['Date', 'setTimeout'],
  );
  app.view.groups[4].tasks.push(app.tasks[1]);
  // The batch listens for fingers on the page (initBatch), and folds the rows leaving on it (clearBatch).
  const on = {},
    was = document.querySelectorAll;
  document.addEventListener = (type, fn) => (on[type] ||= []).push(fn);
  globalThis.addEventListener = (type, fn) => (on[type] ||= []).push(fn);
  document.querySelectorAll = () => [];
  c.after(() => {
    delete document.addEventListener;
    delete globalThis.addEventListener;
    if (was) document.querySelectorAll = was;
    else delete document.querySelectorAll;
  });
  app.initBatch();
  const finger = type => on[type].forEach(fn => fn({ pointerId: 1 }));
  await moveTo(app, app.tasks[1], new Date(), 'Today');
  finger('pointerdown');
  c.mock.timers.tick(5000);
  await new Promise(setImmediate);
  assert.deepEqual(rows('week'), ['Moved to Today'], 'the gap stays while a finger is down');
  finger('pointerup');
  c.mock.timers.tick(2999);
  await new Promise(setImmediate);
  assert.deepEqual(rows('week'), ['Moved to Today'], 'and for 3 seconds after');
  c.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.deepEqual([rows('week'), rows('today'), app.leaving], [[], [1], {}], 'then it leaves');
});
test('Undo puts the task back in Next 7 days where its gap was, and takes it out of Today', async c => {
  const { v, app, at, rows } = onToday(c, [
    { id: 1, title: 'Order milk', due_date: new Date(2026, 9, 9, 9).toISOString() },
    { id: 2, title: 'Call the plumber', due_date: new Date(2026, 9, 10, 16).toISOString() },
    { id: 3, title: 'Fix the gate', due_date: new Date(2026, 9, 11, 17).toISOString() },
  ]);
  app.view.groups[4].tasks.push(app.tasks[1], app.tasks[2], app.tasks[3]);
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  await tapGap(app, 2);
  assert.deepEqual(
    [v.task(2).due_date, rows('week'), rows('today'), app.flashed.arrived, app.leaving],
    [at(10, 16), [1, 2, 3], [], [2], {}],
    'the task is back at 4 PM on Saturday, highlighted where its gap was',
  );
});
test('a row thrown 10 days ahead leaves a gap naming the day, and the task is on none of Today’s groups', async c => {
  const { v, app, at, shown, rows } = onToday(c, [
    { id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 10, 16).toISOString() },
  ]);
  app.view.groups[4].tasks.push(app.tasks[1]);
  await moveTo(app, app.tasks[1], new Date(2026, 9, 17), 'Sat 17');
  assert.deepEqual(
    [v.task(1).due_date, rows('week'), shown(1)],
    [at(17, 16), ['Moved to Sat 17'], false],
    'the gap is the only trace of the task on Today',
  );
  assert.deepEqual(app.toasts, [{}], 'nothing is said beside the add box');
  await tapGap(app, 1);
  assert.deepEqual([v.task(1).due_date, rows('week')], [at(10, 16), [1]], 'Undo brings the task back to its gap');
});
test('a move Vikunja refuses puts the row back in Next 7 days with Try again, and leaves no gap', async c => {
  const { v, app, at, key, rows } = onToday(c, [
    { id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 10, 16).toISOString() },
  ]);
  app.view.groups[4].tasks.push(app.tasks[1]);
  v.trouble = () => 403;
  assert.equal(await moveTo(app, app.tasks[1], new Date(), 'Today'), false);
  assert.deepEqual(
    [app.tasks[1].due_date, key(1), rows('week'), rows('today'), app.leaving, sync.all(1).length],
    [at(10, 16), 'week', [1], [], {}, 0],
    'the task is back where it was, the move is not kept, and the gap is gone',
  );
  assert.deepEqual(said(app), ["Moving a task couldn't be saved: HTTP 403 from the fake.", 'Try again', 1, 'cap']);
  assert.equal(app.toast.cls, 'failed');
  v.trouble = () => null;
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(1).due_date, key(1), rows('week')],
    [at(7, 16), 'today', ['Moved to Today']],
    'Try again moves the task, and leaves the gap',
  );
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
  await tapGap(app, 1);
  assert.deepEqual(
    [v.task(1).due_date, key(1), app.flashed.arrived],
    [at(7, 16), 'today', [1]],
    'the task is back today at 4 PM and highlighted where it was',
  );
  await moveTo(app, app.tasks[2], new Date(), 'Today');
  assert.equal(v.task(2).due_date, at(7, 0), 'a time that has passed becomes today with no time');
  await tapGap(app, 2);
  assert.deepEqual(
    [v.task(2).due_date, key(2)],
    [at(6, 9), 'overdue'],
    'Undo makes the task overdue again at its old time',
  );
  await moveTo(app, app.tasks[1], null, null);
  assert.deepEqual([v.task(1).due_date, shown(1)], [ZERO, false], 'No date takes the task off Today');
  await tapGap(app, 1);
  assert.deepEqual(
    [v.task(1).due_date, key(1)],
    [at(7, 16), 'today'],
    'Undo restores the date and time, and the task is back on Today',
  );
  await moveTo(app, app.tasks[3], new Date(2026, 9, 8), 'Tomorrow');
  await tapGap(app, 3);
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
  assert.deepEqual(gaps(app), [['today', 'Moved to Tomorrow']], 'the gap shows before the move is saved');
  const undone = tapGap(app, 1);
  answer();
  globalThis.fetch = real;
  assert.equal(await going, true);
  await undone;
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'the task is moved and then moved back');
  // A change to the task's title since the move doesn't stop Undo. A change to its date does, and Undo says so.
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  v.task(1).title = 'Call the plumber about the boiler';
  await tapGap(app, 1);
  assert.deepEqual([v.task(1).due_date, key(1)], [at(7, 16), 'today'], 'Undo puts the date back');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  v.task(1).due_date = at(10, 16);
  await tapGap(app, 1);
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
  assert.deepEqual(
    [app.tasks[1].due_date, key(1), gaps(app)],
    [at(9, 16), 'week', [['today', 'Moved to Fri 9']]],
    'the row moves, and leaves the same gap as online',
  );
  await tapGap(app, 1);
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
test("moving a card changes only its task's date, and a card with a sooner subtask stays, leaves no gap and says why", async c => {
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const sub = (id, due) => ({
    id,
    title: 'Sub ' + id,
    done: false,
    due_date: due,
    related_tasks: { parenttask: [{ id: id - 1 }] },
  });
  const { v, app, key, rows } = onToday(
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
  Object.assign(app, { cardAdded: {}, cardOpen: {}, cardPage: {}, rowNow: Date.now }); // what listGroups reads for cards
  assert.deepEqual(
    [v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10), rows('today')],
    [at(9, 17), ZERO, at(9, 17), 'week', ['Moved to Fri 9', 20]],
    "only the task's date changes, and the card moves with it, leaving a gap",
  );
  const g = app.listGroups.find(x => x.key === 'today');
  assert.deepEqual(
    g.items.map(t => (isMovedGap(t) ? t.text : t.id)),
    ['Moved to Fri 9', 20],
    'the gap is a row of its own, never a card',
  );
  await tapGap(app, 10);
  assert.deepEqual(
    [v.task(10).due_date, v.task(11).due_date, app.view.cards[10].when, key(10)],
    [at(7, 17), ZERO, at(7, 17), 'today'],
    'Undo puts the card back where it was',
  );
  await moveTo(app, app.tasks[20], new Date(2026, 9, 9), 'Fri 9');
  assert.deepEqual(
    [v.task(20).due_date, v.task(21).due_date, key(20), gaps(app)],
    [at(9, 0), at(7, 18), 'today', []],
    'the task moves to Friday with no time, and its subtask due today keeps it under Today, with no gap',
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
    await tapGap(app, id);
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
  assert.deepEqual(gaps(app), [], 'Move all leaves no gaps');
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
test('Pocket forgets what it kept to undo a move once its gap has gone, or its Undo has run', async c => {
  const { app } = onToday(c, [{ id: 1, title: 'Call the plumber', due_date: new Date(2026, 9, 7, 16).toISOString() }]);
  app.view.groups[1].tasks.push(app.tasks[1]);
  await collected(); // what earlier tests kept
  const n = undosKept();
  await moveTo(app, app.tasks[1], new Date(2026, 9, 9), 'Fri 9');
  await collected();
  assert.equal(undosKept(), n + 1);
  app.clearNow();
  await collected();
  assert.equal(undosKept(), n, 'its gap has gone');
  app.offline = true;
  await moveTo(app, app.tasks[1], new Date(2026, 9, 8), 'Tomorrow');
  await moveTo(app, app.tasks[1], new Date(2026, 9, 10), 'Sat 10');
  await collected();
  assert.equal(undosKept(), n + 2, 'a move that replaced another keeps both Undos');
  await tapGap(app, 1);
  app.clearNow();
  await collected();
  assert.equal(undosKept(), n, "one Undo has run, and the other's gap has gone");
});

/* A date changed in a task's sheet while offline waits in the outbox, and the row shows it at once, where it was. Today
   then places the row as its load would: by the date the row shows. */
const offlineDates = c => {
  const made = (d, h) => new Date(2026, 9, d, h).toISOString(),
    { app, at } = onToday(
      c,
      [
        { id: 1, title: 'Call the plumber', due_date: made(9, 9), created: made(1, 9) },
        { id: 2, title: 'Fix the gate', due_date: made(9, 10), created: made(7, 9) },
        { id: 3, title: 'Order milk', due_date: made(9, 11), created: made(1, 9) },
      ],
      {},
      ['Date', 'setTimeout'],
    );
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(views));
  Object.assign(app, { render() {}, todayDay: +startOfDay() });
  app.view.route = location.hash;
  app.offline = true;
  const due = (id, to) =>
    app.act({ id: uuid7(), op: 'due', task: id, was: app.tasks[id].due_date, due: to, run: null });
  return { app, at, dates: () => Promise.all([due(1, at(17, 9)), due(2, ZERO), due(3, ZERO)]) };
};
test('a date moved offline 8 or more days ahead, or taken off, leaves Today at the minute’s tick, not for Next 7 days', async c => {
  const { app, dates } = offlineDates(c),
    week = () => app.view.groups.find(g => g.key === 'week').tasks.map(t => t.id);
  app.view.groups.find(g => g.key === 'week').tasks.push(app.tasks[1], app.tasks[2], app.tasks[3]);
  await dates();
  assert.deepEqual(week(), [1, 2, 3], 'the rows stay where they are while the user works');
  // The rows that leave find no elements to fold here.
  const was = document.querySelectorAll;
  document.querySelectorAll = () => [];
  c.after(() => (was ? (document.querySelectorAll = was) : delete document.querySelectorAll));
  app.tickToday();
  await new Promise(setImmediate);
  assert.deepEqual(
    app.view.groups.map(g => [g.key, g.tasks.map(t => t.id)]).filter(([, ids]) => ids.length),
    [['nodate', [2]]],
    'only the task made today stays, under Added today, no date',
  );
});
test('a load that lists tasks by Vikunja’s dates places them by the dates moved offline', async c => {
  const { app, dates } = offlineDates(c);
  await dates();
  const { groups } = app.todayFrom(
    { rows: [1, 2, 3].map(id => ({ t: app.tasks[id], key: 'dated' })), cards: new Map(), parents: [], steps: [] },
    t => app.row(t),
  );
  assert.deepEqual(
    groups.map(g => [g.key, g.tasks.map(t => t.id)]).filter(([, ids]) => ids.length),
    [['nodate', [2]]],
    'Next 7 days has none of them',
  );
});
