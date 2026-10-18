// Tests for the assign and label ops (src/js/ops/people.js, labels.js), against a fake Vikunja behind the plugin's
// relay: one person or label put on or taken off the set Vikunja has, a new label made once, pruning, Undo, a task
// deleted since, and the words.
import './browser.mjs';
import { sender } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyOf, started, TASK } from '../../src/js/app/tasks.js';
import { sync } from '../../src/js/sync.js';
import { addLines } from '../../src/js/ops/index.js';
import actions from '../../src/js/app/actions.js';
import { line } from './samples.mjs';

const FLOOR = { id: 600, title: 'floor' },
  MOP = { id: 601, title: 'mop' },
  BOB = { id: 7, username: 'bob', name: 'Bob' };
// A sender whose tasks have rows and copies, and whose Vikunja has the labels floor and mop.
const listed = (t, list, ...parts) => {
  const s = sender(t, list, actions, ...parts);
  s.v.labels.push(FLOOR, MOP);
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
const task = (id, more) => ({ id, title: 'Mop the floor', project_id: 5, assignees: [], labels: [], ...more });
const ids = list => (list || []).map(x => x.id);

test("a line's labels and people reach Vikunja's copy once they are set", async t => {
  const { app } = listed(t, [task(2)]);
  Object.assign(app, { canSee: async () => true, findUser: async () => BOB, prefixes: { assignee: '@' } });
  const [f] = addLines([line('Buy rope', { labels: ['floor'], assignees: ['bob'] })], { pid: 5 });
  app.loadLabels = async () => [FLOOR, MOP];
  const r = await app.act(f);
  assert.equal(r.status, 'sent');
  assert.deepEqual([ids(copyOf(r.ids[0]).labels), ids(copyOf(r.ids[0]).assignees)], [[600], [7]]);
});
