// Tests for the ops in the outbox (src/js/ops/) and their sender (src/js/app/acts.js), against a fake Vikunja behind
// the plugin's relay.
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addLines, cancelOf, COMMON, DEFAULTS, opOf, OPS, refusalOf, SENT, stageView } from '../../src/js/ops/index.js';
import acts, { heldTasks, stageContext, waits } from '../../src/js/app/acts.js';
import tasks, { copyOf, started, TASK, TASK_REACTIONS_COMMENTS } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import sheet from '../../src/js/app/sheet.js';
import { CANCEL, sync, uuid7 } from '../../src/js/sync.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { UNKNOWN } from '../../src/js/messages.js';
import { figure } from '../../src/js/ops/stages.js';
import { ZERO } from '../../src/js/util.js';

const FIELDS = ['apply', 'stages', ...Object.keys(DEFAULTS), 'text', 'refused', 'dropped'];

/* An op sets every field, to its own value or to null for the default, so a new op decides each one. The comment on OPS
   names every field, since it is where a new op is made from. */
test('every op defines every field, null for the default, and the comment on OPS names each', () => {
  for (const [name, op] of Object.entries(OPS)) {
    for (const f of FIELDS) assert.ok(f in op, `${name} has ${f}`);
    for (const f of ['apply', 'text', 'refused', 'dropped']) assert.equal(typeof op[f], 'function', `${name}.${f}`);
    const stages = typeof op.stages === 'function' ? op.stages({ set: {} }) : op.stages;
    assert.ok(stages.length && stages.every(s => typeof s === 'function'), `${name} has its requests`);
    const full = opOf({ op: name });
    for (const f of ['on', 'answered', 'holds', 'waitsOn', 'row', 'files', 'deletes']) assert.equal(typeof full[f], 'function', `${name}.${f}`);
    // A refusal and a Cancel may depend on the entry, here one whose task isn't made yet and one whose task is.
    for (const a of [{ op: name }, { op: name, taskId: 4 }])
      assert.deepEqual([typeof full.keepReads, ['kept', 'back', 'lines', 'undone'].includes(refusalOf(a)), ['undo', 'text', 'back', 'lines', 'made'].includes(cancelOf(a))], ['boolean', true, true], name);
    assert.ok(Array.isArray(op.asks) && Array.isArray(op.saw), `${name} declares asks and saw`);
    assert.deepEqual(op.asks.filter(k => op.saw.includes(k)), [], `${name}: no field is in both asks and saw`);
    assert.deepEqual([...op.asks, ...op.saw].filter(k => COMMON.includes(k) || SENT.includes(k)), [], `${name}: asks and saw leave out the fields every entry has`);
  }
  const comment = readFileSync(new URL('../../src/js/ops/index.js', import.meta.url), 'utf8').split('*/')[0];
  for (const f of FIELDS) assert.match(comment, new RegExp(`^ +- (\\w+, )*${f}\\b`, 'm'), `the comment on OPS names ${f}`);
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
  assert.deepEqual([OPS.progress.apply(step, a('progress', { pct: 40 })).percent_done, OPS.finish.apply(step, a('finish')).done, OPS.reopen.apply(done, a('reopen')).done], [0.4, true, false]);
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
   refusal calls it, and what Cancel leaves in Vikunja before and after its first request. The first row of each
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
  note: [['A comment on “Unlock the door”', 'A comment on “Unlock the door”', 'Your comment is back where you typed it.', 'Your comment is back where you typed it.'],
    ['A comment on “a step”', 'A comment', 'Your comment is back where you typed it.', 'Your comment is back where you typed it.']],
  answer: [['Unlock the door', 'Answers on “Unlock the door”', 'Your answer to “Unlock the door” isn\'t saved.', 'Your answer to “Unlock the door” isn\'t saved.'],
    ['a step', 'Answers', 'Your answer to “it” isn\'t saved.', 'Your answer to “it” isn\'t saved.']],
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
  due: [['Removed its due date: Unlock the door', 'Moving “Unlock the door T#5m”', '“Unlock the door” stays without a date.', '“Unlock the door” stays without a date.'],
    ['Removed its due date: a step', 'Moving a task', '“it” stays without a date.', '“it” stays without a date.']],
  repeat: [['Doesn\'t repeat: Unlock the door', 'Changing how “Unlock the door” repeats', '“Unlock the door” still doesn\'t repeat.', '“Unlock the door” still doesn\'t repeat.'],
    ['Doesn\'t repeat: a step', 'Changing how a task repeats', '“it” still doesn\'t repeat.', '“it” still doesn\'t repeat.']],
};

test('each op says what the outbox said before: its row, its refusal, and what cancelling it leaves', () => {
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
  test(`a tick made while ${how} is not tried, and can be cancelled`, async t => {
    t.after(() => { delete navigator.onLine; });
    const { v, app, r } = await offlineTick(t, mark);
    await settle(t);
    assert.deepEqual([r.status, v.requests.filter(q => q.path !== '/user').length, app.pending[0].sent, app.offline], ['offline', 0, undefined, true]);
    assert.deepEqual(app.outboxRows[0].drop, ['dropAct', app.pending[0].id], 'the Outbox offers Cancel');
    await app.dropAct(app.pending[0].id);
    assert.deepEqual([sync.all(1).length, v.requests.filter(q => q.path !== '/user').length, v.task(7).done], [0, 0, undefined]);
  });

/* Cancel in the Outbox asks nothing. The change leaves the outbox at once, and the message says what Vikunja keeps.
   Its Undo puts the same entry back, with its key and in its place, and it is sent once. */
const offlineSender = t => {
  t.after(async () => { for (const x of sync.all(1)) await sync.remove(x.id); });
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const r = sender(t, [{ id: 7, title: 'Wipe the till' }, { id: 8, title: 'Pay the rent', due_date: today.toISOString() }, { id: 9, title: 'Lock up' }]);
  noConnection(r.app, r.v);
  const confirm = globalThis.confirm;
  globalThis.confirm = () => { throw new Error('Cancel asked'); };
  t.after(() => { globalThis.confirm = confirm; });
  return r;
};
const lastSaid = app => app.toasts.at(-1);
test('Cancel asks nothing, says what Vikunja keeps, and its Undo puts the entry back in its place with its key, sent once', async t => {
  const { v, app } = offlineSender(t);
  for (const f of [{ op: 'done', task: 7 }, { op: 'due', task: 8, was: v.task(8).due_date, due: '0001-01-01T00:00:00Z' }, { op: 'claim', task: 9 }])
    await app.act({ ...f, run: null, label: v.task(f.task).title });
  const [tick, move, claim] = sync.all(1), was = JSON.parse(JSON.stringify(move));
  await app.dropAct(move.id);
  assert.deepEqual(sync.all(1).map(e => e.id), [tick.id, claim.id], 'the move leaves at once');
  assert.deepEqual([lastSaid(app).msg, lastSaid(app).action.label, lastSaid(app).place], ['Cancelled. “Pay the rent” stays due today.', 'Undo', 'sheet:top']);
  await lastSaid(app).action.fn();
  assert.deepEqual(sync.all(1).map(e => e.id), [tick.id, move.id, claim.id], 'Undo puts it back where it was');
  assert.deepEqual(sync.all(1)[1], was, 'the same entry, with its key');
  assert.deepEqual(v.requests.filter(q => q.path !== '/user'), [], 'nothing is sent while offline');
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([reached(v, 'PATCH', /^\/tasks\/8$/).length, v.task(8).due_date, sync.all(1)], [1, '0001-01-01T00:00:00Z', []]);
});

test('Cancel\'s Undo does nothing once its message has gone', async t => {
  const { app } = offlineSender(t);
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  await app.dropAct(sync.all(1)[0].id);
  const said = lastSaid(app);
  said.gone();
  await said.action.fn();
  assert.deepEqual(sync.all(1), []);
});

/* The words each op says after Cancel are in WORDS above, and parse.mjs checks an answer's, which are read from HTML.
   A comment's text goes back to its box, so it has no Undo. Unit tests have no DOM, so these ops hold no HTML. */
test('Cancel offers Undo except for a comment, whose text goes back to its box', async t => {
  const { app } = offlineSender(t);
  const cancel = async f => {
    await app.act({ run: null, label: 'Wipe the till', task: 7, ...f });
    await app.dropAct(sync.all(1).at(-1).id);
    return [lastSaid(app).msg, lastSaid(app).action?.label ?? null];
  };
  assert.deepEqual(await cancel({ op: 'done' }), ['Cancelled. “Wipe the till” stays not done in Vikunja.', 'Undo']);
  assert.deepEqual(await cancel({ op: 'claim' }), ['Cancelled. You are not assigned to “Wipe the till”.', 'Undo']);
  assert.deepEqual(await cancel({ op: 'answer', html: '' }), ['Cancelled. Your answer to “Wipe the till” isn\'t saved.', 'Undo']);
  assert.deepEqual(await cancel({ op: 'note', html: '' }), ['Cancelled. Your comment is back where you typed it.', null]);
});

test('Cancel\'s Undo puts a refused change back as refused, to try again', async t => {
  const { v, app } = offlineSender(t);
  app.offline = false; v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  const [e] = app.failed;
  await app.dropAct(e.id);
  assert.deepEqual([app.failed, lastSaid(app).msg], [[], 'Cancelled. “Wipe the till” stays not done in Vikunja.']);
  await lastSaid(app).action.fn();
  assert.deepEqual([app.failed.map(x => [x.id, x.failed.message]), reached(v, 'PATCH', /^\/tasks\/7$/).length], [[[e.id, 'HTTP 403 from the fake']], 1]);
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
  const op = (merge, waiting) => ({ apply: x => ({ ...x }), stages: [async () => {}], asks: [], saw: ['label'], invert: null, merge, waiting, text: () => '', refused: () => '', dropped: () => '' });
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

/* The sheet's date and repeat (sheet.js) go through the outbox as a `due` and a `repeat` op. A template's date is when
   it next repeats, so a done template shows none, and taking its date off takes three requests (ops/dates.js).
   `sheeted` gives a sender with the sheet open on the first task. */
const sheeted = (t, list, role = null) => {
  const s = dated(t, list);
  Object.defineProperties(s.app, Object.getOwnPropertyDescriptors(sheet));
  Object.defineProperties(s.app, { checklistRole: { value: role, writable: true }, dueTime: { value: '09:00' } });
  Object.assign(s.app.sheet, { id: list[0].id, kind: 'task', open: true });
  return s;
};
const patches = (v, id) => reached(v, 'PATCH', new RegExp(`^/tasks/${id}$`)).map(r => r.body);
const WEEKLY = { repeat_after: 604800, repeat_mode: 0 }, DAILY = { repeat_after: 86400, repeat_mode: 0 }, NEVER = { repeat_after: 0, repeat_mode: 0 };

test('a repeat sets its fields, its Undo goes back to what each had, and a later repeat takes the place of one not sent', () => {
  const a = { op: 'repeat', task: 7, set: { ...WEEKLY, due_date: D(9) }, was: { ...NEVER, due_date: ZERO } };
  assert.deepEqual(OPS.repeat.apply({ id: 7, title: 'Water the plants', ...NEVER, due_date: ZERO }, a), { id: 7, title: 'Water the plants', ...WEEKLY, due_date: D(9) });
  assert.deepEqual(OPS.repeat.invert(a), { op: 'repeat', task: 7, set: a.was, was: a.set, check: a.set }, 'before Vikunja answers, the Undo checks for the values sent');
  assert.equal(OPS.repeat.invert({ ...a, got: { task: { ...WEEKLY, due_date: '2026-10-09T13:00:00Z' } } }).check.due_date, '2026-10-09T13:00:00Z', 'once it answers, for the values Vikunja stored');
  assert.deepEqual(OPS.repeat.merge(a, { op: 'repeat', task: 7, set: DAILY, was: WEEKLY }), { op: 'repeat', task: 7, set: { ...DAILY, due_date: D(9) }, was: { ...NEVER, due_date: ZERO } },
    'the fields of both, each with the first value before');
  assert.deepEqual([OPS.repeat.merge({ op: 'due', task: 7, was: D(5), due: D(9) }, a), OPS.due.merge(a, { op: 'due', task: 7, was: D(5), due: D(9) })], [null, null], 'a repeat and a move never fold into each other');
  assert.deepEqual([OPS.repeat.text(a, 'Water the plants'), OPS.repeat.text({ set: { repeat_mode: 1 } }, 'Water the plants'), OPS.repeat.dropped(a, 'Water the plants')],
    ['Repeats every week: Water the plants', 'Repeats every month: Water the plants', '“Water the plants” still doesn\'t repeat.']);
  assert.equal(OPS.repeat.dropped({ ...a, was: WEEKLY }, 'Water the plants'), '“Water the plants” still repeats every week.', 'Cancel names the repeat it had before');
});

test('a template\'s date taken off makes it done and keeps its repeat, and its Undo gives the date back, not done', () => {
  const off = { op: 'due', task: 7, tpl: true, was: D(9), due: ZERO, done: true }, on = { op: 'due', task: 7, tpl: true, was: ZERO, due: D(9), done: false };
  assert.deepEqual(OPS.due.apply({ id: 7, title: 'TEMPLATE: Closing', ...DAILY, due_date: D(9), done: false }, off), { id: 7, title: 'TEMPLATE: Closing', ...DAILY, due_date: ZERO, done: true });
  assert.deepEqual(OPS.due.invert(off), { op: 'due', task: 7, due: D(9), was: ZERO, check: ZERO, tpl: true, done: false });
  assert.deepEqual(OPS.due.invert(on), { op: 'due', task: 7, due: ZERO, was: D(9), check: D(9), tpl: true, done: true });
  assert.deepEqual(OPS.due.merge(on, { op: 'due', task: 7, tpl: true, was: D(9), due: D(10) }), { op: 'due', task: 7, tpl: true, was: ZERO, due: D(10), done: false },
    'a later date keeps the first move\'s done, because the template is still done in Vikunja');
});

test('the sheet shows a new date and repeat at once, offline, and Vikunja gets each once, as two ops that don\'t fold', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false }]);
  app.offline = true;
  const dating = app.setDue(D(9));
  assert.deepEqual([app.dueShown, app.tasks[7].due_date], [D(9), D(9)], 'the sheet and the row show the date at once');
  const repeating = app.setRepeat('week');
  assert.deepEqual([app.repeatValue, app.tasks[7].repeat_after], ['week', 604800]);
  await dating; await repeating;
  assert.deepEqual(sync.all(1).map(e => e.op), ['due', 'repeat']);
  assert.deepEqual([app.waiting.dues[7], app.sheet.dirty], [true, true], 'the row shows it waits, and the screen is drawn again when the sheet closes');
  app.offline = false;
  await app.flush();
  assert.deepEqual([patches(v, 7), sync.all(1), app.dueShown, app.repeatValue], [[{ due_date: D(9) }, WEEKLY], [], D(9), 'week']);
});

test('a repeat picked for a task with no date gives it one, and a done template is then not done', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(5), ...NEVER, done: true }, { id: 8, title: 'Water the plants', due_date: ZERO, ...NEVER, done: false }], 'template');
  assert.equal(app.dueShown, ZERO, 'a done template shows no date');
  await app.setRepeat('day');
  const [body] = patches(v, 7);
  assert.deepEqual([Object.keys(body).sort(), body.done, app.tasks[7].done, v.task(7).repeat_after], [['done', 'due_date', 'repeat_after', 'repeat_mode'], false, false, 86400]);
  assert.match(app.toasts.find(x => x.place === 'sheet:due').msg, /^Pocket set the due date to .+, because a repeat needs one\./);
  app.checklistRole = null; app.sheet.id = 8;
  await app.setRepeat('week');
  assert.deepEqual([Object.keys(patches(v, 8)[0]).sort(), v.task(8).due_date !== ZERO, v.task(8).repeat_after], [['due_date', 'repeat_after', 'repeat_mode'], true, 604800],
    'a task that isn\'t a template gets a date, and nothing about done');
});

test('a template\'s date taken off offline sends its three requests once each, and a lost reply on the second finishes the same way', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false }], 'template');
  app.offline = true;
  await app.setDue(ZERO);
  assert.deepEqual([app.dueShown, app.tasks[7].done, app.repeatValue], [ZERO, true, 'day'], 'the sheet shows it done, with no date and its repeat, at once');
  let n = 0;
  v.trouble = r => r.method === 'PATCH' && 'due_date' in r.body && !n++ ? 'lost' : null;
  app.offline = false;
  await app.flush();
  assert.equal(sync.all(1)[0]?.stage, 1, 'the reply to the second request is lost');
  await app.flush();
  const sent = v.requests.filter(r => r.method === 'PATCH');
  assert.deepEqual(patches(v, 7), [NEVER, { due_date: ZERO, done: true }, DAILY], 'each request reaches Vikunja once');
  assert.deepEqual([sent.length, sent[2].key, sent[2].replayed], [4, sent[1].key, true], 'the second is sent again with its key');
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after, sync.all(1)], [true, ZERO, 86400, []]);
  // Giving it a date again is one request, which makes it not done.
  await app.setDue(D(10));
  assert.deepEqual([patches(v, 7).at(-1), v.task(7).done, app.dueShown], [{ due_date: D(10), done: false }, false, D(10)]);
});

test('an Undo of a repeat puts back each field still as the repeat left it, and leaves one changed since', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'Water the plants', due_date: ZERO, ...NEVER, done: false }]);
  const f = { id: uuid7(), op: 'repeat', task: 7, set: { ...WEEKLY, due_date: D(9) }, was: { ...NEVER, due_date: ZERO }, run: null };
  await app.act(f, true);
  v.task(7).due_date = D(12);
  const { left } = app.undoOps([f]);
  assert.deepEqual([await left, patches(v, 7).at(-1), v.task(7).due_date, app.tasks[7].due_date], [1, NEVER, D(12), D(12)], 'the repeat goes back, and the date changed since stays');
});

/* A row shows the waiting ops on top of Vikunja's copy, so what it shows can differ from what Vikunja has when an op
   is sent: a repeat changed in the web app, a waiting op cancelled. A body that depends on Vikunja's copy is built from
   one read when it is first sent. */
test('a template\'s date taken off puts back the repeat Vikunja has when it is sent, and is one request when Vikunja\'s copy doesn\'t repeat', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false }, { id: 8, title: 'TEMPLATE: Opening', due_date: D(10), ...NEVER, done: false }], 'template');
  noConnection(app, v);
  await app.setDue(ZERO);
  Object.assign(v.task(7), WEEKLY);                                       // changed in the web app while it waits
  // A repeat picked for the other template shows on its row. Cancelled, it never reaches Vikunja.
  app.sheet.id = 8;
  await app.setRepeat('day');
  await app.setDue(ZERO);
  await app.dropAct(sync.all(1).find(e => e.op === 'repeat').id);
  await settle(t);                                                        // the flush Cancel starts finds no connection
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([patches(v, 7), v.task(7).repeat_after], [[NEVER, { due_date: ZERO, done: true }, WEEKLY], 604800]);
  assert.deepEqual([patches(v, 8), v.task(8).repeat_after, v.task(8).done], [[{ due_date: ZERO, done: true }], 0, true]);
});

test('a repeat sets a date only when Vikunja\'s copy has none when it is sent', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false }]);
  noConnection(app, v);
  await app.setDue(ZERO);
  await app.setRepeat('week');
  assert.match(app.toasts.find(x => x.place === 'sheet:due')?.msg, /^Pocket set the due date to /, 'the sheet says which date it set, while the repeat waits');
  // The date taken off is cancelled, so Vikunja still has the date.
  await app.dropAct(sync.all(1).find(e => e.op === 'due').id);
  await settle(t);
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual([patches(v, 7), v.task(7).due_date], [[WEEKLY], D(5)]);
});

test('a date or a repeat that Vikunja refuses, or may not have, says so under the sheet\'s date until the sheet closes', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'Water the plants', due_date: D(5), ...NEVER, done: false }, { id: 8, title: 'Feed the cat', due_date: D(5), ...NEVER, done: false }]);
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await app.setDue(D(9));
  const said = () => { const x = app.toasts.at(-1); return [x.msg, x.place, x.ms, x.action?.label]; };
  assert.deepEqual(said(), ['Moving “Water the plants” couldn\'t be saved: HTTP 403 from the fake. It\'s kept to try again.', 'sheet:due', null, 'Outbox']);
  assert.equal(app.dueShown, D(5), 'the sheet shows the date Vikunja has');
  v.trouble = r => r.method === 'PATCH' ? 'unknown' : null;
  app.sheet.id = 8;
  await app.setRepeat('week');
  assert.deepEqual(said(), ['Changing how “Feed the cat” repeats may not have reached Vikunja.', 'sheet:due', null, 'Outbox']);
});

test('Cancel of a change whose answer is unknown doesn\'t say what Vikunja has, and a move names both dates', async t => {
  const { v, app } = offlineSender(t);
  app.offline = false; v.trouble = r => r.method === 'PATCH' ? 'unknown' : null;
  await app.act({ op: 'due', task: 8, was: v.task(8).due_date, due: ZERO, run: null, label: 'Pay the rent' });
  await app.act({ op: 'done', task: 7, run: null, label: 'Wipe the till' });
  await app.dropAct(app.failed.find(e => e.op === 'due').id);
  assert.equal(lastSaid(app).msg, 'Cancelled. Vikunja may have “Pay the rent” due today or without a date.');
  await app.dropAct(app.failed.find(e => e.op === 'done').id);
  assert.equal(lastSaid(app).msg, 'Cancelled. Vikunja may or may not have this change.');
});

test('Cancel of a template\'s date taken off partway says its repeat is gone', async t => {
  const { v, app } = sheeted(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false }], 'template');
  v.trouble = r => r.method === 'PATCH' && 'due_date' in r.body ? 403 : null;
  await app.setDue(ZERO);
  assert.deepEqual([app.failed[0]?.stage, v.task(7).repeat_after], [1, 0], 'the repeat is off, and the date is refused');
  await app.dropAct(app.failed[0].id);
  assert.equal(lastSaid(app).msg, 'Cancelled. “TEMPLATE: Closing” no longer repeats, because its date was only partly removed. Set its repeat again in its sheet.');
});

test('a move is one stage, so its entry is saved once when sent and once when answered', async t => {
  const { app } = dated(t, [{ id: 7, title: 'Call the plumber', due_date: D(5) }]);
  const saves = t.mock.method(sync, 'save');
  await move(app, 7, D(9)).sending;
  assert.equal(saves.mock.callCount(), 2);
});

test('an Undo of a repeat that gave a done template a date leaves it done, by turning the repeat off before done is sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: D(5), ...NEVER, done: true }]);
  const f = { id: uuid7(), op: 'repeat', task: 7, set: { ...DAILY, due_date: D(9), done: false }, was: { ...NEVER, due_date: D(5), done: true }, run: null };
  await app.act(f, true);
  assert.deepEqual([v.task(7).done, v.task(7).repeat_after], [false, 86400]);
  const { left } = app.undoOps([f]);
  assert.deepEqual([await left, patches(v, 7).slice(1)], [0, [NEVER, { due_date: D(5), done: true }]]);
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after], [true, D(5), 0]);
});

test('an Undo retried with Try again puts back the repeat Vikunja had when the Undo was first sent', async t => {
  const { v, app } = dated(t, [{ id: 7, title: 'TEMPLATE: Closing', due_date: ZERO, ...DAILY, done: true }]);
  const f = { id: uuid7(), op: 'due', task: 7, tpl: true, was: ZERO, due: D(9), done: false, run: null };
  await app.act(f, true);
  Object.assign(v.task(7), WEEKLY);                                       // changed in the web app since
  let n = 0;
  v.trouble = r => r.method === 'PATCH' && 'due_date' in r.body && !n++ ? 403 : null;
  const { left } = app.undoOps([f]);
  assert.deepEqual([await left, v.task(7).repeat_after], [1, 0], 'the repeat is off, and taking the date off is refused');
  await app.retryAct(app.failed[0].id);
  const off = { due_date: ZERO, done: true };
  assert.deepEqual(patches(v, 7).slice(1), [NEVER, off, off, WEEKLY], 'the refused request, then the same one again and the repeat back');
  assert.deepEqual([v.task(7).done, v.task(7).due_date, v.task(7).repeat_after, sync.all(1)], [true, ZERO, 604800, []]);
});

/* Taking a template's date off turns its repeat off first. Its Undo puts back the repeat that first request read from
   Vikunja, so the template ends as it was, however far the change got. */
const TEMPLATE = id => ({ id, title: 'TEMPLATE: Closing', due_date: D(9), ...DAILY, done: false });
const dateOff = (app, task) => { const f = { id: uuid7(), op: 'due', task, tpl: true, was: D(9), due: ZERO, done: true, run: null }; return { f, sending: app.act(f, true) }; };
const asBefore = (v, id) => [v.task(id).due_date, v.task(id).done, v.task(id).repeat_after];
test('an Undo of a template\'s date taken off and refused partway puts back its date and its repeat', async t => {
  const { v, app } = dated(t, [TEMPLATE(6), TEMPLATE(7), TEMPLATE(8)]);
  // Vikunja refuses 6's first request (its repeat off), 7's second (its date off) and 8's third (its repeat back).
  const refused = { '/tasks/6': b => b.repeat_after === 0, '/tasks/7': b => 'due_date' in b, '/tasks/8': b => b.repeat_after > 0 };
  v.trouble = r => r.method === 'PATCH' && refused[r.path]?.(r.body) ? 403 : null;
  const offs = [6, 7, 8].map(id => dateOff(app, id));
  for (const o of offs) await o.sending;
  assert.deepEqual([app.failed.map(e => [e.task, e.stage]), [6, 7, 8].map(id => v.task(id).repeat_after)], [[[6, 0], [7, 1], [8, 2]], [86400, 0, 0]]);
  v.trouble = () => null;
  const { left } = app.undoOps(offs.map(o => o.f));
  assert.deepEqual([app.tasks[8].due_date, app.tasks[8].done, app.tasks[8].repeat_after], [D(9), false, 86400], 'the row shows the Undo at once');
  assert.equal(await left, 0);
  assert.deepEqual([6, 7, 8].map(id => asBefore(v, id)), [[D(9), false, 86400], [D(9), false, 86400], [D(9), false, 86400]]);
  assert.deepEqual([patches(v, 6).length, patches(v, 7).at(-1), patches(v, 8).at(-1), sync.all(1)], [1, DAILY, { due_date: D(9), done: false, ...DAILY }, []],
    'nothing is sent for 6, whose first request changed nothing, and each field still as the change left it is put back');
});

test('an Undo of a template\'s date taken off whose answer is unknown puts back the repeat if Vikunja made it, and sends nothing if not', async t => {
  const { v, app } = dated(t, [TEMPLATE(7), TEMPLATE(8)]);
  v.trouble = r => r.method === 'PATCH' && r.body.repeat_after === 0 ? 'unknown' : null;
  const offs = [7, 8].map(id => dateOff(app, id));
  for (const o of offs) await o.sending;
  assert.deepEqual(app.failed.map(e => [e.task, e.stage, e.failed.message]), [[7, 0, UNKNOWN], [8, 0, UNKNOWN]]);
  v.trouble = () => null;
  Object.assign(v.task(7), NEVER);                                         // Vikunja made 7's first request
  const { left } = app.undoOps(offs.map(o => o.f));
  assert.deepEqual([await left, asBefore(v, 7), asBefore(v, 8)], [0, [D(9), false, 86400], [D(9), false, 86400]]);
  assert.deepEqual([patches(v, 7).slice(1), patches(v, 8).slice(1), sync.all(1)], [[DAILY], [], []]);
});

/* A line refused after its task was made is kept in the Outbox, as any change is. `halfAdded` adds two lines in task
   9's subtask box, the second under the first. Vikunja refuses to put the first under task 9. */
const halfAdded = async t => {
  const { v, app } = sender(t, [{ id: 9, title: 'Pack the van', project_id: 5, related_tasks: {} }]);
  t.after(async () => { for (const x of sync.all(1)) await sync.remove(x.id); });
  v.trouble = r => r.path === '/tasks/9/relations' ? 403 : null;
  const line = (title, under = null) => ({ raw: title, p: { title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null, remind: false, done: false, pct: 0 }, under });
  const es = addLines([line('Load chairs'), line('Stack them', 0)], { parent: { id: 9, project_id: 5, title: 'Pack the van' } }).map(f => app.actEntry(f));
  return { v, app, es, r: await app.sendLines(es) };
};
const made = v => reached(v, 'POST', /^\/projects\/5\/tasks$/).map(r => r.body.title);
test('a line refused after its task was made stays in the Outbox, says it is added, and the line under it waits', async t => {
  const { v, app, r } = await halfAdded(t);
  assert.deepEqual([lastSaid(app).msg, lastSaid(app).action?.label], ['Adding “Load chairs” couldn\'t be saved in full (it\'s added): HTTP 403 from the fake. It\'s kept to try again.', 'Outbox']);
  assert.deepEqual([r.error, r.unsent], [undefined, []], 'the add box has nothing of its own to say, and nothing goes back to it');
  assert.deepEqual(app.outboxRows.map(x => [x.text, x.failed, x.retry, x.drop?.[0]]),
    [['Finishing “Load chairs”', 'Vikunja refused it: HTTP 403 from the fake', true, 'dropAct'], ['Subtask of “Load chairs”: Stack them', '', false, 'cancelPending']]);
  assert.deepEqual(made(v), ['Load chairs']);
});

test('Try again of a line whose task was made sends only the stages left, then the line under it', async t => {
  const { v, app, es } = await halfAdded(t);
  v.trouble = () => null;
  await app.retryAct(es[0].id);
  assert.deepEqual([made(v), reached(v, 'POST', /\/relations$/).map(r => r.path), sync.all(1)], [['Load chairs', 'Stack them'], ['/tasks/9/relations', '/tasks/9/relations', '/tasks/101/relations'], []]);
});

test('Cancel of a line whose task was made leaves the task in Vikunja, offers no Undo, and sends the line under it under that task', async t => {
  const { v, app, es } = await halfAdded(t);
  v.trouble = () => null;
  await app.dropAct(es[0].id);
  assert.deepEqual([lastSaid(app).msg, lastSaid(app).action], ['Cancelled. “Load chairs” stays in Vikunja. The rest of the change is not sent.', null]);
  await settle(t, () => !sync.all(1).length);
  assert.deepEqual([made(v), reached(v, 'POST', /\/relations$/).map(r => r.path), sync.all(1)], [['Load chairs', 'Stack them'], ['/tasks/9/relations', '/tasks/101/relations'], []]);
});

/* `madeUp` is an op no code outside src/js/ops/ knows by name. Each test gives it one field and shows that the shared
   code asks the op for it. Fields it leaves out take their defaults. Its one request is a PATCH of its task. */
const madeUp = (t, fields) => {
  OPS.madeUp = { apply: x => ({ ...x }), stages: [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { priority: 2 } })],
    asks: ['batch', 'raw'], saw: ['label'], text: () => 'A made-up change', refused: () => 'A made-up change', dropped: () => 'Vikunja keeps what it has.', ...fields };
  t.after(() => { delete OPS.madeUp; });
};
const emptied = async app => { for (const x of sync.all(1)) await sync.remove(x.id); app.refreshPending(); app.toasts.length = 0; };

test('what a refusal does is the op\'s: kept in the Outbox, its text back, its lines back to their box, or undone', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]), given = [];
  t.after(() => emptied(app));
  app.giveBack = (a, error) => { given.push(a.id); error.back = true; };
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  const refused = async (refusal, list) => {
    await emptied(app);
    madeUp(t, { refusal });
    return app.actAll(list.map(f => ({ op: 'madeUp', task: 7, run: null, label: 'Wipe the till', ...f })));
  };
  await refused(null, [{}]);
  assert.deepEqual([app.failed.length, lastSaid(app).msg], [1, 'A made-up change couldn\'t be saved: HTTP 403 from the fake. It\'s kept to try again.'], 'kept by default');
  const back = await refused('back', [{}]);
  assert.deepEqual([sync.all(1), given, lastSaid(app).msg], [[], [back.entry], 'A made-up change couldn\'t be saved: HTTP 403 from the fake. Its text is back in the box.'], 'its text back');
  const lines = await refused('lines', [{ batch: 'b', raw: 'Rope' }, { batch: 'b', raw: 'Tape' }]);
  assert.deepEqual([sync.all(1), lines.all[0].unsent, app.toasts], [[], ['Rope', 'Tape'], []], 'it and the line after it go back to their box, which says so');
  const undone = await refused('undone', [{}]);
  assert.deepEqual([undone.status, sync.all(1), app.toasts], ['error', [], []], 'undone, and the code that queued it says why');
});

test('what Cancel gives back is the op\'s, and Cancel offers Undo only when nothing went back', async t => {
  const { app } = offlineSender(t), given = [];
  t.after(() => emptied(app));
  app.giveBack = (a, said) => { given.push(a.op); said.back = true; };
  const cancel = async cancel => {
    await emptied(app);
    madeUp(t, { cancel });
    await app.act({ op: 'madeUp', task: 7, run: null, label: 'Wipe the till' });
    const id = sync.all(1)[0].id, drop = app.outboxRows.find(r => r.key === id).drop;
    if (drop[0] !== 'dropAct') return drop;
    await app.dropAct(id);
    return [lastSaid(app).msg, lastSaid(app).action?.label ?? null];
  };
  assert.deepEqual(await cancel(null), ['Cancelled. Vikunja keeps what it has.', 'Undo']);
  assert.deepEqual(await cancel('text'), ['Cancelled. Vikunja keeps what it has. Its text is back where you typed it.', null]);
  assert.deepEqual(await cancel('back'), ['Cancelled. Vikunja keeps what it has.', null], 'its own words say where its text went');
  assert.deepEqual(given, ['madeUp', 'madeUp'], 'only text and back give text back');
  const [how, id] = await cancel('lines');
  assert.deepEqual([how, id], ['cancelPending', sync.all(1)[0].id], 'an unsent line is cancelled as its waiting row\'s Cancel does it');
});

test('an op says it was refused in its task\'s open sheet only where it names a place there', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  Object.assign(app.sheet, { id: 7, kind: 'task', open: true });
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  for (const sheetPlace of [null, 'sheet:due']) {
    await emptied(app);
    madeUp(t, { sheetPlace });
    await app.act({ op: 'madeUp', task: 7, run: null });
    assert.deepEqual([lastSaid(app).place, lastSaid(app).ms], sheetPlace ? ['sheet:due', null] : ['step', undefined]);
  }
});

test('once Vikunja answers, the op says what the screen does, and by default a checklist\'s screen refreshes its step', async t => {
  const { app } = sender(t, [{ id: 7, title: 'Wipe the till' }]), seen = [];
  app.refreshRunTask = id => seen.push(['refreshed', id]);
  app.view.shownRun = { id: 5, steps: [7] };
  madeUp(t, {});
  await app.act({ op: 'madeUp', task: 7, run: 5 });
  madeUp(t, { answered: (app, a, c) => seen.push(['answered', a.task, typeof c.send]) });
  await app.act({ op: 'madeUp', task: 7, run: 5 });
  assert.deepEqual(seen, [['refreshed', 7], ['answered', 7, 'function']]);
});

test('a failed op holds back the ids its op names, and an op waits on the ids its op names', t => {
  madeUp(t, { holds: a => [a.task, 'pending-' + a.id], waitsOn: a => [a.after] });
  const stopped = heldTasks([{ kind: 'act', op: 'madeUp', id: 'x', task: 4, failed: true }]);
  assert.deepEqual([...stopped], [4, 'pending-x']);
  const op = (id, after) => ({ kind: 'act', op: 'madeUp', id, task: 9, after });
  assert.deepEqual([waits(op('y', 'pending-x'), stopped), waits(op('z', 4), stopped), waits(op('w', 3), stopped)], [true, true, false]);
  assert.ok(stopped.has('pending-y') && stopped.has(9), 'an op that waits holds back what it would hold if it failed');
});

test('a waiting row in a list is the op\'s row', t => {
  madeUp(t, { row: a => ({ id: 'pending-' + a.id, title: a.raw }) });
  const pendingTasks = Object.getOwnPropertyDescriptor(sending, 'pendingTasks').get;
  const e = { kind: 'act', op: 'madeUp', id: 'r1', raw: 'Buy rope', at: '2026-10-16T09:00:00.000Z' };
  assert.deepEqual(pendingTasks.call({ pending: [e, { kind: 'act', op: 'done', id: 'r2', task: 7 }], failed: [], slow: ['r1'] }), [{ id: 'pending-r1', title: 'Buy rope', waits: true }]);
});

test('the files an op still has to upload move to an entry of their own once a stage is done', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, { stages: [async () => {}, OPS.done.stages[0]], files: a => a.files.filter(f => !f.sent) });
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  const photo = { key: 'k1', name: 'till.jpg', size: 1, type: 'image/jpeg', sent: false };
  await app.act({ op: 'madeUp', task: 7, taskId: 7, run: null, files: [photo] });
  const op = sync.all(1).find(e => e.kind === 'act'), own = sync.all(1).find(e => !e.kind);
  assert.deepEqual([op.files, op.filed, own.taskId, own.files], [[], own.id, 7, [photo]]);
});

/* An op records what the user chose (`asks`). What the screen showed (`saw`) is for its words and its Undo, so a stage
   that reads it throws, and the request is built from Vikunja's copy instead. */
test('act() throws on a field the op doesn\'t declare, naming the op and the field, and queues nothing', async t => {
  const { app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  await assert.rejects(app.act({ op: 'done', task: 7, run: null, html: '<p>Done early</p>' }), /The done op doesn't declare the field html/);
  assert.deepEqual(sync.all(1), []);
});

test('a stage that reads a field the op saw throws, naming the op and the field, and one that reads what the user chose sends it', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  const rename = k => [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { title: a[k] } })];
  madeUp(t, { stages: rename('label') });
  await app.act({ op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter' });
  assert.match(app.failed[0].failed.message, /^The madeUp op's stage read label, what the screen showed\. Read Vikunja's copy with c\.once instead\.$/);
  assert.deepEqual([v.task(7).title, v.requests.filter(r => r.method === 'PATCH')], ['Wipe the till', []], 'nothing is sent');
  await emptied(app);
  madeUp(t, { stages: rename('raw') });
  await app.act({ op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter' });
  assert.deepEqual([v.task(7).title, sync.all(1)], ['Wipe the counter', []]);
  const a = { op: 'madeUp', raw: 'Wipe the counter', label: 'Wipe the till' }, seen = stageView(a);
  seen.taskId = 7;
  assert.deepEqual([a.taskId, seen.raw, 'label' in seen], [7, 'Wipe the counter', true], 'a write through the stage\'s view reaches the entry');
});

test('an op\'s Undo and its words read what the screen showed', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, { saw: ['label', 'was'], invert: a => ({ op: 'madeUp', task: a.task, raw: a.was, was: a.raw }), refused: a => `Renaming “${a.was}”`,
    stages: [(a, c) => c.send('/tasks/' + a.task, { method: 'PATCH', body: { title: a.raw } })] });
  const f = { id: uuid7(), op: 'madeUp', task: 7, run: null, raw: 'Wipe the counter', was: 'Wipe the till' };
  await app.act(f);
  assert.equal(v.task(7).title, 'Wipe the counter');
  assert.equal(await app.undoOps([f]).left, 0);
  assert.equal(v.task(7).title, 'Wipe the till', 'Undo puts back the title the row showed');
  v.trouble = r => r.method === 'PATCH' ? 403 : null;
  await app.act({ ...f, id: uuid7() });
  assert.match(lastSaid(app).msg, /^Renaming “Wipe the till” couldn't be saved/);
});

test('the tasks an op deletes are hidden while it waits, and forgotten once Vikunja answers it', async t => {
  const { v, app } = sender(t, [{ id: 7, title: 'Wipe the till' }]);
  t.after(() => emptied(app));
  madeUp(t, { deletes: a => [a.task] });
  app.row(v.task(7));
  noConnection(app, v);
  await app.act({ op: 'madeUp', task: 7, run: null });
  assert.deepEqual([app.beingDeleted(7), app.hiddenRows.has(7), !!app.tasks[7]], [true, true, true]);
  app.offline = false; v.trouble = () => null;
  await app.sendActs(sync.all(1)[0].id);
  assert.deepEqual([app.beingDeleted(7), app.tasks[7]], [false, undefined]);
});
