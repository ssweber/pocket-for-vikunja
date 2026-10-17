// The tasks on screen. The app keeps one copy of each task (src/js/app/tasks.js).
import { component, fakeVikunja, outboxOf, QUEUED } from './fake.mjs';
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
import { sync } from '../../src/js/sync.js';

// A read as a screen's load makes it: started, answered, then put into Vikunja's copies, inside a change.
const read = (list, asked = TASK) => current.change(w => w.read(list, asked, started()));
// An answer to a write that started now, or a read that started at `at`, put into Vikunja's copies.
const put = (list, asked, at) => {
  if (at !== undefined) return current.change(w => w.read(list, asked, at));
  const w = writes();
  w.end();
  current.change(x => x.answer(list, asked, w));
};
// A direct save of `fields` on task `id` answered with `got`, written as saveTask writes it, and its edit `e` ended in
// the same change.
const answerSave = (e, id, fields, got) => {
  const w = writes({ [id]: fields });
  w.end();
  current.change(x => {
    x.made(id, fields, w);
    x.answer([got], TASK, w);
    e.ok();
  });
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
   from a change, or an edit's ok and undo called later, throws outside one. */
test('a writer called outside a change throws', () => {
  const app = component(tasks);
  let kept;
  app.change(w => {
    kept = w;
  });
  assert.throws(() => kept.answer([{ id: 1, title: 'Call Jo' }], TASK), /inside change/);
  const e = app.change(w => w.edit(1, { title: 'Call Jo' }));
  assert.throws(() => e.ok(), /inside change/);
  assert.throws(
    () => app.change(async w => w.edit(1, {})),
    /Await the request first/,
    'a change must not wait for anything',
  );
  assert.equal(copyOf(1), undefined);
});

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
  const moved = writes({ 1: { due_date: '2026-10-09T09:00:00Z' } });
  moved.end();
  app.change(w => {
    w.edit(1, { title: 'Wipe every menu' });
    w.answer([{ id: 1, due_date: '2026-10-09T09:00:00Z' }], ['due_date'], moved);
    w.edit(1, { title: 'Wipe the menus today' });
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
  const t = app.row(copyOf(1));
  app.change(w => {
    app.change(inner => inner.edit(1, { title: 'Wipe every menu' }));
    assert.equal(t.title, 'Wipe the menus', 'the inner change ending shows nothing');
    w.edit(1, { done: true });
  });
  assert.deepEqual([t.title, t.done], ['Wipe every menu', true]);
});

test('a change that throws still shows what it wrote, and the error goes on', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Wipe the menus' }]);
  const t = app.row(copyOf(1));
  assert.throws(
    () =>
      app.change(w => {
        w.edit(1, { title: 'Wipe every menu' });
        throw new Error('Vikunja refused it');
      }),
    /Vikunja refused it/,
  );
  assert.equal(t.title, 'Wipe every menu');
  app.change(w => w.edit(1, { done: true }));
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

/* show(id) stacks three layers: Vikunja's copy, the waiting ops applied through each op's `apply`, then the direct
   saves still running (edit), oldest first. The test adds an op that renames a task to the registry. */
test("a row shows Vikunja's copy, then its waiting ops, then the saves still running, and stays one object", () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    read([{ id: 1, title: 'Wipe the menus', due_date: '2026-10-08T09:00:00Z', priority: 1 }]);
    const t = app.row(copyOf(1));
    app.pending = [{ kind: 'act', id: 'r1', task: 1, op: 'rename', title: 'Wipe every menu', items: [] }];
    outboxOf(app, app.pending);
    const due = app.change(w => w.edit(1, { due_date: '2026-10-09T09:00:00Z', title: 'Wipe the menus today' }));
    assert.deepEqual(
      [t.title, t.due_date, t.priority],
      ['Wipe the menus today', '2026-10-09T09:00:00Z', 1],
      'a save laid over the op wins',
    );
    app.change(() => due.undo());
    assert.deepEqual(
      [t.title, t.due_date],
      ['Wipe every menu', '2026-10-08T09:00:00Z'],
      'without the save, the op shows over the copy',
    );
    app.pending = [];
    outboxOf(app, app.pending);
    assert.equal(t.title, 'Wipe the menus', "without the op, the row is Vikunja's copy");
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

/* edit lays a save's fields over the row until the save answers. The answer goes into Vikunja's copy and ok takes the
   fields off in one show, so the row never shows the old value in between. */
test('a save shows on the row at once, its answer replaces it, and a failed save puts back only its own fields', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Order cups', due_date: '2026-10-08T09:00:00Z', priority: 1, updated: 'a' }]);
  const t = app.row(copyOf(1)),
    shown = [];
  app.tasks[1] = new Proxy(t, {
    set(o, k, v) {
      shown.push([k, v]);
      o[k] = v;
      return true;
    },
  });
  const due = app.change(w => w.edit(1, { due_date: '2026-10-09T09:00:00Z' })),
    title = app.change(w => w.edit(1, { title: 'Order lids' }));
  assert.deepEqual([t.due_date, t.title], ['2026-10-09T09:00:00Z', 'Order lids']);
  answerSave(
    due,
    1,
    { due_date: '2026-10-09T09:00:00Z' },
    {
      id: 1,
      title: 'Order cups',
      due_date: '2026-10-09T09:00:00Z',
      priority: 1,
      updated: 'b',
    },
  );
  assert.deepEqual(
    [t.due_date, t.title, t.updated, copyOf(1).due_date],
    ['2026-10-09T09:00:00Z', 'Order lids', 'b', '2026-10-09T09:00:00Z'],
    'the first answer brings the new date, and the title still being saved stays',
  );
  assert.equal(
    shown.filter(([k]) => k === 'title').length,
    1,
    'the title was written once, and never back to the old one',
  );
  app.change(() => title.undo());
  assert.deepEqual(
    [t.title, t.due_date],
    ['Order cups', '2026-10-09T09:00:00Z'],
    'a failed save puts back its own field only',
  );
});

/* The sheet holds its task's id and reads the task's row, the object every list shows. So a change made anywhere shows
   in the sheet at once. */
test("the sheet reads its task's row by id, so a change made in a list shows in the sheet at once", () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', done: false }]);
  const t = app.row(copyOf(1));
  app.sheet = { id: 1 };
  assert.equal(app.sheetTask, t, 'the sheet and the list read one object');
  app.change(w => w.edit(1, { done: true }));
  assert.equal(app.sheetTask.done, true, 'a tick in the list shows in the sheet');
  read([{ id: 1, title: 'Call Jo back' }]);
  assert.equal(app.sheetTask.title, 'Call Jo back', 'and so does a read');
});

/* Two saves of one task run one after another. The first answer carries the task before the second save. Its fields
   go into the copy, and the second save's field stays on top until its own answer. */
test("two saves in flight on one task: the first answer does not flicker the second save's field back", async () => {
  const v = fakeVikunja([{ id: 1, title: 'Order cups', due_date: '2026-10-08T09:00:00Z', done: false }]);
  const app = component(tasks, actions),
    seen = [];
  read([v.task(1)]);
  const t = app.row(copyOf(1));
  app.tasks[1] = new Proxy(t, {
    set(o, k, x) {
      if (k === 'title') seen.push(x);
      o[k] = x;
      return true;
    },
  });
  const save = fields => {
    const e = app.change(w => w.edit(1, fields));
    return app.saveTask(1, fields).then(
      got => app.change(() => e.ok(got)),
      x => {
        app.change(() => e.undo());
        throw x;
      },
    );
  };
  await Promise.all([save({ due_date: '2026-10-09T09:00:00Z' }), save({ title: 'Order lids' })]);
  assert.deepEqual(seen, ['Order lids'], 'the title is written once');
  assert.deepEqual([t.title, t.due_date], ['Order lids', '2026-10-09T09:00:00Z']);
});

/* A read can start before a save and arrive after its answer, carrying the task as it was. The store records when each
   task's last answer arrived, and a read started before that leaves the copy as it is. */
test("a read started before a task's answer leaves its copy alone, and a read started after it is taken", async () => {
  const v = fakeVikunja([
    { id: 1, title: 'Order cups', done: false },
    { id: 2, title: 'Order lids', done: false },
  ]);
  const app = component(tasks, actions);
  read([v.task(1), v.task(2)]);
  const t = app.row(copyOf(1)),
    before = started(),
    stale = [structuredClone(v.task(1)), structuredClone(v.task(2))];
  stale[1].title = 'Order big lids';
  await app.saveTask(1, { done: true });
  put(stale, TASK, before);
  assert.deepEqual([t.done, copyOf(1).done], [true, true], 'the late read of task 1 is ignored');
  assert.equal(copyOf(2).title, 'Order big lids', 'the same read is taken for a task answered before it started');
  v.task(1).title = 'Order paper cups';
  read([v.task(1)]);
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
    ticked = app.change(w => w.edit(1, { done: true }));
  app.markRow(1, { kind: 'done' });
  answerSave(
    ticked,
    1,
    { done: true },
    { id: 1, title: 'Water the plants', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 },
  );
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
  app.change(w => w.edit(1, { done: true })); // as tickRunStep does, until the outbox sends the tick
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

/* A subtask is read from its own row. Each edit of a subtask is on that row only, so one subtask's failed save never
   leaves another's change shown, and the parent's list of its subtasks stays as Vikunja gave it. */
test("a failed tick of one subtask puts it back while another subtask's edit is still running", () => {
  const app = component(tasks),
    steps = [
      { id: 2, title: 'Mop', done: false },
      { id: 3, title: 'Sweep', done: false },
    ];
  read([{ id: 1, title: 'Closing up', related_tasks: { subtask: steps } }]);
  const p = app.row(copyOf(1)),
    shown = () => p.related_tasks.subtask.map(s => [app.subRow(s).title, app.subRow(s).done]);
  app.subRows(p);
  const ticked = app.change(w => w.edit(2, { done: true }));
  app.change(w => w.edit(3, { title: 'Sweep up' }));
  assert.deepEqual(shown(), [
    ['Mop', true],
    ['Sweep up', false],
  ]);
  app.change(() => ticked.undo());
  assert.deepEqual(
    shown(),
    [
      ['Mop', false],
      ['Sweep up', false],
    ],
    'the failed tick is gone, and the rename still shows',
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
  const at = started(),
    renamed = app.change(w => w.edit(2, { title: 'Mop the floor' }));
  answerSave(renamed, 2, { title: 'Mop the floor' }, { id: 2, title: 'Mop the floor' });
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

/* Rule 10 in a sheet. The sheet's subtask rows are the subtasks' own rows, so ticking one changes that row only. The
   sheet's list of subtasks, and every other subtask's row, have nothing to redraw. The test uses Alpine's reactivity
   (reactive.mjs), and counts each effect every time it runs again. */
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
  for (const id of [2, 3, 4])
    Alpine.effect(() => {
      ran[id]++;
      const s = app.subtasks.find(x => x.id === id);
      void [s.done, s.title];
    });
  const ticked = app.change(w => w.edit(3, { done: true }));
  flush();
  answerSave(ticked, 3, { done: true }, { id: 3, title: 'Load 3', done: true });
  flush();
  assert.deepEqual(
    ran,
    { list: 1, 2: 1, 3: 2, 4: 1 },
    'the tick and its answer ran the ticked row once, and nothing else',
  );
});

/* A read and an answer have different writers. A read always carries the time it started, so a read can never be taken
   for an answer. A save that rebases reads the task first. When nothing is left to change, that read is all the save
   got, and it must not count as Vikunja's newest answer. Here a subtask is deleted while the read of its parent is in
   flight, and the read lands after the delete with the subtask still listed. */
test("a save's read of its task is a read, so a stale one doesn't bring back a subtask deleted meanwhile", async () => {
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
  const saving = app.saveTask(1, null, () => null); // nothing left to change, as for a template's progress
  await new Promise(ok => setImmediate(ok));
  app.change(w => w.forgetTree([2])); // Vikunja answered the subtask's delete
  land();
  await saving;
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
    kind: 'step',
    id: 'e1',
    run: 50,
    title: 'Wipe the counter',
    at: now,
    after: 51,
    before: null,
    items: [],
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

/* Edits stack oldest first. When a newer save of a field is answered, Vikunja has that field, so an older edit still
   running stops laying it, as the old dates a task that arrived done holds while it leaves. A failed save on a row
   marked done takes its field back at once, not when the batch clears. */
test('a newer save of a field wins over an older edit still running, and a failed save on a row marked done goes back', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, leaving);
  read([{ id: 1, title: 'Order cups', done: false, due_date: '2026-10-08T09:00:00Z' }]);
  const t = app.row(copyOf(1));
  app.change(w => w.edit(1, { due_date: '2026-10-08T09:00:00Z', done: true })); // held while the row leaves
  const moved = app.change(w => w.edit(1, { due_date: '2026-10-09T09:00:00Z' }));
  answerSave(
    moved,
    1,
    { due_date: '2026-10-09T09:00:00Z' },
    { id: 1, title: 'Order cups', done: true, due_date: '2026-10-09T09:00:00Z' },
  );
  assert.deepEqual(
    [t.due_date, t.done],
    ['2026-10-09T09:00:00Z', true],
    "the newer date shows, and the older edit's other field stays",
  );
  app.markRow(1, { kind: 'done' });
  const renamed = app.change(w => w.edit(1, { title: 'Order lids' }));
  assert.equal(t.title, 'Order lids');
  app.change(() => renamed.undo());
  assert.equal(t.title, 'Order cups', 'the failed save is gone while the row is still marked');
  await app.clearBatch(true);
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
