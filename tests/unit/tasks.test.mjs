// The tasks on screen. The app keeps one copy of each task (src/js/app/tasks.js).
import { component, fakeVikunja } from './fake.mjs';
import { watching } from './reactive.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tasks, { SHOWN_OWN_WAY } from '../../src/js/app/tasks.js';
import acts from '../../src/js/app/acts.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import { OPS } from '../../src/js/ops/index.js';
import { cache } from '../../src/js/util.js';

test('a task loaded again is the same object and matches what Vikunja has now', () => {
  const app = component(tasks);
  const first = app.keep({ id: 1, title: 'Call Jo', due_date: '2026-10-08T09:00:00Z', labels: [{ id: 3 }] });
  const again = app.keep({ id: 1, title: 'Call Jo back', labels: [] });
  assert.equal(again, first, 'every row that shows the task shows the change');
  assert.deepEqual(first, { id: 1, title: 'Call Jo back', labels: [] }, 'a field that Vikunja no longer gives is removed');
});

test('a task loaded again has only its changed fields written, so an unchanged row does not update', () => {
  const app = component(tasks), was = { id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] }, pending: true };
  const t = app.keep(was), written = [];
  app.tasks[1] = new Proxy(t, { set(o, k, v){ written.push(k); o[k] = v; return true; }, deleteProperty(o, k){ written.push('-' + k); delete o[k]; return true; } });
  app.keep({ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } });
  assert.deepEqual(written, ['-pending'], 'new lists with the same contents are not written');
  app.keep({ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: true }] } });
  assert.deepEqual(written, ['-pending', 'related_tasks'], 'a ticked subtask is written, even though the parent\'s `updated` is unchanged');
  assert.equal(t.related_tasks.subtask[0].done, true);
});

test('a repeating task shown as done until the batch clears stays unchanged through a load, though Vikunja has it open at its next date', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-10T09:00:00Z', repeat_after: 86400 });
  // The user ticks the task. Vikunja moves it to its next date, but the row shows it done with its old date until the mark is removed.
  t.done = true; app.leaving[1] = 'done';
  const again = app.keep({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 });
  assert.equal(again, t);
  assert.deepEqual([t.done, t.due_date], [true, '2026-10-10T09:00:00Z'], 'the task still shows as done with its old date');
  // Once the mark is removed, the task matches what Vikunja has.
  delete app.leaving[1];
  app.keep({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 });
  assert.deepEqual([t.done, t.due_date], [false, '2026-10-11T09:00:00Z']);
  // A row with any other mark is updated the same as before. That covers a task reopened, and a task marked done that Vikunja also has as done.
  app.leaving[1] = 'open';
  app.keep({ id: 1, title: 'Water them', done: false });
  assert.equal(t.title, 'Water them');
  t.done = true; app.leaving[1] = 'done';
  app.keep({ id: 1, title: 'Water them all', done: true });
  assert.equal(t.title, 'Water them all');
});

test('a kept task is a copy, so changing the loaded object does not change it', () => {
  const app = component(tasks), loaded = { id: 1, title: 'Call Jo' };
  app.keep(loaded).title = 'Changed on screen';
  assert.equal(loaded.title, 'Call Jo');
});

test('a saved change appears on the task\'s rows, and a task that is not on screen is not added', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Call Jo', done: false });
  app.syncTask({ id: 1, done: true });
  assert.equal(t.done, true);
  app.syncTask({ id: 2, done: true });
  assert.equal(app.rowTask(2), null);
});

test('a deleted task is removed from every list and forgotten', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Call Jo' }), other = app.keep({ id: 2, title: 'Buy milk' });
  cache.set(1, { id: 1 });
  app.view.groups = [{ key: 'overdue', tasks: [t] }, { key: 'today', tasks: [other, t] }];
  app.forget(1);
  assert.deepEqual(app.view.groups.map(g => g.tasks.map(x => x.id)), [[], [2]]);
  assert.equal(app.rowTask(1), null);
  assert.equal(cache.has(1), false);
});

// An outbox entry for an op, as act() queues it.
const act = (task, op, more = {}) => ({ kind: 'act', id: op + task + (more.pct ?? ''), task, op, items: [], ...more });

test('a task as it will be is Vikunja\'s copy with its waiting ops applied in order, and the copy is left as it was', () => {
  const app = component(tasks), copy = { id: 2, title: 'Mop the floor', done: false, percent_done: 0 };
  cache.set(2, copy);
  app.pending = [act(2, 'progress', { pct: 30 }), act(3, 'done'), act(2, 'progress', { pct: 60 }), act(2, 'done')];
  app.keyOps();
  assert.deepEqual(app.opsOn[2].map(e => e.id), ['progress230', 'progress260', 'done2'], 'a task\'s ops in the order they will be sent');
  assert.deepEqual(app.withWaiting(2), { id: 2, title: 'Mop the floor', done: true, percent_done: 0.6 }, 'the later progress wins');
  assert.deepEqual(copy, { id: 2, title: 'Mop the floor', done: false, percent_done: 0 });
  assert.equal(app.withWaiting(3), null, 'a task with no copy from Vikunja has nothing to apply its ops to');
  app.pending = []; app.keyOps();
  assert.equal(app.withWaiting(2), copy, 'with nothing waiting, the task is Vikunja\'s copy');
});

/* opsOn is kept by task, as `waiting` is (rule 10). A change to one task's ops rewrites only that task's key, so a row
   that reads its own task's ops is redrawn only when they change. */
test('a change to one task\'s waiting ops leaves the other tasks\' ops as the same objects', c => {
  const { Alpine, flush } = watching(c), app = Alpine.reactive(component(tasks)), asked = { 5: 0, 6: 0 };
  for (const id of [5, 6]) Alpine.effect(() => { asked[id]++; void app.opsOn[id]; });
  const outbox = list => { app.pending = list; app.keyOps(); flush(); };
  outbox([act(5, 'done'), act(6, 'progress', { pct: 40 })]);
  const six = Alpine.raw(app).opsOn[6];
  outbox([act(5, 'done'), act(5, 'note'), act(6, 'progress', { pct: 40 })]);
  assert.deepEqual(asked, { 5: 3, 6: 2 }, 'only the task whose ops changed is read again');
  assert.equal(Alpine.raw(app).opsOn[6], six);
  outbox([act(6, 'progress', { pct: 40 })]);
  assert.deepEqual([asked, Object.keys(Alpine.raw(app).opsOn)], [{ 5: 4, 6: 2 }, ['6']], 'a task with nothing waiting has no key');
});

/* When Vikunja answers an op, the answer goes into cache and the op leaves opsOn in the same step. Each time either
   changes, the test reads the task as it will be. It must never show the progress from before the op. */
test('an op\'s answer goes into cache as the op stops waiting, so the task never shows its old value', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 2, title: 'Mop the floor', done: false, percent_done: 0, reactions: null }]);
  const app = component(tasks, acts, sending, outbox, runs), seen = [];
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], flushing: false, cap: {}, sheet: { task: null, sub: {} },
    view: { groups: [], run: null }, places: {}, endPlace(){}, aimSent(){}, claimSent(){}, positionSent(){} });
  Object.defineProperty(app, 'toast', { value: {} });
  cache.set(2, { id: 2, title: 'Mop the floor', done: false, percent_done: 0, reactions: { '✅': [{ id: 3 }] }, comment_count: 2 });
  const look = () => seen.push(app.withWaiting(2).percent_done);
  const ops = app.opsOn = new Proxy({}, { set(o, k, x){ o[k] = x; look(); return true; }, deleteProperty(o, k){ delete o[k]; look(); return true; } });
  cache.set = function(k, x){ Map.prototype.set.call(this, k, x); look(); return this; };
  try { assert.equal((await app.act({ op: 'progress', task: 2, pct: 40, run: null })).status, 'sent'); }
  finally { delete cache.set; }
  assert.deepEqual(seen, [0.4, 0.4, 0.4], 'the op joins, its answer is written, the op leaves');
  assert.deepEqual([Object.keys(ops), v.task(2).percent_done], [[], 0.4]);
  assert.deepEqual(cache.get(2), { ...v.task(2), reactions: { '✅': [{ id: 3 }] }, comment_count: 2 },
    'Vikunja\'s answer replaces the fields it has. Reactions it wasn\'t asked for, and fields it left out, keep what cache had');
});

/* Rows get withWaiting only for an op that is shown through the store. The ops in SHOWN_OWN_WAY still change the
   screen by their own code, and their rows are left alone. The test adds an op that renames a task to the registry. */
test('a task\'s rows get the task as it will be when an op shown through the store joins or leaves it, and not for the other ops', () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    for (const id of [1, 2]) { cache.set(id, { id, title: 'Task ' + id, done: false }); app.keep({ id, title: 'Task ' + id, done: false, comment_count: 2 }); }
    const rows = [app.tasks[1], app.tasks[2]];
    app.pending = [act(1, 'rename', { title: 'Renamed' }), act(2, 'done')];
    app.keyOps();
    assert.deepEqual(rows.map(x => [x.title, x.done, x.comment_count]), [['Renamed', false, undefined], ['Task 2', false, 2]],
      'the renamed task is Vikunja\'s copy with the op applied. The ticked task\'s row is left as it was');
    assert.deepEqual([app.tasks[1], app.tasks[2]], rows, 'each task is still one object');
    app.pending = [act(2, 'done')]; app.keyOps();
    assert.equal(rows[0].title, 'Task 1', 'once the op stops waiting, the row is Vikunja\'s copy again');
    app.answered({ ...act(2, 'done') }, { id: 2, title: 'Task 2', done: true });
    assert.deepEqual([rows[1].done, cache.get(2).done, app.opsOn[2]], [false, true, undefined], 'an answered tick goes into cache, and its row is left to its own code');
    assert.ok(SHOWN_OWN_WAY.every(op => op in OPS), 'every op in the list is an op');
  } finally { delete OPS.rename; }
});
