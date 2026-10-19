// Tests for the outbox's sender (src/js/app/acts.js), against a fake Vikunja behind the plugin's relay: a lost reply,
// an answer the relay can't vouch for, Try again, Cancel and its Undo, flush, and a new op meeting an earlier one.
import './browser.mjs';
import { sender, reached, lostOnce, noConnection, settle, offlineSender, lastSaid } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLines, OPS } from '../../src/js/ops/index.js';
import { copyOf, started, TASK_REACTIONS_COMMENTS } from '../../src/js/app/tasks.js';
import { CANCEL, sync } from '../../src/js/sync.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { NOT_KEPT, UNKNOWN } from '../../src/js/messages.js';
import sheet from '../../src/js/app/sheet.js';

test("a tick on a repeating step whose reply is lost moves the step's date once when it is sent again", async t => {
  const step = {
    id: 2,
    title: 'Check the fridge',
    done: false,
    due_date: '2026-10-07T09:00:00Z',
    repeat_after: 86400,
    related_tasks: { parenttask: [{ id: 1 }] },
  };
  const { v, app } = sender(t, [{ id: 1, title: 'Closing', related_tasks: { subtask: [{ id: 2 }] } }, step]);
  lostOnce(v, 'PATCH', /^\/tasks\/2$/);
  const r = await app.act({ op: 'done', task: 2, run: 1 });
  assert.equal(r.status, 'offline', 'a lost reply leaves the tick waiting');
  await app.sendActs(app.pending[0].id);
  assert.deepEqual(
    [reached(v, 'PATCH', /^\/tasks\/2$/).length, v.task(2).due_date],
    [1, new Date(vikunjaNext(step)).toISOString()],
  );
  assert.deepEqual(
    [v.task(2).reactions?.['✅'], sync.all(1).length],
    [undefined, 0],
    'the step moved on to its next date is open, so it gets no ✅',
  );
});
test('a comment whose reply is lost is posted once when it is sent again', async t => {
  const { v, app } = sender(t, [{ id: 5, title: 'Call the plumber' }]);
  lostOnce(v, 'POST', /comments$/);
  await app.act({ op: 'note', task: 5, html: '<p>Booked</p>', run: null });
  await app.sendActs(app.pending[0].id);
  assert.deepEqual([v.task(5).comments.length, reached(v, 'POST', /comments$/).length, sync.all(1).length], [1, 1, 0]);
});
test('a claim whose reply is lost is made once when it is sent again', async t => {
  const { v, app } = sender(t, [{ id: 6, title: 'Order cups', assignees: [] }]);
  lostOnce(v, 'POST', /assignees$/);
  await app.act({ op: 'claim', task: 6, run: null });
  await app.sendActs(app.pending[0].id);
  assert.deepEqual(
    [v.task(6).assignees.map(u => u.id), reached(v, 'POST', /assignees$/).length, sync.all(1).length],
    [[1], 1, 0],
  );
});
test('a deletion whose reply is lost half way deletes each task once when it is sent again', async t => {
  const { v, app } = sender(t, [
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } },
    { id: 2, title: 'Pack the cups', related_tasks: { subtask: [{ id: 3 }] } },
    { id: 3, title: 'Wrap them' },
  ]);
  lostOnce(v, 'DELETE', /^\/tasks\/2$/);
  await app.act({ op: 'delete', task: 1, ids: [3, 2, 1], run: null });
  assert.deepEqual(
    reached(v, 'DELETE', /./).map(r => r.path),
    ['/tasks/3', '/tasks/2'],
  );
  await app.sendActs(app.pending[0].id);
  assert.deepEqual(
    reached(v, 'DELETE', /./).map(r => r.path),
    ['/tasks/3', '/tasks/2', '/tasks/1'],
    'the first two get the answers the relay kept',
  );
  assert.deepEqual([[1, 2, 3].filter(id => v.task(id)), sync.all(1).length], [[], 0]);
});
test("a change the relay can't vouch for is kept as failed, and Try again sends it with a new key", async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  v.trouble = r => (r.method === 'PATCH' ? 'unknown' : null);
  const r = await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  assert.deepEqual([r.status, app.failed.length, app.failed[0].failed.message], ['error', 1, UNKNOWN]);
  assert.equal(
    app.toasts.at(-1).msg,
    "A tick on “Wipe the till” may not have reached Vikunja. Check, then tap Try again if it's missing.",
  );
  // Its Outbox button opens the Outbox and sends nothing, because the user checks Vikunja first.
  let opened = null;
  app.openSheet = kind => {
    opened = kind;
  };
  const sent = v.requests.length;
  app.toasts.at(-1).action.fn();
  assert.deepEqual([app.toasts.at(-1).action.label, opened, v.requests.length], ['Outbox', 'outbox', sent]);
  assert.equal(app.outboxRows[0].failed, "May not have reached Vikunja. Check, then tap Try again if it's missing.");
  assert.ok(!v.task(7).done, "the change wasn't made");
  const first = v.requests.find(q => q.method === 'PATCH').key;
  v.trouble = () => null;
  await app.retryAct(app.failed[0].id);
  const again = v.requests.filter(q => q.method === 'PATCH').at(-1).key;
  assert.notEqual(again.split(':')[0], first.split(':')[0], 'the key is new');
  assert.deepEqual([again.split(':').slice(1), v.task(7).done, sync.all(1).length], [['0', '0'], true, 0]);
});
test('a refused change kept to try again, and a change held behind it, each have a button that opens the Outbox', async t => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  const kept = app.toasts.at(-1);
  await app.act({ op: 'progress', task: 7, pct: 50, run: null, label: 'Wipe the till' });
  const held = app.toasts.find(x => /^Not sent/.test(x.msg));
  assert.deepEqual(
    [kept.msg, kept.action?.label],
    ["A tick on “Wipe the till” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox'],
  );
  assert.deepEqual(
    [held.msg, held.action?.label],
    ['Not sent. Vikunja refused an earlier change to “Wipe the till”.', 'Outbox'],
  );
});
// A change held behind a refused one goes only after Try again or Cancel on the refused one, not every 30 seconds.
test('a change held behind a refused one is said by the sender alone, and its caller says nothing more', async t => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }], sheet);
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  const before = app.toasts.length;
  Object.assign(app.sheet, { id: 7, commentDraft: 'Counted twice' });
  await app.postComment();
  // The fake has no database for the outbox, so the sender also says the phone couldn't keep the comment.
  assert.deepEqual(
    app.toasts
      .slice(before)
      .map(x => x.msg)
      .filter(m => m !== NOT_KEPT),
    ['Not sent. Vikunja refused an earlier change to “Wipe the till”.'],
  );
});
/* A request that gets no answer may have reached Vikunja, and after it an act can't be dropped. So while Pocket knows
   it is offline, an act's first request isn't tried, and flush sends a read first to find out. */
const offlineTick = async (t, mark) => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  mark(app, v);
  const r = await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  return { v, app, r };
};
for (const [how, mark] of [
  ['Pocket has found no connection', noConnection],
  [
    'the browser says it is offline',
    () => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }),
  ],
])
  test(`a tick made while ${how} is not tried, and can be cancelled`, async t => {
    t.after(() => {
      delete navigator.onLine;
    });
    const { v, app, r } = await offlineTick(t, mark);
    await settle(t);
    assert.deepEqual(
      [r.status, v.requests.filter(q => q.path !== '/user').length, app.pending[0].sent, app.offline],
      ['offline', 0, undefined, true],
    );
    assert.deepEqual(app.outboxRows[0].drop, ['dropAct', app.pending[0].id], 'the Outbox offers Cancel');
    await app.dropAct(app.pending[0].id);
    assert.deepEqual(
      [sync.all(1).length, v.requests.filter(q => q.path !== '/user').length, v.task(7).done],
      [0, 0, undefined],
    );
  });
test('Cancel asks nothing, says what Vikunja keeps, and its Undo puts the entry back in its place with its key, sent once', async t => {
  const { v, app } = offlineSender(t);
  for (const f of [
    { op: 'done', task: 7 },
    { op: 'due', task: 8, was: v.task(8).due_date, due: '0001-01-01T00:00:00Z' },
    { op: 'claim', task: 9 },
  ])
    await app.act({ ...f, run: null, label: v.task(f.task).title });
  const [tick, move, claim] = sync.all(1),
    was = JSON.parse(JSON.stringify(move));
  await app.dropAct(move.id);
  assert.deepEqual(
    sync.all(1).map(e => e.id),
    [tick.id, claim.id],
    'the move leaves at once',
  );
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action.label, lastSaid(app).place],
    ['Cancelled. “Pay the rent” due date stays today.', 'Undo', 'sheet:top'],
  );
  await lastSaid(app).action.fn();
  assert.deepEqual(
    sync.all(1).map(e => e.id),
    [tick.id, move.id, claim.id],
    'Undo puts it back where it was',
  );
  assert.deepEqual(sync.all(1)[1], was, 'the same entry, with its key');
  assert.deepEqual(
    v.requests.filter(q => q.path !== '/user'),
    [],
    'nothing is sent while offline',
  );
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(
    [reached(v, 'PATCH', /^\/tasks\/8$/).length, v.task(8).due_date, sync.all(1)],
    [1, '0001-01-01T00:00:00Z', []],
  );
});
test("Cancel's Undo does nothing once its message has gone", async t => {
  const { app } = offlineSender(t);
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  await app.dropAct(sync.all(1)[0].id);
  const said = lastSaid(app);
  said.gone();
  await said.action.fn();
  assert.deepEqual(sync.all(1), []);
});
/* The words each op says after Cancel are in WORDS above, and parse.mjs checks an answer's, which are read from HTML.
   A comment's text goes back to its box, so it has no Undo. */
test('Cancel offers Undo except for a comment, whose text goes back to its box', async t => {
  const { app } = offlineSender(t);
  const cancel = async f => {
    await app.act({ run: null, label: 'Wipe the till', task: 7, ...f });
    await app.dropAct(sync.all(1).at(-1).id);
    return [lastSaid(app).msg, lastSaid(app).action?.label ?? null];
  };
  assert.deepEqual(await cancel({ op: 'done' }), ['Cancelled. “Wipe the till” stays not done.', 'Undo']);
  assert.deepEqual(await cancel({ op: 'claim' }), ['Cancelled. “Wipe the till” stays unassigned.', 'Undo']);
  assert.deepEqual(await cancel({ op: 'answer', html: '' }), [
    "Cancelled. Your answer to “Wipe the till” isn't saved.",
    'Undo',
  ]);
  assert.deepEqual(await cancel({ op: 'note', html: '' }), [
    'Cancelled. Your comment is back where you typed it.',
    null,
  ]);
});
test("Cancel's Undo puts a refused change back as refused, to try again", async t => {
  const { v, app } = offlineSender(t);
  app.offline = false;
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  const [e] = app.failed;
  await app.dropAct(e.id);
  assert.deepEqual([app.failed, lastSaid(app).msg], [[], 'Cancelled. “Wipe the till” stays not done.']);
  await lastSaid(app).action.fn();
  assert.deepEqual(
    [app.failed.map(x => [x.id, x.failed.message]), reached(v, 'PATCH', /^\/tasks\/7$/).length],
    [[[e.id, 'HTTP 403 from the fake']], 1],
  );
});
test('a tick made just after a brief drop is sent once a read gets through, without waiting for the 30-second timer', async t => {
  const { v, app, r } = await offlineTick(t, app => {
    app.offline = true;
  });
  assert.equal(r.status, 'offline');
  await settle(t, () => !sync.all(1).length);
  assert.deepEqual(
    [v.requests.map(q => q.method + ' ' + q.path).slice(0, 2), v.task(7).done, sync.all(1).length, app.offline],
    [['GET /user', 'PATCH /tasks/7'], true, 0, false],
  );
});
test('flush while offline sends a read first, and sends the waiting tick only once the read is answered', async t => {
  const { v, app } = await offlineTick(t, app => {
    app.offline = true;
  });
  v.trouble = () => 'offline';
  await app.flush();
  assert.deepEqual(
    [v.requests.map(q => q.method + ' ' + q.path), app.pending.length, app.offline],
    [['GET /user'], 1, true],
    'nothing more after the read fails',
  );
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(
    [v.requests.map(q => q.method + ' ' + q.path).slice(1, 3), v.task(7).done, sync.all(1).length, app.offline],
    [['GET /user', 'PATCH /tasks/7'], true, 0, false],
  );
});
test('a flush asked for while one runs runs once more when that one ends', async t => {
  const { v, app } = await offlineTick(t, app => {
    app.offline = true;
  });
  // The first flush's read fails once the connection is back, and the second flush is asked for meanwhile.
  const send = globalThis.fetch;
  let release;
  const gate = new Promise(ok => {
    release = ok;
  });
  globalThis.fetch = async (url, opts) => {
    globalThis.fetch = send;
    await gate;
    throw new TypeError('Failed to fetch');
  };
  t.after(() => {
    globalThis.fetch = send;
  });
  const first = app.flush();
  await app.flush();
  release();
  await first;
  assert.deepEqual(
    [v.requests.map(q => q.method + ' ' + q.path).slice(0, 2), v.task(7).done, sync.all(1).length],
    [['GET /user', 'PATCH /tasks/7'], true, 0],
  );
});
test('a tick whose reply was lost is sent again with its key once flush finds the connection', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  lostOnce(v, 'PATCH', /^\/tasks\/7$/);
  const r = await app.act({ op: 'done', task: 7, run: null });
  assert.deepEqual([r.status, app.pending[0].sent, app.offline], ['offline', true, true]);
  await app.flush();
  const patches = v.requests.filter(q => q.method === 'PATCH');
  assert.deepEqual(
    [v.requests[1].path, v.requests[2], patches[1].key, patches[1].replayed],
    ['/user', patches[1], patches[0].key, true],
  );
  assert.deepEqual([reached(v, 'PATCH', /^\/tasks\/7$/).length, v.task(7).done, sync.all(1).length], [1, true, 0]);
});
/* What a finished stage got from Vikunja is kept in the entry, as a body built once is. A tick with a comment whose
   last stage is cut off is sent again in a new try, and its answer still has the comment Vikunja made and Vikunja's
   copy of the step. */
test('a tick with a comment that finishes on a later try still answers with the comment and the step Vikunja made', async t => {
  const { v, app } = sender(t, [
    { id: 1, title: 'Closing', related_tasks: { subtask: [{ id: 2 }] } },
    { id: 2, title: 'Mop the floor', done: false, comments: [], reactions: {} },
  ]);
  app.change(w =>
    w.read(
      [{ id: 2, title: 'Mop the floor', done: false, comments: [], reactions: {}, updated: 'before' }],
      TASK_REACTIONS_COMMENTS,
      started(),
    ),
  );
  let cut = true;
  v.trouble = r => (r.method === 'GET' && r.path === '/tasks/1' && cut ? ((cut = false), 'offline') : null);
  const r = await app.act({ op: 'doneNote', task: 2, run: 1, html: '<p>Bucket is in the shed</p>' });
  assert.deepEqual(
    [r.status, app.pending[0].stage],
    ['offline', 3],
    'the tick, its ✅ and its comment are sent, and the progress is not',
  );
  await app.sendActs(app.pending[0].id);
  assert.equal(sync.all(1).length, 0);
  const posted = v.task(2).comments[0];
  assert.deepEqual(
    [copyOf(2).comments.map(c => [c.id, !!c.waiting]), copyOf(2).updated],
    [[[posted.id, false]], v.task(2).updated],
  );
});
/* Two made-up ops show what fold does for any op. `off` cancels an `on` before it, as an untick cancels a tick, and
   `on` names its own key in `waiting`. */
test('a new op meets any earlier op on its task, and can cancel it, so both leave the outbox', async t => {
  const op = (merge, waiting) => ({
    apply: x => ({ ...x }),
    stages: [async () => {}],
    asks: [],
    saw: ['label'],
    invert: null,
    merge,
    waiting,
    text: () => '',
    refused: () => '',
    dropped: () => '',
  });
  Object.assign(OPS, { on: op(null, 'ons'), off: op((older, newer) => (older.op === 'on' ? CANCEL : null)) });
  t.after(() => {
    delete OPS.on;
    delete OPS.off;
    for (const x of sync.all(1)) sync.remove(x.id);
  });
  const { v, app } = sender(t, [{ id: 7, title: 'Call the plumber' }]);
  app.row(v.task(7));
  app.offline = true;
  await app.act({ op: 'on', task: 7, run: null });
  assert.deepEqual([sync.all(1).length, app.waiting.ons[7]], [1, true], "the op's own key marks its row as waiting");
  await app.act({ op: 'off', task: 7, run: null });
  assert.deepEqual([sync.all(1).length, app.waiting.ons[7]], [0, undefined], 'nothing is left to send');
});
/* A line refused after its task was made is kept in the Outbox, as any change is. `halfAdded` adds two lines in task
   9's subtask box, the second under the first. Vikunja refuses to put the first under task 9. */
const halfAdded = async t => {
  const { v, app } = sender(t, [{ id: 9, title: 'Pack the van', project_id: 5, related_tasks: {} }]);
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  v.trouble = r => (r.path === '/tasks/9/relations' ? 403 : null);
  const line = (title, under = null) => ({
    raw: title,
    p: {
      title,
      due: null,
      priority: 0,
      repeat: null,
      labels: [],
      assignees: [],
      project: null,
      remind: false,
      done: false,
      pct: 0,
    },
    under,
  });
  const es = addLines([line('Load chairs'), line('Stack them', 0)], {
    parent: { id: 9, project_id: 5, title: 'Pack the van' },
  }).map(f => app.actEntry(f));
  return { v, app, es, r: await app.sendLines(es) };
};
const made = v => reached(v, 'POST', /^\/projects\/5\/tasks$/).map(r => r.body.title);
test('a line refused after its task was made stays in the Outbox, says it is added, and the line under it waits', async t => {
  const { v, app, r } = await halfAdded(t);
  assert.deepEqual(
    [lastSaid(app).msg, lastSaid(app).action?.label],
    [
      "Adding “Load chairs” couldn't be saved in full (it's added): HTTP 403 from the fake. It's kept to try again.",
      'Outbox',
    ],
  );
  assert.deepEqual(
    [r.error, r.unsent],
    [undefined, []],
    'the add box has nothing of its own to say, and nothing goes back to it',
  );
  assert.deepEqual(
    app.outboxRows.map(x => [x.text, x.failed, x.retry, x.drop?.[0]]),
    [
      ['Finishing “Load chairs”', 'Vikunja refused it: HTTP 403 from the fake', true, 'dropAct'],
      ['Subtask of “Load chairs”: Stack them', '', false, 'cancelPending'],
    ],
  );
  assert.deepEqual(made(v), ['Load chairs']);
});
test('Try again of a line whose task was made sends only the stages left, then the line under it', async t => {
  const { v, app, es } = await halfAdded(t);
  v.trouble = () => null;
  await app.retryAct(es[0].id);
  assert.deepEqual(
    [made(v), reached(v, 'POST', /\/relations$/).map(r => r.path), sync.all(1)],
    [['Load chairs', 'Stack them'], ['/tasks/9/relations', '/tasks/9/relations', '/tasks/101/relations'], []],
  );
});
test('Cancel of a line whose task was made leaves the task in Vikunja, offers no Undo, and sends the line under it under that task', async t => {
  const { v, app, es } = await halfAdded(t);
  v.trouble = () => null;
  await app.dropAct(es[0].id);
  assert.deepEqual([lastSaid(app).msg, lastSaid(app).action], ['Cancelled. “Load chairs” is added.', null]);
  await settle(t, () => !sync.all(1).length);
  assert.deepEqual(
    [made(v), reached(v, 'POST', /\/relations$/).map(r => r.path), sync.all(1)],
    [['Load chairs', 'Stack them'], ['/tasks/9/relations', '/tasks/101/relations'], []],
  );
});
