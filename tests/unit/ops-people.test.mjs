// Tests for the assign and label ops (src/js/ops/people.js, labels.js), against a fake Vikunja behind the plugin's
// relay: one person or label put on or taken off the set Vikunja has, a new label made once, pruning, Undo, a task
// deleted since, and the words.
import './browser.mjs';
import { sender, reached, noConnection, lastSaid, settle } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import { copyOf, started, TASK } from '../../src/js/app/tasks.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { addLines } from '../../src/js/ops/index.js';
import actions from '../../src/js/app/actions.js';
import checklists from '../../src/js/app/checklists.js';
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
const label = (t, tag, add = true) => ({ id: uuid7(), op: 'label', task: t, tag, add, was: [], run: null });
const assign = (t, person, add = true) => ({ id: uuid7(), op: 'assign', task: t, person, add, was: [], run: null });

test('a person and a label show at once, and each sends the set Vikunja has with that one changed', async t => {
  const { v, app } = listed(t, [task(2, { labels: [FLOOR] })]);
  const sending = app.addAssignee(app.tasks[2], BOB);
  assert.deepEqual(ids(app.tasks[2].assignees), [7], 'the row shows it before Vikunja answers');
  await sending;
  await app.addLabelTo(app.tasks[2], MOP);
  assert.deepEqual(
    reached(v, 'PUT', /bulk$/).map(r => [r.path, r.body]),
    [
      ['/tasks/2/assignees/bulk', { assignees: [{ id: 7 }] }],
      ['/tasks/2/labels/bulk', { labels: [{ id: 600 }, { id: 601 }] }],
    ],
  );
  await app.removeLabelFrom(app.tasks[2], 600);
  await app.removeAssignee(app.tasks[2], 7);
  assert.deepEqual(
    [ids(v.task(2).labels), ids(copyOf(2).labels), ids(app.tasks[2].labels), ids(copyOf(2).assignees)],
    [[601], [601], [601], []],
  );
});

test("a teammate's label added between queueing and sending stays on the task", async t => {
  const { v, app } = listed(t, [task(2, { labels: [FLOOR] })]);
  noConnection(app, v);
  await app.addLabelTo(app.tasks[2], MOP);
  v.task(2).labels.push({ id: 602, title: 'urgent' }); // a teammate's, in the web app
  v.trouble = () => null;
  app.offline = false;
  await app.flush();
  await settle(t, () => !sync.all(1).length);
  assert.deepEqual(ids(v.task(2).labels), [600, 602, 601], "Vikunja keeps the teammate's label");
  assert.deepEqual(ids(copyOf(2).labels), [600, 602, 601], "Vikunja's copy takes the set from Vikunja's answer");
});

test('a new label is made once as its op is sent, and an op that names it later finds it', async t => {
  const { v, app } = listed(t, [task(2), task(3, { title: 'Lock up' })]);
  noConnection(app, v);
  await app.addLabelTo(app.tasks[2], null, 'Urgent');
  await app.addLabelTo(app.tasks[3], null, 'urgent');
  assert.deepEqual(app.tasks[2].labels, [{ id: 'new:urgent', title: 'Urgent' }], 'the row shows the label waiting');
  v.trouble = () => null;
  app.offline = false;
  await app.flush();
  await settle(t, () => !sync.all(1).length);
  const made = v.labels.find(l => l.title === 'Urgent');
  assert.deepEqual(
    [reached(v, 'POST', /^\/labels$/).length, ids(v.task(2).labels), ids(v.task(3).labels)],
    [1, [made.id], [made.id]],
  );
});

test('putting a person or a label on and taking it off cancel out while neither is sent', async t => {
  const { v, app } = listed(t, [task(2, { assignees: [BOB] })]);
  noConnection(app, v);
  await app.addLabelTo(app.tasks[2], FLOOR);
  await app.removeLabelFrom(app.tasks[2], 600);
  await app.removeAssignee(app.tasks[2], 7);
  await app.addAssignee(app.tasks[2], BOB);
  assert.deepEqual(sync.all(1), [], 'nothing is left to send');
  assert.equal(OPS.label.merge(label(2, FLOOR), label(2, MOP, false)), null, 'another label is its own change');
  assert.equal(OPS.assign.merge(assign(2, BOB), assign(2, BOB)), null, 'the same change twice is sent twice');
});

test("an Undo takes off only what the op put on, and leaves a teammate's change", async t => {
  const { v, app } = listed(t, [task(2)]);
  const f = label(2, FLOOR),
    p = assign(2, BOB);
  await app.act(f);
  await app.act(p);
  v.task(2).labels.push(MOP); // a teammate's, in the web app
  assert.equal(await app.undoOps([f, p], false).left, 0);
  assert.deepEqual([ids(v.task(2).labels), ids(v.task(2).assignees)], [[601], []]);
  // A label taken off goes back on, unless the task is gone.
  const off = label(2, MOP, false);
  await app.act(off);
  v.tasks.delete(2);
  assert.equal(await app.undoOps([off], false).left, 1);
  assert.equal(lastSaid(app).msg, 'Not undone: “Mop the floor” has changed since then');
});

test('a person or a label on a task deleted in Vikunja since is dropped, and the sender says why', async t => {
  const { v, app } = listed(t, [task(2)]);
  v.tasks.delete(2);
  const r = await app.addLabelTo(app.tasks[2], FLOOR);
  assert.deepEqual([r.status, sync.all(1).length], ['error', 0]);
  assert.equal(lastSaid(app).msg, "Adding label floor to “Mop the floor” couldn't be saved: The task does not exist.");
});

test("a checklist's people change by the one tapped, and the person claimed meanwhile stays", async t => {
  const { v, app } = listed(t, [task(1, { title: 'Closing', assignees: [{ id: 1, username: 'me' }] })]);
  const said = [];
  Object.assign(app, {
    view: { groups: [], shownRun: { id: 1 } },
    sheet: { id: 1, sub: {}, runEdit: { forIds: [1], people: [{ id: 1, username: 'me' }, BOB] } },
    saveRun() {},
    forText: x => 'For ' + x.assignees.map(u => u.username).join(' and '),
    say: msg => said.push(msg),
  });
  v.task(1).assignees.push({ id: 9, username: 'carol' }); // a step's claim, sent from another phone
  await app.setRunFor(BOB);
  assert.deepEqual(
    [ids(v.task(1).assignees), ids(copyOf(1).assignees), said],
    [[1, 9, 7], [1, 9, 7], ['Now for me and bob']],
  );
});

test("a line's labels and people reach Vikunja's copy once they are set", async t => {
  const { app } = listed(t, [task(2)]);
  Object.assign(app, { canSee: async () => true, findUser: async () => BOB, prefixes: { assignee: '@' } });
  const [f] = addLines([line('Buy rope', { labels: ['floor'], assignees: ['bob'] })], { pid: 5 });
  app.loadLabels = async () => [FLOOR, MOP];
  const r = await app.act(f);
  assert.equal(r.status, 'sent');
  assert.deepEqual([ids(copyOf(r.ids[0]).labels), ids(copyOf(r.ids[0]).assignees)], [[600], [7]]);
});

test('Make template takes back its label op when Vikunja is out of reach, so no label arrives later', async t => {
  const { v, app } = listed(t, [task(4, { title: 'Closing' })], checklists);
  noConnection(app, v);
  app.loadLabels = async () => [];
  await assert.rejects(app.markTemplate({ id: 4, labels: [] }, []), /offline/);
  assert.deepEqual([sync.all(1), app.tasks[4].labels], [[], []]);
});

test('each op names the person or label, and Cancel names what Vikunja keeps', () => {
  const me = { id: 1, username: 'me' },
    a = { user: 1, add: true, person: BOB, tag: FLOOR, stage: 0 },
    copy = () => ({ assignees: [me, BOB], labels: [FLOOR, MOP] });
  assert.deepEqual(
    [
      OPS.assign.text(a, 'Mop'),
      OPS.assign.refused({ ...a, add: false, person: me }, 'Mop'),
      OPS.assign.dropped(a, 'Mop', copy),
      OPS.label.text({ ...a, add: false }, 'Mop'),
      OPS.label.dropped(a, 'Mop', copy),
      OPS.label.dropped({ ...a, was: [] }, 'Mop'),
    ],
    [
      'Assigning Bob to “Mop”',
      'Unassigning you from “Mop”',
      '“Mop” people stay you and Bob.',
      'Removing label floor from “Mop”',
      '“Mop” labels stay floor and mop.',
      '“Mop” has no labels.',
    ],
  );
});
