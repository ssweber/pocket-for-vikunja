// Tests for ticks and progress (src/js/app/actions.js, src/js/ops/ticks.js), against a fake Vikunja behind the
// plugin's relay: a task, a parent and its subtasks, a swipe, the ✅, Done today, and the Undo of each. In a list, a
// row's tick waits for the batch to clear (leaving.js).
import './browser.mjs';
import './outbox-db.mjs';
import { collected, DAY, fingers, patches, opened } from './actions-helpers.mjs';
import { component, sendStages } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks, { started, TASK } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import { stageContext, undosKept } from '../../src/js/app/acts.js';
import leaving from '../../src/js/app/leaving.js';
import cards from '../../src/js/app/cards.js';
import alerts from '../../src/js/app/alerts.js';
import sheet from '../../src/js/app/sheet.js';
import views from '../../src/js/app/views.js';
import { dayGroup, todayGroups } from '../../src/js/lists.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { movedFrom, OPS } from '../../src/js/ops/index.js';
import { figure } from '../../src/js/ops/stages.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { lastSaid, lostOnce, noConnection, reached, sender } from './ops-helpers.mjs';

const sub = (id, more = {}) => ({ id, title: 'Subtask ' + id, done: false, ...more });
// A parent with four subtasks: two open (one half done), one already done, and one that repeats. Completing a parent
// leaves the repeating subtask alone.
const family = () => {
  const subs = [
    sub(11),
    sub(12, { done: true }),
    sub(13, { repeat_after: DAY, due_date: '2026-10-07T09:00:00Z' }),
    sub(14, { percent_done: 0.5 }),
  ];
  const parent = { id: 10, title: 'Pack the van', done: false, percent_done: 0.25, related_tasks: { subtask: subs } };
  return [parent, ...subs];
};
// The patches that are not a parent's calculated progress, which an op's last stage writes (figure).
const ticks = v => patches(v).filter(([, b]) => !('percent_done' in b && Object.keys(b).length === 1));
// A row in a list, for ticking from there. The test controls the batch's timer, so the batch doesn't clear by itself.
const ROW = {};
/* The sender (ops-helpers.mjs) with the actions and the batch, and `more` parts of the app. Its tasks have rows and
   copies, as a screen's read gives them. */
const listed = (t, list, ...more) => {
  const s = sender(t, list, actions, leaving, ...more);
  s.app.render = () => {}; // no screen loads here, even with the screens' part (views.js)
  s.app.change(w =>
    w.read(
      list.map(x => structuredClone(x)),
      TASK,
      started(),
    ),
  );
  for (const x of list) s.app.row(structuredClone(x));
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  return s;
};
// The ids on Today's group `k`.
const onToday = (app, k) => app.view.groups.find(g => g.key === k).tasks.map(x => x.id);
const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise(ok => setImmediate(ok));
};
test('ticking a parent leaves its subtasks as they are', async t => {
  const { v, app } = listed(t, family());
  await app.toggleDone(app.tasks[10], ROW);
  assert.deepEqual(ticks(v), [[10, { done: true }]]);
  assert.deepEqual(
    [11, 14].map(id => v.task(id).done),
    [false, false],
    'its open subtasks stay open',
  );
  assert.deepEqual([app.leaving, app.said], [{ 10: 'done' }, 'Done: Pack the van']);
});
test('completing a parent with close closes its open subtasks, and undo opens exactly those again', async t => {
  const { v, app } = listed(t, family()),
    p = app.tasks[10];
  await app.toggleDone(p, ROW, { close: true });
  assert.deepEqual(
    patches(v),
    [
      [10, { done: true }],
      [11, { done: true }],
      [14, { done: true }],
      [10, { percent_done: 0.75 }],
    ],
    "the parent's progress is 75%, three of four subtasks done, written once they are all closed",
  );
  assert.equal(p.done, true);
  assert.equal(app.said, 'Closed Pack the van + 2 subtasks', 'a screen reader announces the close');
  assert.deepEqual(app.toasts, [], 'no toast appears, because the row shows the change');
  assert.deepEqual(
    app.leaving,
    { 10: 'done', 11: 'done', 14: 'done' },
    'the parent and the closed subtasks stay in place, marked done, until the batch clears',
  );
  assert.equal(v.task(13).done, false, 'a repeating subtask is left alone');
  assert.deepEqual(
    p.related_tasks.subtask.map(s => app.subRow(s).done),
    [true, true, false, true],
    'the ring counts them as done, from their own rows',
  );

  v.requests.length = 0;
  await app.unmark(10);
  assert.deepEqual(app.leaving, {}, 'no row is marked any more');
  assert.deepEqual(ticks(v), [
    [10, { done: false }],
    [11, { done: false }],
    [14, { done: false }],
  ]);
  assert.equal(v.task(12).done, true, 'the subtask that was done before stays done');
  assert.equal(p.done, false);
  assert.deepEqual(
    [v.task(10).percent_done, v.task(14).percent_done],
    [0.38, 0.5],
    "the parent's progress is calculated again, and the subtask's progress is unchanged",
  );
  assert.deepEqual(
    p.related_tasks.subtask.map(s => app.subRow(s).done),
    [false, true, false, false],
  );
});
test('when the batch clears, a parent completed on Today goes to Done today with the subtasks closed with it', async t => {
  const { v, app } = listed(t, family(), views, cards);
  Object.assign(app.view, { groups: todayGroups(), cards: {} });
  app.view.groups[0].tasks.push(...[10, 11, 13, 14].map(id => app.row(v.task(id))));
  await app.toggleDone(app.tasks[10], ROW, { close: true });
  assert.equal(onToday(app, 'overdue').length, 4, 'the rows are still in place');
  t.mock.timers.tick(2999);
  assert.equal(onToday(app, 'overdue').length, 4, 'the batch does not clear before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(
    [onToday(app, 'overdue'), onToday(app, 'donetoday')],
    [[13], [14, 11, 10]],
    'the rows leave together, and the repeating subtask stays',
  );
  assert.deepEqual(app.leaving, {});
});
test('a subtask Vikunja refuses to close stays in the Outbox, and the others close', async t => {
  const { v, app } = listed(t, family());
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/11' ? 403 : null);
  await app.toggleDone(app.tasks[10], ROW, { close: true });
  assert.deepEqual(
    [10, 11, 14].map(id => v.task(id).done),
    [true, false, true],
  );
  assert.deepEqual(
    [app.tasks[11].done, sync.all(1).map(e => [e.task, !!e.failed])],
    [false, [[11, true]]],
    "the refused subtask's row goes back, and its tick waits in the Outbox",
  );
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action.label],
    ["A tick on “Subtask 11” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox'],
  );
});
test('a tick made offline in its own sheet shows at once, and is sent once Pocket reaches Vikunja', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Wipe the menus', done: false }]);
  opened(app, v.task(1));
  noConnection(app, v);
  await app.toggleDone(app.sheetTask, null, { sheet: true });
  assert.deepEqual([app.sheetTask.done, v.task(1).done, sync.all(1).length], [true, false, 1]);
  assert.deepEqual(app.toasts, [], 'the tick shows the change, and nothing is said');
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅'].length, sync.all(1).length], [true, 1, 0]);
});
test('completing a parent from its sheet closes its subtasks, shows a message under them, and Undo opens them again', async t => {
  const list = family(),
    { v, app } = listed(t, list);
  opened(app, list[0]);
  await app.toggleDone(app.sheetTask, null, { sheet: true, close: true });
  assert.deepEqual(ticks(v), [
    [10, { done: true }],
    [11, { done: true }],
    [14, { done: true }],
  ]);
  assert.deepEqual([lastSaid(app).msg, lastSaid(app).place], ['Closed Pack the van + 2 subtasks', 'sheet:subtasks']);
  assert.deepEqual(
    app.sheetTask.related_tasks.subtask.map(s => app.subRow(s).done),
    [true, true, false, true],
    'the sheet shows the subtasks as done',
  );
  assert.equal(app.sheet.dirty, true, 'the list is read again once the sheet closes');
  await lastSaid(app).action.fn();
  assert.deepEqual(
    [10, 11, 12, 14].map(id => v.task(id).done),
    [false, false, true, false],
  );
  assert.deepEqual(
    app.sheetTask.related_tasks.subtask.map(s => app.subRow(s).done),
    [false, true, false, false],
  );
  // A task with no subtasks shows no message, because the tick itself shows the change. Ticking it again opens it.
  const n = app.toasts.length;
  opened(app, v.task(12));
  await app.sheetDone();
  assert.equal(v.task(12).done, false);
  assert.equal(app.toasts.length, n);
});
test("ticking a done parent that is above open subtasks on a project's list opens it again in place", async t => {
  const { v, app } = listed(t, [
    { id: 10, title: 'Pack the van', done: true, related_tasks: { subtask: [sub(11)] } },
    sub(11),
  ]);
  const head = app.tasks[10],
    kid = app.tasks[11];
  app.route = { name: 'project', id: 1 };
  app.view.groups = [
    { key: 'open', tasks: [kid, head], heads: [10] },
    { key: 'done', loaded: false, count: 3, tasks: [] },
  ];
  assert.equal(app.isHead(head), true);
  await app.toggleDone(head, ROW);
  assert.equal(v.task(10).done, false);
  assert.deepEqual(
    app.view.groups[0].tasks.map(x => x.id),
    [11, 10],
    'the parent is still on the open list',
  );
  assert.equal(app.view.groups[1].count, 2, 'the Done count no longer includes it');
  assert.deepEqual([app.leaving[10], app.said], ['open', 'Not done: Pack the van'], 'the row shows it open, in place');
  assert.equal(v.task(11).done, false, 'the subtask is unchanged');
  await app.unmark(10);
  assert.equal(v.task(10).done, true, 'tapping the tick again makes the parent done again');
  assert.equal(v.task(11).done, false, 'the subtask is still open');
  await app.clearBatch(true);
  assert.deepEqual(
    app.view.groups[0].tasks.map(x => x.id),
    [11, 10],
    'the parent stays when the batch clears',
  );
});
test("a parent completed on a project's list stays above its open repeating subtask, marked done", async t => {
  const list = family().map(x => ({ ...x, project_id: 1 }));
  for (const s of list.slice(1)) s.related_tasks = { parenttask: [{ id: 10 }] };
  const { v, app } = listed(t, list, views, cards);
  Object.assign(app, { route: { name: 'project', id: 1 } });
  const p = app.tasks[10];
  app.view.groups = [
    { key: 'open', tasks: [p, ...[11, 13, 14].map(id => app.tasks[id])] },
    { key: 'done', loaded: false, count: 1, tasks: [] },
  ];
  await app.toggleDone(p, ROW, { close: true });
  assert.deepEqual(app.view.groups[0].heads, [10], 'the parent is a head above the repeating subtask');
  assert.equal(app.view.groups[1].count, 2, 'the Done count includes the closed tasks');
  assert.deepEqual(app.leaving, { 10: 'done', 11: 'done', 14: 'done' });
  await app.unmark(10);
  assert.deepEqual(
    [10, 11, 14].map(id => v.task(id).done),
    [false, false, false],
    'tapping the tick again opens all three tasks',
  );
  assert.equal(app.view.groups[1].count, 1);
  // Complete it again and let the batch clear. The parent stays, over the repeating subtask, and the closed tasks move to Done.
  await app.toggleDone(p, ROW, { close: true });
  await app.clearBatch(true);
  assert.deepEqual(
    app.view.groups[0].tasks.map(x => x.id),
    [10, 13],
  );
  assert.equal(app.view.groups[1].count, 4, 'the Done count includes the parent and the two subtasks closed with it');
});
test('a tick Vikunja refuses goes back, and waits in the Outbox to be tried again', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Call Jo', done: false }]);
  v.trouble = () => 403;
  const x = app.tasks[1];
  await app.toggleDone(x, ROW);
  assert.deepEqual(app.leaving, {}, 'the row is not marked and stays as it was');
  assert.equal(x.done, false);
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action.label],
    ["A tick on “Call Jo” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox'],
  );
  v.trouble = () => null;
  await app.retryAct(sync.all(1)[0].id);
  assert.equal(v.task(1).done, true, 'Try again in the Outbox ticks it');
});
test('a repeating task whose tick lost its reply is ticked once, and tapping its tick puts its date back', async t => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const { v, app } = listed(t, [{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }]);
  lostOnce(v, 'PATCH', /^\/tasks\/1$/);
  const x = app.tasks[1];
  await app.toggleDone(x, ROW);
  assert.deepEqual(
    [x.done, x.due_date, app.leaving[1]],
    [true, due, 'done'],
    'the row shows the task done, with its old date, until the batch clears',
  );
  assert.match(app.said, /^Done: Water the plants\. It repeats, next /);
  // Tapping its tick before the batch clears sends the tick again, which the relay answers from what it kept, and
  // then puts the date back.
  app.offline = false;
  await app.unmark(1);
  assert.deepEqual(
    [reached(v, 'PATCH', /^\/tasks\/1$/).map(r => r.body), v.task(1).due_date, x.due_date, x.done],
    [[{ done: true }, { due_date: due }], due, due, false],
  );
});
test('a repeating task ticked on Today returns open with its next date once the batch clears, in that date’s group', async t => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const { v, app } = listed(
    t,
    [{ id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY }],
    views,
    cards,
  );
  const shown = () => app.view.groups.flatMap(g => g.tasks.map(x => [g.key, x.id]));
  Object.assign(app.view, { groups: todayGroups(), cards: {} });
  app.view.groups.find(g => g.key === dayGroup(due)).tasks.push(app.tasks[1]);
  await app.toggleDone(app.tasks[1], ROW);
  await settled();
  assert.deepEqual(shown(), [[dayGroup(due), 1]], 'the row stays where it is until the batch clears');
  await app.clearBatch(true);
  const x = app.tasks[1];
  assert.deepEqual([x.done, x.due_date], [false, v.task(1).due_date], 'the task is open at its next date');
  assert.equal(Date.parse(x.due_date) - Date.parse(due), DAY * 1000);
  assert.deepEqual(shown(), [[dayGroup(x.due_date), 1]], 'and on Today, in the group for that date');
  // A task whose next date is past what Today shows leaves Today.
  v.task(1).repeat_after = 30 * DAY;
  app.change(w => w.read([structuredClone(v.task(1))], TASK, started()));
  await app.toggleDone(app.tasks[1], ROW);
  await app.clearBatch(true);
  assert.deepEqual(shown(), []);
});
test('setting progress to 100% marks the task done, and tapping its tick opens it at the progress it had', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]);
  await app.setProgress(app.tasks[1], 100, ROW);
  assert.deepEqual(patches(v), [[1, { done: true }]], 'the progress value is left as it was');
  assert.equal(v.task(1).done, true);
  await app.unmark(1);
  assert.deepEqual([patches(v).at(-1), v.task(1).percent_done], [[1, { done: false }], 0.4]);
  // The sheet (its row or its Progress line) behaves the same. The tick shows it, and ticking again opens it.
  const n = app.toasts.length;
  opened(app, v.task(1));
  await app.sheetProgress(app.sheetTask, 100);
  assert.deepEqual([v.task(1).done, v.task(1).percent_done, app.toasts.length], [true, 0.4, n]);
  await app.sheetDone();
  assert.deepEqual([v.task(1).done, v.task(1).percent_done], [false, 0.4]);
});
test('a repeating task swiped to 100% starts its next date at 0%, and its Undo puts back its date and progress', async t => {
  const due = new Date(Date.now() + 36e5).toISOString();
  const { v, app } = listed(t, [
    { id: 1, title: 'Water the plants', done: false, due_date: due, repeat_after: DAY, percent_done: 0.5 },
  ]);
  await app.setProgress(app.tasks[1], 100, ROW);
  assert.deepEqual(
    [patches(v), v.task(1).due_date],
    [[[1, { done: true, percent_done: 0 }]], new Date(vikunjaNext({ due_date: due, repeat_after: DAY })).toISOString()],
  );
  await app.unmark(1);
  assert.deepEqual([v.task(1).due_date, v.task(1).percent_done], [due, 0.5]);
});
/* A full swipe right marks the task done and looks the same as a tick. The row finishes its swipe off the screen, then
   shows as done in its place, never as a gap, with the same mark as a tick. Tapping its tick undoes it. The row
   leaves the list when the batch clears. In a sheet, a subtask's row stays in place as done, with nothing marked. */
test('a full swipe marks the task done like a tick, in place and never as a gap, and tapping its tick undoes it', async t => {
  const { v, app } = listed(
    t,
    [
      { id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 },
      { id: 2, title: 'Sand it', done: false },
      { id: 3, title: 'Prime it', done: false },
      { id: 4, title: 'Paint the shed', related_tasks: { subtask: [{ id: 3 }] } },
    ],
    views,
    cards,
  );
  app.view.groups = [{ key: 'today', tasks: [app.tasks[1], app.tasks[2]] }];
  await app.setProgress(app.tasks[1], 100, ROW);
  assert.deepEqual([app.leaving, app.isGap(app.tasks[1], { depth: {} }), v.task(1).done], [{ 1: 'done' }, false, true]);
  await app.unmark(1);
  assert.deepEqual(app.leaving, {});
  assert.deepEqual(
    [patches(v).at(-1), v.task(1).percent_done],
    [[1, { done: false }], 0.5],
    'tapping the tick opens the task again at the progress it had',
  );
  await app.setProgress(app.tasks[1], 100, ROW);
  await app.toggleDone(app.tasks[2], ROW);
  assert.deepEqual(app.leaving, { 1: 'done', 2: 'done' }, 'a swiped row and a ticked row are marked the same way');
  await app.clearBatch(true);
  assert.deepEqual([app.view.groups[0].tasks, app.leaving], [[], {}], 'both rows leave with the batch');
  // A subtask in its parent's sheet is done where it is, with nothing marked. The sheet's subtask rows are their own.
  opened(app, {
    id: 4,
    title: 'Paint the shed',
    related_tasks: { subtask: [{ id: 3, title: 'Prime it', done: false }] },
  });
  app.subRows(app.sheetTask);
  await app.setProgress(app.subRow(app.sheetTask.related_tasks.subtask[0]), 100, null, { sub: true });
  assert.deepEqual(
    [app.leaving, app.subRow(app.sheetTask.related_tasks.subtask[0]).done, v.task(3).done],
    [{}, true, true],
    "the subtask's row is done",
  );
});
/* A row shows as done in place from the moment the user ticks it or releases the swipe, not from when Vikunja answers
   (toggleDone's holdRow). The mark replaces that once the op is sent. Tapping its tick in the meantime waits for the
   answer and then undoes it. If Vikunja refuses the tick, the row is released. A deletion's gap is held the same way
   (gapNow) until the deletion is queued to send. */
test('a swiped row is held done before Vikunja answers, and a tick tapped meanwhile undoes it after the answer', async t => {
  const { v, app } = listed(t, [
      { id: 1, title: 'Paint the fence', done: false, percent_done: 0.5 },
      { id: 2, title: 'Sand it', done: false },
    ]),
    send = globalThis.fetch;
  // Vikunja's answers are held back until `answer()` is called.
  let held = [];
  const answer = () => {
      const go = held;
      held = null;
      go.forEach(ok => ok());
    },
    turn = () => new Promise(ok => setImmediate(ok));
  globalThis.fetch = async (...a) => {
    if (held) await new Promise(ok => held.push(ok));
    return send(...a);
  };
  document.querySelectorAll = () => []; // no rows to slide back in
  try {
    app.view.groups = [{ key: 'today', tasks: [app.tasks[1], app.tasks[2]] }];
    let setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual(
      [app.leaving, app.tasks[1].done, v.task(1).done],
      [{ 1: 'done' }, true, false],
      'the row is held done from the moment of release, before Vikunja has answered',
    );
    const tapped = app.unmark(1);
    await turn();
    assert.deepEqual(
      [app.leaving, patches(v)],
      [{ 1: 'done' }, []],
      'tapping the tick sends nothing until Vikunja answers',
    );
    answer();
    await setting;
    await tapped;
    assert.deepEqual(app.leaving, {}, 'after the answer the tap undoes the mark');
    assert.deepEqual(
      [v.task(1).done, v.task(1).percent_done, patches(v).length],
      [false, 0.5, 2],
      'the task is open again at the progress it had',
    );
    // If Vikunja refuses the tick, the row is released.
    v.trouble = () => 403;
    setting = app.setProgress(app.tasks[1], 100, ROW);
    assert.deepEqual(app.leaving, { 1: 'done' });
    await setting;
    await turn();
    assert.deepEqual([app.leaving, app.tasks[1].done], [{}, false], 'the row is released and the task is not done');
    for (const x of sync.all(1)) await sync.remove(x.id);
    app.refreshPending();
    v.trouble = () => null;
    // A tapped tick is held the same way. Tapping it again before the answer undoes it once the answer arrives.
    held = [];
    const ticking = app.toggleDone(app.tasks[1], ROW),
      again = app.unmark(1);
    assert.deepEqual([app.leaving, typeof again.then], [{ 1: 'done' }, 'function']);
    answer();
    await ticking;
    await again;
    assert.deepEqual(
      [app.leaving, v.task(1).done, app.tasks[1].done],
      [{}, false, false],
      'ticking twice leaves the task open and nothing marked',
    );
    // A deletion shows "Deleted" and Restore at once. If the user cancels (the confirmation is answered no), the row comes back.
    let said = null;
    const asked = new Promise(ok => {
      said = ok;
    });
    app.gapNow(2, asked);
    assert.deepEqual(app.leaving[2], 'deleted');
    said(false);
    await asked;
    await turn();
    assert.equal(app.leaving[2], undefined, 'cancelling the deletion leaves no gap');
  } finally {
    globalThis.fetch = send;
    delete document.querySelectorAll;
  }
});
test('progress below 100% is sent as it is, and a refused progress goes back and waits in the Outbox', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: false, percent_done: 0.4 }]);
  const x = app.tasks[1];
  await app.setProgress(x, 70, null);
  assert.equal(v.task(1).percent_done, 0.7);
  assert.deepEqual(app.toasts, [], 'no message appears, because sliding the progress back is the undo');
  assert.equal(app.said, 'Progress of Paint the fence set to 70%', 'a screen reader announces the progress');

  v.trouble = () => 403;
  await app.setProgress(x, 90, null);
  assert.equal(x.percent_done, 0.7);
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action.label],
    ["Progress on “Paint the fence” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox'],
  );
  v.trouble = () => null;
  await app.retryAct(sync.all(1)[0].id);
  assert.equal(v.task(1).percent_done, 0.9, 'Try again in the Outbox sets it');
});
/* Swiping a done row left opens it again at the progress where the user releases the swipe, the same as its tick
   would, in one request. Ticking it again makes it done. The sheet's row and Progress line behave the same. */
test('swiping a done task down opens it again at that progress in one request', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: true, percent_done: 0.4 }]);
  const x = app.tasks[1];
  await app.setProgress(x, 75, ROW);
  assert.deepEqual(patches(v), [[1, { done: false, percent_done: 0.75 }]]);
  assert.deepEqual([x.done, v.task(1).done, v.task(1).percent_done], [false, false, 0.75]);
  await app.toggleDone(x, null);
  assert.deepEqual(
    [v.task(1).done, v.task(1).percent_done],
    [true, 0.75],
    'ticking again makes the task done and keeps its progress',
  );
  opened(app, v.task(1));
  await app.sheetProgress(app.sheetTask, 50);
  assert.deepEqual(
    [v.task(1).done, v.task(1).percent_done],
    [false, 0.5],
    "the sheet's progress bar behaves the same way",
  );
});
test('the Undo of an untick made at a progress ticks the task again at the progress it had', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: true, percent_done: 0.4 }]);
  const queued = [],
    actAll = app.actAll;
  app.actAll = function (list, quiet) {
    queued.push(...list);
    return actAll.call(this, list, quiet);
  };
  await app.setProgress(app.tasks[1], 75, ROW);
  assert.equal(await app.undoOps(queued).left, 0);
  assert.deepEqual(
    [patches(v).at(-1), v.task(1).done, app.tasks[1].percent_done],
    [[1, { done: true, percent_done: 0.4 }], true, 0.4],
  );
});
test('ticking a subtask or setting its progress shows only on its row, with no message, and the row stays in place', async t => {
  const kid = {
    id: 2,
    title: 'Pack the cups',
    done: false,
    percent_done: 0,
    related_tasks: { parenttask: [{ id: 1 }] },
  };
  const { v, app } = listed(t, [kid, { id: 3, title: 'Wash them', done: false }]),
    x = app.tasks[2];
  await app.setProgress(x, 50, null);
  assert.equal(v.task(2).percent_done, 0.5);
  await app.toggleDone(x, null);
  assert.equal(v.task(2).done, true);
  await app.toggleDone(x, null);
  assert.equal(v.task(2).done, false);
  assert.deepEqual(app.toasts, [], 'no messages');
  // In its parent's sheet, the subtask's copy has no parent set, so `sub: true` tells the action it is a subtask.
  await app.toggleDone(app.tasks[3], null, { sub: true });
  assert.deepEqual(app.toasts, []);
});
/* A parent's calculated progress is written right after one of its subtasks changes, by the same op, and only when the
   progress changes. */
test("ticking a subtask or setting its progress writes its parent's calculated progress right after, if it changed", async t => {
  const kid = id => ({
    id,
    title: 'Step ' + id,
    done: false,
    percent_done: 0,
    related_tasks: { parenttask: [{ id: 1 }] },
  });
  const { v, app } = listed(t, [
    {
      id: 1,
      title: 'Open up',
      percent_done: 0,
      related_tasks: { subtask: [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] },
    },
    kid(2),
    kid(3),
    kid(4),
    kid(5),
  ]);
  await app.setProgress(app.tasks[2], 50, null);
  assert.deepEqual(
    patches(v),
    [
      [2, { percent_done: 0.5 }],
      [1, { percent_done: 0.13 }],
    ],
    "one subtask at 50% of four gives 13%, written after the subtask's own request",
  );
  v.requests.length = 0;
  await app.toggleDone(app.tasks[2], null);
  assert.deepEqual(
    patches(v),
    [
      [2, { done: true }],
      [1, { percent_done: 0.25 }],
    ],
    'a done subtask counts as 100%',
  );
  v.requests.length = 0;
  await app.setProgress(app.tasks[3], 0, null);
  assert.deepEqual(patches(v), [[3, { percent_done: 0 }]], 'an unchanged parent progress is not written');
  // In its parent's sheet, the subtask's copy names no parent, so the sheet's task is its parent.
  v.requests.length = 0;
  opened(app, { id: 1, related_tasks: { subtask: [{ id: 4, title: 'Step 4', done: false }] } });
  await app.toggleDone({ id: 4, title: 'Step 4', done: false }, null, { sub: true });
  assert.deepEqual(patches(v), [
    [4, { done: true }],
    [1, { percent_done: 0.5 }],
  ]);
});
// In a subtask's own sheet, setting progress by swiping its row or tapping a quarter in Details also writes the
// parent's progress.
test("setting a subtask's progress in its own sheet writes its parent's progress right after", async t => {
  const kid = id => ({
    id,
    title: 'Step ' + id,
    done: false,
    percent_done: 0,
    related_tasks: { parenttask: [{ id: 1 }] },
  });
  const { v, app } = listed(
    t,
    [{ id: 1, title: 'Open up', percent_done: 0, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }, kid(2), kid(3)],
    sheet,
  );
  Object.assign(app, { keepTemplate() {}, rowTitle: x => x.title, unsay() {} });
  opened(app, v.task(2));
  await app.sheetProgress(app.sheetTask, 50);
  assert.deepEqual(patches(v), [
    [2, { percent_done: 0.5 }],
    [1, { percent_done: 0.25 }],
  ]);
});
test("a change to a checklist step goes through the outbox, and the same entry writes the checklist's progress last", async t => {
  const { v } = listed(t, [
      {
        id: 1,
        title: 'Opening',
        percent_done: 0,
        related_tasks: {
          subtask: [
            { id: 2, done: true },
            { id: 3, percent_done: 0.5 },
          ],
        },
      },
      { id: 2, done: true },
      { id: 3, percent_done: 0.5 },
    ]),
    app = component(tasks, actions),
    send = a => figure(a, stageContext(a, app).start()),
    entry = () => ({ id: uuid7(), op: 'done', task: 2, run: 1, stage: 3 });
  for (const op of ['progress', 'done', 'skip', 'undone', 'doneNote'])
    assert.equal(OPS[op].stages.at(-1), figure, op + ': the progress write is the last part');
  await send({ id: uuid7(), op: 'finish', task: 1, run: 1, stage: 2 });
  assert.equal(v.requests.length, 0, 'a finished checklist has no progress to calculate');
  const a = entry();
  await send(a);
  assert.deepEqual(patches(v), [[1, { percent_done: 0.75 }]], 'one step done and one at 50% give 75%');
  await send(a);
  assert.equal(
    patches(v).length,
    1,
    'the same entry sent again sends the same body with the same key, and the relay answers it',
  );
  await send(entry());
  assert.equal(patches(v).length, 1, 'a new entry finds the progress already right, so nothing is written');
});
test("a tick puts the user's ✅ on a task wherever it is, and an untick takes it off, except on a repeating task", async t => {
  const { v, app } = listed(t, [
    { id: 1, title: 'Order the cups', done: false, project_id: 7 },
    { id: 2, title: 'Book the dentist', done: false, project_id: 8 },
    {
      id: 3,
      title: 'Water the plants',
      done: false,
      project_id: 7,
      due_date: '2026-10-07T09:00:00Z',
      repeat_after: DAY,
    },
  ]);
  app.seenBy = { 7: 2, 8: 0 };
  for (const id of [1, 2, 3]) await app.toggleDone(app.tasks[id], null);
  assert.deepEqual(
    [1, 2, 3].map(id => v.task(id).reactions?.['✅']?.map(u => u.id) || null),
    [[1], [1], null],
    'a project only the user can see gets it too, and a task moved on to its next date gets none',
  );
  await app.toggleDone(app.tasks[1], null);
  await app.toggleDone(app.tasks[1], null);
  await app.toggleDone(app.tasks[1], null);
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅']], [false, []], 'unticking takes the ✅ off');
});
test("a task ticked on Today joins Done today when the batch clears, newest first, and a checklist's step does not", async t => {
  const { app } = listed(
    t,
    [
      { id: 1, title: 'Order the cups', done: false },
      { id: 2, title: 'Fix the till', done: true, assignees: [{ id: 1 }] },
      { id: 3, title: 'Take the croissants out', done: true, assignees: [{ id: 1 }] },
    ],
    views,
    cards,
  );
  app.route = { name: 'today' };
  app.view.groups = [
    { key: 'today', tasks: [app.tasks[1]] },
    { key: 'donetoday', tasks: [app.tasks[2]] },
  ];
  await app.toggleDone(app.tasks[1], ROW);
  assert.deepEqual(
    app.view.groups[1].tasks.map(x => x.id),
    [2],
    'Done today waits for the batch',
  );
  await app.clearBatch(true);
  assert.deepEqual(
    app.view.groups.map(g => g.tasks.map(x => x.id)),
    [[], [1, 2]],
  );
  app.stepRun = x => (x.id === 3 ? 9 : null);
  app.view.groups[0].tasks.push(app.tasks[3]);
  app.regroup();
  assert.deepEqual(
    app.view.groups.map(g => g.tasks.map(x => x.id)),
    [[], [1, 2]],
  );
});
test('an untick in Done today marks the row open, and it moves to its group on Today as the batch clears', async t => {
  const due = new Date(Date.now() + 36e5).toISOString(),
    { app } = listed(
      t,
      [{ id: 1, title: 'Order the cups', done: true, due_date: due, assignees: [{ id: 1 }] }],
      views,
      cards,
    );
  Object.assign(app.view, { groups: todayGroups(), cards: {} });
  app.view.groups.find(g => g.key === 'donetoday').tasks.push(app.tasks[1]);
  const finger = fingers(t, app);
  await app.toggleDone(app.tasks[1], ROW);
  assert.deepEqual(
    [app.tasks[1].done, app.leaving, onToday(app, 'donetoday')],
    [false, { 1: 'open' }, [1]],
    'the row is open at once, marked, and still in Done today',
  );
  finger('pointerdown');
  t.mock.timers.tick(5000);
  await settled();
  assert.deepEqual(onToday(app, 'donetoday'), [1], 'it stays while a finger is down');
  finger('pointerup');
  t.mock.timers.tick(2999);
  await settled();
  assert.deepEqual(onToday(app, 'donetoday'), [1], 'and for 3 seconds after');
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(
    [onToday(app, 'donetoday'), onToday(app, dayGroup(due)), app.leaving],
    [[], [1], {}],
    'then it is in the group for its date',
  );
});
test('on Checklists, a finished checklist moves to Finished and a reopened one to Open, each as the batch clears', async t => {
  const { app } = listed(
    t,
    [
      { id: 1, title: 'Opening up · Oct 19', done: false },
      { id: 2, title: 'Closing up · Oct 18', done: true },
    ],
    views,
  );
  const cl = { project: { id: 5, title: 'Checklists' }, templates: [], runs: [app.tasks[1]], finished: [app.tasks[2]] };
  app.route = { name: 'checklists' };
  app.view.checklists = [cl];
  const lists = () => [cl.runs.map(x => x.id), cl.finished.map(x => x.id)];
  await app.tickRunTask(app.tasks[1], ROW);
  await app.tickRunTask(app.tasks[2], ROW);
  assert.deepEqual([lists(), app.leaving], [[[1], [2]], { 1: 'done', 2: 'open' }], 'both stay until the batch clears');
  await app.clearBatch(true);
  assert.deepEqual(lists(), [[2], [1]], 'then each is where it belongs');
});
test('Done today holds what the user ticked, what is assigned to them, what is in a project only they see, and checklists they started', () => {
  const app = component(views);
  Object.assign(app, { user: { id: 1 }, seenBy: { 7: 2, 8: 0 }, isRunTask: t => !!t.run });
  const mine = { id: 1 },
    other = { id: 2 };
  const cases = [
    [{ project_id: 7, reactions: { '✅': [mine] } }, true],
    [{ project_id: 7, reactions: { '✅': [other] } }, false],
    [{ project_id: 7, assignees: [mine] }, true],
    [{ project_id: 8 }, true],
    [{ project_id: 7 }, false],
    [{ project_id: 7, run: true, created_by: mine }, true],
    [{ project_id: 7, run: true, created_by: other }, false],
  ];
  assert.deepEqual(
    cases.map(([t]) => app.doneByMe(t)),
    cases.map(([, want]) => want),
  );
});
test('on Today, a done row whose reactions Pocket has not read counts as ticked here, and one with only a teammate’s ✅ does not', () => {
  const app = component(views, sending);
  Object.assign(app, { user: { id: 1 }, seenBy: { 7: 2 }, route: { name: 'today' } });
  app.view = { groups: todayGroups(), cards: {} };
  const done = { id: 9, done: true, done_at: new Date().toISOString(), project_id: 7 };
  assert.deepEqual(
    [app.belongsIn(done, 'today'), app.belongsIn({ ...done, reactions: { '✅': [{ id: 2 }] } }, 'today')],
    ['donetoday', null],
  );
});
test('Done today keeps only what was done today, also in a copy of Today saved on an earlier day', () => {
  const app = component(tasks, actions, cards, alerts, sending),
    now = new Date(),
    yesterday = new Date(now - 864e5).toISOString();
  Object.assign(app, { route: { name: 'today' }, pending: [], view: { groups: todayGroups(), cards: {} } });
  app.view.groups.find(g => g.key === 'donetoday').tasks = [
    { id: 1, done: true, done_at: yesterday },
    { id: 2, done: true, done_at: now.toISOString() },
    { id: 3, done: true },
  ];
  assert.deepEqual(
    app.listBase.find(g => g.key === 'donetoday').tasks.map(t => t.id),
    [2, 3],
    'a task just ticked, with no time yet, stays',
  );
});
test("finishing a checklist puts the user's ✅ on it, and reopening it takes the ✅ off", async t => {
  const { v } = listed(t, [{ id: 1, title: 'Closing up · Oct 14', done: false }]);
  // A countdown keeps the time a step was ticked (keepTick). This checklist has none.
  const app = component(tasks, actions, { keepTick() {} });
  await sendStages(app, { op: 'finish', task: 1, run: 1 });
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅'].map(u => u.id)], [true, [1]]);
  await sendStages(app, { op: 'reopen', task: 1, run: 1 });
  assert.deepEqual([v.task(1).done, v.task(1).reactions['✅']], [false, []]);
});
/* Lines that quick add sent done, placed on Today as placeSent places them. Task 2 repeats, so Vikunja has moved it on
   to its next date, and its row shows it done at the date it was made with until the batch clears. */
test("tapping the tick of a task quick add made done unticks it, and a repeating one's puts its date back", async t => {
  const due = '2026-10-07T09:00:00Z',
    { v, app } = listed(t, [
      { id: 1, title: 'Order the cups', done: true },
      { id: 2, title: 'Water the plants', done: false, due_date: '2026-10-08T09:00:00Z', repeat_after: DAY },
    ]);
  Object.assign(app, { route: { name: 'today' }, positions: {} });
  app.view = { groups: [], route: location.hash, shownRun: null };
  const placed = (id, made) =>
    app.placeSent([{ id, title: v.task(id).title, ...made, arrived: { now: v.task(id), done: true } }]);
  placed(1, { done: false, due_date: due });
  await app.unmark(1);
  assert.deepEqual([v.task(1).done, app.tasks[1].done], [false, false]);
  placed(2, { done: false, due_date: due, repeat_after: DAY });
  assert.deepEqual(
    [app.tasks[2].done, app.tasks[2].due_date],
    [true, due],
    'the row shows the task done at the date it was made with',
  );
  await app.unmark(2);
  assert.deepEqual([v.task(2).due_date, app.tasks[2].due_date, app.tasks[2].done], [due, due, false]);
});

/* Ticks and progress are ops (ops/ticks.js), sent through the outbox, each with an Undo that is an op too. */
const op = (name, task, more = {}) => ({ id: uuid7(), op: name, task, run: null, ...more });
test('a tick and an untick made offline cancel out, and a second progress takes the place of the first', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: false, percent_done: 0 }]);
  noConnection(app, v);
  for (const name of ['done', 'undone', 'done', 'undone']) await app.act(op(name, 1));
  assert.deepEqual([sync.all(1).length, app.tasks[1].done], [0, false], 'ticking and unticking leaves nothing to send');
  await app.act(op('progress', 1, { pct: 50, was: 0 }));
  const second = op('progress', 1, { pct: 75, was: 50 });
  await app.act(second);
  assert.deepEqual(
    sync.all(1).map(e => [e.pct, e.was]),
    [[75, 0]],
    'one progress is left, from the progress before the first to the last',
  );
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(
    reached(v, 'PATCH', /^\/tasks\/1$/).map(r => r.body),
    [{ percent_done: 0.75 }],
  );
  await app.undoOps([second]).left;
  assert.equal(v.task(1).percent_done, 0, "the second's Undo goes back to the progress before the first");
});
test('a tick whose reply was lost and an untick after it are both sent, since Vikunja may have the tick', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: false }]);
  lostOnce(v, 'PATCH', /^\/tasks\/1$/);
  assert.equal((await app.act(op('done', 1))).status, 'offline');
  await app.act(op('undone', 1));
  await app.flush();
  assert.deepEqual([v.task(1).done, sync.all(1).length], [false, 0]);
});
test('an Undo leaves a progress a teammate changed since, and says so on the row', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Paint the fence', done: false, percent_done: 0 }]);
  const f = op('progress', 1, { pct: 50, was: 0 });
  await app.act(f);
  v.task(1).percent_done = 0.6;
  assert.equal(await app.undoOps([f], false).left, 1);
  assert.deepEqual(
    [v.task(1).percent_done, app.tasks[1].percent_done],
    [0.6, 0.6],
    "Vikunja keeps the teammate's progress, and the row shows it",
  );
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).row.id, lastSaid(app).cls],
    ['Not undone: “Paint the fence” has changed since then.', 1, 'failed'],
  );
  assert.equal(sync.all(1).length, 0, 'the Undo leaves the outbox');
});
test("the Undo of a repeating task's tick puts back its dates, also after a lost reply, and leaves a date changed since", async t => {
  const due = '2026-10-07T09:00:00Z',
    plants = {
      id: 1,
      title: 'Water the plants',
      done: false,
      due_date: due,
      start_date: '2026-10-07T08:00:00Z',
      repeat_after: DAY,
      reminders: [{ reminder: '2026-10-07T08:30:00Z' }],
    };
  const { v, app } = listed(t, [plants]);
  const tick = () => op('done', 1, { was: movedFrom(app.tasks[1]) });
  let f = tick();
  assert.deepEqual(f.was, {
    due_date: due,
    start_date: '2026-10-07T08:00:00Z',
    reminders: [{ reminder: '2026-10-07T08:30:00Z' }],
  });
  await app.act(f);
  assert.notEqual(v.task(1).due_date, due, 'Vikunja moves the task on to its next date');
  assert.equal(v.task(1).reactions, undefined, 'a task moved on is open, so it gets no ✅');
  assert.equal(await app.undoOps([f]).left, 0);
  assert.deepEqual([v.task(1).due_date, v.task(1).done], [due, false], 'Undo puts its date back');
  // The tick's reply is lost, and Undo is tapped before it is sent again. The Undo waits behind the tick, and is made
  // from Vikunja's answer once the tick has it.
  lostOnce(v, 'PATCH', /^\/tasks\/1$/);
  f = tick();
  assert.equal((await app.act(f)).status, 'offline');
  app.offline = false;
  assert.equal(await app.undoOps([f]).left, 0);
  assert.deepEqual([v.task(1).due_date, sync.all(1).length], [due, 0]);
  // A date changed in Vikunja since stays, and Undo says so.
  f = tick();
  await app.act(f);
  // Off the 9:00 times the repeat moves it to, so the date differs from Vikunja's whatever day the test runs.
  v.task(1).due_date = '2026-10-20T21:00:00Z';
  assert.equal(await app.undoOps([f], false).left, 1);
  assert.deepEqual(
    [v.task(1).due_date, lastSaid(app).msg],
    ['2026-10-20T21:00:00Z', 'Not undone: “Water the plants” has changed since then.'],
  );
});
test("the Undo of a repeating task's tick whose reply was lost unticks it, when Vikunja marked it done", async t => {
  const plants = { id: 1, title: 'Water the plants', done: false, due_date: '2026-10-07T09:00:00Z', repeat_after: DAY };
  const { v, app } = listed(t, [plants]);
  v.task(1).repeat_after = 0; // a teammate's, in the web app
  lostOnce(v, 'PATCH', /^\/tasks\/1$/);
  const f = op('done', 1, { was: movedFrom(app.tasks[1]) });
  assert.equal((await app.act(f)).status, 'offline');
  app.offline = false;
  assert.equal(await app.undoOps([f]).left, 0);
  assert.deepEqual([v.task(1).done, sync.all(1).length], [false, 0]);
});
test('Pocket forgets what it kept to undo a tick, a progress, an edit, a person or a label once no Undo can be tapped', async t => {
  const { v, app } = listed(
    t,
    [1, 2, 3, 4].map(id => ({ id, title: 'Task ' + id, done: false, percent_done: 0, assignees: [], labels: [] })),
  );
  v.labels.push({ id: 600, title: 'floor' });
  await collected(); // what earlier tests kept
  const n = undosKept();
  await app.toggleDone(app.tasks[1], ROW);
  await app.setProgress(app.tasks[2], 40, ROW);
  await app.act({ op: 'edit', task: 3, run: null, set: { title: 'Paint the gate' }, was: { title: 'Task 3' } });
  await app.addAssignee(app.tasks[4], { id: 7, username: 'bob' });
  await app.addLabelTo(app.tasks[4], { id: 600, title: 'floor' });
  await collected();
  assert.equal(undosKept(), n + 1, 'only the tick shows an Undo, on its row until the batch clears');
  await app.clearBatch(true);
  await collected();
  assert.equal(undosKept(), n);
});
test('a tick on a task deleted in Vikunja since leaves the outbox, and says why', async t => {
  const { v, app } = listed(t, [{ id: 1, title: 'Call Jo', done: false }]);
  v.tasks.delete(1);
  const r = await app.act(op('done', 1));
  assert.deepEqual([r.status, sync.all(1).length], ['error', 0], 'nothing is kept to try again');
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action],
    ["A tick on “Call Jo” couldn't be saved: The task does not exist.", null],
  );
});
test('an Undo the sender reads while it is still being saved on the phone stays in the outbox to be sent', async t => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const e = { id: uuid7(), kind: 'act', op: 'undone', task: 5, user: 1, at: new Date().toISOString(), n: 0, files: [] },
    adding = sync.add(e, []),
    read = await sync.fresh(e.id);
  await adding;
  assert.deepEqual([read?.id, sync.all(1).map(x => x.id)], [e.id, [e.id]]);
});
