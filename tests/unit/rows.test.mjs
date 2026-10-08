// The one row (src/markup/task-row.html), for a task, a subtask in its sheet, and a step on a run's screen: what it asks
// the component, by the options of the list it's in (g).
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import views from '../../src/js/app/views.js';
import claims from '../../src/js/app/claims.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';
import { rowGestures, screenRows } from '../../src/js/lists.js';

const RUN = { depth: {}, run: true, at: 0, insertAt: null, locked: false };
// A step as a run's screen works it out (runView, runs.js), with only what the row reads.
const step = f => ({ id: 7, i: 0, title: 'Take the croissants out', done: false, skipped: false, slow: false, added: '', notes: [], dueText: '', late: false, slot: null, ...f });

test('a step\'s tick goes through the outbox; a subtask\'s in its sheet, and a task\'s, as before', () => {
  const app = component(views, claims, leaving), calls = [];
  Object.assign(app, { tickStep: (s, op) => calls.push(['step', s.id, op]), toggleSubtask: t => calls.push(['sub', t.id]),
    toggleDone: (t, row) => calls.push(['task', t.id, row]), aimAfterTick: t => calls.push(['aim', t.id]) });
  app.tickRow(step({}), RUN);
  app.tickRow(step({ done: true }), RUN);
  app.tickRow({ id: 3 }, { depth: {}, sheet: true });
  app.tickRow({ id: 4 }, { depth: {} }, 'row');
  assert.deepEqual(calls, [['step', 7, 'done'], ['step', 7, 'undone'], ['sub', 3], ['task', 4, 'row'], ['aim', 4]]);
});

test('under a step\'s title: Inserted or Repeated, its notes, and its countdown until it\'s done', () => {
  const app = component(views, claims);
  assert.deepEqual(app.rowMeta(step({}), RUN), []);
  const meta = app.rowMeta(step({ added: 'Inserted', notes: [{}, {}], dueText: '5m late', late: true }), RUN);
  assert.deepEqual(meta.map(m => [m.key, m.cls, m.text]), [['added', 'added', 'Inserted'], ['notes', 'note-mark num', '2'], ['due', 'due num overdue', '5m late']]);
  assert.equal(meta[1].label, '2 notes');
  assert.equal(app.rowMeta(step({ notes: [{}] }), RUN)[0].label, 'A note');
  assert.deepEqual(app.rowMeta(step({ done: true, dueText: 'Due in 3m' }), RUN), [], 'a done step has no countdown');
});

test('a step\'s slot is who\'s doing it until it\'s done, when its row shows who did it instead', () => {
  const app = component(views, claims), slot = { id: 7, users: [], can: true };
  assert.equal(app.rowSlot(step({ slot }), RUN), slot);
  assert.equal(app.rowSlot(step({ slot, done: true }), RUN), null);
});

/* What a finger can do on a row, besides its progress, by the screen its list is on (motion-and-rows-plan, section 2):
   Today is for doing, so no swipe to Delete and no move; a project and a task's sheet are for managing; search has no
   order of its own. The row writes its list's options on itself, and the gesture code reads them there. */
test('Today\'s rows are neither swiped to Delete nor moved; a project\'s and a sheet\'s are both; search\'s only swiped', () => {
  const on = name => rowGestures({ depth: {}, ...screenRows(name) });
  assert.equal(on('today'), '');
  assert.equal(on('project'), 'delete reorder');
  assert.equal(on('search'), 'delete');
  assert.equal(on('checklists'), '', 'a screen that says nothing allows neither');
  assert.equal(rowGestures({ depth: {}, sheet: true, delete: true, reorder: true }), 'delete reorder');
  assert.equal(rowGestures(RUN), '', 'a run\'s steps: never swiped, their order is the order line');
});

test('a row held or swiped: its Delete and its move only where its list allows them, its progress everywhere', () => {
  const app = component(progress), asked = [];
  Object.assign(app, { lines: {}, canTick: () => true, canDelete: () => true, reorderOf: t => (asked.push(t.id), { start(){} }) });
  const row = gestures => ({ dataset: { gestures }, clientWidth: 360 }), t = { id: 5, percent_done: .25 };
  const today = app.rowGesture(t, row(''), false);
  assert.equal(today.swipe, null, 'Today: a swipe left is left to the page');
  assert.equal(today.reorder, null);
  assert.equal(today.start, 25, 'its progress still slides');
  assert.deepEqual(asked, [], 'its place isn\'t even looked up');
  const search = app.rowGesture(t, row('delete'), false);
  assert.ok(search.swipe);
  assert.equal(search.reorder, null);
  const project = app.rowGesture(t, row('delete reorder'), false);
  assert.ok(project.swipe && project.reorder);
  assert.deepEqual(asked, [5]);
});

/* Progress slid on a row no one is doing says you're doing it (motion-and-rows-plan, section 3): your picture as the
   slide starts, the claim sent only if the slide changed something, and someone else's never replaced. */
test('a slide shows you on a task no one is doing, and claims it only once it has changed something', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, acts = [];
  const app = component(claims);
  Object.assign(app, { user: me, pending: [], slideClaim: null, canWrite: () => true, act: async a => { acts.push(a); } });
  const free = app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: 1 }, [], false);
  const end = app.claimOnSlide(free);
  assert.equal(app.slideClaim, 5);
  assert.deepEqual(app.peopleOf(5, []), [me], 'your picture takes the place of "+ me" as it starts');
  await end(false);
  assert.equal(app.slideClaim, null);
  assert.deepEqual(app.peopleOf(5, []), [], 'let go where it started: no one claimed');
  assert.deepEqual(acts, []);
  await app.claimOnSlide(free)(true);
  assert.deepEqual(acts, [{ op: 'claim', task: 5, run: null }], 'changed: claimed, through the outbox');
  assert.equal(app.slideClaim, null, 'from then on the outbox says who');
  const theirs = app.claimSlot({ id: 6, title: 'Count the till', project_id: 1 }, [priya], false);
  await app.claimOnSlide(theirs)(true);
  assert.equal(app.slideClaim, null);
  assert.equal(acts.length, 1, 'someone else\'s stays theirs');
  await app.claimOnSlide(app.claimSlot({ id: 7, title: 'Mine', project_id: 1 }, [me], false))(true);
  assert.equal(acts.length, 1, 'yours already: nothing to send, and sliding back to 0% later keeps it');
});
