// Tests for the ops in the outbox (src/js/ops/): every op declares every field, its apply and its words, and the
// sender asks the op what to do. sender.test.mjs tests the sender, and ops-dates.test.mjs the date ops.
import './browser.mjs';
import { sender, noConnection, offlineSender, lastSaid } from './ops-helpers.mjs';
import { component, fakeVikunja, outboxOf } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cancelOf, COMMON, DEFAULTS, opOf, OPS, refusalOf, SENT, stageView } from '../../src/js/ops/index.js';
import { heldTasks, stageContext, waits } from '../../src/js/app/acts.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { figure } from '../../src/js/ops/stages.js';

const FIELDS = ['apply', 'stages', ...Object.keys(DEFAULTS), 'text', 'refused', 'dropped'];
/* An op sets every field, to its own value or to null for the default, so a new op decides each one. The comment on OPS
   names every field, since it is where a new op is made from. */
test('every op defines every field, null for the default, and the comment on OPS names each', () => {
  for (const [name, op] of Object.entries(OPS)) {
    for (const f of FIELDS) assert.ok(f in op, `${name} has ${f}`);
    for (const f of ['apply', 'text', 'refused', 'dropped']) assert.equal(typeof op[f], 'function', `${name}.${f}`);
    const stages = typeof op.stages === 'function' ? op.stages({ set: {} }) : op.stages;
    assert.ok(stages.length && stages.every(s => typeof s === 'function'), `${name} has its requests`);
    const full = opOf({ op: name });
    for (const f of ['on', 'answered', 'holds', 'waitsOn', 'row', 'files', 'deletes'])
      assert.equal(typeof full[f], 'function', `${name}.${f}`);
    // A refusal and a Cancel may depend on the entry, here one whose task isn't made yet and one whose task is.
    for (const a of [{ op: name }, { op: name, taskId: 4 }])
      assert.deepEqual(
        [
          typeof full.keepReads,
          ['kept', 'back', 'lines', 'undone'].includes(refusalOf(a)),
          ['undo', 'text', 'back', 'lines', 'made'].includes(cancelOf(a)),
        ],
        ['boolean', true, true],
        name,
      );
    assert.ok(Array.isArray(op.asks) && Array.isArray(op.saw), `${name} declares asks and saw`);
    assert.deepEqual(
      op.asks.filter(k => op.saw.includes(k)),
      [],
      `${name}: no field is in both asks and saw`,
    );
    assert.deepEqual(
      [...op.asks, ...op.saw].filter(k => COMMON.includes(k) || SENT.includes(k)),
      [],
      `${name}: asks and saw leave out the fields every entry has`,
    );
  }
  const comment = readFileSync(new URL('../../src/js/ops/index.js', import.meta.url), 'utf8').split('*/')[0];
  for (const f of FIELDS)
    assert.match(comment, new RegExp(`^ +- (\\w+, )*${f}\\b`, 'm'), `the comment on OPS names ${f}`);
});
test('apply returns the task as a new object, and leaves the task and the op alone', () => {
  const task = {
      id: 4,
      title: 'Unlock the door',
      done: false,
      percent_done: 0.25,
      assignees: [{ id: 2 }],
      reactions: {},
      comments: [],
    },
    was = structuredClone(task);
  for (const [name, op] of Object.entries(OPS)) {
    const a = {
        id: 'e1',
        op: name,
        task: 4,
        user: 1,
        pct: 50,
        ids: [4],
        at: '2026-10-15T09:00:00.000Z',
        html: '<p>Done</p>',
      },
      before = structuredClone(a),
      out = op.apply(task, a);
    assert.notEqual(out, task, name);
    assert.deepEqual([task, a], [was, before], `${name} changed nothing it was given`);
  }
  assert.deepEqual(
    [
      OPS.done.apply(task, { user: 1 }).done,
      OPS.undone.apply({ ...task, done: true }, { user: 1 }).done,
      OPS.progress.apply(task, { pct: 50 }).percent_done,
    ],
    [true, false, 0.5],
  );
  assert.deepEqual(
    OPS.claim.apply(task, { user: 1 }).assignees.map(u => u.id),
    [2, 1],
  );
  assert.deepEqual(OPS.unclaim.apply(task, { user: 2 }).assignees, []);
});
/* Each op shows itself through its apply: the task as it will be once Vikunja has made the change. A row shows it while
   the op waits, and Vikunja's copy takes it when the op is answered. */
test("each op's apply shows its change: a tick with the user's ✅, a skip with ⏭️, a comment marked waiting, a claim with the claimer's name", () => {
  const me = { id: 1, username: 'alex', name: 'Alex' },
    priya = { id: 2, username: 'priya' },
    at = '2026-10-15T09:00:00.000Z',
    NONE = '0001-01-01T00:00:00Z';
  const step = {
    id: 4,
    title: 'Unlock the door',
    done: false,
    done_at: NONE,
    reactions: { '✅': [priya] },
    comments: [{ id: 7, comment: '<p>Key under the mat</p>', author: priya }],
    assignees: [],
  };
  const a = (op, more = {}) => ({ id: 'e-' + op, op, task: 4, user: 1, who: me, at, ...more });
  const done = OPS.done.apply(step, a('done'));
  assert.deepEqual(
    [done.done, done.done_at, done.reactions['✅'], done.reactions['⏭️'], done.comments.length],
    [true, at, [priya, me], [], 1],
    "done at the op's time, with a ✅",
  );
  const skipped = OPS.skip.apply(done, a('skip', { html: '<p>Skipped: no key</p>' }));
  assert.deepEqual(
    [skipped.reactions['✅'], skipped.reactions['⏭️'], skipped.comments.at(-1)],
    [[priya], [me], { id: 'e-skip', comment: '<p>Skipped: no key</p>', author: me, created: at, waiting: true }],
    "a skip takes the user's ✅ off, puts a ⏭️ on and adds its comment, marked waiting",
  );
  const undone = OPS.undone.apply(skipped, a('undone'));
  assert.deepEqual(
    [undone.done, undone.done_at, undone.reactions['✅'], undone.reactions['⏭️']],
    [false, NONE, [priya], []],
    "not done: only the user's own ✅ and ⏭️ go",
  );
  assert.deepEqual(
    OPS.doneNote.apply(step, a('doneNote', { html: '<p>Done early</p>' })).comments.map(c => [c.comment, !!c.waiting]),
    [
      ['<p>Key under the mat</p>', false],
      ['<p>Done early</p>', true],
    ],
  );
  for (const op of ['note', 'answer'])
    assert.deepEqual(OPS[op].apply(step, a(op, { html: '<p>7 °C</p>' })).comments.at(-1).author, me, op);
  const listed = { id: 4, title: 'Unlock the door', done: false };
  assert.deepEqual(
    OPS.doneNote.apply(listed, a('doneNote', { html: '<p>Done early</p>' })),
    { ...listed, done: true, done_at: at },
    'a task read without its reactions and comments gets neither, or one ✅ would read as the only one',
  );
  assert.deepEqual(
    [OPS.claim.apply(step, a('claim')).assignees, OPS.claim.apply(step, { user: 1 }).assignees],
    [[me], [{ id: 1 }]],
    'a claim adds the claimer with their name, or only their id for an entry queued before Pocket kept it',
  );
  assert.deepEqual(
    [
      OPS.progress.apply(step, a('progress', { pct: 40 })).percent_done,
      OPS.finish.apply(step, a('finish')).done,
      OPS.reopen.apply(done, a('reopen')).done,
    ],
    [0.4, true, false],
  );
  const van = { id: 1, related_tasks: { subtask: [{ id: 4 }, { id: 5 }] } },
    del = a('delete', { ids: [6, 4], up: 1 });
  assert.deepEqual(
    [OPS.delete.apply(van, del).related_tasks.subtask, OPS.delete.on(del)],
    [[{ id: 5 }], [6, 4, 1]],
    'a delete takes its tasks off the parent that stays',
  );
});
/* A deleted subtask's last stage writes its parent's progress. When a waiting delete deletes the parent too, the
   stage leaves it alone. Swiping a subtask on Today and then its parent did this. */
test("a deleted subtask's figure stage skips a parent that a waiting delete deletes", async () => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 3 }] } }]),
    app = component(tasks);
  app.pending = [{ kind: 'act', op: 'delete', id: 'd1', task: 1, ids: [1], items: [] }];
  outboxOf(app, app.pending);
  const a = { id: 'd2', op: 'delete', task: 2, ids: [2], up: 1, stage: 1 };
  await figure(a, stageContext(a, app).start());
  assert.deepEqual(v.requests, [], 'the parent is neither read nor written');
});
/* Each op's words, as the outbox said them before the ops had words of their own: its row in the Outbox, what a
   refusal calls it, and what Cancel leaves in Vikunja before and after its first request. The first row of each
   has a step's title with its time, and the second has no title. */
const WORDS = {
  done: [
    [
      'Done: Unlock the door',
      'A tick on “Unlock the door”',
      '“Unlock the door” stays not done in Vikunja.',
      '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Done: a step',
      'A tick',
      '“it” stays not done in Vikunja.',
      '“it” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
  ],
  undone: [
    [
      'Not done: Unlock the door',
      'Marking “Unlock the door” not done',
      '“Unlock the door” stays done in Vikunja.',
      '“Unlock the door” stays not done in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Not done: a step',
      'Marking a step not done',
      '“it” stays done in Vikunja.',
      '“it” stays not done in Vikunja. The rest of the change is not sent.',
    ],
  ],
  skip: [
    [
      'Skipped: Unlock the door',
      'A skip on “Unlock the door”',
      '“Unlock the door” stays not done in Vikunja.',
      '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Skipped: a step',
      'A skip',
      '“it” stays not done in Vikunja.',
      '“it” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
  ],
  doneNote: [
    [
      'Done, with a comment: Unlock the door',
      'Marking “Unlock the door” done, with its comment',
      '“Unlock the door” stays not done in Vikunja.',
      '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Done, with a comment: a step',
      'Marking a step done, with its comment',
      '“it” stays not done in Vikunja.',
      '“it” stays marked done in Vikunja. The rest of the change is not sent.',
    ],
  ],
  note: [
    [
      'A comment on “Unlock the door”',
      'A comment on “Unlock the door”',
      'Your comment is back where you typed it.',
      'Your comment is back where you typed it.',
    ],
    [
      'A comment on “a step”',
      'A comment',
      'Your comment is back where you typed it.',
      'Your comment is back where you typed it.',
    ],
  ],
  answer: [
    [
      'Unlock the door',
      'Answers on “Unlock the door”',
      "Your answer to “Unlock the door” isn't saved.",
      "Your answer to “Unlock the door” isn't saved.",
    ],
    ['a step', 'Answers', "Your answer to “it” isn't saved.", "Your answer to “it” isn't saved."],
  ],
  finish: [
    [
      'Finishing “Unlock the door”',
      'Finishing the checklist',
      'The checklist stays open in Vikunja.',
      'The checklist stays finished in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Finishing “a step”',
      'Finishing the checklist',
      'The checklist stays open in Vikunja.',
      'The checklist stays finished in Vikunja. The rest of the change is not sent.',
    ],
  ],
  reopen: [
    [
      'Reopening “Unlock the door”',
      'Reopening the checklist',
      'The checklist stays finished in Vikunja.',
      'The checklist stays open in Vikunja. The rest of the change is not sent.',
    ],
    [
      'Reopening “a step”',
      'Reopening the checklist',
      'The checklist stays finished in Vikunja.',
      'The checklist stays open in Vikunja. The rest of the change is not sent.',
    ],
  ],
  progress: [
    [
      'Progress: 40% on “Unlock the door”',
      'Progress on “Unlock the door”',
      '“Unlock the door” keeps the progress it has in Vikunja.',
      '“Unlock the door” keeps the progress it has in Vikunja.',
    ],
    [
      'Progress: 40% on “a step”',
      'Progress',
      '“it” keeps the progress it has in Vikunja.',
      '“it” keeps the progress it has in Vikunja.',
    ],
  ],
  claim: [
    [
      'Assigning “Unlock the door” to you',
      'Assigning “Unlock the door” to you',
      'You are not assigned to “Unlock the door”.',
      'You are not assigned to “Unlock the door”.',
    ],
    [
      'Assigning “a step” to you',
      'Assigning it to you',
      'You are not assigned to “it”.',
      'You are not assigned to “it”.',
    ],
  ],
  unclaim: [
    [
      'Unassigning you from “Unlock the door”',
      'Unassigning you from “Unlock the door”',
      '“Unlock the door” stays assigned to you.',
      '“Unlock the door” stays assigned to you.',
    ],
    [
      'Unassigning you from “a step”',
      'Unassigning you from it',
      '“it” stays assigned to you.',
      '“it” stays assigned to you.',
    ],
  ],
  delete: [
    [
      'Deleting “Unlock the door”, with 2 subtasks',
      'Deleting “Unlock the door”',
      '“Unlock the door” stays in Vikunja.',
      '“Unlock the door” stays in Vikunja.',
    ],
    ['Deleting “a step”, with 2 subtasks', 'Deleting a task', '“it” stays in Vikunja.', '“it” stays in Vikunja.'],
  ],
  position: [
    [
      'Moving “Unlock the door” in its list',
      'Moving “Unlock the door T#5m”',
      "“Unlock the door” stays where it was in Vikunja's list.",
      "“Unlock the door” stays where it was in Vikunja's list.",
    ],
    [
      'Moving “a step” in its list',
      'Moving a task',
      "“it” stays where it was in Vikunja's list.",
      "“it” stays where it was in Vikunja's list.",
    ],
  ],
  edit: [
    [
      'Renaming “Unlock the door” to “Unlock the back door”',
      'Renaming “Unlock the door”',
      '“Unlock the door” keeps its title in Vikunja.',
      '“Unlock the door” keeps its title in Vikunja.',
    ],
    [
      'Renaming a task to “Unlock the back door”',
      'Renaming a task',
      '“it” keeps its title in Vikunja.',
      '“it” keeps its title in Vikunja.',
    ],
  ],
  add: [
    ['New task: Unlock the door T#5m', 'Adding “Unlock the door T#5m”', '', ''],
    ['New task: ', 'Adding a task', '', ''],
  ],
  due: [
    [
      'Removed its due date: Unlock the door',
      'Moving “Unlock the door T#5m”',
      '“Unlock the door” stays without a date.',
      '“Unlock the door” stays without a date.',
    ],
    ['Removed its due date: a step', 'Moving a task', '“it” stays without a date.', '“it” stays without a date.'],
  ],
  repeat: [
    [
      "Doesn't repeat: Unlock the door",
      'Changing how “Unlock the door” repeats',
      "“Unlock the door” still doesn't repeat.",
      "“Unlock the door” still doesn't repeat.",
    ],
    [
      "Doesn't repeat: a step",
      'Changing how a task repeats',
      "“it” still doesn't repeat.",
      "“it” still doesn't repeat.",
    ],
  ],
};
test('each op says what the outbox said before: its row, its refusal, and what cancelling it leaves', () => {
  assert.deepEqual(Object.keys(WORDS).sort(), Object.keys(OPS).sort());
  for (const [name, op] of Object.entries(OPS))
    ['Unlock the door T#5m', ''].forEach((title, k) => {
      const a = stage => ({
        op: name,
        task: 1,
        stage,
        pct: 40,
        ids: [3, 2, 1],
        html: '',
        set: { title: 'Unlock the back door' },
      });
      assert.deepEqual(
        [op.text(a(0), title), op.refused(a(0), title), op.dropped(a(0), title), op.dropped(a(1), title)],
        WORDS[name][k],
        `${name}, title "${title}"`,
      );
    });
  assert.equal(
    OPS.done.text({ op: 'done' }, 'Mop', true),
    'Done: Mop (repeated)',
    'a step repeated in its checklist says so',
  );
  assert.deepEqual(
    [OPS.add.text({ over: 'Pack the van' }, 'Chairs'), OPS.add.text({ taskId: 4 }, 'Chairs')],
    ['Subtask of “Pack the van”: Chairs', 'Finishing “Chairs”'],
    'a line says what it goes under, as the Outbox said before',
  );
  const day = n => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  assert.deepEqual(
    [
      OPS.due.text({ due: day(0).toISOString() }, 'Mop'),
      OPS.due.text({ due: day(1).toISOString() }, 'Mop'),
      OPS.due.text({ due: day(9).toISOString() }, 'Mop'),
    ],
    [
      'Moved to today: Mop',
      'Moved to tomorrow: Mop',
      `Moved to ${day(9).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: day(9).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}: Mop`,
    ],
    'a move names its day as the message after a hold does',
  );
});
/* `madeUp` is an op no code outside src/js/ops/ knows by name. Each test gives it one field and shows that the shared
   code asks the op for it. Fields it leaves out take their defaults. Its one request is a PATCH of its task. */
const madeUp = (t, fields) => {
  OPS.madeUp = {
    apply: x => ({ ...x }),
    stages: [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { priority: 2 } })],
    asks: ['batch', 'raw'],
    saw: ['label'],
    text: () => 'A made-up change',
    refused: () => 'A made-up change',
    dropped: () => 'Vikunja keeps what it has.',
    ...fields,
  };
  t.after(() => {
    delete OPS.madeUp;
  });
};
const emptied = async app => {
  for (const x of sync.all(1)) await sync.remove(x.id);
  app.refreshPending();
  app.toasts.length = 0;
};
test("what a refusal does is the op's: kept in the Outbox, its text back, its lines back to their box, or undone", async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]),
    given = [];
  t.after(() => emptied(app));
  app.giveBack = (a, error) => {
    given.push(a.id);
    error.back = true;
  };
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  const refused = async (refusal, list) => {
    await emptied(app);
    madeUp(t, { refusal });
    return app.actAll(list.map(f => ({ op: 'madeUp', task: 7, run: null, label: 'Wipe the till', ...f })));
  };
  await refused(null, [{}]);
  assert.deepEqual(
    [app.failed.length, lastSaid(app).msg],
    [1, "A made-up change couldn't be saved: HTTP 403 from the fake. It's kept to try again."],
    'kept by default',
  );
  const back = await refused('back', [{}]);
  assert.deepEqual(
    [sync.all(1), given, lastSaid(app).msg],
    [[], [back.entry], "A made-up change couldn't be saved: HTTP 403 from the fake. Its text is back in the box."],
    'its text back',
  );
  const lines = await refused('lines', [
    { batch: 'b', raw: 'Rope' },
    { batch: 'b', raw: 'Tape' },
  ]);
  assert.deepEqual(
    [sync.all(1), lines.all[0].unsent, app.toasts],
    [[], ['Rope', 'Tape'], []],
    'it and the line after it go back to their box, which says so',
  );
  const put = [];
  madeUp(t, { refusal: 'undone', putBack: (app, a, error) => put.push([a.task, error.status]) });
  await emptied(app);
  const undone = await app.actAll([{ op: 'madeUp', task: 7, run: null, label: 'Wipe the till' }]);
  assert.deepEqual(
    [undone.status, sync.all(1), app.toasts, put],
    ['error', [], [], [[7, 403]]],
    'undone, and its putBack says why',
  );
});
test("what Cancel gives back is the op's, and Cancel offers Undo only when nothing went back", async t => {
  const { app } = offlineSender(t),
    given = [];
  t.after(() => emptied(app));
  app.giveBack = (a, said) => {
    given.push(a.op);
    said.back = true;
  };
  const cancel = async cancel => {
    await emptied(app);
    madeUp(t, { cancel });
    await app.act({ op: 'madeUp', task: 7, run: null, label: 'Wipe the till' });
    const id = sync.all(1)[0].id,
      drop = app.outboxRows.find(r => r.key === id).drop;
    if (drop[0] !== 'dropAct') return drop;
    await app.dropAct(id);
    return [lastSaid(app).msg, lastSaid(app).action?.label ?? null];
  };
  assert.deepEqual(await cancel(null), ['Cancelled. Vikunja keeps what it has.', 'Undo']);
  assert.deepEqual(await cancel('text'), [
    'Cancelled. Vikunja keeps what it has. Its text is back where you typed it.',
    null,
  ]);
  assert.deepEqual(
    await cancel('back'),
    ['Cancelled. Vikunja keeps what it has.', null],
    'its own words say where its text went',
  );
  assert.deepEqual(given, ['madeUp', 'madeUp'], 'only text and back give text back');
  const [how, id] = await cancel('lines');
  assert.deepEqual(
    [how, id],
    ['cancelPending', sync.all(1)[0].id],
    "an unsent line is cancelled as its waiting row's Cancel does it",
  );
});
test("an op says it was refused in its task's open sheet only where it names a place there", async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  Object.assign(app.sheet, { id: 7, kind: 'task', open: true });
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  for (const sheetPlace of [null, 'sheet:due']) {
    await emptied(app);
    madeUp(t, { sheetPlace });
    await app.act({ op: 'madeUp', task: 7, run: null });
    assert.deepEqual([lastSaid(app).place, lastSaid(app).ms], sheetPlace ? ['sheet:due', null] : ['step', undefined]);
  }
});
test("once Vikunja answers, the op says what the screen does, and by default a checklist's screen refreshes its step", async t => {
  const { app } = sender(t, [{ id: 7, title: 'Wipe the till' }]),
    seen = [];
  app.refreshRunTask = id => seen.push(['refreshed', id]);
  app.view.shownRun = { id: 5, steps: [7] };
  madeUp(t, {});
  await app.act({ op: 'madeUp', task: 7, run: 5 });
  madeUp(t, { answered: (app, a, c) => seen.push(['answered', a.task, typeof c.send]) });
  await app.act({ op: 'madeUp', task: 7, run: 5 });
  assert.deepEqual(seen, [
    ['refreshed', 7],
    ['answered', 7, 'function'],
  ]);
});
test('a failed op holds back the ids its op names, and an op waits on the ids its op names', t => {
  madeUp(t, { holds: a => [a.task, 'pending-' + a.id], waitsOn: a => [a.after] });
  const stopped = heldTasks([{ kind: 'act', op: 'madeUp', id: 'x', task: 4, failed: true }]);
  assert.deepEqual([...stopped], [4, 'pending-x']);
  const op = (id, after) => ({ kind: 'act', op: 'madeUp', id, task: 9, after });
  assert.deepEqual(
    [waits(op('y', 'pending-x'), stopped), waits(op('z', 4), stopped), waits(op('w', 3), stopped)],
    [true, true, false],
  );
  assert.ok(stopped.has('pending-y') && stopped.has(9), 'an op that waits holds back what it would hold if it failed');
});
test("a waiting row in a list is the op's row", t => {
  madeUp(t, { row: a => ({ id: 'pending-' + a.id, title: a.raw }) });
  const pendingTasks = Object.getOwnPropertyDescriptor(sending, 'pendingTasks').get;
  const e = { kind: 'act', op: 'madeUp', id: 'r1', raw: 'Buy rope', at: '2026-10-16T09:00:00.000Z' };
  assert.deepEqual(
    pendingTasks.call({ pending: [e, { kind: 'act', op: 'done', id: 'r2', task: 7 }], failed: [], slow: ['r1'] }),
    [{ id: 'pending-r1', title: 'Buy rope', waits: true }],
  );
});
test('the files an op still has to upload move to an entry of their own once a stage is done', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, { stages: [async () => {}, OPS.done.stages[0]], files: a => a.files.filter(f => !f.sent) });
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  const photo = { key: 'k1', name: 'till.jpg', size: 1, type: 'image/jpeg', sent: false };
  // The sender gives an entry its photos and the task it made, as submitCapture and a stage do.
  const e = Object.assign(app.actEntry({ op: 'madeUp', task: 7, run: null }), { taskId: 7, files: [photo] });
  await app.queue([e]);
  await app.sendActs(e.id);
  const op = sync.all(1).find(e => e.kind === 'act'),
    own = sync.all(1).find(e => !e.kind);
  assert.deepEqual([op.files, op.filed, own.taskId, own.files], [[], own.id, 7, [photo]]);
});
/* An op records what the user chose (`asks`). What the screen showed (`saw`) is for its words and its Undo, so a stage
   that reads it throws, and the request is built from Vikunja's copy instead. */
test("act() throws on a field the op doesn't declare, naming the op and the field, and queues nothing", async t => {
  const { app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  await assert.rejects(
    app.act({ op: 'done', task: 7, run: null, html: '<p>Done early</p>' }),
    /The done op doesn't declare the field html/,
  );
  await assert.rejects(
    app.act({ op: 'done', task: 7, run: null, fixed: { body: {} } }),
    /The done op is queued with the sender's field fixed/,
    "a caller can't hand a stage what it would otherwise read from Vikunja",
  );
  assert.deepEqual(sync.all(1), []);
});
test('a stage that reads a field the op saw throws, naming the op and the field, and one that reads what the user chose sends it', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  const rename = k => [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { title: a[k] } })];
  madeUp(t, { stages: rename('label') });
  await app.act({ op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter' });
  assert.match(
    app.failed[0].failed.message,
    /^The madeUp op's stage read label, what the screen showed\. Read Vikunja's copy with c\.once instead\.$/,
  );
  assert.deepEqual(
    [v.task(7).title, v.requests.filter(r => r.method === 'PATCH')],
    ['Wipe the till', []],
    'nothing is sent',
  );
  await emptied(app);
  madeUp(t, { stages: rename('raw') });
  await app.act({ op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter' });
  assert.deepEqual([v.task(7).title, sync.all(1)], ['Wipe the counter', []]);
  const a = { op: 'madeUp', raw: 'Wipe the counter', label: 'Wipe the till' },
    seen = stageView(a);
  seen.taskId = 7;
  assert.deepEqual(
    [a.taskId, seen.raw, 'label' in seen],
    [7, 'Wipe the counter', true],
    "a write through the stage's view reaches the entry",
  );
});
test("an op's Undo and its words read what the screen showed", async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, {
    saw: ['label', 'was'],
    invert: a => ({ op: 'madeUp', task: a.task, raw: a.was, was: a.raw }),
    refused: a => `Renaming “${a.was}”`,
    stages: [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { title: a.raw } })],
  });
  const f = { id: uuid7(), op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter', was: 'Wipe the till' };
  await app.act(f);
  assert.equal(v.task(7).title, 'Wipe the counter');
  assert.equal(await app.undoOps([f]).left, 0);
  assert.equal(v.task(7).title, 'Wipe the till', 'Undo puts back the title the row showed');
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.act({ ...f, id: uuid7() });
  assert.match(lastSaid(app).msg, /^Renaming “Wipe the till” couldn't be saved/);
});
test('the tasks an op deletes are hidden while it waits, and forgotten once Vikunja answers it', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, { deletes: a => [a.task] });
  app.row(v.task(7));
  noConnection(app, v);
  await app.act({ op: 'madeUp', task: 7, run: null });
  assert.deepEqual([app.beingDeleted(7), app.hiddenRows.has(7), !!app.tasks[7]], [true, true, true]);
  app.offline = false;
  v.trouble = () => null;
  await app.sendActs(sync.all(1)[0].id);
  assert.deepEqual([app.beingDeleted(7), app.tasks[7]], [false, undefined]);
});
