// Tests for the ops in the outbox (src/js/ops/) and their sender (src/js/app/acts.js), against a fake Vikunja behind
// the plugin's relay.
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from '../../src/js/ops/index.js';
import acts, { stageContext } from '../../src/js/app/acts.js';
import tasks, { copyOf, started, TASK, TASK_REACTIONS_COMMENTS } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import { CANCEL, sync, uuid7 } from '../../src/js/sync.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { UNKNOWN } from '../../src/js/messages.js';
import { figure } from '../../src/js/ops/stages.js';

const FIELDS = ['apply', 'stages', 'invert', 'merge', 'text', 'refused', 'dropped'];

test('every op has every field, and only invert and merge may be empty', () => {
  for (const [name, op] of Object.entries(OPS)) {
    for (const f of FIELDS) assert.ok(f in op, `${name} has ${f}`);
    for (const f of ['apply', 'text', 'refused', 'dropped']) assert.equal(typeof op[f], 'function', `${name}.${f}`);
    assert.ok(op.stages.length && op.stages.every(s => typeof s === 'function'), `${name} has its requests`);
    assert.ok(!('on' in op) || typeof op.on === 'function', `${name}.on`);
  }
});

test('apply returns the task as a new object, and leaves the task and the op alone', () => {
  const task = { id: 4, title: 'Unlock the door', done: false, percent_done: 0.25, assignees: [{ id: 2 }], reactions: {}, comments: [] }, was = structuredClone(task);
  for (const [name, op] of Object.entries(OPS)) {
    const a = { id: 'e1', op: name, task: 4, user: 1, pct: 50, ids: [4], at: '2026-10-15T09:00:00.000Z', html: '<p>Done</p>' }, before = structuredClone(a), out = op.apply(task, a);
    assert.notEqual(out, task, name);
    assert.deepEqual([task, a], [was, before], `${name} changed nothing it was given`);
  }
  assert.deepEqual([OPS.done.apply(task, { user: 1 }).done, OPS.undone.apply({ ...task, done: true }, { user: 1 }).done, OPS.progress.apply(task, { pct: 50 }).percent_done], [true, false, 0.5]);
  assert.deepEqual(OPS.claim.apply(task, { user: 1 }).assignees.map(u => u.id), [2, 1]);
  assert.deepEqual(OPS.unclaim.apply(task, { user: 2 }).assignees, []);
});

/* Each op shows itself through its apply: the task as it will be once Vikunja has made the change. A row shows it while
   the op waits, and Vikunja's copy takes it when the op is answered. */
test('each op\'s apply shows its change: a tick with the user\'s ✅, a skip with ⏭️, a comment marked waiting, a claim with the claimer\'s name', () => {
  const me = { id: 1, username: 'alex', name: 'Alex' }, priya = { id: 2, username: 'priya' }, at = '2026-10-15T09:00:00.000Z', NONE = '0001-01-01T00:00:00Z';
  const step = { id: 4, title: 'Unlock the door', done: false, done_at: NONE, reactions: { '✅': [priya] }, comments: [{ id: 7, comment: '<p>Key under the mat</p>', author: priya }], assignees: [] };
  const a = (op, more = {}) => ({ id: 'e-' + op, op, task: 4, user: 1, who: me, at, ...more });
  const done = OPS.done.apply(step, a('done'));
  assert.deepEqual([done.done, done.done_at, done.reactions['✅'], done.reactions['⏭️'], done.comments.length], [true, at, [priya, me], [], 1], 'done at the op\'s time, with a ✅');
  const skipped = OPS.skip.apply(done, a('skip', { html: '<p>Skipped: no key</p>' }));
  assert.deepEqual([skipped.reactions['✅'], skipped.reactions['⏭️'], skipped.comments.at(-1)], [[priya], [me], { id: 'e-skip', comment: '<p>Skipped: no key</p>', author: me, created: at, waiting: true }],
    'a skip takes the user\'s ✅ off, puts a ⏭️ on and adds its comment, marked waiting');
  const undone = OPS.undone.apply(skipped, a('undone'));
  assert.deepEqual([undone.done, undone.done_at, undone.reactions['✅'], undone.reactions['⏭️']], [false, NONE, [priya], []], 'not done: only the user\'s own ✅ and ⏭️ go');
  assert.deepEqual(OPS.doneNote.apply(step, a('doneNote', { html: '<p>Done early</p>' })).comments.map(c => [c.comment, !!c.waiting]), [['<p>Key under the mat</p>', false], ['<p>Done early</p>', true]]);
  for (const op of ['note', 'answer']) assert.deepEqual(OPS[op].apply(step, a(op, { html: '<p>7 °C</p>' })).comments.at(-1).author, me, op);
  const listed = { id: 4, title: 'Unlock the door', done: false };
  assert.deepEqual(OPS.doneNote.apply(listed, a('doneNote', { html: '<p>Done early</p>' })), { ...listed, done: true, done_at: at },
    'a task read without its reactions and comments gets neither, or one ✅ would read as the only one');
  assert.deepEqual([OPS.claim.apply(step, a('claim')).assignees, OPS.claim.apply(step, { user: 1 }).assignees], [[me], [{ id: 1 }]],
    'a claim adds the claimer with their name, or only their id for an entry queued before Pocket kept it');
  assert.deepEqual([OPS.progress.apply(step, a('progress', { pct: 40 })).percent_done, OPS.finish.apply(step).done, OPS.reopen.apply(done).done], [0.4, true, false]);
  const van = { id: 1, related_tasks: { subtask: [{ id: 4 }, { id: 5 }] } }, del = a('delete', { ids: [6, 4], up: 1 });
  assert.deepEqual([OPS.delete.apply(van, del).related_tasks.subtask, OPS.delete.on(del)], [[{ id: 5 }], [6, 4, 1]], 'a delete takes its tasks off the parent that stays');
});

/* A deleted subtask's last stage writes its parent's progress. When a waiting delete deletes the parent too, the
   stage leaves it alone. Swiping a subtask on Today and then its parent did this. */
test('a deleted subtask\'s figure stage skips a parent that a waiting delete deletes', async () => {
  const v = fakeVikunja([{ id: 1, title: 'Pack the van', related_tasks: { subtask: [{ id: 3 }] } }]), app = component(tasks);
  app.pending = [{ kind: 'act', op: 'delete', id: 'd1', task: 1, ids: [1], items: [] }]; app.change(w => w.keyOps());
  const a = { id: 'd2', op: 'delete', task: 2, ids: [2], up: 1, stage: 1 };
  await figure(a, stageContext(a, app).start());
  assert.deepEqual(v.requests, [], 'the parent is neither read nor written');
});

/* Each op's words, as the outbox said them before the ops had words of their own: its row in the Outbox, what a
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
  add: [['New task: Unlock the door T#5m', 'Adding “Unlock the door T#5m”', '', ''], ['New task: ', 'Adding a task', '', '']],
  due: [['Removed its due date: Unlock the door', 'Moving “Unlock the door T#5m”', '', ''], ['Removed its due date: a step', 'Moving a task', '', '']],
};

test('each op says what the outbox said before: its row, its refusal, and what dropping it leaves', () => {
  assert.deepEqual(Object.keys(WORDS).sort(), Object.keys(OPS).sort());
  for (const [name, op] of Object.entries(OPS)) ['Unlock the door T#5m', ''].forEach((title, k) => {
    const a = stage => ({ op: name, task: 1, stage, pct: 40, ids: [3, 2, 1], html: '' });
    assert.deepEqual([op.text(a(0), title), op.refused(a(0), title), op.dropped(a(0), title), op.dropped(a(1), title)], WORDS[name][k], `${name}, title "${title}"`);
  });
  assert.equal(OPS.done.text({ op: 'done' }, 'Mop', true), 'Done: Mop (repeated)', 'a step repeated in its checklist says so');
  assert.deepEqual([OPS.add.text({ over: 'Pack the van' }, 'Chairs'), OPS.add.text({ taskId: 4 }, 'Chairs')],
    ['Subtask of “Pack the van”: Chairs', 'Finishing “Chairs”'], 'a line says what it goes under, as the Outbox said before');
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(9, 0, 0, 0); return d; };
  assert.deepEqual([OPS.due.text({ due: day(0).toISOString() }, 'Mop'), OPS.due.text({ due: day(1).toISOString() }, 'Mop'), OPS.due.text({ due: day(9).toISOString() }, 'Mop')],
    ['Moved to today: Mop', 'Moved to tomorrow: Mop', `Moved to ${day(9).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: day(9).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}: Mop`],
    'a move names its day as the message after a hold does');
});

/* The sender with a fake outbox. Each act is queued with act() and sent at once. Messages are read from `toasts`, since
   `toast` here is the component's own toast, which act() reads. */
const sender = (t, list) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(list), app = component(tasks, acts, sending, outbox, runs);
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], slow: [], flushing: false, cap: {}, sheet: { id: null, sub: {} },
    view: { groups: [], shownRun: null }, places: {}, endPlace(){}, aimSent(){}, positionSent(){} });
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
  assert.equal(app.toasts.at(-1).msg, 'A tick on “Wipe the till” may not have reached Vikunja.');
  // Its Outbox button opens the Outbox and sends nothing, because the user checks Vikunja first.
  let opened = null;
  app.openSheet = kind => { opened = kind; };
  const sent = v.requests.length;
  app.toasts.at(-1).action.fn();
  assert.deepEqual([app.toasts.at(-1).action.label, opened, v.requests.length], ['Outbox', 'outbox', sent]);
  assert.equal(app.outboxRows[0].failed, 'Vikunja may or may not have this change. Check, then tap Try again if it\'s missing.');
  assert.ok(!v.task(7).done, 'the change wasn\'t made');
  const first = v.requests.find(q => q.method === 'PATCH').key;
  v.trouble = () => null;
  await app.retryAct(app.failed[0].id);
  const again = v.requests.filter(q => q.method === 'PATCH').at(-1).key;
  assert.notEqual(again.split(':')[0], first.split(':')[0], 'the key is new');
  assert.deepEqual([again.split(':').slice(1), v.task(7).done, sync.all(1).length], [['0', '0'], true, 0]);
});

test('a refused change kept to try again, and a change held behind it, each have a button that opens the Outbox', async t => {
  t.after(async () => { for (const x of sync.all(1)) await sync.remove(x.id); });
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  const kept = app.toasts.at(-1);
  await app.act({ op: 'progress', task: 7, pct: 50, run: null, label: 'Wipe the till' });
  const held = app.toasts.find(x => /^Not sent/.test(x.msg));
  assert.deepEqual([kept.msg, kept.action?.label], ['A tick on “Wipe the till” couldn\'t be saved: HTTP 403 from the fake. It\'s kept to try again.', 'Outbox']);
  assert.deepEqual([held.msg, held.action?.label], ['Not sent. Vikunja refused an earlier change to “Wipe the till”.', 'Outbox']);
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
    assert.deepEqual(app.outboxRows[0].drop, ['dropAct', app.pending[0].id], 'the Outbox offers Don\'t send it');
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

/* What a finished stage got from Vikunja is kept in the entry, as a body built once is. A tick with a comment whose
   last stage is cut off is sent again in a new try, and its answer still has the comment Vikunja made and Vikunja's
   copy of the step. */
test('a tick with a comment that finishes on a later try still answers with the comment and the step Vikunja made', async t => {
  const { v, app } = sender(t, [{ id: 1, title: 'Closing', related_tasks: { subtask: [{ id: 2 }] } }, { id: 2, title: 'Mop the floor', done: false, comments: [], reactions: {} }]);
  app.change(w => w.read([{ id: 2, title: 'Mop the floor', done: false, comments: [], reactions: {}, updated: 'before' }], TASK_REACTIONS_COMMENTS, started()));
  let cut = true;
  v.trouble = r => r.method === 'GET' && r.path === '/tasks/1' && cut ? (cut = false, 'offline') : null;
  const r = await app.act({ op: 'doneNote', task: 2, run: 1, html: '<p>Bucket is in the shed</p>' });
  assert.deepEqual([r.status, app.pending[0].stage], ['offline', 3], 'the tick, its ✅ and its comment are sent, and the progress is not');
  await app.sendActs(app.pending[0].id);
  assert.equal(sync.all(1).length, 0);
  const posted = v.task(2).comments[0];
  assert.deepEqual([copyOf(2).comments.map(c => [c.id, !!c.waiting]), copyOf(2).updated], [[[posted.id, false]], v.task(2).updated]);
});

/* Moving a task to another date (ops/dates.js). A move is a `due` op. Its Undo is an op too, made from what the move
   recorded, which checks Vikunja's date before it writes the old one back. `dated` gives a sender whose tasks have rows
   and copies, and `move` queues a move as reschedule does. */
const D = (d, h = 9) => new Date(2026, 9, d, h).toISOString();
const dated = (t, list) => {
  const s = sender(t, list);
  s.app.change(w => w.read(list.map(x => structuredClone(x)), TASK, started()));
  for (const x of list) s.app.row(structuredClone(x));
  t.after(async () => { for (const x of sync.all(1)) await sync.remove(x.id); });
  return s;
};
const move = (app, task, due) => { const f = { id: uuid7(), op: 'due', task, was: app.tasks[task].due_date, due, run: null }; return { f, sending: app.act(f, true) }; };
const datePatches = v => reached(v, 'PATCH', /^\/tasks\/\d+$/).map(r => r.body.due_date);

test('a move sets the date, its Undo goes back to the date before, and a later move takes the place of one not sent', () => {
  const a = { op: 'due', task: 7, was: D(5), due: D(9) };
  assert.deepEqual(OPS.due.apply({ id: 7, title: 'Call the plumber', due_date: D(5) }, a), { id: 7, title: 'Call the plumber', due_date: D(9) });
  assert.deepEqual(OPS.due.invert(a), { op: 'due', task: 7, due: D(5), was: D(9), check: D(9) }, 'before Vikunja answers, the Undo checks for the date sent');
  assert.equal(OPS.due.invert({ ...a, got: { task: { due_date: '2026-10-09T13:00:00Z' } } }).check, '2026-10-09T13:00:00Z', 'once it answers, for the date Vikunja stored');
  assert.deepEqual(OPS.due.merge(a, { ...a, was: D(9), due: D(12) }), { ...a, was: D(5), due: D(12) }, 'the later move keeps the first move\'s date before');
  assert.equal(OPS.due.merge({ op: 'done', task: 7 }, a), null, 'a move replaces only a move');
});

test('an Undo of a move not sent yet takes the move out of the outbox, and nothing is sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  const { f, sending } = move(app, 7, D(9));
  assert.equal(app.tasks[7].due_date, D(9), 'the row moves at once');
  assert.equal((await sending).status, 'offline');
  assert.deepEqual([sync.all(1).length, app.waiting.dues[7]], [1, true], 'the move waits, and its row shows it is waiting');
  const { left } = await app.undoOps([f]);
  assert.equal(app.tasks[7].due_date, D(5), 'the row goes back at once');
  assert.deepEqual([await left, app.tasks[7].due_date, sync.all(1).length, app.waiting.dues[7]], [0, D(5), 0, undefined]);
  assert.deepEqual(v.requests, [], 'nothing is sent');
});

test('two moves made offline on one task send one request, and the second\'s Undo returns the task to its first date', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  const first = move(app, 7, D(8));
  await first.sending;
  const second = move(app, 7, D(9));
  await second.sending;
  assert.deepEqual(sync.all(1).map(e => [e.was, e.due]), [[D(5), D(9)]], 'one entry, from the first date to the last');
  assert.equal(app.tasks[7].due_date, D(9));
  app.offline = false;
  await app.flush();
  assert.deepEqual([datePatches(v), v.task(7).due_date], [[D(9)], D(9)]);
  // The second move is a change to the date since the first, so the first move's Undo leaves it.
  let undo = await app.undoOps([first.f]);
  assert.equal(app.tasks[7].due_date, D(9));
  assert.deepEqual([await undo.left, v.task(7).due_date, datePatches(v)], [1, D(9), [D(9)]], 'it counts as changed since, and nothing is sent');
  undo = await app.undoOps([second.f]);
  assert.equal(app.tasks[7].due_date, D(5), 'the second move\'s Undo shows the first date at once');
  assert.deepEqual([await undo.left, v.task(7).due_date, datePatches(v)], [0, D(5), [D(9), D(5)]]);
});

test('the Undo of a move that replaced another goes back to the first date, also when another tab sent it', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  app.offline = true;
  await move(app, 7, D(8)).sending;
  const second = move(app, 7, D(9));
  await second.sending;
  // Another tab sends the move. Vikunja has its date, and it leaves the outbox without this tab seeing the answer.
  v.task(7).due_date = D(9);
  for (const x of sync.all(1)) await sync.remove(x.id);
  app.offline = false;
  const { left } = await app.undoOps([second.f]);
  assert.deepEqual([await left, v.task(7).due_date], [0, D(5)]);
});

test('an Undo never folds into a move, and a move never folds into an Undo or past one', async t => {
  const { app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const m = move(app, 7, D(8));
  await m.sending;
  app.offline = true;
  await move(app, 7, D(9)).sending;
  const { left } = await app.undoOps([m.f]);
  await left;
  await move(app, 7, D(12)).sending;
  assert.deepEqual(sync.all(1).map(e => [e.due, !!e.undo]), [[D(9), false], [D(5), true], [D(12), false]], 'the Undo keeps its check, and is checked after the move before it');
});

test('a move that has sent a request, or is held, is not replaced by a later move', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }, { id: 8, title: 'Order milk', due_date: D(5) }]);
  lostOnce(v, 'PATCH', /^\/tasks\/7$/);
  assert.equal((await move(app, 7, D(8)).sending).status, 'offline', 'the reply to the first move is lost');
  await move(app, 7, D(9)).sending;
  assert.deepEqual([datePatches(v), v.task(7).due_date, sync.all(1).length], [[D(8), D(9)], D(9), 0], 'both moves are sent, in order');
  // A move Vikunja refused stays in the Outbox, and holds back the later move.
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await move(app, 8, D(8)).sending;
  await move(app, 8, D(9)).sending;
  assert.deepEqual(sync.all(1).map(e => [e.due, !!e.failed]), [[D(8), true], [D(9), false]]);
  // A move held until a time, as a deletion is held while Restore shows in another tab.
  for (const x of sync.all(1)) await sync.remove(x.id);
  app.offline = true;
  const held = move(app, 8, D(8));
  await held.sending;
  await sync.save({ ...sync.entries.get(held.f.id), until: Date.now() + 60e3 });
  await move(app, 8, D(9)).sending;
  assert.deepEqual(sync.all(1).map(e => e.due), [D(8), D(9)]);
});

test('an Undo puts the date back after a change to another field, and leaves a date changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5), comments: [] }]);
  let m = move(app, 7, D(9));
  await m.sending;
  // Another person changes the title and comments. Vikunja's date is written in another format, at the same time.
  Object.assign(v.task(7), { title: 'Call the plumber today', comments: [{ id: 1, comment: 'Done by noon' }], due_date: D(9).replace('.000Z', 'Z') });
  let undo = await app.undoOps([m.f]);
  assert.deepEqual([await undo.left, v.task(7).due_date, v.task(7).title], [0, D(5), 'Call the plumber today'], 'the date goes back, and the title stays');
  m = move(app, 7, D(9));
  await m.sending;
  v.task(7).due_date = D(12);
  const sent = datePatches(v).length;
  undo = await app.undoOps([m.f]);
  assert.equal(app.tasks[7].due_date, D(5), 'the row goes back at once');
  assert.deepEqual([await undo.left, datePatches(v).length, v.task(7).due_date, app.tasks[7].due_date], [1, sent, D(12), D(12)],
    'a date changed since is left alone, nothing is sent, and the row shows Vikunja\'s date');
  // An Undo made offline is checked when it is sent, and says so then.
  m = move(app, 7, D(14));
  await m.sending;
  app.offline = true;
  undo = await app.undoOps([m.f]);
  assert.equal(await undo.left, 0, 'the Undo waits');
  v.task(7).due_date = D(15);
  app.offline = false;
  await app.flush();
  assert.deepEqual([v.task(7).due_date, app.toasts.at(-1).msg], [D(15), 'Not undone: “Call the plumber today” has changed since then'], 'the title is Vikunja\'s, as the Undo read it');
});

test('an Undo of a move whose answer is unknown puts the date back if the move arrived, and sends nothing if it didn\'t', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }, { id: 8, title: 'Order milk', due_date: D(5) }]);
  v.trouble = r => r.method === 'PATCH' ? 'unknown' : null;
  const arrived = move(app, 7, D(9)), lost = move(app, 8, D(9));
  assert.deepEqual([(await arrived.sending).error.code, (await lost.sending).error.code, app.failed.length], ['unknown', 'unknown', 2]);
  v.trouble = () => null;
  v.task(7).due_date = D(9);
  const sent = datePatches(v).length, { left } = await app.undoOps([arrived.f, lost.f]);
  assert.deepEqual([await left, v.task(7).due_date, v.task(8).due_date, datePatches(v).slice(sent)], [0, D(5), D(5), [D(5)]], 'only the move that arrived is sent back');
  assert.deepEqual([sync.all(1).length, app.failed.length], [0, 0], 'neither move stays in the Outbox');
});

test('an Undo of a move on a task deleted since leaves the outbox, and counts as changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const m = move(app, 7, D(9));
  await m.sending;
  v.tasks.delete(7);
  const { left } = await app.undoOps([m.f]);
  assert.deepEqual([await left, sync.all(1).length, app.failed.length], [1, 0, 0]);
});

/* Two made-up ops show what fold does for any op. `off` cancels an `on` before it, as an untick cancels a tick, and
   `on` names its own key in `waiting`. */
test('a new op meets any earlier op on its task, and can cancel it, so both leave the outbox', async t => {
  const op = (merge, waiting) => ({ apply: x => ({ ...x }), stages: [async () => {}], invert: null, merge, waiting, text: () => '', refused: () => '', dropped: () => '' });
  Object.assign(OPS, { on: op(null, 'ons'), off: op((older, newer) => older.op === 'on' ? CANCEL : null) });
  t.after(() => { delete OPS.on; delete OPS.off; for (const x of sync.all(1)) sync.remove(x.id); });
  const { v, app } = sender(t, [{ id: 7, title: 'Call the plumber' }]);
  app.row(v.task(7));
  app.offline = true;
  await app.act({ op: 'on', task: 7, run: null });
  assert.deepEqual([sync.all(1).length, app.waiting.ons[7]], [1, true], 'the op\'s own key marks its row as waiting');
  await app.act({ op: 'off', task: 7, run: null });
  assert.deepEqual([sync.all(1).length, app.waiting.ons[7]], [0, undefined], 'nothing is left to send');
});
