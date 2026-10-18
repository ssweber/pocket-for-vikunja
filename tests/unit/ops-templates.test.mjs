// Tests for the template ops (src/js/ops/templates.js), against a fake Vikunja behind the plugin's relay.
import './browser.mjs';
import { sender, settle, lastSaid } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { started, TASK } from '../../src/js/app/tasks.js';
import { sync } from '../../src/js/sync.js';
import checklists from '../../src/js/app/checklists.js';
import quickadd from '../../src/js/app/quickadd.js';

const TEMPLATE = { id: 601, title: 'template' },
  FLOOR = { id: 600, title: 'floor' };
const ids = list => (list || []).map(x => x.id);
// Task 7, Closing, with steps 8 and 9, as Vikunja has it. `more` changes a task, by id.
const closing = (more = {}) =>
  [
    { id: 7, title: 'Closing', related_tasks: { subtask: [{ id: 8 }, { id: 9 }] } },
    { id: 8, title: 'Mop the floor', related_tasks: { parenttask: [{ id: 7 }] } },
    { id: 9, title: 'Lock up', related_tasks: { parenttask: [{ id: 7 }] } },
  ].map(t => ({ project_id: 5, done: false, description: '', labels: [], assignees: [], ...t, ...more[t.id] }));
// A sender with the template editor, whose tasks have rows and copies, and whose Vikunja has the label "template".
const editor = (t, list) => {
  const s = sender(t, list, checklists, quickadd);
  s.v.labels.push(TEMPLATE, FLOOR);
  s.app.change(w =>
    w.read(
      list.map(x => structuredClone(x)),
      TASK,
      started(),
    ),
  );
  for (const x of list) s.app.row(structuredClone(x));
  Object.assign(s.app, {
    projects: [],
    labels: [TEMPLATE, FLOOR],
    render() {},
    go() {},
    closeSheet() {},
    showTask() {},
    unsay() {},
  });
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  return s;
};
const outbox = () => sync.all(1);

test('Make template refused partway waits in the Outbox as no template, and Cancel takes back what it made', async t => {
  const { v, app } = editor(t, closing());
  // Vikunja refuses the last request, which marks the task done and names it.
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/7' ? 403 : null);
  const r = await app.act({ op: 'makeTemplate', task: 7, run: null, steps: [8, 9] });
  assert.equal(r.status, 'error');
  assert.deepEqual(
    [ids(v.task(7).labels), v.task(7).done, v.task(7).title, v.task(8).done, v.task(9).done],
    [[601], false, 'Closing', true, true],
    'Vikunja has the label and the steps done, but not the task marked done as a template',
  );
  assert.deepEqual(
    [app.tasks[7].done, app.tasks[7].title, outbox().map(e => !!e.failed)],
    [false, 'Closing', [true]],
    'the row shows the task as Vikunja has it, and the op waits in the Outbox',
  );
  v.trouble = () => null;
  await app.dropAct(outbox()[0].id);
  await settle(t, () => !outbox().length);
  assert.deepEqual(
    [ids(v.task(7).labels), v.task(8).done, v.task(9).done, outbox(), lastSaid(app).msg],
    [[], false, false, [], 'Cancelled.'],
    'Cancel takes the label off and opens the steps again',
  );
});
