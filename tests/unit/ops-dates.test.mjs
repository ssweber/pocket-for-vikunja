// Tests for the due and repeat ops (src/js/ops/dates.js), against a fake Vikunja behind the plugin's relay: what each
// sends, its Undo, a later op that replaces it, the sheet's date and repeat, and a template's date.
import './browser.mjs';
import { sender, reached, lostOnce, noConnection, settle, offlineSender, lastSaid } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import { started, TASK } from '../../src/js/app/tasks.js';
import sheet from '../../src/js/app/sheet.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { UNKNOWN } from '../../src/js/messages.js';
import { ZERO } from '../../src/js/util.js';

/* Moving a task to another date (ops/dates.js). A move is a `due` op. Its Undo is an op too, made from what the move
   recorded, which checks Vikunja's date before it writes the old one back. `dated` gives a sender whose tasks have rows
   and copies, and `move` queues a move as reschedule does. */
const D = (d, h = 9) => new Date(2026, 9, d, h).toISOString();
const dated = (t, list) => {
  const s = sender(t, list);
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
const move = (app, task, due) => {
  const f = { id: uuid7(), op: 'due', task, was: app.tasks[task].due_date, due, run: null };
  return { f, sending: app.act(f, true) };
};
const datePatches = v => reached(v, 'PATCH', /^\/tasks\/\d+$/).map(r => r.body.due_date);
test('a move sets the date, its Undo goes back to the date before, and a later move takes the place of one not sent', () => {
  const a = { op: 'due', task: 7, was: D(5), due: D(9) };
  assert.deepEqual(OPS.due.apply({ id: 7, title: 'Call the plumber', due_date: D(5) }, a), {
    id: 7,
    title: 'Call the plumber',
    due_date: D(9),
  });
  assert.deepEqual(
    OPS.due.invert(a),
    { op: 'due', task: 7, due: D(5), was: D(9), check: D(9) },
    'before Vikunja answers, the Undo checks for the date sent',
  );
  assert.equal(
    OPS.due.invert({ ...a, got: { task: { due_date: '2026-10-09T13:00:00Z' } } }).check,
    '2026-10-09T13:00:00Z',
    'once it answers, for the date Vikunja stored',
  );
  assert.deepEqual(
    OPS.due.merge(a, { ...a, was: D(9), due: D(12) }),
    { ...a, was: D(5), due: D(12) },
    "the later move keeps the first move's date before",
  );
  assert.equal(OPS.due.merge({ op: 'done', task: 7 }, a), null, 'a move replaces only a move');
});
test('an Undo of a move not sent yet takes the move out of the outbox, and nothing is sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  const { f, sending } = move(app, 7, D(9));
  assert.equal(app.tasks[7].due_date, D(9), 'the row moves at once');
  assert.equal((await sending).status, 'offline');
  assert.deepEqual(
    [sync.all(1).length, app.waiting.dues[7]],
    [1, true],
    'the move waits, and its row shows it is waiting',
  );
  const { left } = await app.undoOps([f]);
  assert.equal(app.tasks[7].due_date, D(5), 'the row goes back at once');
  assert.deepEqual(
    [await left, app.tasks[7].due_date, sync.all(1).length, app.waiting.dues[7]],
    [0, D(5), 0, undefined],
  );
  assert.deepEqual(v.requests, [], 'nothing is sent');
});
test("two moves made offline on one task send one request, and the second's Undo returns the task to its first date", async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  const first = move(app, 7, D(8));
  await first.sending;
  const second = move(app, 7, D(9));
  await second.sending;
  assert.deepEqual(
    sync.all(1).map(e => [e.was, e.due]),
    [[D(5), D(9)]],
    'one entry, from the first date to the last',
  );
  assert.equal(app.tasks[7].due_date, D(9));
  app.offline = false;
  await app.flush();
  assert.deepEqual([datePatches(v), v.task(7).due_date], [[D(9)], D(9)]);
  // The second move is a change to the date since the first, so the first move's Undo leaves it.
  let undo = await app.undoOps([first.f]);
  assert.equal(app.tasks[7].due_date, D(9));
  assert.deepEqual(
    [await undo.left, v.task(7).due_date, datePatches(v)],
    [1, D(9), [D(9)]],
    'it counts as changed since, and nothing is sent',
  );
  undo = await app.undoOps([second.f]);
  assert.equal(app.tasks[7].due_date, D(5), "the second move's Undo shows the first date at once");
  assert.deepEqual([await undo.left, v.task(7).due_date, datePatches(v)], [0, D(5), [D(9), D(5)]]);
});
test('the Undo of a move that replaced another goes back to the first date, also when another tab sent it', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  await move(app, 7, D(8)).sending;
  const second = move(app, 7, D(9));
  await second.sending;
  // Another tab sends the move. Vikunja has its date, and it leaves the outbox without this tab seeing the answer.
  v.task(7).due_date = D(9);
  for (const x of sync.all(1)) await sync.remove(x.id);
  app.offline = false;
  const { left } = await app.undoOps([second.f]);
  assert.deepEqual([await left, v.task(7).due_date], [0, D(5)]);
});
test('an Undo never folds into a move, and a move never folds into an Undo or past one', async t => {
  const { app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const m = move(app, 7, D(8));
  await m.sending;
  app.offline = true;
  await move(app, 7, D(9)).sending;
  const { left } = await app.undoOps([m.f]);
  await left;
  await move(app, 7, D(12)).sending;
  assert.deepEqual(
    sync.all(1).map(e => [e.due, !!e.undo]),
    [
      [D(9), false],
      [D(5), true],
      [D(12), false],
    ],
    'the Undo keeps its check, and is checked after the move before it',
  );
});
test('a move that has sent a request, or is held, is not replaced by a later move', async t => {
  const { v, app } = dated(t, [
    { id: 7, title: 'Call the plumber', due_date: D(5) },
    { id: 8, title: 'Order milk', due_date: D(5) },
  ]);
  lostOnce(v, 'PATCH', /^\/tasks\/7$/);
  assert.equal((await move(app, 7, D(8)).sending).status, 'offline', 'the reply to the first move is lost');
  await move(app, 7, D(9)).sending;
  assert.deepEqual(
    [datePatches(v), v.task(7).due_date, sync.all(1).length],
    [[D(8), D(9)], D(9), 0],
    'both moves are sent, in order',
  );
  // A move Vikunja refused stays in the Outbox, and holds back the later move.
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await move(app, 8, D(8)).sending;
  await move(app, 8, D(9)).sending;
  assert.deepEqual(
    sync.all(1).map(e => [e.due, !!e.failed]),
    [
      [D(8), true],
      [D(9), false],
    ],
  );
  // A move held until a time, as a deletion is held while Restore shows in another tab.
  for (const x of sync.all(1)) await sync.remove(x.id);
  app.offline = true;
  const held = move(app, 8, D(8));
  await held.sending;
  await sync.save({ ...sync.entries.get(held.f.id), until: Date.now() + 60e3 });
  await move(app, 8, D(9)).sending;
  assert.deepEqual(
    sync.all(1).map(e => e.due),
    [D(8), D(9)],
  );
});
test('an Undo puts the date back after a change to another field, and leaves a date changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5), comments: [] }]);
  let m = move(app, 7, D(9));
  await m.sending;
  // Another person changes the title and comments. Vikunja's date is written in another format, at the same time.
  Object.assign(v.task(7), {
    title: 'Call the plumber today',
    comments: [{ id: 1, comment: 'Done by noon' }],
    due_date: D(9).replace('.000Z', 'Z'),
  });
  let undo = await app.undoOps([m.f]);
  assert.deepEqual(
    [await undo.left, v.task(7).due_date, v.task(7).title],
    [0, D(5), 'Call the plumber today'],
    'the date goes back, and the title stays',
  );
  m = move(app, 7, D(9));
  await m.sending;
  v.task(7).due_date = D(12);
  const sent = datePatches(v).length;
  undo = await app.undoOps([m.f]);
  assert.equal(app.tasks[7].due_date, D(5), 'the row goes back at once');
  assert.deepEqual(
    [await undo.left, datePatches(v).length, v.task(7).due_date, app.tasks[7].due_date],
    [1, sent, D(12), D(12)],
    "a date changed since is left alone, nothing is sent, and the row shows Vikunja's date",
  );
  // An Undo made offline is checked when it is sent, and says so then.
  m = move(app, 7, D(14));
  await m.sending;
  app.offline = true;
  undo = await app.undoOps([m.f]);
  assert.equal(await undo.left, 0, 'the Undo waits');
  v.task(7).due_date = D(15);
  app.offline = false;
  await app.flush();
  assert.deepEqual(
    [v.task(7).due_date, app.toasts.at(-1).msg],
    [D(15), 'Not undone: “Call the plumber today” has changed since then'],
    "the title is Vikunja's, as the Undo read it",
  );
});
test("an Undo of a move whose answer is unknown puts the date back if the move arrived, and sends nothing if it didn't", async t => {
  const { v, app } = dated(t, [
    { id: 7, title: 'Call the plumber', due_date: D(5) },
    { id: 8, title: 'Order milk', due_date: D(5) },
  ]);
  v.trouble = r => (r.method === 'PATCH' ? 'unknown' : null);
  const arrived = move(app, 7, D(9)),
    lost = move(app, 8, D(9));
  assert.deepEqual(
    [(await arrived.sending).error.code, (await lost.sending).error.code, app.failed.length],
    ['unknown', 'unknown', 2],
  );
  v.trouble = () => null;
  v.task(7).due_date = D(9);
  const sent = datePatches(v).length,
    { left } = await app.undoOps([arrived.f, lost.f]);
  assert.deepEqual(
    [await left, v.task(7).due_date, v.task(8).due_date, datePatches(v).slice(sent)],
    [0, D(5), D(5), [D(5)]],
    'only the move that arrived is sent back',
  );
  assert.deepEqual([sync.all(1).length, app.failed.length], [0, 0], 'neither move stays in the Outbox');
});
test('an Undo of a move on a task deleted since leaves the outbox, and counts as changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const m = move(app, 7, D(9));
  await m.sending;
  v.tasks.delete(7);
  const { left } = await app.undoOps([m.f]);
  assert.deepEqual([await left, sync.all(1).length, app.failed.length], [1, 0, 0]);
});
/* The sheet's date and repeat (sheet.js) go through the outbox as a `due` and a `repeat` op. A template's date is when
   it next repeats, so a done template shows none, and taking its date off takes three requests (ops/dates.js).
   `sheeted` gives a sender with the sheet open on the first task. */
const sheeted = (t, list, role = null) => {
  const s = dated(t, list);
  Object.defineProperties(s.app, Object.getOwnPropertyDescriptors(sheet));
  Object.defineProperties(s.app, { checklistRole: { value: role, writable: true }, dueTime: { value: '09:00' } });
  Object.assign(s.app.sheet, { id: list[0].id, kind: 'task', open: true });
  return s;
};
const patches = (v, id) => reached(v, 'PATCH', new RegExp(`^/tasks/${id}$`)).map(r => r.body);
const WEEKLY = { repeat_after: 604800, repeat_mode: 0 },
  DAILY = { repeat_after: 86400, repeat_mode: 0 },
  NEVER = { repeat_after: 0, repeat_mode: 0 };
test('a repeat sets its fields, its Undo goes back to what each had, and a later repeat takes the place of one not sent', () => {
  const a = { op: 'repeat', task: 7, set: { ...WEEKLY, due_date: D(9) }, was: { ...NEVER, due_date: ZERO } };
  assert.deepEqual(OPS.repeat.apply({ id: 7, title: 'Water the plants', ...NEVER, due_date: ZERO }, a), {
    id: 7,
    title: 'Water the plants',
    ...WEEKLY,
    due_date: D(9),
  });
  assert.deepEqual(
    OPS.repeat.invert(a),
    { op: 'repeat', task: 7, set: a.was, was: a.set, check: a.set },
    'before Vikunja answers, the Undo checks for the values sent',
  );
  assert.equal(
    OPS.repeat.invert({ ...a, got: { task: { ...WEEKLY, due_date: '2026-10-09T13:00:00Z' } } }).check.due_date,
    '2026-10-09T13:00:00Z',
    'once it answers, for the values Vikunja stored',
  );
  assert.deepEqual(
    OPS.repeat.merge(a, { op: 'repeat', task: 7, set: DAILY, was: WEEKLY }),
    { op: 'repeat', task: 7, set: { ...DAILY, due_date: D(9) }, was: { ...NEVER, due_date: ZERO } },
    'the fields of both, each with the first value before',
  );
  assert.deepEqual(
    [
      OPS.repeat.merge({ op: 'due', task: 7, was: D(5), due: D(9) }, a),
      OPS.due.merge(a, { op: 'due', task: 7, was: D(5), due: D(9) }),
    ],
    [null, null],
    'a repeat and a move never fold into each other',
  );
  assert.deepEqual(
    [
      OPS.repeat.text(a, 'Water the plants'),
      OPS.repeat.text({ set: { repeat_mode: 1 } }, 'Water the plants'),
      OPS.repeat.dropped(a, 'Water the plants'),
    ],
    [
      'Repeats every week: Water the plants',
      'Repeats every month: Water the plants',
      '“Water the plants” stays without a repeat.',
    ],
  );
  assert.equal(
    OPS.repeat.dropped({ ...a, was: WEEKLY }, 'Water the plants'),
    '“Water the plants” repeat stays every week.',
    'Cancel names the repeat it had before',
  );
});
test("a template's date taken off makes it done and keeps its repeat, and its Undo gives the date back, not done", () => {
  const off = { op: 'due', task: 7, tpl: true, was: D(9), due: ZERO, done: true },
    on = { op: 'due', task: 7, tpl: true, was: ZERO, due: D(9), done: false };
  assert.deepEqual(OPS.due.apply({ id: 7, title: 'TEMPLATE: Closing', ...DAILY, due_date: D(9), done: false }, off), {
    id: 7,
    title: 'TEMPLATE: Closing',
    ...DAILY,
    due_date: ZERO,
    done: true,
  });
  assert.deepEqual(OPS.due.invert(off), {
    op: 'due',
    task: 7,
    due: D(9),
    was: ZERO,
    check: ZERO,
    tpl: true,
    done: false,
  });
  assert.deepEqual(OPS.due.invert(on), {
    op: 'due',
    task: 7,
    due: ZERO,
    was: D(9),
    check: D(9),
    tpl: true,
    done: true,
  });
  assert.deepEqual(
    OPS.due.merge(on, { op: 'due', task: 7, tpl: true, was: D(9), due: D(10) }),
    { op: 'due', task: 7, tpl: true, was: ZERO, due: D(10), done: false },
    "a later date keeps the first move's done, because the template is still done in Vikunja",
  );
});
test("the sheet shows a new date and repeat at once, offline, and Vikunja gets each once, as two ops that don't fold", async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false }]);
  app.offline = true;
  const dating = app.setDue(D(9));
  assert.deepEqual([app.dueShown, app.tasks[7].due_date], [D(9), D(9)], 'the sheet and the row show the date at once');
  const repeating = app.setRepeat('week');
  assert.deepEqual([app.repeatValue, app.tasks[7].repeat_after], ['week', 604800]);
  await dating;
  await repeating;
  assert.deepEqual(
    sync.all(1).map(e => e.op),
    ['due', 'repeat'],
  );
  assert.deepEqual(
    [app.waiting.dues[7], app.sheet.dirty],
    [true, true],
    'the row shows it waits, and the screen is drawn again when the sheet closes',
  );
  app.offline = false;
  await app.flush();
  assert.deepEqual(
    [patches(v, 7), sync.all(1), app.dueShown, app.repeatValue],
    [[{ due_date: D(9) }, WEEKLY], [], D(9), 'week'],
  );
});
test('a repeat picked for a task with no date gives it one, and a done template is then not done', async t => {
  const { v, app } = sheeted(
    t,
    [
      { id: 7, title: 'TEMPLATE: Closing', due_date: D(5), ...NEVER, done: true },
      { id: 8, title: 'Water the plants', due_date: ZERO, ...NEVER, done: false },
    ],
    'template',
  );
  assert.equal(app.dueShown, ZERO, 'a done template shows no date');
  await app.setRepeat('day');
  const [body] = patches(v, 7);
  assert.deepEqual(
    [Object.keys(body).sort(), body.done, app.tasks[7].done, v.task(7).repeat_after],
    [['done', 'due_date', 'repeat_after', 'repeat_mode'], false, false, 86400],
  );
  assert.match(
    app.toasts.find(x => x.place === 'sheet:due').msg,
    /^Pocket set the due date to .+, because a repeat needs one\./,
  );
  app.checklistRole = null;
  app.sheet.id = 8;
  await app.setRepeat('week');
  assert.deepEqual(
    [Object.keys(patches(v, 8)[0]).sort(), v.task(8).due_date !== ZERO, v.task(8).repeat_after],
    [['due_date', 'repeat_after', 'repeat_mode'], true, 604800],
    "a task that isn't a template gets a date, and nothing about done",
  );
});
test("a template's date taken off offline sends its three requests once each, and a lost reply on the second finishes the same way", async t => {
  const { v, app } = sheeted(
    t,
    [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false }],
    'template',
  );
  app.offline = true;
  await app.setDue(ZERO);
  assert.deepEqual(
    [app.dueShown, app.tasks[7].done, app.repeatValue],
    [ZERO, true, 'day'],
    'the sheet shows it done, with no date and its repeat, at once',
  );
  let n = 0;
  v.trouble = r => (r.method === 'PATCH' && 'due_date' in r.body && !n++ ? 'lost' : null);
  app.offline = false;
  await app.flush();
  assert.equal(sync.all(1)[0]?.stage, 1, 'the reply to the second request is lost');
  await app.flush();
  const sent = v.requests.filter(r => r.method === 'PATCH');
  assert.deepEqual(patches(v, 7), [NEVER, { due_date: ZERO, done: true }, DAILY], 'each request reaches Vikunja once');
  assert.deepEqual(
    [sent.length, sent[2].key, sent[2].replayed],
    [4, sent[1].key, true],
    'the second is sent again with its key',
  );
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after, sync.all(1)], [true, ZERO, 86400, []]);
  // Giving it a date again is one request, which makes it not done.
  await app.setDue(D(10));
  assert.deepEqual(
    [patches(v, 7).at(-1), v.task(7).done, app.dueShown],
    [{ due_date: D(10), done: false }, false, D(10)],
  );
});
test('an Undo of a repeat puts back each field still as the repeat left it, and leaves one changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Water the plants', due_date: ZERO, ...NEVER, done: false }]);
  const f = {
    id: uuid7(),
    op: 'repeat',
    task: 7,
    set: { ...WEEKLY, due_date: D(9) },
    was: { ...NEVER, due_date: ZERO },
    run: null,
  };
  await app.act(f, true);
  v.task(7).due_date = D(12);
  const { left } = app.undoOps([f]);
  assert.deepEqual(
    [await left, patches(v, 7).at(-1), v.task(7).due_date, app.tasks[7].due_date],
    [1, NEVER, D(12), D(12)],
    'the repeat goes back, and the date changed since stays',
  );
});
/* A row shows the waiting ops on top of Vikunja's copy, so what it shows can differ from what Vikunja has when an op
   is sent: a repeat changed in the web app, a waiting op cancelled. A body that depends on Vikunja's copy is built from
   one read when it is first sent. */
test("a template's date taken off puts back the repeat Vikunja has when it is sent, and is one request when Vikunja's copy doesn't repeat", async t => {
  const { v, app } = sheeted(
    t,
    [
      { id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false },
      { id: 8, title: 'TEMPLATE: Opening', due_date: D(10), ...NEVER, done: false },
    ],
    'template',
  );
  noConnection(app, v);
  await app.setDue(ZERO);
  Object.assign(v.task(7), WEEKLY); // changed in the web app while it waits
  // A repeat picked for the other template shows on its row. Cancelled, it never reaches Vikunja.
  app.sheet.id = 8;
  await app.setRepeat('day');
  await app.setDue(ZERO);
  await app.dropAct(sync.all(1).find(e => e.op === 'repeat').id);
  await settle(t); // the flush Cancel starts finds no connection
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([patches(v, 7), v.task(7).repeat_after], [[NEVER, { due_date: ZERO, done: true }, WEEKLY], 604800]);
  assert.deepEqual(
    [patches(v, 8), v.task(8).repeat_after, v.task(8).done],
    [[{ due_date: ZERO, done: true }], 0, true],
  );
});
test("a repeat sets a date only when Vikunja's copy has none when it is sent", async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false }]);
  noConnection(app, v);
  await app.setDue(ZERO);
  await app.setRepeat('week');
  assert.match(
    app.toasts.find(x => x.place === 'sheet:due')?.msg,
    /^Pocket set the due date to /,
    'the sheet says which date it set, while the repeat waits',
  );
  // The date taken off is cancelled, so Vikunja still has the date.
  await app.dropAct(sync.all(1).find(e => e.op === 'due').id);
  await settle(t);
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([patches(v, 7), v.task(7).due_date], [[WEEKLY], D(5)]);
});
test("a date or a repeat that Vikunja refuses, or may not have, says so under the sheet's date until the sheet closes", async t => {
  const { v, app } = sheeted(t, [
    { id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false },
    { id: 8, title: 'Feed the cat', due_date: D(5), ...NEVER, done: false },
  ]);
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.setDue(D(9));
  const said = () => {
    const x = app.toasts.at(-1);
    return [x.msg, x.place, x.ms, x.action?.label];
  };
  assert.deepEqual(said(), [
    "Moving “Water the plants” couldn't be saved: HTTP 403 from the fake. It's kept to try again.",
    'sheet:due',
    null,
    'Outbox',
  ]);
  assert.equal(app.dueShown, D(5), 'the sheet shows the date Vikunja has');
  v.trouble = r => (r.method === 'PATCH' ? 'unknown' : null);
  app.sheet.id = 8;
  await app.setRepeat('week');
  assert.deepEqual(said(), [
    'Changing how “Feed the cat” repeats may not have reached Vikunja.',
    'sheet:due',
    null,
    'Outbox',
  ]);
});
test("Cancel of a change whose answer is unknown doesn't say what Vikunja has, and a move names both dates", async t => {
  const { v, app } = offlineSender(t);
  app.offline = false;
  v.trouble = r => (r.method === 'PATCH' ? 'unknown' : null);
  await app.act({ op: 'due', task: 8, was: v.task(8).due_date, due: ZERO, run: null, label: 'Pay the rent' });
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  await app.dropAct(app.failed.find(e => e.op === 'due').id);
  assert.equal(lastSaid(app).msg, 'Cancelled. Vikunja may have “Pay the rent” due today or without a date.');
  await app.dropAct(app.failed.find(e => e.op === 'done').id);
  assert.equal(lastSaid(app).msg, 'Cancelled. Vikunja may or may not have this change.');
});
test("Cancel of a template's date taken off partway says its repeat is gone", async t => {
  const { v, app } = sheeted(
    t,
    [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false }],
    'template',
  );
  v.trouble = r => (r.method === 'PATCH' && 'due_date' in r.body ? 403 : null);
  await app.setDue(ZERO);
  assert.deepEqual(
    [app.failed[0]?.stage, v.task(7).repeat_after],
    [1, 0],
    'the repeat is off, and the date is refused',
  );
  await app.dropAct(app.failed[0].id);
  assert.equal(
    lastSaid(app).msg,
    'Cancelled. “TEMPLATE: Closing” no longer repeats. Its due date stays Fri, Oct 9. Set its repeat again in its sheet.',
  );
});
test('a move is one stage, so its entry is saved once when sent and once when answered', async t => {
  const { app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const saves = t.mock.method(sync, 'save');
  await move(app, 7, D(9)).sending;
  assert.equal(saves.mock.callCount(), 2);
});
test('an Undo of a repeat that gave a done template a date leaves it done, by turning the repeat off before done is sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(5), ...NEVER, done: true }]);
  const f = {
    id: uuid7(),
    op: 'repeat',
    task: 7,
    set: { ...DAILY, due_date: D(9), done: false },
    was: { ...NEVER, due_date: D(5), done: true },
    run: null,
  };
  await app.act(f, true);
  assert.deepEqual([v.task(7).done, v.task(7).repeat_after], [false, 86400]);
  const { left } = app.undoOps([f]);
  assert.deepEqual([await left, patches(v, 7).slice(1)], [0, [NEVER, { due_date: D(5), done: true }]]);
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after], [true, D(5), 0]);
});
test('an Undo retried with Try again puts back the repeat Vikunja had when the Undo was first sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: ZERO, ...DAILY, done: true }]);
  const f = { id: uuid7(), op: 'due', task: 7, tpl: true, was: ZERO, due: D(9), done: false, run: null };
  await app.act(f, true);
  Object.assign(v.task(7), WEEKLY); // changed in the web app since
  let n = 0;
  v.trouble = r => (r.method === 'PATCH' && 'due_date' in r.body && !n++ ? 403 : null);
  const { left } = app.undoOps([f]);
  assert.deepEqual(
    [await left, v.task(7).repeat_after],
    [1, 0],
    'the repeat is off, and taking the date off is refused',
  );
  await app.retryAct(app.failed[0].id);
  const off = { due_date: ZERO, done: true };
  assert.deepEqual(
    patches(v, 7).slice(1),
    [NEVER, off, off, WEEKLY],
    'the refused request, then the same one again and the repeat back',
  );
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after, sync.all(1)], [true, ZERO, 604800, []]);
});
/* Taking a template's date off turns its repeat off first. Its Undo puts back the repeat that first request read from
   Vikunja, so the template ends as it was, however far the change got. */
const TEMPLATE = id => ({ id, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false });
const dateOff = (app, task) => {
  const f = { id: uuid7(), op: 'due', task, tpl: true, was: D(9), due: ZERO, done: true, run: null };
  return { f, sending: app.act(f, true) };
};
const asBefore = (v, id) => [v.task(id).due_date, v.task(id).done, v.task(id).repeat_after];
test("an Undo of a template's date taken off and refused partway puts back its date and its repeat", async t => {
  const { v, app } = dated(t, [TEMPLATE(6), TEMPLATE(7), TEMPLATE(8)]);
  // Vikunja refuses 6's first request (its repeat off), 7's second (its date off) and 8's third (its repeat back).
  const refused = {
    '/tasks/6': b => b.repeat_after === 0,
    '/tasks/7': b => 'due_date' in b,
    '/tasks/8': b => b.repeat_after > 0,
  };
  v.trouble = r => (r.method === 'PATCH' && refused[r.path]?.(r.body) ? 403 : null);
  const offs = [6, 7, 8].map(id => dateOff(app, id));
  for (const o of offs) await o.sending;
  assert.deepEqual(
    [app.failed.map(e => [e.task, e.stage]), [6, 7, 8].map(id => v.task(id).repeat_after)],
    [
      [
        [6, 0],
        [7, 1],
        [8, 2],
      ],
      [86400, 0, 0],
    ],
  );
  v.trouble = () => null;
  const { left } = app.undoOps(offs.map(o => o.f));
  assert.deepEqual(
    [app.tasks[8].due_date, app.tasks[8].done, app.tasks[8].repeat_after],
    [D(9), false, 86400],
    'the row shows the Undo at once',
  );
  assert.equal(await left, 0);
  assert.deepEqual(
    [6, 7, 8].map(id => asBefore(v, id)),
    [
      [D(9), false, 86400],
      [D(9), false, 86400],
      [D(9), false, 86400],
    ],
  );
  assert.deepEqual(
    [patches(v, 6).length, patches(v, 7).at(-1), patches(v, 8).at(-1), sync.all(1)],
    [1, DAILY, { due_date: D(9), done: false, ...DAILY }, []],
    'nothing is sent for 6, whose first request changed nothing, and each field still as the change left it is put back',
  );
});
test("an Undo of a template's date taken off whose answer is unknown puts back the repeat if Vikunja made it, and sends nothing if not", async t => {
  const { v, app } = dated(t, [TEMPLATE(7), TEMPLATE(8)]);
  v.trouble = r => (r.method === 'PATCH' && r.body.repeat_after === 0 ? 'unknown' : null);
  const offs = [7, 8].map(id => dateOff(app, id));
  for (const o of offs) await o.sending;
  assert.deepEqual(
    app.failed.map(e => [e.task, e.stage, e.failed.message]),
    [
      [7, 0, UNKNOWN],
      [8, 0, UNKNOWN],
    ],
  );
  v.trouble = () => null;
  Object.assign(v.task(7), NEVER); // Vikunja made 7's first request
  const { left } = app.undoOps(offs.map(o => o.f));
  assert.deepEqual([await left, asBefore(v, 7), asBefore(v, 8)], [0, [D(9), false, 86400], [D(9), false, 86400]]);
  assert.deepEqual([patches(v, 7).slice(1), patches(v, 8).slice(1), sync.all(1)], [[DAILY], [], []]);
});
