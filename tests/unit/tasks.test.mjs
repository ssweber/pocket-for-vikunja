// The tasks on screen. The app keeps one copy of each task (src/js/app/tasks.js).
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tasks from '../../src/js/app/tasks.js';
import { cache } from '../../src/js/util.js';

test('a task loaded again is the same object, as Vikunja has it now', () => {
  const app = component(tasks);
  const first = app.keep({ id: 1, title: 'Call Jo', due_date: '2026-10-08T09:00:00Z', labels: [{ id: 3 }] });
  const again = app.keep({ id: 1, title: 'Call Jo back', labels: [] });
  assert.equal(again, first, 'every row showing it shows the change');
  assert.deepEqual(first, { id: 1, title: 'Call Jo back', labels: [] }, 'a field Vikunja no longer gives is gone');
});

test('a task loaded again has only what changed written to it, so an unchanged row has nothing to do', () => {
  const app = component(tasks), was = { id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] }, pending: true };
  const t = app.keep(was), written = [];
  app.tasks[1] = new Proxy(t, { set(o, k, v){ written.push(k); o[k] = v; return true; }, deleteProperty(o, k){ written.push('-' + k); delete o[k]; return true; } });
  app.keep({ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: false }] } });
  assert.deepEqual(written, ['-pending'], 'new lists, the same in them: left as they were');
  app.keep({ id: 1, title: 'Call Jo', labels: [{ id: 3 }], related_tasks: { subtask: [{ id: 2, done: true }] } });
  assert.deepEqual(written, ['-pending', 'related_tasks'], 'a subtask ticked, its parent’s `updated` as it was: written');
  assert.equal(t.related_tasks.subtask[0].done, true);
});

test('a repeating task shown done until the batch clears stays as it is through a load, though Vikunja has it open at its next date', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-10T09:00:00Z', repeat_after: 86400 });
  // The user ticks the task. Vikunja moves it to its next date, but the row shows it done with its old date until the mark is removed.
  t.done = true; app.leaving[1] = 'done';
  const again = app.keep({ id: 1, title: 'Water the plants', done: false, due_date: '2026-10-11T09:00:00Z', repeat_after: 86400 });
  assert.equal(again, t);
  assert.deepEqual([t.done, t.due_date], [true, '2026-10-10T09:00:00Z'], 'as it\'s shown');
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

test('a task kept is a copy: changing what was loaded leaves it alone', () => {
  const app = component(tasks), loaded = { id: 1, title: 'Call Jo' };
  app.keep(loaded).title = 'Changed on screen';
  assert.equal(loaded.title, 'Call Jo');
});

test('a change saved is on the task\'s rows; one not on screen isn\'t added', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Call Jo', done: false });
  app.syncTask({ id: 1, done: true });
  assert.equal(t.done, true);
  app.syncTask({ id: 2, done: true });
  assert.equal(app.rowTask(2), null);
});

test('a task deleted is off every list and forgotten', () => {
  const app = component(tasks), t = app.keep({ id: 1, title: 'Call Jo' }), other = app.keep({ id: 2, title: 'Buy milk' });
  cache.set(1, { id: 1 });
  app.view.groups = [{ key: 'overdue', tasks: [t] }, { key: 'today', tasks: [other, t] }];
  app.forget(1);
  assert.deepEqual(app.view.groups.map(g => g.tasks.map(x => x.id)), [[], [2]]);
  assert.equal(app.rowTask(1), null);
  assert.equal(cache.has(1), false);
});
