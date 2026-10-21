// Tests for the assign and label ops (src/js/ops/people.js, labels.js), against a fake Vikunja behind the plugin's
// relay: one person or label put on or taken off the set Vikunja has, a new label made once, pruning, Undo, a task
// deleted since, and the words.
import './browser.mjs';
import { sender, reached, noConnection, lastSaid, settle } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import { copyOf, started } from '../../src/js/app/tasks.js';
import { TASK } from '../../src/js/tasks.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { addLines } from '../../src/js/ops/index.js';
import actions from '../../src/js/app/actions.js';
import claims from '../../src/js/app/claims.js';
import progress from '../../src/js/app/progress.js';
import { line } from './samples.mjs';

const FLOOR = { id: 600, title: 'floor' },
  MOP = { id: 601, title: 'mop' },
  BOB = { id: 7, username: 'bob', name: 'Bob' },
  ME = { id: 1, username: 'me', name: '' };
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
  assert.equal(OPS.assign.merge(assign(2, BOB), assign(2, ME, false)), null, 'another person is their own change');
});

test('the same person or label put on twice while neither is sent is sent once, with what the row showed first', () => {
  const was = [{ id: 9, username: 'carol', name: '' }],
    tags = [MOP];
  assert.deepEqual(OPS.assign.merge({ ...assign(2, BOB), was }, assign(2, BOB)).was, was);
  const m = OPS.label.merge({ ...label(2, FLOOR), was: tags }, label(2, { id: null, title: 'Floor' }));
  assert.deepEqual([m.tag, m.was], [{ id: 600, title: 'Floor' }, tags], 'a label typed again keeps the id found');
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
  assert.equal(lastSaid(app).msg, 'Not undone: “Mop the floor” has changed since then.');
});

test('a person or a label on a task deleted in Vikunja since is dropped, and the sender says why', async t => {
  const { v, app } = listed(t, [task(2)]);
  v.tasks.delete(2);
  const r = await app.addLabelTo(app.tasks[2], FLOOR);
  assert.deepEqual([r.status, sync.all(1).length], ['error', 0]);
  assert.equal(lastSaid(app).msg, "Adding label floor to “Mop the floor” couldn't be saved: The task does not exist.");
});

test('the Undo of a change cancelled in the Outbox, or dropped when Vikunja refused it, sends nothing', async t => {
  const { v, app } = listed(t, [task(2), task(3, { title: 'Lock up' })]);
  noConnection(app, v);
  const f = label(2, FLOOR);
  await app.act(f);
  await app.dropAct(f.id);
  v.task(2).labels.push(FLOOR); // a teammate's, in the web app
  v.trouble = () => null;
  app.offline = false;
  assert.equal(await app.undoOps([f], false).left, 0);
  v.tasks.delete(3);
  const p = assign(3, BOB);
  assert.equal((await app.act(p)).status, 'error');
  assert.equal(await app.undoOps([p], false).left, 0);
  assert.deepEqual(
    [ids(v.task(2).labels), reached(v, 'PUT', /bulk$/).length, sync.all(1)],
    [[600], 0, []],
    "Vikunja keeps the teammate's label, and nothing is left to send",
  );
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

// Checklist 1 and its step 2, on the checklist's screen with no connection. `slot` is the step's claim slot.
const offlineStep = (t, more = {}) => {
  const s = listed(t, [task(1, { title: 'Closing' }), task(2, more)], claims, progress);
  Object.assign(s.app, { canWrite: () => true, view: { groups: [], shownRun: { id: 1 } } });
  noConnection(s.app, s.v);
  return { ...s, slot: () => s.app.claimSlot(s.app.tasks[2], s.app.tasks[2].assignees, false, 1) };
};
const queued = () => sync.all(1).map(e => e.op);

test('claiming a step and letting it go cancel out while neither is sent, from its slot or its sheet', async t => {
  const { app, slot } = offlineStep(t);
  await app.toggleClaim(slot());
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [['claim'], [1]]);
  await app.toggleClaim(slot());
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [[], []], 'tapping the slot again leaves nothing to send');
  await app.toggleClaim(slot());
  await app.removeAssignee(app.tasks[2], 1);
  assert.deepEqual(queued(), [], 'unassigning yourself in the sheet cancels the claim');
  await app.addAssignee(app.tasks[2], ME);
  await app.toggleClaim(slot());
  assert.deepEqual(queued(), [], 'letting the step go cancels assigning yourself');
  await app.addAssignee(app.tasks[2], ME);
  await app.addAssignee(app.tasks[2], ME);
  await app.toggleClaim(slot());
  assert.deepEqual(queued(), [], 'assigning yourself twice is one change, which letting go cancels');
});

test('letting a claimed step go and claiming it again cancel out while neither is sent', async t => {
  const { app, slot } = offlineStep(t, { assignees: [ME] });
  await app.toggleClaim(slot());
  await app.toggleClaim(slot());
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [[], [1]]);
});

test('a slide that claims a step queues the claim after the progress, so letting the step go cancels the claim', async t => {
  const { app, slot } = offlineStep(t);
  const s = { id: 2, title: 'Mop the floor', pct: 0, done: false, slot: slot() };
  Object.defineProperty(app, 'runView', { value: { steps: [s], finished: false } });
  app.stepSlide({ dataset: { id: '2' }, clientWidth: 360 }, { closest: () => null }).finish(40);
  await settle(t, () => queued().length === 2);
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [['progress', 'claim'], [1]]);
  await app.toggleClaim(slot());
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [['progress'], []]);
});

test('the same step claimed twice, or let go twice, while neither is sent is sent once', async t => {
  const { app } = offlineStep(t);
  const twice = async op => {
    for (let i = 0; i < 2; i++) await app.act({ id: uuid7(), op, task: 2, user: 1, run: 1 });
  };
  await twice('claim');
  assert.deepEqual([queued(), ids(app.tasks[2].assignees)], [['claim'], [1]], 'one claim');
  await app.act({ id: uuid7(), op: 'unclaim', task: 2, user: 1, run: 1 });
  await twice('unclaim');
  assert.deepEqual(
    [queued(), ids(app.tasks[2].assignees)],
    [['unclaim'], []],
    'letting go cancels the claim, and letting go twice more is sent once',
  );
});

test('a person put on a checklist and taken off cancel out while neither is sent', async t => {
  const { v, app } = listed(t, [task(1, { title: 'Closing', assignees: [ME] })]);
  Object.assign(app, {
    view: { groups: [], shownRun: { id: 1 } },
    sheet: { id: 1, sub: {}, runEdit: { forIds: [1], people: [ME, BOB] } },
    saveRun() {},
    forText: () => '',
  });
  noConnection(app, v);
  await app.setRunFor(BOB);
  await app.setRunFor(BOB);
  assert.deepEqual([queued(), ids(app.tasks[1].assignees)], [[], [1]]);
});

test('a claim already sent is never folded, and only a change to the same person folds', async t => {
  const { v, app, slot } = offlineStep(t);
  v.trouble = () => null;
  app.offline = false;
  await app.toggleClaim(slot());
  await app.toggleClaim(slot());
  assert.deepEqual(
    [reached(v, 'POST', /assignees$/).length, reached(v, 'DELETE', /assignees/).length, ids(v.task(2).assignees)],
    [1, 1, []],
    'a claim sent before the step was let go is taken back in Vikunja',
  );
  const claim = { id: uuid7(), op: 'claim', task: 2, user: 1, run: 1 };
  assert.equal(OPS.unclaim.merge(assign(2, BOB), { ...claim, op: 'unclaim' }), null, 'another person');
  assert.equal(OPS.claim.merge({ op: 'progress', task: 2, pct: 40 }, claim), null, 'another change');
  assert.deepEqual(
    OPS.assign.merge(claim, { ...assign(2, ME), was: [ME] }).was,
    [],
    'assigning yourself after a claim keeps what the row showed before the claim',
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

test('each op names the person or label, and Cancel names what Vikunja keeps', () => {
  const me = { id: 1, username: 'me' },
    a = { user: 1, add: true, person: BOB, tag: FLOOR, stage: 0 },
    copy = () => ({ assignees: [me, BOB], labels: [FLOOR, MOP] });
  assert.deepEqual(
    [
      OPS.assign.text(a, 'Mop'),
      OPS.assign.text({ ...a, person: me }, 'Mop'),
      OPS.assign.refused({ ...a, add: false, person: me }, 'Mop'),
      OPS.assign.dropped(a, 'Mop', copy),
      OPS.assign.dropped({ ...a, was: [] }, 'Mop'),
      OPS.label.text({ ...a, add: false }, 'Mop'),
      OPS.label.dropped(a, 'Mop', copy),
      OPS.label.dropped({ ...a, was: [] }, 'Mop'),
    ],
    [
      'Assigning Bob to “Mop”',
      'Assigning “Mop” to you',
      'Unassigning you from “Mop”',
      '“Mop” stays assigned to you and Bob.',
      '“Mop” stays unassigned.',
      'Removing label floor from “Mop”',
      '“Mop” labels stay floor and mop.',
      '“Mop” has no labels.',
    ],
  );
});

test("the people menu lists you first, then the others who can see the task's project by name, and ticks who is on it", t => {
  const { app } = listed(t, [task(2, { assignees: [BOB] })], claims);
  app.user = ME;
  const sees = (user, ...pids) => ({ user, pids: new Set(pids) });
  app.people = [
    sees({ id: 9, username: 'zed', name: 'Zed' }, 5),
    sees(BOB, 5),
    sees(ME, 5, 6),
    sees({ id: 8, username: 'carol', name: '' }, 6),
    sees({ id: 3, username: 'amy', name: 'Amy' }, 5, 6),
  ];
  assert.deepEqual(
    app.whoList(app.tasks[2]).map(x => [x.u.username, x.on]),
    [
      ['me', false],
      ['amy', false],
      ['bob', true],
      ['zed', false],
    ],
    'carol cannot see project 5, so she is not listed',
  );
  app.people = null;
  assert.deepEqual(
    app.whoList(app.tasks[2]).map(x => x.u.username),
    ['me'],
    'before the people are loaded, only you are listed',
  );
});

test('tapping a person in the people menu assigns them, or unassigns them if ticked, offline too', async t => {
  const { app, v } = listed(t, [task(2)], claims);
  Object.assign(app, { user: ME, canWrite: () => true });
  noConnection(app, v);
  const slot = () => app.claimSlot(app.tasks[2], app.tasks[2].assignees, false),
    queued = () => sync.all(1).map(e => [e.op, e.person?.id ?? e.user, e.add]);
  await app.whoTap(slot(), BOB);
  assert.deepEqual([ids(app.tasks[2].assignees), queued()], [[7], [['assign', 7, true]]], 'bob is assigned at once');
  await app.whoTap(slot(), BOB);
  assert.deepEqual([ids(app.tasks[2].assignees), queued()], [[], []], 'tapping bob again unassigns him');
  await app.whoTap(slot(), ME);
  assert.deepEqual(
    [ids(app.tasks[2].assignees), queued()],
    [[1], [['claim', 1, undefined]]],
    'tapping Me claims the task, as a tap on "+ me" does',
  );
  await app.whoTap(slot(), ME);
  assert.deepEqual([ids(app.tasks[2].assignees), queued()], [[], []], 'tapping Me again lets it go');
});
