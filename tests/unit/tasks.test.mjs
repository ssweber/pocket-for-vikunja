// The tasks on screen, one copy of each (src/js/app/tasks.js).
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
