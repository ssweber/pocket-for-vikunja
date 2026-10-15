// The tasks on screen. The app keeps one copy of each task (src/js/app/tasks.js).
import { component, fakeVikunja } from './fake.mjs';
import { watching } from './reactive.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tasks, { copyOf, put, SAVED, SHOWN_OWN_WAY, started, TASK, TASK_COUNT, TASK_COUNT_REACTIONS } from '../../src/js/app/tasks.js';
import acts from '../../src/js/app/acts.js';
import actions from '../../src/js/app/actions.js';
import leaving from '../../src/js/app/leaving.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import views from '../../src/js/app/views.js';
import { OPS } from '../../src/js/ops/index.js';
import { saved } from '../../src/js/lists.js';

// A read as a screen's load makes it: started, answered, then put into Vikunja's copies.
const read = (list, asked = TASK) => put(list, asked, started());

test('a task read again is the same object and shows what Vikunja has now', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', due_date: '2026-10-08T09:00:00Z', labels: [{ id: 3 }] }]);
  const first = app.row(copyOf(1));
  read([{ id: 1, title: 'Call Jo back', labels: [] }]);
  assert.equal(app.row(copyOf(1)), first, 'every row that shows the task shows the change');
  assert.deepEqual(first, { id: 1, title: 'Call Jo back', due_date: '2026-10-08T09:00:00Z', labels: [] }, 'a field the read left out keeps what the copy had');
});

test('a task read again has only its changed fields written, so an unchanged row does not update', () => {
  const app = component(tasks), was = { id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } };
  read([was]);
  const t = app.row(was), written = [];
  app.tasks[1] = new Proxy(t, { set(o, k, v){ written.push(k); o[k] = v; return true; }, deleteProperty(o, k){ written.push('-' + k); delete o[k]; return true; } });
  read([{ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } }]);
  assert.deepEqual(written, [], 'new lists with the same contents are not written');
  read([{ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: true }] } }]);
  assert.deepEqual(written, ['related_tasks'], 'a ticked subtask is written, even though the parent\'s `updated` is unchanged');
  assert.equal(t.related_tasks.subtask[0].done, true);
});

/* show(id) stacks three layers: Vikunja's copy, the waiting ops applied through each op's `apply`, then the direct
   saves still running (edit), oldest first. The test adds an op that renames a task to the registry, since the ops
   Pocket has are still shown their own way (SHOWN_OWN_WAY). */
test('a row shows Vikunja\'s copy, then its waiting ops, then the saves still running, and stays one object', () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    read([{ id: 1, title: 'Wipe the menus', due_date: '2026-10-08T09:00:00Z', priority: 1 }]);
    const t = app.row(copyOf(1));
    app.pending = [{ kind: 'act', id: 'r1', task: 1, op: 'rename', title: 'Wipe every menu', items: [] }]; app.keyOps();
    const due = app.edit(1, { due_date: '2026-10-09T09:00:00Z', title: 'Wipe the menus today' });
    assert.deepEqual([t.title, t.due_date, t.priority], ['Wipe the menus today', '2026-10-09T09:00:00Z', 1], 'a save laid over the op wins');
    due.undo();
    assert.deepEqual([t.title, t.due_date], ['Wipe every menu', '2026-10-08T09:00:00Z'], 'without the save, the op shows over the copy');
    app.pending = []; app.keyOps();
    assert.equal(t.title, 'Wipe the menus', 'without the op, the row is Vikunja\'s copy');
    assert.equal(app.tasks[1], t, 'every change was written into the same object');
  } finally { delete OPS.rename; }
});

test('a row has its own lists and objects, so writing a row never changes Vikunja\'s copy or the read it came from', () => {
  const app = component(tasks), loaded = { id: 1, title: 'Call Jo', labels: [{ id: 3, title: 'cafe' }] };
  read([loaded]);
  const t = app.row(loaded);
  t.labels[0].title = 'changed on screen'; t.title = 'Changed on screen';
  assert.deepEqual([loaded.title, loaded.labels[0].title, copyOf(1).title, copyOf(1).labels[0].title], ['Call Jo', 'cafe', 'Call Jo', 'cafe']);
});

test('a save\'s answer shows on the task\'s rows, and a task that is not on screen is not added', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Call Jo', done: false }]);
  const t = app.row(copyOf(1));
  put([{ id: 1, done: true }], ['done']);
  assert.equal(t.done, true);
  put([{ id: 2, done: true }], ['done']);
  assert.equal(app.rowTask(2), null);
});

/* edit lays a save's fields over the row until the save answers. ok writes the answer into Vikunja's copy and takes
   the fields off in one show, so the row never shows the old value in between. */
test('a save shows on the row at once, its answer replaces it, and a failed save puts back only its own fields', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Order cups', due_date: '2026-10-08T09:00:00Z', priority: 1, updated: 'a' }]);
  const t = app.row(copyOf(1)), shown = [];
  app.tasks[1] = new Proxy(t, { set(o, k, v){ shown.push([k, v]); o[k] = v; return true; } });
  const due = app.edit(1, { due_date: '2026-10-09T09:00:00Z' }), title = app.edit(1, { title: 'Order lids' });
  assert.deepEqual([t.due_date, t.title], ['2026-10-09T09:00:00Z', 'Order lids']);
  due.ok({ id: 1, title: 'Order cups', due_date: '2026-10-09T09:00:00Z', priority: 1, updated: 'b' });
  assert.deepEqual([t.due_date, t.title, t.updated, copyOf(1).due_date], ['2026-10-09T09:00:00Z', 'Order lids', 'b', '2026-10-09T09:00:00Z'],
    'the first answer brings the new date, and the title still being saved stays');
  assert.equal(shown.filter(([k]) => k === 'title').length, 1, 'the title was written once, and never back to the old one');
  title.undo();
  assert.deepEqual([t.title, t.due_date], ['Order cups', '2026-10-09T09:00:00Z'], 'a failed save puts back its own field only');
});

/* Two saves of one task run one after another. The first answer carries the task before the second save. Its fields
   go into the copy, and the second save's field stays on top until its own answer. */
test('two saves in flight on one task: the first answer does not flicker the second save\'s field back', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Order cups', due_date: '2026-10-08T09:00:00Z', done: false }]);
  const app = component(tasks, actions), seen = [];
  read([v.task(1)]);
  const t = app.row(copyOf(1));
  app.tasks[1] = new Proxy(t, { set(o, k, x){ if (k === 'title') seen.push(x); o[k] = x; return true; } });
  const save = (fields) => { const e = app.edit(1, fields); return app.saveTask(1, fields).then(got => e.ok(got), x => { e.undo(); throw x; }); };
  await Promise.all([save({ due_date: '2026-10-09T09:00:00Z' }), save({ title: 'Order lids' })]);
  assert.deepEqual(seen, ['Order lids'], 'the title is written once');
  assert.deepEqual([t.title, t.due_date], ['Order lids', '2026-10-09T09:00:00Z']);
});

/* A read can start before a save and arrive after its answer, carrying the task as it was. The store records when each
   task's last answer arrived, and a read started before that leaves the copy as it is. */
test('a read started before a task\'s answer leaves its copy alone, and a read started after it is taken', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Order cups', done: false }, { id: 2, title: 'Order lids', done: false }]);
  const app = component(tasks, actions);
  read([v.task(1), v.task(2)]);
  const t = app.row(copyOf(1)), before = started(), stale = [structuredClone(v.task(1)), structuredClone(v.task(2))];
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
test('a task leaving done keeps every field until its batch clears, then shows Vikunja\'s copy', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, leaving);

  read([{ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-10T09:00:00Z', repeat_after: 86400 }]);
  const t = app.row(copyOf(1)), ticked = app.edit(1, { done: true });
  app.markRow(1, { kind: 'done' });
  ticked.ok({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 });
  read([{ id: 1, title: 'Water them', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 }]);
  assert.deepEqual([t.done, t.due_date, t.title], [true, '2026-10-10T09:00:00Z', 'Water the plants'], 'the answer and a later read wait');
  await app.clearBatch(true);
  assert.deepEqual([t.done, t.due_date, t.title], [false, '2026-10-11T09:00:00Z', 'Water them'], 'once the batch clears, the row is Vikunja\'s copy');
  assert.equal(app.tasks[1], t);
});

test('a deleted task is removed from every list and forgotten', () => {
  const app = component(tasks), t = app.row({ id: 1, title: 'Call Jo' }), other = app.row({ id: 2, title: 'Buy milk' });
  put([{ id: 1, title: 'Call Jo' }], TASK);
  app.view.groups = [{ key: 'overdue', tasks: [t] }, { key: 'today', tasks: [other, t] }];
  app.forget(1);
  assert.deepEqual(app.view.groups.map(g => g.tasks.map(x => x.id)), [[], [2]]);
  assert.equal(app.rowTask(1), null);
  assert.equal(copyOf(1), undefined);
});

/* Vikunja answers null for a field the request didn't expand, and leaves fields out of what it doesn't send. Each read
   writes only the fields it can be trusted for (put). */
test('a read leaves the fields it isn\'t trusted for as the copy had them, and takes a trusted null', () => {
  component(tasks);
  const me = [{ id: 3 }];
  put([{ id: 1, title: 'Wipe the menus', labels: [{ id: 5, title: 'cafe' }], reactions: { '✅': me }, comment_count: 2 }], TASK_COUNT_REACTIONS);
  put([{ id: 1, title: 'Wipe the menus', labels: [{ id: 5, title: 'cafe' }], reactions: null, comment_count: 2 }], TASK_COUNT);
  assert.deepEqual(copyOf(1).reactions, { '✅': me }, 'a list read without expand=reactions keeps the copy\'s ✅');
  put([{ id: 1, title: 'Wipe the menus', labels: null }], TASK);
  assert.equal(copyOf(1).labels, null, 'a full read with no labels removes the last label');
  assert.equal(copyOf(1).comment_count, 2, 'a read without the count keeps it');
  const was = copyOf(1);
  put([{ id: 1, title: 'Wipe all the menus' }], TASK);
  assert.deepEqual([was.title, copyOf(1).title], ['Wipe the menus', 'Wipe all the menus'], 'a copy someone holds, as Undo does, stays as it was');
});

test('a copy never holds Pocket\'s own fields, from a read, a saved screen or a task just sent', () => {
  const app = component(tasks), own = { pending: true, parent: 9, was: 'pending-x-0', place: 2048 };
  put([{ id: 1, title: 'Order cups', ...own }], TASK);
  app.keptRows([{ id: 2, title: 'Order lids', updated: '2026-10-15T09:00:00Z', ...own }]);
  put([{ id: 3, title: 'Order straws', ...own }], SAVED);
  for (const id of [1, 2, 3]) assert.deepEqual(Object.keys(copyOf(id)).filter(k => k in own), [], 'task ' + id);
  assert.equal(app.tasks[2].parent, 9, 'the row keeps what the saved screen gave it');
});

/* A row shows a waiting op's effect (a step ticked offline is ticked on its row), but Vikunja doesn't have it yet. A
   screen saved then must not keep it, or reopening Pocket would show it as Vikunja's. */
test('a saved screen holds Vikunja\'s copy of each task, not a waiting op\'s effect on its row', () => {
  const app = component(tasks, views), copy = { id: 1, title: 'Wipe the menus', done: false, project_id: 7, updated: '2026-10-15T09:00:00Z' };
  read([copy], TASK_COUNT);
  const t = app.row(copy);
  app.edit(1, { done: true });                   // as tickRunStep does, until the outbox sends the tick
  Object.assign(app, { route: { name: 'project', id: 7 }, positions: {} });
  app.view = { groups: [{ key: 'open', tasks: [t] }], project: { id: 7, title: 'Cafe' }, listView: null };
  app.saveProject();
  assert.equal(saved.get('project.7.open').groups[0].tasks[0].done, false);
  localStorage.removeItem('pocket.saved.project.7.open');
});

test('opening Pocket puts a saved copy into the store only where it is newer than the copy there, or there is none', () => {
  const app = component(tasks), at = h => `2026-10-15T0${h}:00:00Z`;
  read([{ id: 41, title: 'Old name', updated: at(8) }, { id: 42, title: 'New name', updated: at(9) }]);
  const rows = app.keptRows([{ id: 41, title: 'New name', updated: at(9) }, { id: 42, title: 'Old name', updated: at(8) }, { id: 43, title: 'Only saved', updated: at(8) }]);
  assert.deepEqual([41, 42, 43].map(id => copyOf(id).title), ['New name', 'New name', 'Only saved']);
  assert.deepEqual(rows.map(t => t.title), ['New name', 'New name', 'Only saved'], 'each row shows the newer copy');
});

// An outbox entry for an op, as act() queues it.
const act = (task, op, more = {}) => ({ kind: 'act', id: op + task + (more.pct ?? ''), task, op, items: [], ...more });

test('a task as it will be is Vikunja\'s copy with its waiting ops applied in order, and the copy is left as it was', () => {
  const app = component(tasks), copy = { id: 2, title: 'Mop the floor', done: false, percent_done: 0 };
  put([copy], TASK);
  app.pending = [act(2, 'progress', { pct: 30 }), act(3, 'done'), act(2, 'progress', { pct: 60 }), act(2, 'done')];
  app.keyOps();
  assert.deepEqual(app.opsOn[2].map(e => e.id), ['progress230', 'progress260', 'done2'], 'a task\'s ops in the order they will be sent');
  assert.deepEqual(app.withWaiting(2), { id: 2, title: 'Mop the floor', done: true, percent_done: 0.6 }, 'the later progress wins');
  assert.deepEqual(copyOf(2), { id: 2, title: 'Mop the floor', done: false, percent_done: 0 });
  assert.equal(app.withWaiting(3), null, 'a task with no copy from Vikunja has nothing to apply its ops to');
  app.pending = []; app.keyOps();
  assert.equal(app.withWaiting(2), copyOf(2), 'with nothing waiting, the task is Vikunja\'s copy');
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

/* When Vikunja answers an op, the answer goes into Vikunja's copy and the op leaves opsOn in the same step. Each time
   the op joins or leaves, the test reads the task as it will be. It must never show the progress from before the op. */
test('an op\'s answer goes into Vikunja\'s copy as the op stops waiting, so the task never shows its old value', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([{ id: 2, title: 'Mop the floor', done: false, percent_done: 0, reactions: null }]);
  const app = component(tasks, acts, sending, outbox, runs), seen = [];
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], flushing: false, cap: {}, sheet: { task: null, sub: {} },
    view: { groups: [], run: null }, places: {}, endPlace(){}, aimSent(){}, claimSent(){}, positionSent(){} });
  Object.defineProperty(app, 'toast', { value: {} });
  put([{ id: 2, title: 'Mop the floor', done: false, percent_done: 0, reactions: { '✅': [{ id: 3 }] }, comment_count: 2 }], TASK_COUNT_REACTIONS);
  const look = () => seen.push(app.withWaiting(2).percent_done);
  const ops = app.opsOn = new Proxy({}, { set(o, k, x){ o[k] = x; look(); return true; }, deleteProperty(o, k){ delete o[k]; look(); return true; } });
  assert.equal((await app.act({ op: 'progress', task: 2, pct: 40, run: null })).status, 'sent');
  assert.deepEqual(seen, [0.4, 0.4], 'the op joins, and when it leaves its answer is already written');
  assert.deepEqual([Object.keys(ops), v.task(2).percent_done], [[], 0.4]);
  assert.deepEqual(copyOf(2), { ...v.task(2), reactions: { '✅': [{ id: 3 }] }, comment_count: 2 },
    'Vikunja\'s answer replaces the fields it has. Reactions it wasn\'t asked for, and fields it left out, keep what the copy had');
});

/* A row shows an op through the store only for an op that is not in SHOWN_OWN_WAY. Those ops still change the screen
   by their own code. The test adds an op that renames a task to the registry. */
test('a task\'s rows show an op shown through the store as it joins or leaves, and an op\'s answer once it is answered', () => {
  const app = component(tasks);
  OPS.rename = { apply: (x, a) => ({ ...x, title: a.title }) };
  try {
    for (const id of [1, 2]) { read([{ id, title: 'Task ' + id, done: false }]); app.row({ id, title: 'Task ' + id, done: false, comment_count: 2 }); }
    const rows = [app.tasks[1], app.tasks[2]];
    app.pending = [act(1, 'rename', { title: 'Renamed' }), act(2, 'done')];
    app.keyOps();
    assert.deepEqual(rows.map(x => [x.title, x.done, x.comment_count]), [['Renamed', false, 2], ['Task 2', false, 2]],
      'the renamed task is Vikunja\'s copy with the op applied, and keeps the field the copy lacks. The tick shows its own way');
    assert.deepEqual([app.tasks[1], app.tasks[2]], rows, 'each task is still one object');
    app.pending = [act(2, 'done')]; app.keyOps();
    assert.equal(rows[0].title, 'Task 1', 'once the op stops waiting, the row is Vikunja\'s copy again');
    app.answered({ ...act(2, 'done') }, { id: 2, title: 'Task 2', done: true });
    assert.deepEqual([rows[1].done, copyOf(2).done, app.opsOn[2]], [true, true, undefined], 'an answered tick goes into Vikunja\'s copy and onto its rows');
    assert.ok(SHOWN_OWN_WAY.every(op => op in OPS), 'every op in the list is an op');
  } finally { delete OPS.rename; }
});

/* A tick sent through the outbox shows on its row through an edit kept for its entry (until). Its answer takes the
   edit off in the same show that writes the answer. An entry that leaves the outbox unanswered takes it off too. */
test('a change sent as an op shows until the op is answered or leaves the outbox', () => {
  const app = component(tasks);
  read([{ id: 1, title: 'Wipe the menus', done: false }, { id: 2, title: 'Mop the floor', done: false }]);
  const [one, two] = [1, 2].map(id => app.row(copyOf(id))), seen = [];
  app.pending = [act(1, 'done'), act(2, 'done')]; app.keyOps();
  app.edit(1, { done: true }).until('done1'); app.edit(2, { done: true }).until('done2');
  app.tasks[1] = new Proxy(one, { set(o, k, v){ seen.push([k, v]); o[k] = v; return true; } });
  assert.deepEqual([one.done, two.done], [true, true]);
  app.answered(act(1, 'done'), { id: 1, title: 'Wipe the menus', done: true });
  assert.deepEqual([one.done, seen], [true, []], 'the answer replaces the edit without the row changing');
  app.pending = []; app.keyOps();
  assert.equal(two.done, false, 'dropped from the outbox, the tick is gone from its row');
});
