// Tests for the ops in the outbox (src/js/ops/) and their sender (src/js/app/acts.js), against a fake Vikunja behind
// the plugin's relay.
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import acts from '../../src/js/app/acts.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import { sync } from '../../src/js/sync.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { UNKNOWN } from '../../src/js/messages.js';

const FIELDS = ['apply', 'stages', 'invert', 'merge', 'waiting', 'text', 'refused', 'dropped'];

test('every op has every field, and only invert, merge and waiting may be empty', () => {
  for (const [name, op] of Object.entries(OPS)) {
    for (const f of FIELDS) assert.ok(f in op, `${name} has ${f}`);
    for (const f of ['apply', 'text', 'refused', 'dropped']) assert.equal(typeof op[f], 'function', `${name}.${f}`);
    assert.ok(op.stages.length && op.stages.every(s => typeof s === 'function'), `${name} has its requests`);
    assert.ok(op.waiting === null || (typeof op.waiting.key === 'string' && typeof op.waiting.value === 'function'), `${name}.waiting`);
  }
});

test('apply returns the task as a new object, and leaves the task and the op alone', () => {
  const task = { id: 4, title: 'Unlock the door', done: false, percent_done: 0.25, assignees: [{ id: 2 }] }, was = structuredClone(task);
  for (const [name, op] of Object.entries(OPS)) {
    const a = { op: name, task: 4, user: 1, pct: 50, ids: [4] }, before = structuredClone(a), out = op.apply(task, a);
    assert.notEqual(out, task, name);
    assert.deepEqual([task, a], [was, before], `${name} changed nothing it was given`);
  }
  assert.deepEqual([OPS.done.apply(task).done, OPS.undone.apply({ ...task, done: true }).done, OPS.progress.apply(task, { pct: 50 }).percent_done], [true, false, 0.5]);
  assert.deepEqual(OPS.claim.apply(task, { user: 1 }).assignees.map(u => u.id), [2, 1]);
  assert.deepEqual(OPS.unclaim.apply(task, { user: 2 }).assignees, []);
});

/* Each op's words, as the outbox said them before the ops had words of their own: its row in Waiting to send, what a
   refusal calls it, and what Don't send it leaves in Vikunja before and after its first request. The first row of each
   has a step's title with its time, and the second has no title. */
const WORDS = {
  done: [['Done: Unlock the door', 'A tick on “Unlock the door”', '“Unlock the door” stays not done in Vikunja.', '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.'],
    ['Done: a step', 'A tick', '“it” stays not done in Vikunja.', '“it” stays marked done in Vikunja. The rest of the change is not sent.']],
  undone: [['Not done: Unlock the door', 'Marking “Unlock the door” not done', '“Unlock the door” stays done in Vikunja.', '“Unlock the door” stays not done in Vikunja. The rest of the change is not sent.'],
    ['Not done: a step', 'Marking a step not done', '“it” stays done in Vikunja.', '“it” stays not done in Vikunja. The rest of the change is not sent.']],
  skip: [['Skipped: Unlock the door', 'A skip on “Unlock the door”', '“Unlock the door” stays not done in Vikunja.', '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.'],
    ['Skipped: a step', 'A skip', '“it” stays not done in Vikunja.', '“it” stays marked done in Vikunja. The rest of the change is not sent.']],
  doneNote: [['Done, with a comment: Unlock the door', 'Marking “Unlock the door” done, with its comment', '“Unlock the door” stays not done in Vikunja.', '“Unlock the door” stays marked done in Vikunja. The rest of the change is not sent.'],
    ['Done, with a comment: a step', 'Marking a step done, with its comment', '“it” stays not done in Vikunja.', '“it” stays marked done in Vikunja. The rest of the change is not sent.']],
  note: [['A comment on “Unlock the door”', 'A comment on “Unlock the door”', 'The comment isn\'t posted. Its text goes back into the comment box.', 'The comment isn\'t posted. Its text goes back into the comment box.'],
    ['A comment on “a step”', 'A comment', 'The comment isn\'t posted. Its text goes back into the comment box.', 'The comment isn\'t posted. Its text goes back into the comment box.']],
  answer: [['Unlock the door', 'Answers on “Unlock the door”', '', ''],
    ['a step', 'Answers', '', '']],
  finish: [['Finishing “Unlock the door”', 'Finishing the checklist', 'The checklist stays open in Vikunja.', 'The checklist stays finished in Vikunja. The rest of the change is not sent.'],
    ['Finishing “a step”', 'Finishing the checklist', 'The checklist stays open in Vikunja.', 'The checklist stays finished in Vikunja. The rest of the change is not sent.']],
  reopen: [['Reopening “Unlock the door”', 'Reopening the checklist', 'The checklist stays finished in Vikunja.', 'The checklist stays open in Vikunja. The rest of the change is not sent.'],
    ['Reopening “a step”', 'Reopening the checklist', 'The checklist stays finished in Vikunja.', 'The checklist stays open in Vikunja. The rest of the change is not sent.']],
  progress: [['Progress: 40% on “Unlock the door”', 'Progress on “Unlock the door”', '“Unlock the door” keeps the progress it has in Vikunja.', '“Unlock the door” keeps the progress it has in Vikunja.'],
    ['Progress: 40% on “a step”', 'Progress', '“it” keeps the progress it has in Vikunja.', '“it” keeps the progress it has in Vikunja.']],
  claim: [['Assigning “Unlock the door” to you', 'Assigning “Unlock the door” to you', 'You are not assigned to “Unlock the door”.', 'You are not assigned to “Unlock the door”.'],
    ['Assigning “a step” to you', 'Assigning it to you', 'You are not assigned to “it”.', 'You are not assigned to “it”.']],
  unclaim: [['Unassigning you from “Unlock the door”', 'Unassigning you from “Unlock the door”', '“Unlock the door” stays assigned to you.', '“Unlock the door” stays assigned to you.'],
    ['Unassigning you from “a step”', 'Unassigning you from it', '“it” stays assigned to you.', '“it” stays assigned to you.']],
  delete: [['Deleting “Unlock the door”, with 2 subtasks', 'Deleting “Unlock the door”', '“Unlock the door” stays in Vikunja.', '“Unlock the door” stays in Vikunja.'],
    ['Deleting “a step”, with 2 subtasks', 'Deleting a task', '“it” stays in Vikunja.', '“it” stays in Vikunja.']],
  position: [['Moving “Unlock the door” in its list', 'Moving “Unlock the door T#5m”', '“Unlock the door” stays where it was in Vikunja\'s list.', '“Unlock the door” stays where it was in Vikunja\'s list.'],
    ['Moving “a step” in its list', 'Moving a task', '“it” stays where it was in Vikunja\'s list.', '“it” stays where it was in Vikunja\'s list.']],
};

test('each op says what the outbox said before: its row, its refusal, and what dropping it leaves', () => {
  assert.deepEqual(Object.keys(WORDS).sort(), Object.keys(OPS).sort());
  for (const [name, op] of Object.entries(OPS)) ['Unlock the door T#5m', ''].forEach((title, k) => {
    const a = stage => ({ op: name, task: 1, stage, pct: 40, ids: [3, 2, 1], html: '' });
    assert.deepEqual([op.text(a(0), title), op.refused(a(0), title), op.dropped(a(0), title), op.dropped(a(1), title)], WORDS[name][k], `${name}, title "${title}"`);
  });
  assert.equal(OPS.done.text({ op: 'done' }, 'Mop', true), 'Done: Mop (repeated)', 'a step repeated in its checklist says so');
});

/* The sender with a fake outbox. Each act is queued with act() and sent at once. Messages are read from `toasts`, since
   `toast` here is the component's own toast, which act() reads. */
const sender = (t, list) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(list), app = component(tasks, acts, sending, outbox, runs);
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], flushing: false, cap: {}, sheet: { id: null, sub: {} },
    view: { groups: [], shownRun: null }, places: {}, endPlace(){}, aimSent(){}, claimSent(){}, positionSent(){} });
  Object.defineProperty(app, 'toast', { value: {} });
  return { v, app };
};
// The requests that reached Vikunja. The relay answers a request sent again with its key from what it kept.
const reached = (v, method, re) => v.requests.filter(r => r.method === method && re.test(r.path) && !r.replayed);
const lostOnce = (v, method, re) => { let n = 0; v.trouble = r => r.method === method && re.test(r.path) && !n++ ? 'lost' : null; };

test('a tick on a repeating step whose reply is lost moves the step\'s date once when it is sent again', async t => {
  const step = { id: 2, title: 'Check the fridge', done: false, due_date: '2026-10-07T09:00:00Z', repeat_after: 86400, related_tasks: { parenttask: [{ id: 1 }] } };
  const { v, app } = sender(t, [{ id: 1, title: 'Closing', related_tasks: { subtask: [{ id: 2 }] } }, step]);
  lostOnce(v, 'PATCH', /^\/tasks\/2$/);
  const r = await app.act({ op: 'done', task: 2, run: 1 });
  assert.equal(r.status, 'offline', 'a lost reply leaves the tick waiting');
  await app.sendActs(app.pending[0].id);
  assert.deepEqual([reached(v, 'PATCH', /^\/tasks\/2$/).length, v.task(2).due_date], [1, new Date(vikunjaNext(step)).toISOString()]);
  assert.deepEqual([v.task(2).reactions['✅'].length, sync.all(1).length], [1, 0]);
});

test('a comment whose reply is lost is posted once when it is sent again', async t => {
  const { v, app } = sender(t, [{ id: 5, title: 'Call the plumber' }]);
  lostOnce(v, 'POST', /comments$/);
  await app.act({ op: 'note', task: 5, html: '<p>Booked</p>', run: null });
  await app.sendActs(app.pending[0].id);
  assert.deepEqual([v.task(5).comments.length, reached(v, 'POST', /comments$/).length, sync.all(1).length], [1, 1, 0]);
});

test('a claim whose reply is lost is made once when it is sent again', async t => {
  const { v, app } = sender(t, [{ id: 6, title: 'Order cups', assignees: [] }]);
  lostOnce(v, 'POST', /assignees$/);
  await app.act({ op: 'claim', task: 6, run: null });
  await app.sendActs(app.pending[0].id);
  assert.deepEqual([v.task(6).assignees.map(u => u.id), reached(v, 'POST', /assignees$/).length, sync.all(1).length], [[1], 1, 0]);
});

test('a deletion whose reply is lost half way deletes each task once when it is sent again', async t => {
  const { v, app } = sender(t, [{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Pack the cups', related_tasks: { subtask: [{ id: 3 }] } }, { id: 3, title: 'Wrap them' }]);
  lostOnce(v, 'DELETE', /^\/tasks\/2$/);
  await app.act({ op: 'delete', task: 1, ids: [3, 2, 1], run: null });
  assert.deepEqual(reached(v, 'DELETE', /./).map(r => r.path), ['/tasks/3', '/tasks/2']);
  await app.sendActs(app.pending[0].id);
  assert.deepEqual(reached(v, 'DELETE', /./).map(r => r.path), ['/tasks/3', '/tasks/2', '/tasks/1'], 'the first two get the answers the relay kept');
  assert.deepEqual([[1, 2, 3].filter(id => v.task(id)), sync.all(1).length], [[], 0]);
});

test('a change the relay can\'t vouch for is kept as failed, and Try again sends it with a new key', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  v.trouble = r => r.method === 'PATCH' ? 'unknown' : null;
  const r = await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  assert.deepEqual([r.status, app.failed.length, app.failed[0].failed.message], ['error', 1, UNKNOWN]);
  assert.equal(app.toasts.at(-1).msg, 'A tick on “Wipe the till” may not have reached Vikunja. Tap the warning sign at the top.');
  assert.equal(app.outboxRows[0].failed, 'Vikunja may or may not have this change. Check, then tap Try again if it\'s missing.');
  assert.ok(!v.task(7).done, 'the change wasn\'t made');
  const first = v.requests.find(q => q.method === 'PATCH').key;
  v.trouble = () => null;
  await app.retryAct(app.failed[0].id);
  const again = v.requests.filter(q => q.method === 'PATCH').at(-1).key;
  assert.notEqual(again.split(':')[0], first.split(':')[0], 'the key is new');
  assert.deepEqual([again.split(':').slice(1), v.task(7).done, sync.all(1).length], [['0', '0'], true, 0]);
});

/* A request that gets no answer may have reached Vikunja, and after it an act can't be dropped. So while Pocket knows
   it is offline, an act's first request isn't tried, and flush sends a read first to find out. */
const offlineTick = async (t, mark) => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  mark(app, v);
  const r = await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  return { v, app, r };
};
// The act starts flush, whose read fails here, as it would with no connection.
const noConnection = (app, v) => { app.offline = true; v.trouble = q => q.path === '/user' ? 'offline' : null; };
// Fire the flush an act started (setTimeout is mocked here), and let its requests settle.
const settle = async (t, done = () => false) => { t.mock.timers.tick(1); for (let i = 0; i < 200 && !done(); i++) await new Promise(ok => setImmediate(ok)); };
for (const [how, mark] of [['Pocket has found no connection', noConnection], ['the browser says it is offline', () => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })]])
  test(`a tick made while ${how} is not tried, and can be dropped`, async t => {
    t.after(() => { delete navigator.onLine; });
    const { v, app, r } = await offlineTick(t, mark);
    await settle(t);
    assert.deepEqual([r.status, v.requests.filter(q => q.path !== '/user').length, app.pending[0].sent, app.offline], ['offline', 0, undefined, true]);
    assert.deepEqual(app.outboxRows[0].drop, ['dropAct', app.pending[0].id], 'Waiting to send offers Don\'t send it');
    globalThis.confirm = () => true;
    await app.dropAct(app.pending[0].id);
    assert.deepEqual([sync.all(1).length, v.requests.filter(q => q.path !== '/user').length, v.task(7).done], [0, 0, undefined]);
  });

test('a tick made just after a brief drop is sent once a read gets through, without waiting for the 30-second timer', async t => {
  const { v, app, r } = await offlineTick(t, app => { app.offline = true; });
  assert.equal(r.status, 'offline');
  await settle(t, () => !sync.all(1).length);
  assert.deepEqual([v.requests.map(q => q.method + ' ' + q.path).slice(0, 2), v.task(7).done, sync.all(1).length, app.offline], [['GET /user', 'PATCH /tasks/7'], true, 0, false]);
});

test('flush while offline sends a read first, and sends the waiting tick only once the read is answered', async t => {
  const { v, app } = await offlineTick(t, app => { app.offline = true; });
  v.trouble = () => 'offline';
  await app.flush();
  assert.deepEqual([v.requests.map(q => q.method + ' ' + q.path), app.pending.length, app.offline], [['GET /user'], 1, true], 'nothing more after the read fails');
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([v.requests.map(q => q.method + ' ' + q.path).slice(1, 3), v.task(7).done, sync.all(1).length, app.offline], [['GET /user', 'PATCH /tasks/7'], true, 0, false]);
});

test('a tick whose reply was lost is sent again with its key once flush finds the connection', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  lostOnce(v, 'PATCH', /^\/tasks\/7$/);
  const r = await app.act({ op: 'done', task: 7, run: null });
  assert.deepEqual([r.status, app.pending[0].sent, app.offline], ['offline', true, true]);
  await app.flush();
  const patches = v.requests.filter(q => q.method === 'PATCH');
  assert.deepEqual([v.requests[1].path, v.requests[2], patches[1].key, patches[1].replayed], ['/user', patches[1], patches[0].key, true]);
  assert.deepEqual([reached(v, 'PATCH', /^\/tasks\/7$/).length, v.task(7).done, sync.all(1).length], [1, true, 0]);
});
