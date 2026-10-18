// The tasks on screen. The app keeps one copy of each task (src/js/app/tasks.js).
import { component, fakeVikunja, outboxOf, QUEUED, sendStages } from './fake.mjs';
import { watching } from './reactive.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tasks, {
  copyOf,
  putting,
  SAVED,
  sendingOp,
  started,
  TASK,
  TASK_COUNT,
  TASK_COUNT_REACTIONS,
  TASK_REACTIONS_COMMENTS,
  writes,
} from '../../src/js/app/tasks.js';
import { app as current } from '../../src/js/util.js';
import acts from '../../src/js/app/acts.js';
import actions from '../../src/js/app/actions.js';
import leaving from '../../src/js/app/leaving.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import views from '../../src/js/app/views.js';
import claims from '../../src/js/app/claims.js';
import sheetPart from '../../src/js/app/sheet.js';
import lines from '../../src/js/app/lines.js';
import { OPS } from '../../src/js/ops/index.js';
import { saved } from '../../src/js/lists.js';
import { api } from '../../src/js/api.js';
import { sync, uuid7 } from '../../src/js/sync.js';

// A read as a screen's load makes it: started, answered, then put into Vikunja's copies, inside a change.
const read = (list, asked = TASK) => current.change(w => w.read(list, asked, started()));
// An answer to a write that started now, or a read that started at `at`, put into Vikunja's copies.
const put = (list, asked, at) => {
  if (at !== undefined) return current.change(w => w.read(list, asked, at));
  const w = writes();
  w.end();
  current.change(x => x.answer(list, asked, w));
};
// Op `a` sent and answered as the sender does it: its write is in flight on its tasks, then its answer comes, with
// Vikunja's copy of its task (`got`) when its stages kept one.
const answering = (a, got = null) => {
  const w = sendingOp(a);
  current.change(x => x.answered(a, w, got && { ...w, replayed: false, task: got }));
  w.end();
};

test('a task read again is the same object and shows what Vikunja has now', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', due_date: '2026-10-08T09:00:00Z', labels: [{ id: 3 }] }]);
  const first = app.row(copyOf(1));
  read([{ id: 1, title: 'Call Jo back', labels: [] }]);
  assert.equal(app.row(copyOf(1)), first, 'every row that shows the task shows the change');
  assert.deepEqual(
    first,
    { id: 1, title: 'Call Jo back', due_date: '2026-10-08T09:00:00Z', labels: [] },
    'a field the read left out keeps what the copy had',
  );
});

test('a task read again has only its changed fields written, so an unchanged row does not update', () => {
  const app = component(tasks),
    was = { id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } };
  read([was]);
  const t = app.row(was),
    written = [];
  app.tasks[1] = new Proxy(t, {
    set(o, k, v) {
      written.push(k);
      o[k] = v;
      return true;
    },
    deleteProperty(o, k) {
      written.push('-' + k);
      delete o[k];
      return true;
    },
  });
  read([{ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } }]);
  assert.deepEqual(written, [], 'new lists with the same contents are not written');
  read([{ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: true }] } }]);
  assert.deepEqual(
    written,
    ['related_tasks'],
    "a ticked subtask is written, even though the parent's `updated` is unchanged",
  );
  assert.equal(t.related_tasks.subtask[0].done, true);
});

/* Every write to the store happens inside change(), which shows each task it touched once when it ends. A writer kept
   from a change throws outside one. */
test('a writer called outside a change throws', () => {
  const app = component(tasks);
  let kept;
  app.change(w => {
    kept = w;
  });
  assert.throws(() => kept.answer([{ id: 1, title: 'Call Jo' }], TASK), /inside change/);
  assert.throws(
    () => app.change(async w => w.leave(1)),
    /Await the request first/,
    'a change must not wait for anything',
  );
  assert.equal(copyOf(1), undefined);
});

// A write to task 1 that started now and has ended, whose answer gives `fields`.
const ended = fields => {
  const w = writes({ 1: fields });
  w.end();
  return w;
};
test('several writes to one task in one change show it once, with only their end result', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Wipe the menus', due_date: '2026-10-08T09:00:00Z' }]);
  const t = app.row(copyOf(1)),
    written = [];
  app.tasks[1] = new Proxy(t, {
    set(o, k, v) {
      written.push([k, v]);
      o[k] = v;
      return true;
    },
  });
  const renamed = ended({ title: 'Wipe every menu' }),
    moved = ended({ due_date: '2026-10-09T09:00:00Z' }),
    again = ended({ title: 'Wipe the menus today' });
  app.change(w => {
    w.answer([{ id: 1, title: 'Wipe every menu' }], ['title'], renamed);
    w.answer([{ id: 1, due_date: '2026-10-09T09:00:00Z' }], ['due_date'], moved);
    w.answer([{ id: 1, title: 'Wipe the menus today' }], ['title'], again);
    assert.equal(t.title, 'Wipe the menus', 'nothing shows before the change ends');
  });
  assert.deepEqual(
    written,
    [
      ['title', 'Wipe the menus today'],
      ['due_date', '2026-10-09T09:00:00Z'],
    ],
    'each field is written once',
  );
});

test('a change inside a change joins it, and the task shows once the outer change ends', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Wipe the menus', done: false }]);
  const t = app.row(copyOf(1)),
    renamed = ended({ title: 'Wipe every menu' }),
    ticked = ended({ done: true });
  app.change(w => {
    app.change(inner => inner.answer([{ id: 1, title: 'Wipe every menu' }], ['title'], renamed));
    assert.equal(t.title, 'Wipe the menus', 'the inner change ending shows nothing');
    w.answer([{ id: 1, done: true }], ['done'], ticked);
  });
  assert.deepEqual([t.title, t.done], ['Wipe every menu', true]);
});

test('a change that throws still shows what it wrote, and the error goes on', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Wipe the menus' }]);
  const t = app.row(copyOf(1)),
    renamed = ended({ title: 'Wipe every menu' }),
    ticked = ended({ done: true });
  assert.throws(
    () =>
      app.change(w => {
        w.answer([{ id: 1, title: 'Wipe every menu' }], ['title'], renamed);
        throw new Error('Vikunja refused it');
      }),
    /Vikunja refused it/,
  );
  assert.equal(t.title, 'Wipe every menu');
  app.change(w => w.answer([{ id: 1, done: true }], ['done'], ticked));
  assert.equal(t.done, true, 'the next change shows its writes when it ends');
});

/* A deleted task's copy goes through put like any answer, so its answer time is recorded. A read that started before
   the delete then leaves it deleted. */
test("forget records an answer time, so a read in flight doesn't bring the task back", () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo' }]);
  app.row(copyOf(1));
  const at = started();
  app.change(w => w.forget(1));
  put([{ id: 1, title: 'Call Jo' }], TASK, at);
  assert.deepEqual([copyOf(1), app.rowTask(1)], [undefined, null]);
});

/* show(id) stacks Vikunja's copy and the waiting ops, applied in order through each op's `apply`. The test adds an op
   that renames a task to the registry. */
test("a row shows Vikunja's copy, then its waiting ops in order, and stays one object", () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    read([{ id: 1, title: 'Wipe the menus', due_date: '2026-10-08T09:00:00Z', priority: 1 }]);
    const t = app.row(copyOf(1)),
      rename = { kind: 'act', id: 'r1', task: 1, op: 'rename', title: 'Wipe every menu' },
      move = { kind: 'act', id: 'r2', task: 1, op: 'rename', title: 'Wipe the menus today' };
    outboxOf(app, [rename, move]);
    assert.deepEqual([t.title, t.priority], ['Wipe the menus today', 1], 'the later op shows over the earlier');
    outboxOf(app, [rename]);
    assert.equal(t.title, 'Wipe every menu', 'without the later op, the earlier shows over the copy');
    outboxOf(app, []);
    assert.equal(t.title, 'Wipe the menus', "without the ops, the row is Vikunja's copy");
    assert.equal(app.tasks[1], t, 'every change was written into the same object');
  } finally {
    delete OPS.rename;
  }
});

test("a row has its own lists and objects, so writing a row never changes Vikunja's copy or the read it came from", () => {
  const app = component(tasks),
    loaded = { id: 1, title: 'Call Jo', labels: [{ id: 3, title: 'cafe' }] };
  read([loaded]);
  const t = app.row(loaded);
  t.labels[0].title = 'changed on screen';
  t.title = 'Changed on screen';
  assert.deepEqual(
    [loaded.title, loaded.labels[0].title, copyOf(1).title, copyOf(1).labels[0].title],
    ['Call Jo', 'cafe', 'Call Jo', 'cafe'],
  );
});

test("a save's answer shows on the task's rows, and a task that is not on screen is not added", () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', done: false }]);
  const t = app.row(copyOf(1));
  put([{ id: 1, done: true }], ['done']);
  assert.equal(t.done, true);
  put([{ id: 2, done: true }], ['done']);
  assert.equal(app.rowTask(2), null);
});

/* The sheet holds its task's id and reads the task's row, the object every list shows. So a change made anywhere shows
   in the sheet at once. */
test("the sheet reads its task's row by id, so a change made in a list shows in the sheet at once", () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', done: false }]);
  const t = app.row(copyOf(1));
  app.sheet = { id: 1 };
  assert.equal(app.sheetTask, t, 'the sheet and the list read one object');
  outboxOf(app, [act(1, 'done')]);
  assert.equal(app.sheetTask.done, true, 'a tick in the list shows in the sheet');
  read([{ id: 1, title: 'Call Jo back' }]);
  assert.equal(app.sheetTask.title, 'Call Jo back', 'and so does a read');
});

/* A read can start before a write and arrive after its answer, carrying the task as it was. The store records when each
   task's last answer arrived, and a read started before that leaves the copy as it is. */
test("a read started before a task's answer leaves its copy alone, and a read started after it is taken", () => {
  const app = component(tasks);
  read([
    { id: 1, title: 'Order cups', done: false },
    { id: 2, title: 'Order lids', done: false },
  ]);
  const t = app.row(copyOf(1)),
    before = started(),
    stale = [
      { id: 1, title: 'Order cups', done: false },
      { id: 2, title: 'Order big lids', done: false },
    ];
  put([{ id: 1, title: 'Order cups', done: true }], TASK);
  put(stale, TASK, before);
  assert.deepEqual([t.done, copyOf(1).done], [true, true], 'the late read of task 1 is ignored');
  assert.equal(copyOf(2).title, 'Order big lids', 'the same read is taken for a task answered before it started');
  read([{ id: 1, title: 'Order paper cups', done: true }]);
  assert.deepEqual([t.title, t.done], ['Order paper cups', true], 'a read started after the answer is taken');
});

/* A ticked list row is held done from the tap, and marked until its batch clears (leaving.js). A repeating task's
   answer has it open at its next date, which would move the row to another group as it leaves. So the row keeps every
   field until the batch clears, and then shows Vikunja's copy. */
test("a task leaving done keeps every field until its batch clears, then shows Vikunja's copy", async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, leaving);

  read([{ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-10T09:00:00Z', repeat_after: 86400 }]);
  const t = app.row(copyOf(1)),
    tick = act(1, 'done');
  outboxOf(app, [tick]);
  app.markRow(1, { kind: 'done' });
  answering(tick, {
    id: 1,
    title: 'Water the plants',
    done: false,
    due_date: '2026-10-11T09:00:00Z',
    repeat_after: 86400,
  });
  outboxOf(app, []);
  read([{ id: 1, title: 'Water them', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 }]);
  assert.deepEqual(
    [t.done, t.due_date, t.title],
    [true, '2026-10-10T09:00:00Z', 'Water the plants'],
    'the answer and a later read wait',
  );
  await app.clearBatch(true);
  assert.deepEqual(
    [t.done, t.due_date, t.title],
    [false, '2026-10-11T09:00:00Z', 'Water them'],
    "once the batch clears, the row is Vikunja's copy",
  );
  assert.equal(app.tasks[1], t);
});

test('a deleted task is removed from every list and forgotten', () => {
  const app = component(tasks),
    t = app.row({ id: 1, title: 'Call Jo' }),
    other = app.row({ id: 2, title: 'Buy milk' });
  put([{ id: 1, title: 'Call Jo' }], TASK);
  app.view.groups = [
    { key: 'overdue', tasks: [t] },
    { key: 'today', tasks: [other, t] },
  ];
  app.change(w => w.forget(1));
  assert.deepEqual(
    app.view.groups.map(g => g.tasks.map(x => x.id)),
    [[], [2]],
  );
  assert.equal(app.rowTask(1), null);
  assert.equal(copyOf(1), undefined);
});

/* Vikunja answers null for a field the request didn't expand, and leaves fields out of what it doesn't send. Each read
   writes only the fields it can be trusted for (put). */
test("a read leaves the fields it isn't trusted for as the copy had them, and takes a trusted null", () => {
  component(tasks);
  const me = [{ id: 3 }];
  put(
    [{ id: 1, title: 'Wipe the menus', labels: [{ id: 5, title: 'cafe' }], reactions: { '✅': me }, comment_count: 2 }],
    TASK_COUNT_REACTIONS,
  );
  put(
    [{ id: 1, title: 'Wipe the menus', labels: [{ id: 5, title: 'cafe' }], reactions: null, comment_count: 2 }],
    TASK_COUNT,
  );
  assert.deepEqual(copyOf(1).reactions, { '✅': me }, "a list read without expand=reactions keeps the copy's ✅");
  put([{ id: 1, title: 'Wipe the menus', labels: null }], TASK);
  assert.equal(copyOf(1).labels, null, 'a full read with no labels removes the last label');
  assert.equal(copyOf(1).comment_count, 2, 'a read without the count keeps it');
  const was = copyOf(1);
  put([{ id: 1, title: 'Wipe all the menus' }], TASK);
  assert.deepEqual(
    [was.title, copyOf(1).title],
    ['Wipe the menus', 'Wipe all the menus'],
    'a copy someone holds, as Undo does, stays as it was',
  );
});

test("a copy never holds Pocket's own fields, from a read, a saved screen or a task just sent", () => {
  const app = component(tasks),
    own = { pending: true, parent: 9, was: 'pending-x-0', place: 2048 };
  put([{ id: 1, title: 'Order cups', ...own }], TASK);
  app.keptRows([{ id: 2, title: 'Order lids', updated: '2026-10-15T09:00:00Z', ...own }]);
  put([{ id: 3, title: 'Order straws', ...own }], SAVED);
  for (const id of [1, 2, 3])
    assert.deepEqual(
      Object.keys(copyOf(id)).filter(k => k in own),
      [],
      'task ' + id,
    );
  assert.equal(app.tasks[2].parent, 9, 'the row keeps what the saved screen gave it');
});

/* A row shows a waiting op's effect (a step ticked offline is ticked on its row), but Vikunja doesn't have it yet. A
   screen saved then must not keep it, or reopening Pocket would show it as Vikunja's. */
test("a saved screen holds Vikunja's copy of each task, not a waiting op's effect on its row", () => {
  const app = component(tasks, views),
    copy = { id: 1, title: 'Wipe the menus', done: false, project_id: 7, updated: '2026-10-15T09:00:00Z' };
  read([copy], TASK_COUNT);
  const t = app.row(copy);
  outboxOf(app, [act(1, 'done')]); // a tick waiting in the outbox
  Object.assign(app, { route: { name: 'project', id: 7 }, positions: {} });
  app.view = { groups: [{ key: 'open', tasks: [t] }], project: { id: 7, title: 'Cafe' }, listView: null };
  app.saveProject();
  assert.equal(saved.get('project.7.open').groups[0].tasks[0].done, false);
  localStorage.removeItem('pocket.saved.project.7.open');
});

test('opening Pocket puts a saved copy into the store only where it is newer than the copy there, or there is none', () => {
  const app = component(tasks),
    at = h => `2026-10-15T0${h}:00:00Z`;
  read([
    { id: 41, title: 'Old name', updated: at(8) },
    { id: 42, title: 'New name', updated: at(9) },
  ]);
  const rows = app.keptRows([
    { id: 41, title: 'New name', updated: at(9) },
    { id: 42, title: 'Old name', updated: at(8) },
    { id: 43, title: 'Only saved', updated: at(8) },
  ]);
  assert.deepEqual(
    [41, 42, 43].map(id => copyOf(id).title),
    ['New name', 'New name', 'Only saved'],
  );
  assert.deepEqual(
    rows.map(t => t.title),
    ['New name', 'New name', 'Only saved'],
    'each row shows the newer copy',
  );
});

// An outbox entry for an op, as act() queues it.
const act = (task, op, more = {}) => ({ kind: 'act', id: op + task + (more.pct ?? ''), task, op, items: [], ...more });

test("a task as it will be is Vikunja's copy with its waiting ops applied in order, and the copy is left as it was", () => {
  const app = component(tasks),
    copy = { id: 2, title: 'Mop the floor', done: false, percent_done: 0 };
  put([copy], TASK);
  app.pending = [act(2, 'progress', { pct: 30 }), act(3, 'done'), act(2, 'progress', { pct: 60 }), act(2, 'done')];
  outboxOf(app, app.pending);
  assert.deepEqual(
    app.opsOn[2].map(e => e.id),
    ['progress230', 'progress260', 'done2'],
    "a task's ops in the order they will be sent",
  );
  assert.deepEqual(
    app.shownAs(2),
    { id: 2, title: 'Mop the floor', done: true, done_at: QUEUED, percent_done: 0.6 },
    'the later progress wins',
  );
  assert.deepEqual(copyOf(2), { id: 2, title: 'Mop the floor', done: false, percent_done: 0 });
  assert.equal(app.shownAs(3), null, 'a task with no copy from Vikunja has nothing to apply its ops to');
  app.pending = [];
  outboxOf(app, app.pending);
  assert.equal(app.shownAs(2), copyOf(2), "with nothing waiting, the task is Vikunja's copy");
});

/* opsOn is kept by task, as `waiting` is (rule 10). A change to one task's ops rewrites only that task's key, so a row
   that reads its own task's ops is redrawn only when they change. */
test("a change to one task's waiting ops leaves the other tasks' ops as the same objects", c => {
  const { Alpine, flush } = watching(c),
    app = Alpine.reactive(component(tasks)),
    asked = { 5: 0, 6: 0 };
  for (const id of [5, 6])
    Alpine.effect(() => {
      asked[id]++;
      void app.opsOn[id];
    });
  const outbox = list => {
    app.pending = list;
    outboxOf(app, app.pending);
    flush();
  };
  outbox([act(5, 'done'), act(6, 'progress', { pct: 40 })]);
  const six = Alpine.raw(app).opsOn[6];
  outbox([act(5, 'done'), act(5, 'note'), act(6, 'progress', { pct: 40 })]);
  assert.deepEqual(asked, { 5: 3, 6: 2 }, 'only the task whose ops changed is read again');
  assert.equal(Alpine.raw(app).opsOn[6], six);
  outbox([act(6, 'progress', { pct: 40 })]);
  assert.deepEqual(
    [asked, Object.keys(Alpine.raw(app).opsOn)],
    [{ 5: 4, 6: 2 }, ['6']],
    'a task with nothing waiting has no key',
  );
});

/* When Vikunja answers an op, the answer goes into Vikunja's copy and the op leaves opsOn in the same step. Each time
   the op joins or leaves, the test reads the task as it will be. It must never show the progress from before the op. */
test("an op's answer goes into Vikunja's copy as the op stops waiting, so the task never shows its old value", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 2, title: 'Mop the floor', done: false, percent_done: 0, reactions: null }]);
  const app = component(tasks, acts, sending, outbox, runs),
    seen = [];
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
    aimSent() {},
    positionSent() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  put(
    [
      {
        id: 2,
        title: 'Mop the floor',
        done: false,
        percent_done: 0,
        reactions: { '✅': [{ id: 3 }] },
        comment_count: 2,
      },
    ],
    TASK_COUNT_REACTIONS,
  );
  const look = () => seen.push(app.shownAs(2).percent_done);
  const ops = (app.opsOn = new Proxy(
    {},
    {
      set(o, k, x) {
        o[k] = x;
        look();
        return true;
      },
      deleteProperty(o, k) {
        delete o[k];
        look();
        return true;
      },
    },
  ));
  assert.equal((await app.act({ op: 'progress', task: 2, pct: 40, run: null })).status, 'sent');
  assert.deepEqual(seen, [0.4, 0.4], 'the op joins, and when it leaves its answer is already written');
  assert.deepEqual([Object.keys(ops), v.task(2).percent_done], [[], 0.4]);
  assert.deepEqual(
    copyOf(2),
    { ...v.task(2), reactions: { '✅': [{ id: 3 }] }, comment_count: 2 },
    "Vikunja's answer replaces the fields it has. Reactions it wasn't asked for, and fields it left out, keep what the copy had",
  );
});

/* Every op shows itself on its task's rows through its apply, as it joins the outbox, and leaves when it stops
   waiting. */
test("a task's rows show each waiting op through its apply as it joins or leaves, and an op's answer once it is answered", () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    for (const id of [1, 2]) {
      read([{ id, title: 'Task ' + id, done: false, comment_count: 2 }], TASK_COUNT);
      app.row(copyOf(id));
    }
    const rows = [app.tasks[1], app.tasks[2]];
    app.pending = [act(1, 'rename', { title: 'Renamed' }), act(2, 'done')];
    outboxOf(app, app.pending);
    assert.deepEqual(
      rows.map(x => [x.title, x.done, x.comment_count]),
      [
        ['Renamed', false, 2],
        ['Task 2', true, 2],
      ],
      "each row is Vikunja's copy with its op applied",
    );
    assert.deepEqual([app.tasks[1], app.tasks[2]], rows, 'each task is still one object');
    app.pending = [act(2, 'done')];
    outboxOf(app, app.pending);
    assert.equal(rows[0].title, 'Task 1', "once the op stops waiting, the row is Vikunja's copy again");
    answering({ ...act(2, 'done') }, { id: 2, title: 'Task 2', done: true });
    assert.deepEqual(
      [rows[1].done, copyOf(2).done, app.opsOn[2]],
      [true, true, undefined],
      "an answered tick goes into Vikunja's copy and onto its rows",
    );
  } finally {
    delete OPS.rename;
  }
});

/* A tick sent through the outbox shows on its row through the op. Its answer goes into Vikunja's copy in the same show
   that takes the op off, so the row doesn't change. A tick dropped from the outbox unticks the row. */
test('a tick sent as an op shows until the op is answered or leaves the outbox', () => {
  const app = component(tasks);
  read([
    { id: 1, title: 'Wipe the menus', done: false },
    { id: 2, title: 'Mop the floor', done: false },
  ]);
  const [one, two] = [1, 2].map(id => app.row(copyOf(id))),
    seen = [];
  app.pending = [act(1, 'done'), act(2, 'done')];
  outboxOf(app, app.pending);
  app.tasks[1] = new Proxy(one, {
    set(o, k, v) {
      seen.push([k, v]);
      o[k] = v;
      return true;
    },
  });
  assert.deepEqual([one.done, two.done], [true, true]);
  answering(act(1, 'done'), { id: 1, title: 'Wipe the menus', done: true });
  assert.deepEqual([one.done, seen], [true, []], 'the answer replaces the op without the row changing');
  app.pending = [];
  outboxOf(app, app.pending);
  assert.deepEqual([one.done, two.done], [true, false], 'dropped from the outbox, the tick is gone from its row');
});

/* An op whose reply is not a task still changes Vikunja's copy: the copy takes the op's apply when the op is answered.
   A comment takes the place of the op's waiting one, as Vikunja made it. */
test("an op answered with a reply that is not a task puts its change into Vikunja's copy", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([
    { id: 5, title: 'Unlock the door', comments: [] },
    { id: 6, title: 'Order cups', assignees: [] },
  ]);
  const app = component(tasks, acts, sending, outbox, runs),
    me = { id: 1, username: 'alex', name: 'Alex' };
  Object.assign(app, {
    user: me,
    pending: [],
    failed: [],
    slow: [],
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
    view: { groups: [], shownRun: null },
    places: {},
    endPlace() {},
    aimSent() {},
    positionSent() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  read([{ id: 5, title: 'Unlock the door', comments: [] }], TASK_REACTIONS_COMMENTS);
  read([{ id: 6, title: 'Order cups', assignees: [] }]);
  const [door, cups] = [5, 6].map(id => app.row(copyOf(id)));
  assert.equal((await app.act({ op: 'claim', task: 6, run: null })).status, 'sent');
  assert.deepEqual([copyOf(6).assignees, cups.assignees], [[me], [me]], "the claim, with the claimer's name");
  assert.equal((await app.act({ op: 'note', task: 5, html: '<p>Key under the mat</p>', run: null })).status, 'sent');
  assert.deepEqual(
    copyOf(5).comments.map(c => [c.id, c.comment, !!c.waiting]),
    [[v.task(5).comments[0].id, '<p>Key under the mat</p>', false]],
    'the comment Vikunja made',
  );
  assert.equal(door.comments.length, 1);
});

/* A read can start before an op is answered and land after it, carrying the task as it was. The op's answer is in the
   copy, so the late read leaves the task alone, also when the reply was not a task. */
test('an op answered while a late read is in flight keeps its change', () => {
  const app = component(tasks),
    me = { id: 1, username: 'alex' };
  read([{ id: 1, title: 'Wipe the menus', done: false, assignees: [] }]);
  const t = app.row(copyOf(1)),
    at = started(),
    claim = act(1, 'claim', { user: 1, who: me });
  app.pending = [claim];
  outboxOf(app, app.pending);
  answering(claim);
  put([{ id: 1, title: 'Wipe the menus', done: false, assignees: [] }], TASK, at);
  assert.deepEqual([t.assignees, copyOf(1).assignees], [[me], [me]], 'the late read is ignored');
});

/* A waiting delete hides its tasks (beingDeleted) and takes them off their parent's list of subtasks. While Restore
   shows, the delete is held and its rows keep their gaps, so the parent lists them until the batch clears. */
test("a waiting delete takes its tasks out of their parent's subtasks, once it is no longer held for Restore", async () => {
  const app = component(tasks);
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [] });
  read([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Load chairs' },
    { id: 3, title: 'Load tables' },
  ]);
  const van = app.row(copyOf(1)),
    kids = () => van.related_tasks.subtask.map(s => s.id);
  const del = {
    kind: 'act',
    op: 'delete',
    id: 'del2',
    user: 1,
    task: 2,
    ids: [2],
    up: 1,
    at: new Date().toISOString(),
    items: [],
  };
  sync.held.add(del.id);
  await sync.add(del, []);
  assert.deepEqual(
    [app.beingDeleted(2), kids()],
    [true, [2, 3]],
    'held for Restore, the row hides and the parent still lists it',
  );
  sync.held.delete(del.id);
  await null;
  assert.deepEqual(
    [app.beingDeleted(2), kids(), copyOf(1).related_tasks.subtask.length],
    [true, [3], 2],
    "once it is sent, the parent no longer lists it, and Vikunja's copy is as it was",
  );
  await sync.remove(del.id);
  assert.deepEqual(
    [app.beingDeleted(2), kids()],
    [false, [2, 3]],
    'a delete that leaves the outbox unsent brings it back',
  );
});

// The parts that send the outbox, on the fake component, signed in as user 1.
const sender = () => {
  const app = component(tasks, acts, sending, outbox, runs, actions);
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
    aimSent() {},
    positionSent() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  return app;
};
/* Hold each request `held` picks until `go()` is called. `arrived` resolves once one has arrived. */
const holding = held => {
  const real = globalThis.fetch;
  let go, came;
  const gate = new Promise(ok => {
      go = ok;
    }),
    arrived = new Promise(ok => {
      came = ok;
    });
  globalThis.fetch = async (url, o = {}) => {
    if (held(new URL(url).pathname, o.method || 'GET')) {
      came();
      await gate;
    }
    return real(url, o);
  };
  return { go, arrived };
};

/* The rows learn of each change to the outbox when it happens. An op Vikunja refuses stops waiting, so its row shows
   Vikunja's copy at once, while the outbox still sends the op after it. */
test('an op Vikunja refuses leaves its row at once, while the op after it is still being sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([
      { id: 1, title: 'Mop the floor', percent_done: 0 },
      { id: 2, title: 'Wipe the menus', percent_done: 0 },
    ]),
    app = sender();
  read([v.task(1), v.task(2)]);
  const mop = app.row(copyOf(1));
  v.refuses = r => (r.path === '/tasks/1' ? 403 : null);
  const { go, arrived } = holding(path => path.endsWith('/tasks/2'));
  const sending = app.actAll([
    { op: 'progress', task: 1, pct: 40, run: null },
    { op: 'progress', task: 2, pct: 60, run: null },
  ]);
  await arrived;
  assert.deepEqual([mop.percent_done, app.opsOf(1)], [0, []], 'the refused progress is off the row');
  go();
  await sending;
});

/* An op can keep a read of its task as Vikunja's copy, as an Undo of a date does when the date changed since. A read
   that ran while another write to the task was in flight is thrown away, as any read is, so the title that write
   gives stays. */
test('a read an op keeps of its task is thrown away when another write to the task ran meanwhile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 3, title: 'Lock up', due_date: '2026-10-19T09:00:00Z' }]),
    app = sender();
  read([v.task(3)]);
  const row = app.row(copyOf(3)),
    renaming = writes({ 3: { title: 'Lock up early' } });
  v.task(3).title = 'Lock up early';
  await app.act({ op: 'due', task: 3, due: '2026-10-18T09:00:00Z', check: '2026-10-17T09:00:00Z', run: null });
  renaming.end();
  app.change(w => w.made(3, renaming));
  assert.deepEqual([copyOf(3).title, row.title], ['Lock up early', 'Lock up early']);
});

/* A delete held for Restore shows only on the tasks it deletes. Once its batch clears, sendHeld releases it, and its
   parent stops listing the task at once, also while the outbox is busy sending something else. */
test('a delete released from Restore leaves its parent at once, while the outbox is busy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tail = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    value: {
      request(name, fn) {
        const run = tail.then(fn);
        tail = run.catch(() => {});
        return run;
      },
    },
    configurable: true,
  });
  try {
    const v = fakeVikunja([
        { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } },
        { id: 2, title: 'Load chairs', related_tasks: { parenttask: [{ id: 1 }] } },
      ]),
      app = sender();
    globalThis.confirm = () => true;
    read([v.task(1), v.task(2)]);
    const van = app.row(copyOf(1));
    app.row(copyOf(2));
    const d = await app.holdDelete(app.tasks[2]);
    assert.deepEqual(
      van.related_tasks.subtask.map(s => s.id),
      [2],
      'held for Restore, the parent lists it',
    );
    let free;
    const busy = sync.lock(() => new Promise(ok => (free = ok)));
    const sent = app.sendHeld(d.id);
    await null;
    assert.deepEqual(van.related_tasks.subtask, [], 'released, the parent no longer lists it');
    free();
    await Promise.all([busy, sent]);
  } finally {
    delete navigator.locks;
  }
});

/* A subtask is read from its own row. Each op on a subtask is on that row only, so one subtask's refused tick never
   leaves another's change shown, and the parent's list of its subtasks stays as Vikunja gave it. */
test("a refused tick of one subtask leaves its row while another subtask's rename still waits", () => {
  const app = component(tasks),
    steps = [
      { id: 2, title: 'Mop', done: false },
      { id: 3, title: 'Sweep', done: false },
    ];
  read([{ id: 1, title: 'Closing up', related_tasks: { subtask: steps } }]);
  const p = app.row(copyOf(1)),
    shown = () => p.related_tasks.subtask.map(s => [app.subRow(s).title, app.subRow(s).done]),
    rename = act(3, 'edit', { set: { title: 'Sweep up' } });
  app.subRows(p);
  outboxOf(app, [act(2, 'done'), rename]);
  assert.deepEqual(shown(), [
    ['Mop', true],
    ['Sweep up', false],
  ]);
  outboxOf(app, [rename]);
  assert.deepEqual(
    shown(),
    [
      ['Mop', false],
      ['Sweep up', false],
    ],
    'the refused tick is gone, and the rename still shows',
  );
  assert.deepEqual(p.related_tasks.subtask, steps, "the parent's list of its subtasks is as Vikunja gave it");
});

/* A step renamed in a template's sheet is answered by Vikunja. A read of the template that started before carries the
   step's old title in its list of steps. The sheet reads the step's own row, so the old title doesn't come back. */
test('a late read of a template leaves a step renamed since as it is', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'TEMPLATE: Closing up', related_tasks: { subtask: [{ id: 2, title: 'Mop' }] } }]);
  const tpl = app.row(copyOf(1));
  app.subRows(tpl);
  const at = started();
  answering(act(2, 'edit', { set: { title: 'Mop the floor' } }), { id: 2, title: 'Mop the floor' });
  put(
    [
      { id: 1, title: 'TEMPLATE: Closing up', related_tasks: { subtask: [{ id: 2, title: 'Mop' }] } },
      { id: 2, title: 'Mop' },
    ],
    TASK,
    at,
  );
  assert.deepEqual(
    [app.subRow(tpl.related_tasks.subtask[0]).title, copyOf(2).title],
    ['Mop the floor', 'Mop the floor'],
  );
});

/* A read that started before a task was deleted can land after, with the task in it. The task stays deleted: it gets
   no copy and no row, and the screen's list leaves it out. */
test('a read in flight does not bring back a task deleted meanwhile', () => {
  const app = component(tasks);
  read([
    { id: 1, title: 'Call Jo' },
    { id: 2, title: 'Buy milk' },
  ]);
  app.row(copyOf(1));
  app.row(copyOf(2));
  const landing = putting(TASK);
  app.change(w => w.forgetTree([1]));
  const list = landing([
    { id: 1, title: 'Call Jo' },
    { id: 2, title: 'Buy milk' },
  ]);
  assert.deepEqual([list.map(t => t.id), copyOf(1), app.rowTask(1)], [[2], undefined, null]);
});

/* A tick puts the user's ✅ on a step in place of their ⏭️, and a skip the other way round, in Vikunja as on the row
   (marked, ops/shown.js). A teammate unticked a step the user had skipped, and the user then tapped Done. */
test("a tick takes the user's ⏭️ off a step in Vikunja, a skip takes their ✅, and a teammate's marks stay", async () => {
  const me = { id: 1, username: 'me' },
    bob = { id: 7, username: 'bob' };
  const v = fakeVikunja([{ id: 5, title: 'Mop', done: false, reactions: { '⏭️': [me, bob], '✅': [bob] } }]),
    app = component(tasks, actions, { keepTick() {} }),
    marks = () => Object.fromEntries(Object.entries(v.task(5).reactions).map(([r, us]) => [r, us.map(u => u.id)]));
  await sendStages(app, { op: 'done', task: 5, run: null, user: 1, who: me });
  assert.deepEqual(marks(), { '⏭️': [7], '✅': [7, 1] });
  await sendStages(app, { op: 'skip', task: 5, run: null, user: 1, who: me, html: '<p>No mop</p>' });
  assert.deepEqual(marks(), { '⏭️': [7, 1], '✅': [7] });
});

/* A deleted task leaves every list of related tasks, in the copies and in the rows made from a parent's list. A step
   with a second parent stops naming the parent deleted, and a read from before the delete can't bring the deleted
   task back into the second parent's subtasks. */
test('a deleted task leaves every related list, and a read from before the delete leaves it out', () => {
  const app = component(tasks);
  read([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 3 }] } },
    { id: 2, title: 'Load the van', related_tasks: { subtask: [{ id: 3 }, { id: 4 }] } },
    { id: 3, title: 'Load chairs', related_tasks: { parenttask: [{ id: 1 }, { id: 2 }] } },
  ]);
  app.subRows(app.row(copyOf(2)));
  app.change(w => w.base({ id: 4, title: 'Load tables', related_tasks: { parenttask: [{ id: 2 }, { id: 1 }] } }));
  const before = started();
  app.change(w => w.forgetTree([1]));
  assert.deepEqual(copyOf(3).related_tasks.parenttask, [{ id: 2 }], 'the step names only the parent left');
  assert.deepEqual(app.tasks[4].related_tasks.parenttask, [{ id: 2 }], 'and so does a row with no copy yet');
  put(
    [
      { id: 2, title: 'Load the van', related_tasks: { subtask: [{ id: 1 }, { id: 3 }] } },
      { id: 5, title: 'Lock up', related_tasks: { parenttask: [{ id: 1 }] } },
    ],
    TASK,
    before,
  );
  assert.deepEqual(
    [copyOf(2).related_tasks.subtask, copyOf(5).related_tasks.parenttask],
    [[{ id: 3 }], []],
    'a read from before the delete leaves the task out',
  );
});

/* A read that ran while an op on a task was sent may carry the task from before the op, also when Pocket has no copy
   of the task yet. It is left out for that task, and the next read decides. */
test('a read that ran while an op on a task with no copy was sent is left out, and the next read is taken', () => {
  component(tasks);
  const at = started();
  answering(act(3, 'claim', { user: 1 }));
  put([{ id: 3, title: 'Wipe the till', assignees: [] }], TASK, at);
  assert.equal(copyOf(3), undefined, 'the read may be from before the claim');
  read([{ id: 3, title: 'Wipe the till', assignees: [{ id: 1 }] }]);
  assert.deepEqual(copyOf(3)?.assignees, [{ id: 1 }]);
});

/* Rule 10 in a sheet. The sheet's subtask rows are the subtasks' own rows, so ticking one changes that row only. Every
   other subtask's row has nothing to redraw. The sheet's list of subtasks is worked out again while the tick waits,
   since a waiting op could be a delete that hides a row (hiddenRows), and it gives the same rows. The test uses
   Alpine's reactivity (reactive.mjs), and counts each effect every time it runs again. Each row's effect reads its row
   as x-for gives it. */
test("a subtask ticked in its parent's sheet redraws its own row only", c => {
  const { Alpine, flush } = watching(c),
    app = Alpine.reactive(component(tasks, sheetPart, lines));
  Object.assign(app, { positions: {}, hasOwnOrder: () => false });
  read([
    {
      id: 1,
      title: 'Pack the van',
      related_tasks: { subtask: [2, 3, 4].map(id => ({ id, title: 'Load ' + id, done: false })) },
    },
  ]);
  app.subRows(app.row(copyOf(1)));
  app.sheet = { id: 1 };
  const ran = { list: 0, 2: 0, 3: 0, 4: 0 };
  Alpine.effect(() => {
    ran.list++;
    void app.subtasks;
  });
  const rows = new Map(app.subtasks.map(s => [s.id, s]));
  for (const id of [2, 3, 4])
    Alpine.effect(() => {
      ran[id]++;
      void [rows.get(id).done, rows.get(id).title];
    });
  const tick = act(3, 'done');
  outboxOf(app, [tick]);
  flush();
  answering(tick, { id: 3, title: 'Load 3', done: true });
  outboxOf(app, []);
  flush();
  assert.deepEqual(
    ran,
    { list: 2, 2: 1, 3: 2, 4: 1 },
    'the tick and its answer ran the ticked row once, and no other row',
  );
  assert.ok(
    app.subtasks.every(s => s === rows.get(s.id)),
    'the list gives the same rows',
  );
});

/* A read and an answer have different writers. A read always carries the time it started, so a read can never be taken
   for an answer, as Vikunja's newest copy. Here a subtask is deleted while the read of its parent is in flight, and the
   read lands after the delete with the subtask still listed. */
test("a read of a task carries when it started, so a stale one doesn't bring back a subtask deleted meanwhile", async () => {
  const v = fakeVikunja([
    { id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Load chairs' },
    { id: 3, title: 'Load tables' },
  ]);
  const app = component(tasks, actions),
    real = globalThis.fetch;
  read([v.task(1), v.task(2), v.task(3)]);
  app.row(copyOf(1));
  let land;
  const landing = new Promise(ok => {
    land = ok;
  });
  globalThis.fetch = async (url, o = {}) => {
    const res = await real(url, o);
    if (/\/tasks\/1$/.test(url) && (o.method || 'GET') === 'GET') await landing;
    return res;
  };
  const reading = app.readCopy(1);
  await new Promise(ok => setImmediate(ok));
  app.change(w => w.forgetTree([2])); // Vikunja answered the subtask's delete
  land();
  await reading;
  assert.deepEqual(
    copyOf(1).related_tasks.subtask.map(s => s.id),
    [3],
  );
  assert.throws(
    () => app.change(w => w.read([{ id: 3, title: 'Load tables' }], TASK)),
    /started/,
    'a read without its start time is a bug',
  );
});

/* A step shown from its parent's list of steps has a row but no copy of its own (bases). A claim on it is answered,
   then a read that started before the answer lands. The late-read rule is about the task, so the read is left out. */
test('a late read leaves alone a task with a row but no copy of its own, answered since the read started', () => {
  const app = component(tasks),
    me = { id: 1, username: 'alex' };
  read([{ id: 1, title: 'Closing up', related_tasks: { subtask: [{ id: 2, title: 'Mop', assignees: [] }] } }]);
  app.subRows(app.row(copyOf(1)));
  const at = started(),
    claim = act(2, 'claim', { user: 1, who: me });
  app.pending = [claim];
  outboxOf(app, app.pending);
  answering(claim);
  put([{ id: 2, title: 'Mop', assignees: [] }], TASK, at);
  assert.deepEqual(app.tasks[2].assignees, [me]);
});

/* A step inserted in a checklist is 'pending-' + its entry's id until Vikunja makes it, and its own id from then on.
   The ops on it are filed under whichever it has (opsId), and the checklist's screen looks them up the same way. So a
   tick on the step stays on its row while the rest of the step is set up. */
test('a tick on a step still being inserted shows on its row once Vikunja has made the step', () => {
  const app = component(tasks, runs, claims),
    me = { id: 1, username: 'alex' },
    now = new Date().toISOString();
  read(
    [
      { id: 50, title: 'Opening up', done: false, project_id: 5, assignees: [me] },
      { id: 51, title: 'Unlock the door', done: false, assignees: [], reactions: {}, comments: [] },
    ],
    TASK_REACTIONS_COMMENTS,
  );
  for (const id of [50, 51]) app.row(copyOf(id));
  Object.assign(app, {
    user: me,
    slow: [],
    perms: {},
    runNow: Date.now(),
    view: { shownRun: { id: 50, steps: [51], at: null, last: null } },
  });
  const step = {
    kind: 'act',
    op: 'addStep',
    id: 'e1',
    task: 50,
    run: 50,
    title: 'Wipe the counter',
    at: now,
    after: 51,
    before: null,
    user: 1,
    who: me,
  };
  const tick = { kind: 'act', id: 't1', task: 'pending-e1', op: 'done', run: 50, user: 1, who: me, at: now, items: [] };
  app.pending = [step, tick];
  outboxOf(app, app.pending);
  const shown = () => app.workOutRun().steps.map(s => [s.title, s.done, s.waiting]);
  assert.deepEqual(
    shown(),
    [
      ['Unlock the door', false, false],
      ['Wipe the counter', true, true],
    ],
    'ticked before Vikunja has made it',
  );
  sync.claim(77, 'e1');
  step.taskId = 77; // Vikunja made the step, which isn't set up yet
  try {
    app.change(w => w.keyOps());
    assert.deepEqual(
      shown(),
      [
        ['Unlock the door', false, false],
        ['Wipe the counter', true, true],
      ],
      'still ticked and waiting',
    );
  } finally {
    sync.claimed.delete(77);
  }
});

/* A subtask's assignees and labels are on its own row. The sheet reads them in one request (loadSubPeople) as a read
   with its start time, so a claim answered meanwhile stays, and each subtask's slot reads its row. */
test("the sheet's read of its subtasks' people goes into their rows, and leaves a claim answered meanwhile", async () => {
  const me = { id: 1, username: 'alex' },
    priya = { id: 2, username: 'priya' },
    label = { id: 9, title: 'cafe' };
  fakeVikunja([
    { id: 1, title: 'Closing up', related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: 'Mop', assignees: [] },
    { id: 3, title: 'Sweep', assignees: [priya], labels: [label] },
  ]);
  const app = component(tasks, claims),
    real = globalThis.fetch;
  Object.assign(app, { user: me, sheet: { id: 1, kind: 'task' }, canWrite: () => true });
  Object.defineProperty(app, 'checklistRole', { value: null });
  read([
    {
      id: 1,
      title: 'Closing up',
      related_tasks: {
        subtask: [
          { id: 2, title: 'Mop' },
          { id: 3, title: 'Sweep' },
        ],
      },
    },
  ]);
  app.subRows(app.row(copyOf(1)));
  let land;
  const landing = new Promise(ok => {
    land = ok;
  });
  const listed = JSON.stringify({
    items: [
      { id: 2, title: 'Mop', assignees: [] },
      { id: 3, title: 'Sweep', assignees: [priya], labels: [label] },
    ],
  });
  globalThis.fetch = async (url, o = {}) =>
    /\/tasks\?/.test(url)
      ? landing.then(() => new Response(listed, { headers: { 'Content-Type': 'application/json' } }))
      : real(url, o);
  const loading = app.loadSubPeople(app.sheetTask);
  await new Promise(ok => setImmediate(ok));
  const claim = act(2, 'claim', { user: 1, who: me });
  app.pending = [claim];
  outboxOf(app, app.pending);
  answering(claim);
  land();
  await loading;
  assert.deepEqual(
    [app.tasks[3].assignees, app.tasks[3].labels],
    [[priya], [label]],
    "a subtask's people and labels are on its own row",
  );
  assert.deepEqual(
    [app.tasks[2].assignees, app.rowSlot(app.tasks[2], { sheet: true }).mine],
    [[me], true],
    'the claim answered while the read was in flight stays',
  );
});

/* A line that arrived done is at its next date in Vikunja's copy by the time its row is made. The row is given the task
   as the line made it, marked done, and shows it so until the batch clears (placeSent, arrivedDone). */
test('a task given a row while it is marked done shows as given until its batch clears', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, leaving);
  read([{ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-09T09:00:00Z', repeat_after: 86400 }]);
  app.change(w => {
    w.base({ id: 1, title: 'Water the plants', done: true, due_date: '2026-10-08T09:00:00Z', repeat_after: 86400 });
    w.leave(1, 'done');
  });
  const t = app.tasks[1];
  app.markRow(1, { kind: 'done' });
  read([{ id: 1, title: 'Water them', done: false, due_date: '2026-10-09T09:00:00Z', repeat_after: 86400 }]);
  assert.deepEqual([t.done, t.due_date, t.title], [true, '2026-10-08T09:00:00Z', 'Water the plants']);
  await app.clearBatch(true);
  assert.deepEqual([t.done, t.due_date, t.title], [false, '2026-10-09T09:00:00Z', 'Water them']);
});

/* A read or a saved screen gives a task its row (base). Once Vikunja's copy is known, the row is the copy, and only
   Pocket's own fields come from what was given, such as a new task's `parent`. A field the copy lacks would otherwise
   stay on the row for the session. */
test("a task given a row after its copy is known gets only Pocket's own fields from what was given", () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Order cups' }]);
  app.row(copyOf(1));
  app.change(w => w.base({ id: 1, title: 'Order cups', comment_count: 4, parent: 9 }));
  read([{ id: 1, title: 'Order cups' }]);
  assert.deepEqual(['comment_count' in app.tasks[1], app.tasks[1].parent], [false, 9]);
});

/* A deleted step's copy goes in the same change as its row, so the checklist's screen and every list stop showing it
   at once, not when the checklist is read again. */
test('a task Vikunja deleted loses its row in the same change as its copy', () => {
  const app = component(tasks);
  read([
    { id: 1, title: 'Wipe the counter' },
    { id: 2, title: 'Mop' },
  ]);
  const rows = [1, 2].map(id => app.row(copyOf(id)));
  app.view.groups = [{ key: 'open', tasks: rows }];
  app.change(w => w.forget(1));
  assert.deepEqual([copyOf(1), app.rowTask(1), app.view.groups[0].tasks.map(t => t.id)], [undefined, null, [2]]);
});

// A write names the values it sets (writes), and its answer puts those values into Vikunja's copy.
test('a write names the values it sets, so field names alone are refused', () => {
  component(tasks);
  assert.throws(() => writes({ 1: ['labels'] }), /names the values/);
});

/* A request whose reply never came may reach Vikunja later. The op's write stays in flight until a later try is
   answered, so a read taken meanwhile, which may be from before Vikunja made it, is thrown away. */
test('an op whose request was lost stays in flight until it is sent again, so a read taken meanwhile is thrown away', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', percent_done: 0 }]),
    app = sender(),
    real = globalThis.fetch;
  read([v.task(1)]);
  const row = app.row(copyOf(1));
  // The first PATCH is lost on its way, and reaches Vikunja only after the read below.
  let late = null;
  globalThis.fetch = async (url, o = {}) => {
    if (!late && o.method === 'PATCH') {
      late = () => real(url, o);
      throw new TypeError('Failed to fetch');
    }
    return real(url, o);
  };
  const first = await app.act({ op: 'progress', task: 1, pct: 40, run: null });
  assert.equal(first.status, 'offline');
  read([structuredClone(v.task(1))]);
  await late();
  await app.sendActs(first.entry);
  assert.deepEqual([copyOf(1).percent_done, row.percent_done], [0.4, 0.4]);
});

/* Two writes in flight on one task at once can reach Vikunja in either order, so the store takes neither's reply. The
   task is read once the last of them ends, so its copy doesn't stay old until a screen loads it again. */
test('a task that two crossing writes left unsure is read once, after the last of them ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', percent_done: 0 }]),
    app = sender();
  read([v.task(1)]);
  app.row(copyOf(1));
  // Another write to the task is in flight, as when an op on a step writes its checklist's progress.
  const renaming = writes({ 1: { title: 'Mop twice' } });
  v.task(1).title = 'Mop twice';
  await app.act({ op: 'progress', task: 1, pct: 40, run: null });
  v.task(1).priority = 3; // a teammate's change, which only a read brings
  renaming.end();
  for (let i = 0; i < 5; i++) await new Promise(ok => setImmediate(ok));
  const reads = v.requests.filter(r => r.method === 'GET' && r.path === '/tasks/1');
  assert.equal(reads.length, 1);
  assert.deepEqual([copyOf(1).title, copyOf(1).percent_done, copyOf(1).priority], ['Mop twice', 0.4, 3]);
});

const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise(ok => setImmediate(ok));
};

/* An op's change counts from its first request, also when Try again sends the rest of it after Vikunja refused a
   stage. A read taken in between may hold a teammate's change made after that request, and the change mustn't
   overwrite it. The part of the change the read lacks comes with the read that follows. */
test("an op sent again with Try again counts from its first request, so a teammate's change read since stays", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', done: false, reactions: {} }]),
    app = sender();
  read([v.task(1)], TASK_REACTIONS_COMMENTS);
  app.row(copyOf(1));
  v.refuses = r => (r.path === '/tasks/1/reactions' ? 403 : null);
  const tick = await app.act({ op: 'done', task: 1, run: null });
  assert.equal(tick.status, 'error');
  v.refuses = () => null;
  v.task(1).done = false; // a teammate unticks it
  read([structuredClone(v.task(1))], TASK_REACTIONS_COMMENTS);
  // Try again, as retryAct does it
  const e = sync.entries.get(tick.entry);
  Object.assign(e, { failed: undefined, fails: 0, key: uuid7() });
  await sync.save(e);
  await app.sendActs(tick.entry);
  await settled();
  assert.deepEqual([copyOf(1).done, copyOf(1).reactions['✅'].map(u => u.id)], [false, [1]]);
});

/* An op that the page before this one sent, and Vikunja made, is sent again, and the relay replays every request.
   Vikunja made it before this page read the tasks, so a teammate's change read since stays, on the step and on the
   checklist's progress the op wrote. It stays from the op's answer on, not only once the tasks are read again. */
test("an op sent before the page loaded, and only replayed now, leaves a teammate's change read since", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([
      { id: 1, title: 'Closing', percent_done: 0, related_tasks: { subtask: [{ id: 2 }] } },
      { id: 2, title: 'Mop the floor', percent_done: 0, related_tasks: { parenttask: [{ id: 1 }] } },
    ]),
    app = sender(),
    id = uuid7();
  await api('/tasks/2', { method: 'PATCH', body: { percent_done: 0.4 }, key: id + ':0:0' });
  await api('/tasks/1', { method: 'PATCH', body: { percent_done: 0.4 }, key: id + ':1:0' });
  Object.assign(v.task(1), { percent_done: 0.9 }); // a teammate's changes
  Object.assign(v.task(2), { percent_done: 0.75 });
  read([v.task(1), v.task(2)]);
  for (const k of [1, 2]) app.row(copyOf(k));
  const e = { id, kind: 'act', op: 'progress', task: 2, pct: 40, run: 1, sent: true, stage: 0, fails: 0 };
  await sync.add({ ...e, fixed: { figure: { percent_done: 0.4 } }, user: 1, at: QUEUED, n: 0, files: [] }, []);
  const { go } = holding((path, method) => method === 'GET');
  await app.sendActs(id);
  await settled();
  assert.deepEqual([copyOf(1).percent_done, copyOf(2).percent_done], [0.9, 0.75], 'before the tasks are read again');
  go();
  await settled();
  assert.deepEqual([copyOf(1).percent_done, copyOf(2).percent_done], [0.9, 0.75]);
});

/* A tick the page before this one sent never reached Vikunja, and this page makes all of it fresh. Its change counts
   from its first request here, so the ✅, which no reply brings, goes into the copy with its answer. */
test('an op sent before the page loaded, and made fresh now, shows in the copy from its answer on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', done: false, reactions: {} }]),
    app = sender(),
    id = uuid7();
  read([structuredClone(v.task(1))], TASK_REACTIONS_COMMENTS);
  app.row(copyOf(1));
  const e = { id, kind: 'act', op: 'done', task: 1, run: null, sent: true, stage: 0, fails: 0 };
  await sync.add({ ...e, user: 1, at: QUEUED, n: 0, files: [] }, []);
  holding((path, method) => method === 'GET');
  await app.sendActs(id);
  await settled();
  assert.deepEqual([copyOf(1).done, copyOf(1).reactions['✅']?.map(u => u.id)], [true, [1]]);
});

/* A request whose reply was lost can reach Vikunja before a teammate's change, and the read that shows the change is
   thrown away while the op waits. The relay replays the answer when the op is sent again, so the task is read once
   the op is answered, and the copy shows the teammate's change. */
test("a task is read again after a replayed answer, so a teammate's change made meanwhile shows", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', percent_done: 0 }]),
    app = sender();
  read([v.task(1)]);
  app.row(copyOf(1));
  v.trouble = r => (r.method === 'PATCH' && !v.relayed.size ? 'lost' : null);
  const first = await app.act({ op: 'progress', task: 1, pct: 40, run: null });
  v.task(1).percent_done = 0.75; // a teammate's change
  read([structuredClone(v.task(1))]);
  await app.sendActs(first.entry);
  await settled();
  assert.equal(copyOf(1).percent_done, 0.75);
});

/* A comment whose request was lost before it reached Vikunja waits to be sent again, and a read of its task taken
   meanwhile is thrown away. The comment's answer brings no task, so the task is read again once the op is answered,
   and the copy shows a teammate's change the thrown-away read held. */
test('a task whose read was thrown away while an op waited is read again once the op is answered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', comments: [] }]),
    app = sender();
  read([v.task(1)]);
  app.row(copyOf(1));
  let lose = true;
  v.trouble = r => (r.method === 'POST' && lose ? ((lose = false), 'offline') : null);
  const first = await app.act({ op: 'note', task: 1, html: '<p>Done</p>', run: null });
  assert.equal(first.status, 'offline');
  v.task(1).title = 'Mop the hall'; // a teammate's change
  read([structuredClone(v.task(1))]);
  await app.sendActs(first.entry);
  await settled();
  assert.equal(copyOf(1).title, 'Mop the hall');
});

// A saved screen is older than any read, so a saved copy thrown away after a write to its task is no reason to read it.
test('a saved screen shown after a write to its task does not read the task again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', updated: '2026-10-17T09:00:00Z' }]),
    app = sender();
  read([v.task(1)]);
  app.row(copyOf(1));
  writes({ 1: { title: 'Mop twice' } }).end();
  app.keptRows([{ id: 1, title: 'Mop the hall', updated: '2026-10-17T10:00:00Z' }]);
  await settled();
  assert.deepEqual(v.requests, []);
});

/* A tick whose PATCH the page before this one made is sent again from its next stage, the ✅, which this page makes
   fresh. A teammate unticked the task after the PATCH, and this page read that. The op's change counts from the ✅'s
   request, newer than the read, so its tasks are read once it is answered, and the copy shows the untick. */
test("an op sent before the page loaded, and finished fresh now, leaves a teammate's change read since", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', done: false, reactions: {} }]),
    app = sender(),
    id = uuid7();
  await api('/tasks/1', { method: 'PATCH', body: { done: true }, key: id + ':0:0' });
  v.task(1).done = false; // a teammate unticks it
  read([structuredClone(v.task(1))], TASK_REACTIONS_COMMENTS);
  app.row(copyOf(1));
  const e = { id, kind: 'act', op: 'done', task: 1, run: null, sent: true, stage: 1, fails: 0 };
  await sync.add({ ...e, user: 1, at: QUEUED, n: 0, files: [] }, []);
  await app.sendActs(id);
  await settled();
  assert.deepEqual([copyOf(1).done, copyOf(1).reactions['✅'].map(u => u.id)], [false, [1]]);
});

/* The relay can't tell whether Vikunja made a request whose first try never finished, and here Vikunja did. The op
   stops waiting without an answer this tab saw, so its task is read again, and the copy shows what Vikunja made. */
test('a task is read again once its op stops waiting without an answer this tab saw', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 1, title: 'Mop the floor', percent_done: 0 }]),
    app = sender();
  read([v.task(1)]);
  app.row(copyOf(1));
  v.trouble = r => {
    if (r.method !== 'PATCH') return null;
    v.task(1).percent_done = 0.4;
    return 'unknown';
  };
  const sent = await app.act({ op: 'progress', task: 1, pct: 40, run: null });
  assert.equal(sent.status, 'error');
  await settled();
  assert.equal(copyOf(1).percent_done, 0.4);
  // The outbox changes again, and a screen reads the task.
  app.keyOutbox();
  read([structuredClone(v.task(1))]);
  await settled();
  assert.equal(v.requests.filter(r => r.method === 'GET').length, 1, 'read again once');
});
