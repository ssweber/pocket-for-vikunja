// What an add box's lines become, through the outbox (src/js/app/sending.js, LINE_STEPS in src/js/sync.js), against a
// pretend Vikunja: what's sent for each line, in which order, and what its row shows once it's there.
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import leaving from '../../src/js/app/leaving.js';
import { todayGroups } from '../../src/js/lists.js';
import { sync } from '../../src/js/sync.js';

const DAY = 86400;
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
// The component on Today, with the parts that send an entry and put what it made on the screen. The batch's timer is
// the test's, so it doesn't clear by itself.
const adding = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, leaving, pick(sending, 'createTask', 'linkSubtask', 'sendEntry', 'placeSent', 'pendingPlace', 'arrivedDone', 'findSent', 'refreshPending', 'markSlow'));
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], deleting: [], slow: [], positions: {}, projects: [], canWrite: () => true });
  Object.defineProperty(app, 'pendingTasks', Object.getOwnPropertyDescriptor(sending, 'pendingTasks'));
  app.view = { groups: todayGroups(), route: '' };
  return app;
};
// A line as an add box keeps it in the outbox (packParsed): `p`, what was read in it.
const line = (title, p = {}) => ({ raw: title, p: { title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null, remind: false, done: false, pct: 0, ...p }, taskId: null, done: false, linked: false });
let n = 0;
const entry = (items, more = {}) => ({ id: 'e' + ++n, user: 1, at: new Date().toISOString(), nest: false, pid: 5, items, files: [], ...more });
const send = async (app, e) => { await sync.add(e, []); app.refreshPending(); return app.sendEntry(e.id); };
const sent = v => v.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.path, r.body]);
const group = (app, key) => app.view.groups.find(g => g.key === key).tasks;

test('a line that says it\'s done is made as any task, then marked done as a tick marks it', async t => {
  const v = fakeVikunja(), app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  assert.deepEqual(sent(v), [['POST', '/projects/5/tasks', { title: 'Call Sam' }], ['PATCH', '/tasks/101', { done: true }], ['POST', '/projects/5/tasks', { title: 'Call Jo' }]]);
  assert.deepEqual([r.status, v.task(101).done, v.task(102).done], ['sent', true, false]);
  assert.equal(sync.all(1).length, 0, 'nothing left waiting');
});

test('while it waits, a line that says it\'s done is on its list ticked', async t => {
  const v = fakeVikunja(), app = adding(t);
  v.trouble = () => 'offline';
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  app.refreshPending();
  assert.equal(r.status, 'offline');
  assert.deepEqual(app.pendingTasks.map(x => [x.title, x.done]), [['Call Sam', true], ['Call Jo', false]]);
  await sync.remove(sync.all(1)[0].id);
});

test('a task that arrived done shows ticked on its row and leaves with the batch; its tick meanwhile opens it again', async t => {
  const v = fakeVikunja(), app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true })]));
  app.placeSent(r.tasks);
  assert.deepEqual(group(app, 'nodate').map(x => [x.title, x.done]), [['Call Sam', true]], 'ticked, where a task added goes');
  assert.deepEqual([app.leaving, app.said], [{ 101: 'done' }, 'Done: Call Sam'], 'marked, as a tick marks it');
  t.mock.timers.tick(2999);
  assert.equal(group(app, 'nodate').length, 1, 'not before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(group(app, 'nodate'), [], 'gone with the batch');
  // Another, opened again by its tick before the batch clears.
  const again = await send(app, entry([line('Call Jo', { done: true })]));
  app.placeSent(again.tasks);
  await app.unmark(102);
  assert.deepEqual([v.task(102).done, app.tasks[102].done, app.leaving], [false, false, {}]);
  await app.clearBatch(true);
  assert.deepEqual(group(app, 'nodate').map(x => x.title), ['Call Jo'], 'it stays');
});

test('one that repeats moves on to its next date, as a tick moves it, and a lost reply doesn\'t tick it twice', async t => {
  const v = fakeVikunja(), app = adding(t), due = new Date(Date.now() + 36e5).toISOString();
  const e = entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]);
  v.trouble = r => r.method === 'PATCH' ? 'lost' : null;
  assert.equal((await send(app, e)).status, 'offline', 'kept, to try again');
  v.trouble = () => null;
  const r = await app.sendEntry(e.id);
  assert.equal(sent(v).filter(([m]) => m === 'PATCH').length, 1, 'ticked once: Vikunja\'s copy said it got there');
  assert.equal(Date.parse(v.task(101).due_date) - Date.parse(due), DAY * 1000);
  assert.equal(v.task(101).done, false);
  assert.equal(r.status, 'sent');
});

test('a repeating task that arrived done shows ticked with the date it was given, then open at its next', async t => {
  const v = fakeVikunja(), app = adding(t), due = new Date(Date.now() + 36e5).toISOString();
  const r = await send(app, entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]));
  app.placeSent(r.tasks);
  const row = app.tasks[101];
  assert.deepEqual([row.done, row.due_date, app.leaving[101]], [true, due, 'done']);
  await app.clearBatch(true);
  assert.deepEqual([row.done, row.due_date], [false, v.task(101).due_date], 'open again, at its next date');
  assert.ok(app.view.groups.some(g => g.tasks.includes(row)), 'still on Today: its next date is within the week');
});

test('a line\'s progress is written once it\'s made, as a swipe would set it, and shows in its row\'s tick; 100% is done', async t => {
  const v = fakeVikunja(), app = adding(t);
  const e = entry([line('Tables', { pct: 50 }), line('Chairs', { pct: 100 })]);
  v.trouble = () => 'offline';
  await send(app, e);
  app.refreshPending();
  assert.deepEqual(app.pendingTasks.map(x => [x.title, x.percent_done, x.done]), [['Tables', 0.5, false], ['Chairs', 1, true]], 'while they wait, too');
  v.trouble = () => null;
  v.requests.length = 0;
  const r = await app.sendEntry(e.id);
  assert.deepEqual(sent(v), [['POST', '/projects/5/tasks', { title: 'Tables' }], ['PATCH', '/tasks/101', { percent_done: 0.5 }],
    ['POST', '/projects/5/tasks', { title: 'Chairs' }], ['PATCH', '/tasks/102', { done: true }]]);
  app.placeSent(r.tasks);
  assert.deepEqual(group(app, 'nodate').map(x => [x.title, x.percent_done, x.done]).sort(), [['Chairs', 0, true], ['Tables', 0.5, false]]);
  assert.deepEqual(app.leaving, { 102: 'done' }, 'only the one that\'s done leaves with the batch');
});

test('a pasted list\'s first line, over lines that arrived done or with progress, has the figure they give it', async t => {
  const v = fakeVikunja(), app = adding(t);
  await send(app, entry([line('Pack the van'), line('Load chairs', { done: true }), line('Tables')], { nest: true }));
  await app.saveTask(101, null, () => null);
  assert.deepEqual([v.task(101).percent_done, v.task(102).done, v.task(103).done], [0.5, true, false], 'one of two done');
  assert.deepEqual(v.task(101).related_tasks.subtask.map(s => s.id), [102, 103]);
  await send(app, entry([line('Set the hall'), line('Tables', { pct: 50 }), line('Lights')], { nest: true }));
  await app.saveTask(104, null, () => null);
  assert.equal(v.task(104).percent_done, 0.25, 'one at 50% of two');
  // With none done, its figure is 0, as Vikunja made it: nothing is written.
  v.requests.length = 0;
  await send(app, entry([line('Order cups'), line('Small'), line('Large')], { nest: true }));
  assert.deepEqual(sent(v).filter(([m]) => m === 'PATCH'), []);
});
