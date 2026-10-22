// Tests for what an add box's lines become when they go through the outbox, each line an add op (src/js/ops/add.js,
// sent by src/js/app/acts.js and sending.js), against a fake Vikunja. They check what is sent for each line, in what
// order, and what its row shows once it arrives. They also check what a box shows it has read before sending: its
// chips and the text marked in it (src/js/app/quickadd.js).
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks from '../../src/js/app/tasks.js';
import sending, { batchOf } from '../../src/js/app/sending.js';
import acts from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import leaving from '../../src/js/app/leaving.js';
import quickadd from '../../src/js/app/quickadd.js';
import views from '../../src/js/app/views.js';
import cards from '../../src/js/app/cards.js';
import sheetPart from '../../src/js/app/sheet.js';
import { newBox } from '../../src/js/app/core.js';
import { todayGroups } from '../../src/js/lists.js';
import { busyText, photosLater, UNKNOWN, waitText } from '../../src/js/messages.js';
import { addLines } from '../../src/js/ops/index.js';
import { packParsed, sync } from '../../src/js/sync.js';
import { parseCapture } from '../../src/js/quickadd.js';

const DAY = 86400;
// The parts that queue and send a line, and put the result on the screen. The fake's own flush and render stay.
const SENDING = Object.assign({}, ...[sending, acts, outbox].map(p => Object.getOwnPropertyDescriptors(p)));
delete SENDING.flush;
const parts = Object.defineProperties({}, SENDING);
// The component on Today, with the parts that send an entry and put the result on the screen. The test controls the
// batch's timer, so the batch doesn't clear by itself.
const adding = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(tasks, actions, leaving, quickadd, cards, views, parts);
  Object.assign(app, {
    render() {},
    user: { id: 1 },
    pending: [],
    failed: [],
    slow: [],
    positions: {},
    projects: [],
    canWrite: () => true,
    cap: { text: '' },
    capPhotos: [],
    endPlace() {},
  });
  app.view = { groups: todayGroups(), route: '' };
  app.toasts.push({ msg: '' }); // act() reads the last message
  return app;
};
// A line as an add box reads it (itemsOf). `p` is what was read from the line, and `under` is the index of the line it
// sits under.
const line = (title, p = {}, under = null) => ({
  raw: title,
  p: {
    title,
    due: null,
    priority: 0,
    repeat: null,
    labels: [],
    assignees: [],
    project: null,
    remind: false,
    done: false,
    pct: 0,
    ...p,
  },
  under,
});
// The lines typed together, as their add ops' entries (addLines), into project 5 or under `parent`.
const entry = (items, more = {}) => ({ items, ...more });
const opsOf = (app, e) => (e.entries ||= addLines(e.items, { pid: 5, parent: e.parent }).map(f => app.actEntry(f)));
// The add box shows what became of its lines, so it reads the outbox again itself (submitCapture).
const shown = (app, r) => {
  app.refreshPending();
  return r;
};
const send = async (app, e) => shown(app, await app.sendLines(opsOf(app, e)));
// Send the lines again, as flush or a later add does, and read what became of them.
const resend = async (app, e) => shown(app, batchOf(await app.sendActs(e.entries.at(-1).id), e.entries));
const clear = async () => {
  for (const x of sync.all(1)) await sync.remove(x.id);
};
const sent = v => v.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.path, r.body]);
const group = (app, key) => app.view.groups.find(g => g.key === key).tasks;

test("a line marked as done is created like any task and then marked done, with the user's ✅, as a tick does", async t => {
  const v = fakeVikunja(),
    app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  assert.deepEqual(sent(v), [
    ['POST', '/projects/5/tasks', { title: 'Call Sam' }],
    ['PATCH', '/tasks/101', { done: true }],
    ['POST', '/tasks/101/reactions', { value: '✅' }],
    ['POST', '/projects/5/tasks', { title: 'Call Jo' }],
  ]);
  assert.deepEqual([r.status, v.task(101).done, v.task(102).done], ['sent', true, false]);
  assert.equal(sync.all(1).length, 0, 'nothing is left waiting');
});

test('while it waits, a line marked as done shows ticked on its list', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  v.trouble = () => 'offline';
  const r = await send(app, entry([line('Call Sam', { done: true }), line('Call Jo')]));
  app.refreshPending();
  assert.equal(r.status, 'offline');
  assert.deepEqual(
    app.pendingTasks.map(x => [x.title, x.done]),
    [
      ['Call Sam', true],
      ['Call Jo', false],
    ],
  );
  await clear();
});

test('a task that arrives done shows ticked and leaves with the batch, and tapping its tick before then opens it again', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  const r = await send(app, entry([line('Call Sam', { done: true })]));
  app.placeSent(r.tasks);
  assert.deepEqual(
    group(app, 'nodate').map(x => [x.title, x.done]),
    [['Call Sam', true]],
    'the task shows ticked, where an added task goes',
  );
  assert.deepEqual(
    [app.leaving, app.said],
    [{ 101: 'done' }, 'Done: Call Sam'],
    'the task is marked, as a tick marks it',
  );
  t.mock.timers.tick(2999);
  assert.equal(group(app, 'nodate').length, 1, 'the batch does not clear before 3 seconds');
  await app.clearBatch(true);
  assert.deepEqual(group(app, 'nodate'), [], 'the task leaves with the batch');
  // Another task, opened again by its tick before the batch clears.
  const again = await send(app, entry([line('Call Jo', { done: true })]));
  app.placeSent(again.tasks);
  await app.unmark(102);
  assert.deepEqual([v.task(102).done, app.tasks[102].done, app.leaving], [false, false, {}]);
  await app.clearBatch(true);
  assert.deepEqual(
    group(app, 'nodate').map(x => x.title),
    ['Call Jo'],
    'the reopened task stays',
  );
});

test('a repeating task moves on to its next date as a tick does, and a lost reply does not tick it twice', async t => {
  const v = fakeVikunja(),
    app = adding(t),
    due = new Date(Date.now() + 36e5).toISOString();
  const e = entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]);
  v.trouble = r => (r.method === 'PATCH' ? 'lost' : null);
  assert.equal((await send(app, e)).status, 'offline', 'the entry is kept to try again');
  v.trouble = () => null;
  const r = await resend(app, e);
  const ticks = v.requests.filter(x => x.method === 'PATCH');
  assert.deepEqual(
    ticks.map(x => [x.key, !!x.replayed]),
    [
      [ticks[0].key, false],
      [ticks[0].key, true],
    ],
    'the tick is sent again with its key, and the relay answers from what it kept',
  );
  assert.equal(Date.parse(v.task(101).due_date) - Date.parse(due), DAY * 1000, 'the task moved on one date, not two');
  assert.equal(v.task(101).done, false);
  assert.equal(r.status, 'sent');
});

/* Each stage of a line sends its writes with keys (LINE_STEPS). This line is a subtask of Pack the van, with a label
   Vikunja has, a new label and a person, and it is marked done. Its writes, in order, are the task, the new label,
   the task's labels, its people, the link and the tick. */
const WRITES = [
  ['POST', '/projects/5/tasks'],
  ['POST', '/labels'],
  ['PUT', '/tasks/101/labels/bulk'],
  ['PUT', '/tasks/101/assignees/bulk'],
  ['POST', '/tasks/9/relations'],
  ['PATCH', '/tasks/101'],
];
const labelled = t => {
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5 }]),
    app = adding(t);
  v.labels.push({ id: 1, title: 'Old' });
  Object.assign(app, {
    loadLabels: views.loadLabels,
    canSee: async () => null,
    findUser: async name => ({ id: 7, username: name }),
  });
  return {
    v,
    app,
    e: entry([line('Chairs', { labels: ['Old', 'New'], assignees: ['sam'], done: true })], {
      parent: { id: 9, project_id: 5, title: 'Pack the van' },
    }),
  };
};
test('each stage of a line sends the same key again after its reply was lost, and reads nothing before it', async t => {
  for (const [method, path] of WRITES)
    await t.test(`${method} ${path}`, async t => {
      const { v, app, e } = labelled(t),
        is = r => r.method === method && r.path === path;
      let cut = true;
      v.trouble = r => (is(r) && cut ? ((cut = false), 'lost') : null);
      assert.equal((await send(app, e)).status, 'offline', 'the entry is kept to try again');
      const lost = v.requests.find(is),
        from = v.requests.length;
      assert.equal((await resend(app, e)).status, 'sent');
      const retry = v.requests.slice(from),
        again = retry.find(is);
      assert.deepEqual(
        [again.key, again.replayed],
        [lost.key, true],
        'sent again with its key, and answered from what the relay kept',
      );
      assert.deepEqual(
        retry.slice(0, retry.indexOf(again)).filter(r => r.method === 'GET'),
        [],
        'nothing is read again first',
      );
      const made = v.task(101);
      assert.deepEqual(
        [
          v.tasks.size,
          made.labels.map(l => l.title),
          made.assignees.map(u => u.id),
          made.done,
          v.task(9).related_tasks.subtask.map(s => s.id),
          v.labels.length,
        ],
        [2, ['Old', 'New'], [7], true, [101], 2],
        'one task, with its labels, its person, its link and its tick, and one new label',
      );
    });
});

test('a new label is not sent again once Vikunja answered it, and the requests after it keep their keys', async t => {
  const v = fakeVikunja(),
    app = adding(t),
    stage = r => r.key.split(':').slice(1).join(':');
  app.loadLabels = views.loadLabels;
  const e = entry([line('Chairs', { labels: ['Spare', 'Folding'] })]);
  let cut = true;
  v.trouble = r => (r.path === '/labels' && r.body?.title === 'Folding' && cut ? ((cut = false), 'lost') : null);
  assert.equal((await send(app, e)).status, 'offline');
  assert.equal((await resend(app, e)).status, 'sent');
  const made = v.requests.filter(r => r.path === '/labels' && r.method === 'POST');
  assert.deepEqual(
    made.map(r => [r.body.title, stage(r), !!r.replayed]),
    [
      ['Spare', '2:0', false],
      ['Folding', '2:1', false],
      ['Folding', '2:1', true],
    ],
  );
  assert.deepEqual(v.requests.filter(r => r.path.endsWith('/labels/bulk')).map(stage), ['2:2']);
  assert.deepEqual(
    v.task(101).labels.map(l => l.title),
    ['Spare', 'Folding'],
  );
});

test('a new label on two lines is created once', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  app.loadLabels = views.loadLabels;
  await send(app, entry([line('Chairs', { labels: ['Spare'] }), line('Tables', { labels: ['Spare'] })]));
  assert.deepEqual(
    v.requests.filter(r => r.path === '/labels' && r.method === 'POST').map(r => r.body.title),
    ['Spare'],
  );
  assert.deepEqual(
    [v.task(101).labels, v.task(102).labels].map(ls => ls.map(l => l.title)),
    [['Spare'], ['Spare']],
  );
});

// Run `p` while moving the mocked clock, so the waits between a busy Vikunja's tries (patiently) pass.
const patient = async (t, p) => {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    for (let i = 0; i < 5; i++) await new Promise(ok => setImmediate(ok));
    if (!done) t.mock.timers.tick(500);
  }
  return p;
};

test('a busy Vikunja is asked again for its labels, so the line still gets them', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  app.loadLabels = views.loadLabels;
  let busy = true;
  v.trouble = r => (r.method === 'GET' && r.path === '/labels' && busy ? ((busy = false), 500) : null);
  const r = await patient(t, send(app, entry([line('Chairs', { labels: ['Spare'] })])));
  assert.deepEqual([r.status, r.problems, v.task(101).labels.map(l => l.title)], ['sent', [], ['Spare']]);
});

test('a label deleted in the web app since Pocket read its labels is made again, not sent with its old id', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  v.labels.push({ id: 1, title: 'Old' });
  Object.assign(app, {
    loadLabels: views.loadLabels,
    labels: [
      { id: 1, title: 'Old' },
      { id: 3, title: 'Gone' },
    ],
    labelsLoaded: true,
  });
  const r = await send(app, entry([line('Chairs', { labels: ['Old', 'Gone'] })]));
  assert.deepEqual([r.status, r.problems, v.task(101).labels.map(l => l.title)], ['sent', [], ['Old', 'Gone']]);
  assert.ok(!v.requests.some(r => r.body?.labels?.some(l => l.id === 3)), 'the old id is never sent');
});

const part = r => r.key.split(':').slice(1).join(':');
test("a label Vikunja refuses in the set is reported alone, and the line's other labels are added one by one", async t => {
  const v = fakeVikunja(),
    app = adding(t);
  v.labels.push({ id: 1, title: 'Old' }, { id: 2, title: 'Gone' });
  app.loadLabels = views.loadLabels;
  const e = entry([line('Chairs', { labels: ['Old', 'Gone'] })]);
  // The connection drops before the set is sent, and the label is deleted in the web app before the retry.
  v.trouble = r => (r.path.endsWith('/labels/bulk') ? 'offline' : null);
  assert.equal((await send(app, e)).status, 'offline');
  v.labels.splice(1, 1);
  v.trouble = () => null;
  const r = await resend(app, e);
  assert.deepEqual(
    [r.status, r.problems, v.task(101).labels.map(l => l.title)],
    ['sent', ['label Gone: The label does not exist.'], ['Old']],
  );
  assert.deepEqual(
    v.requests.filter(r => r.path.startsWith('/tasks/101/labels')).map(r => [r.method, part(r), r.body.label_id]),
    [
      ['PUT', '2:0', undefined],
      ['PUT', '2:0', undefined],
      ['POST', '2:1', 1],
      ['POST', '2:2', 2],
    ],
  );
});

test('a person Vikunja refuses is reported alone, the others are assigned, and a retry sends the same keys', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  v.strangers.add(8);
  Object.assign(app, {
    canSee: async () => null,
    findUser: async name => ({ id: { sam: 7, max: 8 }[name], username: name }),
  });
  const e = entry([line('Chairs', { assignees: ['sam', 'max'] })]);
  // The reply to the last request is lost, so the stage runs again from its start.
  let cut = true;
  v.trouble = r => (r.body?.user_id === 8 && cut ? ((cut = false), 'lost') : null);
  assert.equal((await send(app, e)).status, 'offline');
  const r = await resend(app, e);
  assert.deepEqual(
    [r.status, r.problems, v.task(101).assignees.map(u => u.id)],
    ['sent', ['@max: The user does not have access to the project.'], [7]],
  );
  assert.deepEqual(
    v.requests.filter(r => r.path.startsWith('/tasks/101/assignees')).map(r => [r.method, part(r), !!r.replayed]),
    [
      ['PUT', '3:0', false],
      ['POST', '3:1', false],
      ['POST', '3:2', false],
      ['PUT', '3:0', true],
      ['POST', '3:1', true],
      ['POST', '3:2', true],
    ],
  );
});

test('a person with no account is reported as the line is first sent, and their @name stays in the title', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  Object.assign(app, { canSee: async () => false, userExists: async () => false });
  const r = await send(app, entry([line('Chairs @nobody', { assignees: ['nobody'] })]));
  assert.deepEqual([r.status, r.problems, v.task(101).title], ['sent', ['no user @nobody'], 'Chairs @nobody']);
});

test('a @user in the middle of the title loses only its @ once assigned, and stays as typed when there is no such user', async t => {
  const v = fakeVikunja(),
    app = adding(t),
    typed = text => ({ raw: text, p: packParsed(parseCapture(text, [])), under: null });
  Object.assign(app, {
    canSee: async (pid, name) => name === 'bob',
    userExists: async name => name === 'bob',
    findUser: async name => (name === 'bob' ? { id: 7, username: name } : null),
  });
  const r = await send(app, entry([typed('Ask @bob about it @bob'), typed('Ask @nobody about it')]));
  assert.deepEqual(
    [r.status, r.problems, v.task(101).title, v.task(101).assignees.map(u => u.id), v.task(102).title],
    ['sent', ['no user @nobody'], 'Ask bob about it', [7], 'Ask @nobody about it'],
  );
});

test('a repeating task that arrives done shows ticked with its given date, then opens at its next date', async t => {
  const v = fakeVikunja(),
    app = adding(t),
    due = new Date(Date.now() + 36e5).toISOString();
  const r = await send(app, entry([line('Water the plants', { done: true, due, repeat: { after: DAY, mode: 0 } })]));
  app.placeSent(r.tasks);
  const row = app.tasks[101];
  assert.deepEqual([row.done, row.due_date, app.leaving[101]], [true, due, 'done']);
  await app.clearBatch(true);
  assert.deepEqual([row.done, row.due_date], [false, v.task(101).due_date], 'the task is open again at its next date');
  assert.ok(
    app.view.groups.some(g => g.tasks.includes(row)),
    'the task is still on Today, because its next date is within the week',
  );
});

test("a line's progress is written once the task is created, as a swipe sets it, and 100% means done", async t => {
  const v = fakeVikunja(),
    app = adding(t);
  const e = entry([line('Tables', { pct: 50 }), line('Chairs', { pct: 100 })]);
  v.trouble = () => 'offline';
  await send(app, e);
  app.refreshPending();
  assert.deepEqual(
    app.pendingTasks.map(x => [x.title, x.percent_done, x.done]),
    [
      ['Tables', 0.5, false],
      ['Chairs', 1, true],
    ],
    'the progress also shows while the tasks wait',
  );
  v.trouble = () => null;
  v.requests.length = 0;
  const r = await resend(app, e);
  assert.deepEqual(sent(v), [
    ['POST', '/projects/5/tasks', { title: 'Tables' }],
    ['PATCH', '/tasks/101', { percent_done: 0.5 }],
    ['POST', '/projects/5/tasks', { title: 'Chairs' }],
    ['PATCH', '/tasks/102', { done: true }],
    ['POST', '/tasks/102/reactions', { value: '✅' }],
  ]);
  app.placeSent(r.tasks);
  assert.deepEqual(
    group(app, 'nodate')
      .map(x => [x.title, x.percent_done, x.done])
      .sort(),
    [
      ['Chairs', 0, true],
      ['Tables', 0.5, false],
    ],
  );
  assert.deepEqual(app.leaving, { 102: 'done' }, 'only the done task leaves with the batch');
});

test('a parent line gets the progress calculated from subtask lines that arrive done or with progress, written once they are created', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  await send(app, entry([line('Pack the van'), line('Load chairs', { done: true }, 0), line('Tables', {}, 0)]));
  await app.readCopy(101);
  assert.deepEqual(
    [v.task(101).percent_done, v.task(102).done, v.task(103).done],
    [0.5, true, false],
    'one of two subtasks is done',
  );
  assert.deepEqual(
    v.task(101).related_tasks.subtask.map(s => s.id),
    [102, 103],
  );
  await send(app, entry([line('Set the hall'), line('Tables', { pct: 50 }, 0), line('Lights', {}, 0)]));
  await app.readCopy(104);
  assert.equal(v.task(104).percent_done, 0.25, 'one subtask at 50% of two gives 25%');
  // With no subtask done, the parent's progress is 0, as Vikunja made it, so nothing is written.
  v.requests.length = 0;
  await send(app, entry([line('Order cups'), line('Small', {}, 0), line('Large', {}, 0)]));
  assert.deepEqual(
    sent(v).filter(([m]) => m === 'PATCH'),
    [],
  );
});

const links = v =>
  v.requests.filter(r => r.path.endsWith('/relations')).map(r => [+r.path.split('/')[2], r.body.other_task_id]);
test('a list with several parents and nested subtasks creates each line under the line it names, in order', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  // The lines are "## Pack the van", "Load chairs", "  Stack them" (done), "## Set the hall", "Tables (50%)"
  const e = entry([
    line('Pack the van'),
    line('Load chairs', {}, 0),
    line('Stack them', { done: true }, 1),
    line('Set the hall'),
    line('Tables', { pct: 50 }, 3),
  ]);
  v.trouble = () => 'offline';
  await send(app, e);
  app.refreshPending();
  const id = e.entries.map(x => 'pending-' + x.id);
  assert.deepEqual(
    app.pendingTasks.map(x => [x.id, x.parent, x.child]),
    [
      [id[0], null, false],
      [id[1], id[0], true],
      [id[2], id[1], true],
      [id[3], null, false],
      [id[4], id[3], true],
    ],
    "while the lines wait, each row is under its parent line's row, by its entry's id",
  );
  v.trouble = () => null;
  v.requests.length = 0;
  const r = await resend(app, e);
  assert.equal(r.status, 'sent');
  assert.deepEqual(links(v), [
    [101, 102],
    [102, 103],
    [104, 105],
  ]);
  assert.deepEqual(
    r.tasks.map(x => [x.title, x.parent, x.child]),
    [
      ['Pack the van', null, false],
      ['Load chairs', 101, true],
      ['Stack them', 102, true],
      ['Set the hall', null, false],
      ['Tables', 104, true],
    ],
  );
  await app.readCopy(101);
  // The last line under a parent writes the parent's progress, deepest first, because its progress counts in the task
  // above it. Load chairs is 100% (its one subtask is done), so Pack the van is 100%. Tables arrives at 50% after them.
  assert.deepEqual(
    sent(v)
      .filter(([m, , b]) => m === 'PATCH' && 'percent_done' in b && !b.done)
      .map(([, path, b]) => [path, b.percent_done]),
    [
      ['/tasks/102', 1],
      ['/tasks/101', 1],
      ['/tasks/105', 0.5],
      ['/tasks/104', 0.5],
    ],
  );
});

test('an entry an older Pocket saved, with all its lines in one entry, is removed and sends nothing', async t => {
  const v = fakeVikunja(),
    app = adding(t);
  const old = {
    id: 'old1',
    user: 1,
    at: new Date().toISOString(),
    nest: true,
    pid: 5,
    items: [line('Pack the van'), line('Load chairs')],
    files: [],
  };
  await sync.add(old, []);
  app.refreshPending();
  assert.deepEqual(app.pendingTasks, [], 'it shows no waiting row');
  await app.sendEntry(old.id);
  assert.deepEqual([v.requests, sync.all(1)], [[], []]);
});

test('cancelling a waiting line moves the lines under it to its parent, and a message says so', async t => {
  fakeVikunja();
  const app = adding(t);
  app.offline = true; // so no line is sent, and each can be cancelled
  const e = entry([line('Pack the van'), line('Load chairs', {}, 0), line('Stack them', {}, 1), line('Tables', {}, 0)]);
  await send(app, e);
  const [van, load, stack, tables] = e.entries.map(x => x.id),
    under = () => sync.all(1).map(x => [x.raw, x.under]);
  // Each waiting row's Cancel label says what becomes of the lines under it, including the lines under a later parent.
  assert.deepEqual(
    app.pendingTasks.map(x => app.cancelLabel(x)),
    [
      'Cancel Pack the van. The lines under it become their own tasks.',
      'Cancel Load chairs. The line under it moves under “Pack the van”.',
      'Cancel Stack them',
      'Cancel Tables',
    ],
  );
  await app.cancelPending(load);
  assert.deepEqual(under(), [
    ['Pack the van', null],
    ['Stack them', 'pending-' + van],
    ['Tables', 'pending-' + van],
  ]);
  assert.equal(
    app.toast.msg,
    'Cancelled. “Load chairs” is back where you typed it. The 1 line under it is now under “Pack the van”.',
  );
  assert.equal(app.cap.text, 'Load chairs');
  assert.equal(
    app.cancelLabel(app.pendingTasks[0]),
    'Cancel Pack the van. The lines under it become their own tasks.',
    'the label still counts two lines waiting under the first',
  );
  await app.cancelPending(van);
  assert.deepEqual(under(), [
    ['Stack them', null],
    ['Tables', null],
  ]);
  assert.equal(
    app.toast.msg,
    'Cancelled. “Pack the van” is back where you typed it. The 2 lines under it are now their own tasks.',
  );
  assert.deepEqual(
    app.pendingTasks.map(x => [x.id, app.cancelLabel(x)]),
    [
      ['pending-' + stack, 'Cancel Stack them'],
      ['pending-' + tables, 'Cancel Tables'],
    ],
  );
  await clear();
});

/* The lines typed together are one add op each, sent in order. A line under a line waits for that line's task. */
const three = () => entry([line('Pack the van'), line('Load chairs'), line('Stack them', {}, 1)]);
test("a list of three lines, the third under the second, is sent in order, and the third waits for the second's task", async t => {
  const v = fakeVikunja(),
    app = adding(t),
    e = three();
  let cut = true;
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Load chairs' && cut ? ((cut = false), 'offline') : null);
  const r = await send(app, e);
  assert.deepEqual(
    [r.status, r.ids, sync.all(1).map(x => x.raw)],
    ['offline', [101], ['Load chairs', 'Stack them']],
    'the first is made, and the second and third wait',
  );
  assert.equal(
    sync.all(1)[1].under,
    'pending-' + e.entries[1].id,
    'the third names the second until the second is made',
  );
  const done = await resend(app, e);
  assert.deepEqual([done.status, done.ids, links(v)], ['sent', [102, 103], [[102, 103]]]);
  assert.deepEqual(
    v.requests.filter(x => x.method === 'POST' && x.path === '/projects/5/tasks').map(x => x.body.title),
    ['Pack the van', 'Load chairs', 'Load chairs', 'Stack them'],
  );
  assert.equal(sync.all(1).length, 0);
});

test('a refused line goes back to the box with the lines after it, and leaves nothing waiting', async t => {
  const v = fakeVikunja(),
    app = adding(t),
    e = three();
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Load chairs' ? 403 : null);
  const r = await send(app, e);
  assert.deepEqual(
    [r.status, r.ids, r.unsent, r.error.message],
    ['error', [101], ['Load chairs', 'Stack them'], 'HTTP 403 from the fake'],
  );
  assert.deepEqual([sync.all(1), app.pendingTasks], [[], []]);
  assert.deepEqual(
    v.requests.filter(x => x.body?.title === 'Stack them'),
    [],
    'the third is never sent',
  );
});

/* The relay can't tell whether Vikunja made the second line's task. The line stays in the Outbox, marked failed,
   with Try again. The third, under it, waits behind it. */
const unknownSecond = async t => {
  const v = fakeVikunja([{ id: 7, title: 'Wipe the till' }]),
    app = adding(t),
    e = three();
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Load chairs' ? 'unknown' : null);
  return { v, app, e, r: await send(app, e) };
};
test("a line whose answer the relay can't vouch for waits in the Outbox with Try again, and the line under it waits behind it", async t => {
  const { v, app, e, r } = await unknownSecond(t);
  assert.deepEqual(
    [r.status, r.error.message, r.unsent, r.ids],
    ['error', UNKNOWN, [], [101]],
    'nothing goes back to the box',
  );
  assert.deepEqual(
    app.failed.map(x => x.raw),
    ['Load chairs'],
  );
  assert.deepEqual(
    app.outboxRows.map(x => [x.text, x.failed, x.retry, x.drop?.[0]]),
    [
      ['New task: Load chairs', UNKNOWN, true, 'dropAct'],
      ['Subtask of “Load chairs”: Stack them', '', false, 'cancelPending'],
    ],
  );
  assert.equal(
    app.outboxLabel,
    "Outbox, 1 couldn't be saved, 1 waiting to send",
    "the header's button names the Outbox",
  );
  // A tick on another task goes out while the line waits, and flush leaves the line under it waiting too.
  app.flush = sending.flush;
  await app.act({ op: 'done', task: 7, run: null });
  await app.flush();
  assert.deepEqual(
    [v.task(7).done, v.requests.filter(x => x.body?.title === 'Stack them'), sync.all(1).map(x => x.raw)],
    [true, [], ['Load chairs', 'Stack them']],
  );
  // Try again sends the line with a new key, and then the line under it.
  v.trouble = () => null;
  await app.retryAct(e.entries[1].id);
  const posts = v.requests.filter(x => x.body?.title === 'Load chairs');
  assert.notEqual(posts[1].key.split(':')[0], posts[0].key.split(':')[0], 'the key is new');
  assert.deepEqual([links(v), sync.all(1)], [[[102, 103]], []]);
});

test('cancelling a line whose answer is unknown sends the line under it back to the box, with no Undo', async t => {
  const { v, app, e } = await unknownSecond(t);
  await app.dropAct(e.entries[1].id);
  assert.deepEqual(
    [sync.all(1), app.cap.text, app.toast.msg],
    [
      [],
      'Stack them',
      'Cancelled. “Load chairs” may already be added in Vikunja. The lines under it are back where you typed them.',
    ],
  );
  assert.equal(app.toast.action, null);
  assert.deepEqual(
    v.requests.filter(x => x.body?.title === 'Stack them'),
    [],
  );
});

test("a parent's progress is written once, by the last line under it, after subtasks are added to it", async t => {
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5 }]),
    app = adding(t);
  const e = entry([line('Chairs'), line('Legs', { done: true }, 0), line('Tables')], {
    parent: { id: 9, project_id: 5, title: 'Pack the van' },
  });
  await send(app, e);
  const figures = id =>
    v.requests
      .filter(x => x.method === 'PATCH' && x.path === '/tasks/' + id && 'percent_done' in x.body)
      .map(x => [x.key.split(':')[0], x.body.percent_done]);
  assert.deepEqual(
    [figures(101), figures(9)],
    [[[e.entries[1].id, 1]], [[e.entries[2].id, 0.5]]],
    'Legs writes Chairs, the line it is under, and Tables, the last line, writes Pack the van once',
  );
});

const photo = () => new File([new Uint8Array([1, 2, 3])], 'van.jpg', { type: 'image/jpeg' });
const withPhoto = (app, e) => {
  const es = opsOf(app, e);
  es[0].files = [{ key: 'k' + es[0].id, name: 'van.jpg', size: 3, type: 'image/jpeg', sent: false }];
  return es;
};
test('a photo Vikunja keeps refusing waits in an entry of its own, and the lines and ticks after it are sent', async t => {
  t.after(clear);
  const v = fakeVikunja([{ id: 7, title: 'Wipe the till', project_id: 5 }]),
    app = adding(t),
    e = entry([line('Pack the van'), line('Load chairs')]);
  v.trouble = r => (r.path.endsWith('/attachments') ? 503 : null);
  const r = shown(app, await app.sendLines(withPhoto(app, e), [photo()]));
  assert.deepEqual(
    [r.status, r.ids],
    ['offline', [101, 102]],
    'both lines are made, and the add box says the photo uploads later',
  );
  for (let i = 0; i < 6; i++) await app.act({ op: i % 2 ? 'undone' : 'done', task: 7, run: null });
  assert.equal(
    v.requests.filter(x => x.method === 'PATCH' && x.path === '/tasks/7').length,
    6,
    'every tick reaches Vikunja',
  );
  assert.deepEqual(
    sync.all(1).map(x => [x.kind, x.taskId, x.files.map(f => f.name)]),
    [[undefined, 101, ['van.jpg']]],
    'only the photo waits, for the task its line made',
  );
  v.trouble = () => null;
  const sent = await app.sendEntry(sync.all(1)[0].id);
  assert.deepEqual([sent.status, sent.uploaded, sync.all(1)], ['sent', 1, []]);
});

/* An add box says "Saved offline" only when Pocket is offline. Lines or photos that wait for a busy Vikunja say what
   the Outbox says, because Pocket stays online and sends them again by itself. */
const AT = Date.UTC(2026, 9, 21, 15, 42); // the time Pocket next sends
for (const [why, trouble, said] of [
  ['offline', () => 'offline', "Saved offline. They go to Vikunja when you're back online."],
  ['busy', r => (r.method === 'POST' ? 429 : null), busyText(AT)],
])
  test(`lines that wait say why they wait (${why})`, async t => {
    t.after(clear);
    const v = fakeVikunja([]),
      app = adding(t);
    v.trouble = trouble;
    const r = await send(app, entry([line('Pack the van'), line('Load chairs')]));
    assert.deepEqual([r.status, waitText(r, 2, 0, AT)], ['offline', said]);
  });
test('a photo that waits for a busy Vikunja says so, not that it goes once back online', async t => {
  t.after(clear);
  const v = fakeVikunja([]),
    app = adding(t),
    e = entry([line('Pack the van')]);
  v.trouble = r => (r.path.endsWith('/attachments') ? 503 : null);
  const r = shown(app, await app.sendLines(withPhoto(app, e), [photo()]));
  assert.deepEqual(
    [r.status, r.ids, photosLater('Van', 1, r.reached, AT)],
    ['offline', [101], 'Added to Van. ' + busyText(AT)],
  );
});

test('a photo whose reply is lost is sent again with the same key and body, and Vikunja gets it once', async t => {
  t.after(clear);
  const v = fakeVikunja([{ id: 7, title: 'Wipe the till', project_id: 5 }]),
    app = adding(t),
    e = entry([line('Pack the van')]);
  let lose = true;
  v.trouble = r => (r.path.endsWith('/attachments') && lose ? 'lost' : null);
  await app.sendLines(withPhoto(app, e), [photo()]);
  lose = false;
  const sent = await app.sendEntry(sync.all(1)[0].id),
    uploads = v.requests.filter(x => x.path.endsWith('/attachments'));
  assert.deepEqual(
    [sent.uploaded, uploads.length, uploads[1].key === uploads[0].key, uploads[1].replayed],
    [1, 2, true, true],
    'the second send is answered from the first',
  );
  assert.deepEqual(
    v.task(101).attachments.map(a => a.file),
    [{ name: 'van.jpg', size: 3 }],
  );
});

test('a refused change to a task does not hold back subtasks added to it, and no message names a line that waits', async t => {
  t.after(clear);
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5 }]),
    app = adding(t);
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/9' ? 403 : null);
  await app.act({ op: 'done', task: 9, run: null });
  const r = await send(app, entry([line('Chairs')], { parent: { id: 9, project_id: 5, title: 'Pack the van' } }));
  assert.deepEqual([r.status, links(v)], ['sent', [[9, 101]]]);
  // A line that waits behind a line whose answer is unknown says nothing of its own. The add box says what happened.
  await clear();
  const said = app.toasts.length;
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Parent' ? 'unknown' : null);
  await send(app, entry([line('Parent'), line('Child', {}, 0)]));
  assert.deepEqual(
    app.toasts.slice(said).filter(x => /Not sent/.test(x.msg)),
    [],
  );
});

test("a line under a line gets its parent's task from the outbox, so a tab that never saw the parent sent still links it", async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Pack the van'), line('Load chairs', {}, 0)]),
    es = opsOf(app, e);
  await app.queue(es);
  await app.sendActs(es[0].id); // this tab sends the parent only
  assert.deepEqual(
    sync.all(1).map(x => [x.raw, x.under]),
    [['Load chairs', 101]],
    "the parent's task takes the place of its waiting id",
  );
  const kept = new Map(sync.claimed);
  sync.claimed.clear(); // another tab's memory
  try {
    await resend(app, e);
  } finally {
    for (const [k, c] of kept) sync.claimed.set(k, c);
  }
  assert.deepEqual(links(v), [[101, 102]]);
});

test('a line whose parent line is gone without a task is not made, and its text goes back to the box', async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Pack the van'), line('Load chairs', {}, 0), line('Stack them', {}, 1)]);
  v.trouble = () => 'offline';
  await send(app, e);
  await sync.remove(e.entries[0].id);
  Object.assign(v, { trouble: () => null, requests: [] });
  app.offline = false;
  const r = await resend(app, e);
  assert.deepEqual(
    [r.status, v.requests.filter(x => x.method === 'POST'), sync.all(1), app.cap.text],
    ['gone', [], [], 'Load chairs\nStack them'],
  );
});

test("a line whose first request was sent can't be cancelled, and the Outbox offers no Cancel for it", async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Chairs')]);
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Chairs' ? 'lost' : null);
  await send(app, e);
  assert.deepEqual(
    app.outboxRows.map(x => x.drop),
    [null],
  );
  await app.cancelPending(e.entries[0].id);
  assert.deepEqual(
    [app.toast.msg, app.cap.text, sync.all(1).length],
    ['It was sent before it could be cancelled.', '', 1],
  );
  v.trouble = () => null;
  await resend(app, e);
  assert.deepEqual([[...v.tasks.values()].map(x => x.title), sync.all(1)], [['Chairs'], []], 'it is made once');
});

// The waiting row hides its Cancel once its line's first request is sent (task-row.html reads `sent`).
test("a waiting row offers Cancel until its line's first request is sent", async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Chairs')]);
  app.offline = true;
  await send(app, e);
  assert.deepEqual(
    [app.pendingTasks.map(x => x.sent), app.outboxRows.map(x => x.drop?.[0])],
    [[false], ['cancelPending']],
    'not tried while offline',
  );
  app.offline = false;
  v.trouble = r => (r.method === 'POST' ? 'lost' : null);
  await resend(app, e);
  assert.deepEqual([app.pendingTasks.map(x => x.sent), app.outboxRows.map(x => x.drop)], [[true], [null]]);
});

test("a line sent later whose answer is unknown is named in the message, and the message's button opens the Outbox", async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Load chairs')]);
  app.offline = true;
  await send(app, e);
  app.offline = false;
  v.trouble = r => (r.method === 'POST' ? 'unknown' : null);
  app.flush = sending.flush;
  await app.flush();
  let opened = null;
  app.openSheet = kind => {
    opened = kind;
  };
  app.toast.action.fn();
  assert.deepEqual(
    [app.toast.msg, app.toast.action.label, opened],
    [
      "Adding “Load chairs” may not have reached Vikunja. Check, then tap Try again if it's missing.",
      'Outbox',
      'outbox',
    ],
  );
});

test('a line whose answer is unknown keeps its waiting row, so the line under it stays under it', async t => {
  t.after(clear);
  const { app, e } = await unknownSecond(t),
    id = e.entries.map(x => 'pending-' + x.id);
  assert.deepEqual(
    app.pendingTasks.map(x => [x.id, x.parent]),
    [
      [id[1], null],
      [id[2], id[1]],
    ],
  );
  await clear();
});

test('cancelling a failed first line gives its photos back to the add box', async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Pack the van')]);
  v.trouble = r => (r.method === 'POST' ? 'unknown' : null);
  await app.sendLines(withPhoto(app, e), [photo()]);
  app.refreshPending();
  await app.dropAct(e.entries[0].id);
  assert.deepEqual([sync.all(1), app.capPhotos.map(f => f.name)], [[], ['van.jpg']]);
});

test("cancelling a line passes the parents' progress it was to write to a line of its batch that still waits", async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Pack the van'), line('Load chairs', { done: true }, 0), line('Tables', {}, 0), line('Sweep')]);
  v.trouble = r =>
    r.method === 'POST' && r.body?.title === 'Tables'
      ? 'unknown'
      : r.method === 'POST' && r.body?.title === 'Sweep'
        ? 'offline'
        : null;
  app.flush = async () => {};
  await send(app, e);
  await app.dropAct(e.entries[2].id);
  v.trouble = () => null;
  await resend(app, e);
  assert.equal(v.task(101).percent_done, 1, 'Sweep writes the progress of Pack the van, whose one subtask is done');
});

test("a line made by Try again after its batch's progress was written writes its parent's progress again", async t => {
  t.after(clear);
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5 }]),
    app = adding(t);
  const e = entry([line('Chairs'), line('Tables', { done: true })], {
    parent: { id: 9, project_id: 5, title: 'Pack the van' },
  });
  v.trouble = r => (r.method === 'POST' && r.body?.title === 'Chairs' ? 'unknown' : null);
  await send(app, e);
  assert.equal(v.task(9).percent_done, 1, 'Tables, the last line, wrote it without Chairs');
  v.trouble = () => null;
  app.flush = sending.flush;
  await app.retryAct(e.entries[0].id);
  assert.deepEqual([v.task(9).percent_done, sync.all(1)], [0.5, []]);
});

test('a line refused after its task was made gives nothing back, and is kept in the Outbox', async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    e = entry([line('Pack the van'), line('Load chairs', {}, 0)]);
  v.trouble = () => 'offline';
  await send(app, e);
  v.trouble = r => (r.path.endsWith('/relations') ? 403 : null);
  app.flush = sending.flush;
  await app.flush();
  assert.deepEqual(
    [app.cap.text, app.toast.msg, app.toast.action?.label],
    ['', "Adding “Load chairs” couldn't be saved: HTTP 403 from the fake. It's kept to try again.", 'Outbox'],
  );
  assert.deepEqual(
    app.outboxRows.map(x => [x.text, x.retry]),
    [['Finishing “Load chairs”', true]],
  );
});

test('when another tab sends a whole batch first, the add box is told it is gone, not saved offline', async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t),
    es = opsOf(app, entry([line('Pack the van'), line('Load chairs')]));
  await app.queue(es);
  for (const x of es) sync.entries.delete(x.id); // the other tab sent them, and this tab read the outbox again
  assert.equal(batchOf(await app.sendActs(es.at(-1).id), es).status, 'gone');
  assert.deepEqual(v.requests, []);
});

/* What a box reads before it is sent (src/js/app/quickadd.js). These helpers show the chips under the box as text (a
   chip that is tapped off has a ~ in front) and the marked text in the box as kind:text. */
const boxes = () => {
  const app = component(quickadd),
    cafe = { id: 5, title: 'Café' };
  Object.assign(app, {
    user: { id: 1, settings: { frontend_settings: {} } },
    cap: newBox(),
    runInsert: newBox(),
    capPhotos: [],
    projects: [cafe],
    projById: new Map([[5, cafe]]),
    labels: [],
    people: [],
    access: {},
    userKnown: {},
    checklistIds: new Set(),
    remindersReach: false,
    defaultProjectId: () => 5,
    canWrite: () => true,
  });
  app.sheet = { task: { id: 9, project_id: 5, title: 'Pack the van' }, sub: newBox() };
  return app;
};
const chipsOf = (app, w) => app.chips(w).map(c => (c.off ? '~' : '') + c.text);
const marksOf = (app, w) => app.marks(w).map(m => m.kind + ':' + app.box(w).text.slice(m.start, m.end));
const linesOf = (app, w) => app.boxParsedLines(w).map(p => [p.title, p.done]);
const tap = (app, w, text) =>
  app.tapChip(
    w,
    app.chips(w).find(c => c.text.includes(text)),
  );

test('a line marked as done shows a Done chip and a marked marker, and tapping the chip off keeps the marker in the title', () => {
  const app = boxes();
  app.cap.text = 'x Call Sam !2';
  assert.deepEqual(chipsOf(app, 'cap'), ['Done', 'Café', 'Priority 2']);
  assert.deepEqual(marksOf(app, 'cap'), ['done:x', 'priority:!2']);
  assert.deepEqual(linesOf(app, 'cap'), [['Call Sam', true]]);
  tap(app, 'cap', 'Done');
  assert.deepEqual(chipsOf(app, 'cap'), ['~Done', 'Café', 'Priority 2']);
  assert.deepEqual(marksOf(app, 'cap'), ['priority:!2']);
  assert.deepEqual(linesOf(app, 'cap'), [['x Call Sam', false]]);
  tap(app, 'cap', 'Done');
  assert.deepEqual(linesOf(app, 'cap'), [['Call Sam', true]], 'tapping the chip again reads the marker again');
  // A capital X, which a phone's keyboard puts at the start of a line, gives the same chip. Tapped off, the title stays as typed.
  app.cap.text = 'X Call Sam';
  assert.deepEqual(
    [chipsOf(app, 'cap')[0], marksOf(app, 'cap'), linesOf(app, 'cap')],
    ['Done', ['done:X'], [['Call Sam', true]]],
  );
  tap(app, 'cap', 'Done');
  assert.deepEqual(linesOf(app, 'cap'), [['X Call Sam', false]]);
  tap(app, 'cap', 'Done');
  // With quick add turned off in Vikunja, the box still reads the markers. They describe the list, not Vikunja's shortcuts.
  app.user.settings.frontend_settings.quick_add_magic_mode = 'disabled';
  app.cap.text = '- [x] Call Sam tomorrow (50%)';
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'progress:(50%)']);
  assert.deepEqual(
    app.boxParsedLines('cap').map(p => [p.title, p.done, p.pct]),
    [['Call Sam tomorrow', true, 50]],
  );
});

test('a list with lines marked as done shows one chip that counts them, and tapping it leaves them out or adds them back', () => {
  const app = boxes();
  app.cap.text = 'Groceries\n- [x] Eggs\n- [ ] Milk tomorrow\nx Bread';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 will be added as done', '4 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['done:[x]', 'due:tomorrow', 'done:x']);
  assert.deepEqual(linesOf(app, 'cap'), [
    ['Groceries', false],
    ['Eggs', true],
    ['Milk', false],
    ['Bread', true],
  ]);
  tap(app, 'cap', 'will be added as done');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 already ticked, left out', '2 tasks', 'Café']);
  assert.deepEqual(marksOf(app, 'cap'), ['due:tomorrow']);
  assert.deepEqual(linesOf(app, 'cap'), [
    ['Groceries', false],
    ['Milk', false],
  ]);
  tap(app, 'cap', 'left out');
  assert.deepEqual(chipsOf(app, 'cap'), ['2 will be added as done', '4 tasks', 'Café']);
  // A subtask box reads them the same way.
  app.sheet.sub.text = '[x] Load chairs\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['1 will be added as done', '2 subtasks']);
  assert.deepEqual(linesOf(app, 'sub'), [
    ['Load chairs', true],
    ['Tables', false],
  ]);
});

const under = (app, w) => app.boxParsedLines(w).map(p => p.under);
test('a pasted list with headings makes each heading a task with its lines as subtasks, and ↳ Under first line turns that off', () => {
  const app = boxes();
  app.cap.text = '## Pack the van (38%)\n- Load chairs\n- [x] Tables\n## Set the hall\n- Lights (50%)';
  assert.deepEqual(chipsOf(app, 'cap'), ['1 will be added as done', '2 tasks + 3 subtasks', 'Café']);
  assert.deepEqual(under(app, 'cap'), [null, 0, 0, null, 3]);
  assert.deepEqual(
    app.boxParsedLines('cap').map(p => [p.title, p.pct]),
    [
      ['Pack the van', 0],
      ['Load chairs', 0],
      ['Tables', 0],
      ['Set the hall', 0],
      ['Lights', 50],
    ],
    "a parent's percentage is dropped",
  );
  assert.equal(app.nestOn, true, 'the first line is a parent as the list is written');
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [false, [null, null, null, null, null]]);
  assert.deepEqual(chipsOf(app, 'cap'), ['1 will be added as done', '5 tasks', 'Café']);
  app.tapNest();
  assert.deepEqual(
    [app.nestOn, under(app, 'cap')],
    [true, [null, 0, 0, null, 3]],
    'tapping again restores the list as written',
  );
  // A list with no markers does not nest until the user taps ↳ Under first line.
  app.cap = newBox();
  app.cap.text = 'Pack the van\nLoad chairs\nTables';
  assert.deepEqual([app.nestOn, chipsOf(app, 'cap')], [false, ['3 tasks', 'Café']]);
  app.tapNest();
  assert.deepEqual(
    [app.nestOn, chipsOf(app, 'cap'), under(app, 'cap')],
    [true, ['1 task + 2 subtasks', 'Café'], [null, 0, 0]],
  );
  app.tapNest();
  assert.deepEqual([app.nestOn, under(app, 'cap')], [false, [null, null, null]]);
});

test("in a subtask box, a heading's lines go under the heading, and the heading goes under the open task", () => {
  const app = boxes();
  app.sheet.sub.text = '## Chairs\n- Stack them\n- [x] Count them\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['1 will be added as done', '4 subtasks']);
  assert.deepEqual(
    app.boxItems('sub').map(x => [x.raw, x.under]),
    [
      ['Chairs', null],
      ['Stack them', 0],
      ['x Count them', 0],
      ['Tables', 0],
    ],
  );
});

test("a checklist project's subtask box leaves a date in the title, and a @user or *label before it counts as at the end", () => {
  const app = boxes();
  Object.assign(app, { checklistIds: new Set([5]), tasks: { 9: app.sheet.task } });
  app.sheet.id = 9;
  app.sheet.sub.text = 'Call the plumber @bob *home tomorrow';
  assert.deepEqual(
    [linesOf(app, 'sub'), app.boxParsed('sub').labels, app.boxParsed('sub').due],
    [[['Call the plumber @bob tomorrow', false]], ['home'], null],
  );
});

test('a pasted list with indented lines puts each under the nearest line above it that is indented less', () => {
  const app = boxes();
  app.cap.text = 'Pack the van (38%)\n  Load chairs (50%)\n    Stack them\n  Tables\nSet the hall';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 tasks + 3 subtasks', 'Café']);
  assert.deepEqual(under(app, 'cap'), [null, 0, 1, 0, null]);
  assert.deepEqual(
    app.boxParsedLines('cap').map(p => p.pct),
    [0, 0, 0, 0, 0],
    'a percentage on a line with lines under it is dropped',
  );
  assert.equal(app.nestOn, true);
  // In a subtask box, a line goes under the line above it, which goes under the open task.
  app.sheet.sub.text = 'Chairs\n  Stack them\nTables';
  assert.deepEqual(
    app.boxItems('sub').map(x => [x.raw, x.under]),
    [
      ['Chairs', null],
      ['Stack them', 0],
      ['Tables', null],
    ],
  );
});

test("a pasted copy of a project treats its # heading as the list's name, leaves it out, and shows a chip saying so", () => {
  const app = boxes();
  app.cap.text = '# Café · 3 open · 5 done\n- [ ] Order milk\n- [ ] Pack the van\n  - [ ] Tables (50%)';
  assert.deepEqual(chipsOf(app, 'cap'), [
    'The # line is the list’s name, so it is left out',
    '2 tasks + 1 subtask',
    'Café',
  ]);
  assert.deepEqual(
    app.boxItems('cap').map(x => [x.p.title, x.under, x.p.pct]),
    [
      ['Order milk', null, 0],
      ['Pack the van', null, 0],
      ['Tables', 1, 50],
    ],
  );
  assert.equal(app.nestOn, false, 'the first task line is not a parent');
  // Alone in the box, a # line names no list. It is a task, as typed.
  app.cap.text = '# of chairs we need';
  assert.deepEqual([chipsOf(app, 'cap'), linesOf(app, 'cap')], [['Café'], [['# of chairs we need', false]]]);
});

test('in quick add, a first line ending with a colon is the parent of the other lines without its colon, unless ↳ Under first line is off', () => {
  const app = boxes();
  app.cap.text = 'Groceries:\nmilk\n- [x] eggs';
  assert.deepEqual(
    [chipsOf(app, 'cap'), app.nestOn],
    [['1 will be added as done', '1 task + 2 subtasks', 'Café'], true],
  );
  assert.deepEqual(
    app.boxItems('cap').map(x => [x.p.title, x.under]),
    [
      ['Groceries', null],
      ['milk', 0],
      ['eggs', 0],
    ],
  );
  app.tapNest();
  assert.deepEqual([chipsOf(app, 'cap'), app.nestOn], [['1 will be added as done', '3 tasks', 'Café'], false]);
  assert.deepEqual(
    app.boxItems('cap').map(x => [x.p.title, x.under]),
    [
      ['Groceries:', null],
      ['milk', null],
      ['eggs', null],
    ],
  );
  // A subtask box has no ↳ Under first line to tap off, so the colon stays in the title there.
  app.sheet.sub.text = 'Groceries:\nmilk';
  assert.deepEqual(
    app.boxItems('sub').map(x => [x.p.title, x.under]),
    [
      ['Groceries:', null],
      ['milk', null],
    ],
  );
});

/* Subtasks from the add box on a project's list (addSubtasks, actions.js; the cursor, quickadd.js). The list has Pack
   the van with Chairs under it. The box is on the task, directly under it, so the first subtask added goes ahead of
   Chairs. The added subtask becomes the highlighted row (`lit`, which each row reads by its own id), so the next
   subtasks go after it. */
const underBox = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([
    { id: 9, title: 'Pack the van', project_id: 5, related_tasks: { subtask: [{ id: 8 }] } },
    { id: 8, title: 'Chairs', done: false, project_id: 5, related_tasks: { parenttask: [{ id: 9 }] } },
  ]);
  const app = component(tasks, actions, leaving, quickadd, parts, { flush: sending.flush });
  const van = app.row(v.task(9)),
    chairs = app.row(v.task(8));
  Object.assign(app, {
    user: { id: 1, settings: { frontend_settings: {} } },
    pending: [],
    failed: [],
    slow: [],
    positions: { 8: 100 },
    projects: [],
    labels: [],
    people: [],
    access: {},
    userKnown: {},
    checklistIds: new Set(),
    remindersReach: false,
    canWrite: () => true,
    cap: newBox(),
    capPhotos: [],
    route: { name: 'project', id: 5 },
    endPlace() {},
    view: { groups: [{ key: 'open', tasks: [van, chairs] }], route: '', listView: 3 },
    cursor: null,
    lit: {},
    flash() {},
    $nextTick() {},
  });
  app.aim(van);
  const add = text => {
    app.cap.text = text;
    return app.addSubtasks('under');
  };
  // The highlighted row, and what the line above the box says the new tasks go after.
  const aimed = () => [Object.keys(app.lit), app.capTarget?.after];
  return { v, app, van, chairs, add, aimed, pos: id => v.task(id).position };
};

test('a subtask added from the add box is highlighted at once, first as a waiting row and then as its task, and the next goes after it', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  const rope = add('Rope');
  const waits = Object.keys(app.lit)[0];
  assert.deepEqual(
    aimed(),
    [[waits], 'Rope'],
    "before the subtask is kept or sent, the waiting row is highlighted and not the task's own row",
  );
  assert.deepEqual(
    app.pendingTasks.map(x => x.id),
    [waits],
    'the waiting row is already on the list, so it can be highlighted',
  );
  await rope;
  assert.deepEqual(aimed(), [['101'], 'Rope'], "once sent, the same row is highlighted, now as Vikunja's task");
  assert.deepEqual(
    app.view.groups[0].tasks.map(x => x.id),
    [9, 8, 101],
    'the task is on the list where its waiting row was',
  );
  await add('Straps');
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.ok(
    pos(101) < 100 && pos(102) > pos(101) && pos(102) < 100,
    'the first subtask goes ahead of Chairs, and each later one goes after the one before',
  );
  // Two lines typed one right after the other, with the first still being sent. The second still goes after the first.
  const one = add('Hooks'),
    two = add('Tarp');
  await Promise.all([one, two]);
  assert.deepEqual([aimed(), v.task(103).title, v.task(104).title], [[['104'], 'Tarp'], 'Hooks', 'Tarp']);
  assert.ok(pos(103) > pos(102) && pos(104) > pos(103));
});

test('offline, an added subtask waits highlighted, and is still highlighted once it is sent later', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  v.trouble = () => 'offline';
  await add('Rope');
  await add('Straps');
  const rows = app.pendingTasks.map(x => [x.id, x.title, x.position]);
  assert.deepEqual(
    aimed(),
    [[rows[1][0]], 'Straps'],
    "the last subtask's waiting row is highlighted, by the id the list gives it",
  );
  assert.deepEqual(
    rows.map(r => r[1]),
    ['Rope', 'Straps'],
  );
  assert.ok(
    rows[0][2] < 100 && rows[1][2] > rows[0][2] && rows[1][2] < 100,
    'while they wait, the subtasks are ahead of Chairs, each after the one before',
  );
  assert.deepEqual(
    [app.cursor.wait.title, app.cursor.wait.position],
    [rows[1][1], rows[1][2]],
    "the cursor has its row's title and position",
  );
  v.trouble = () => null;
  await app.flush();
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.deepEqual([pos(101), pos(102)], [rows[0][2], rows[1][2]]);
  assert.equal(sync.all(1).length, 0);
});

for (const [text, said] of [
  ['Straps', "Adding “Straps” may not have reached Vikunja. Check, then tap Try again if it's missing."],
  [
    'Rope\nStraps',
    "Added 1 of 2. Adding “Straps” may not have reached Vikunja. Check, then tap Try again if it's missing.",
  ],
])
  test(`a subtask whose answer is unknown is named in the add box, with a button that opens the Outbox (${text.split('\n').length} lines)`, async t => {
    t.after(clear);
    const { v, app, add } = underBox(t);
    v.trouble = r => (r.method === 'POST' && r.body?.title === 'Straps' ? 'unknown' : null);
    await add(text);
    const l = app.toasts.find(x => /Straps/.test(x.msg));
    assert.deepEqual([l.msg, l.place, l.action.label], [said, 'cap', 'Outbox']);
  });

for (const [text, said, button] of [
  ['Straps', "Adding “Straps” may not have reached Vikunja. Check, then tap Try again if it's missing.", 'Outbox'],
  [
    'Rope\nStraps',
    "Added 1 of 2. Adding “Straps” may not have reached Vikunja. Check, then tap Try again if it's missing.",
    'Undo',
  ],
])
  test(`a quick-add line whose answer is unknown is named in the add box (${text.split('\n').length} lines, ${button})`, async t => {
    t.after(clear);
    const { v, app } = underBox(t);
    app.cursor = null;
    app.lit = {};
    Object.assign(app, {
      projects: [{ id: 5, title: 'Van' }],
      defaultProjectId: () => 5,
      $refs: {},
      placeSent() {},
      render() {},
    });
    v.trouble = r => (r.method === 'POST' && r.body?.title === 'Straps' ? 'unknown' : null);
    app.cap.text = text;
    await app.submitCapture();
    const l = app.toasts.find(x => /Straps/.test(x.msg));
    assert.deepEqual(
      [l.msg, l.place, l.action.label],
      [said, 'cap', button],
      'Undo keeps the one button after some lines were added',
    );
  });

test('after a pasted list with nested lines, the last direct subtask is highlighted and the next subtasks go after it', async t => {
  const { v, app, add, aimed, pos } = underBox(t);
  const sent = add('Ladder\n  Check the feet\nTables\n  Fold the legs');
  assert.deepEqual(
    Object.keys(app.lit),
    [app.pendingTasks.find(x => x.title === 'Tables').id],
    'Tables is highlighted, not Fold the legs under it',
  );
  await sent;
  assert.deepEqual(aimed(), [['103'], 'Tables']);
  assert.deepEqual(
    v.requests.filter(r => r.path.endsWith('/relations')).map(r => [+r.path.split('/')[2], r.body.other_task_id]),
    [
      [9, 101],
      [101, 102],
      [9, 103],
      [103, 104],
    ],
  );
  assert.equal(app.positions[103], pos(103), 'the task has its position in the list, which the next subtasks go after');
  assert.ok(pos(101) < pos(102) && pos(102) < pos(103) && pos(103) < pos(104), 'each task goes after the one before');
  await add('Rope');
  assert.ok(pos(105) > pos(103), 'after Tables');
});

test('a subtask added as done is not highlighted because it leaves with the batch, so its task is, and the next goes under the task', async t => {
  const { app, add, aimed, pos } = underBox(t);
  await add('x Rope');
  assert.deepEqual([aimed(), app.leaving], [[['9'], ''], { 101: 'done' }]);
  await add('Straps');
  assert.deepEqual(aimed(), [['102'], 'Straps']);
  assert.ok(pos(102) < pos(101));
});

test('cancelling or refusing a waiting subtask moves the highlight to its task', async t => {
  const { v, app, add, aimed } = underBox(t);
  app.offline = true; // so neither line is sent, and each can be cancelled
  await add('Rope\nStraps');
  const [rope, straps] = sync.all(1).map(x => x.id);
  assert.deepEqual(aimed(), [['pending-' + straps], 'Straps']);
  await app.cancelPending(rope);
  assert.deepEqual(
    [aimed(), app.pendingTasks.map(x => [x.id, x.title])],
    [[['pending-' + straps], 'Straps'], [['pending-' + straps, 'Straps']]],
    'cancelling the first line keeps the highlight on the same line',
  );
  await app.cancelPending(straps);
  assert.deepEqual(
    [aimed(), app.toast.msg],
    [[['9'], ''], 'Cancelled.'],
    'cancelling the highlighted line highlights its task',
  );
  // Back online, as a read that gets through finds. If Vikunja refuses, the text goes back in the box with the reason,
  // and the task is highlighted.
  v.trouble = r => (r.method === 'POST' ? 400 : null);
  app.offline = false;
  await add('Straps');
  assert.deepEqual(
    [aimed(), app.cap.text, app.toast.msg],
    [[['9'], ''], 'Straps', "“Straps” couldn't be saved: HTTP 400 from the fake."],
  );
  assert.equal(sync.all(1).length, 0);
});

/* A ticked row is held as done where it is from the tap, before Vikunja answers (holdRow, leaving.js). The box under
   it stays under it meanwhile, so nothing moves. A row waiting for the batch can still be the cursor (canAim). If
   Vikunja refuses the tick, the row is released and open again, with the box still under it. Once the batch has cleared and the row
   has left the list, keepAim gives the box to its task. */
test('ticking the highlighted subtask keeps the box under it while it waits for the batch, and moves the box to its task once it leaves', async t => {
  const { v, app, chairs, aimed } = underBox(t);
  app.aim(chairs);
  assert.deepEqual(aimed(), [['8'], 'Chairs']);
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  let ticking = app.toggleDone(chairs, {});
  assert.deepEqual(
    [chairs.done, app.leaving, app.capW],
    [true, { 8: 'done' }, 'under'],
    'the row is held done before the tick is answered, and the box is still under it',
  );
  app.keepAim();
  assert.deepEqual(aimed(), [['8'], 'Chairs']);
  await ticking;
  assert.deepEqual(
    [!!chairs.done, app.leaving, app.toast.msg],
    [false, {}, "A tick couldn't be saved: HTTP 403 from the fake. It's kept to try again."],
    'the row is released and open again, and shows why',
  );
  app.keepAim();
  assert.deepEqual(aimed(), [['8'], 'Chairs'], 'the box stays where it was');
  await clear();
  v.trouble = () => null;
  ticking = app.toggleDone(chairs, {});
  await ticking;
  app.keepAim();
  assert.deepEqual(
    [aimed(), app.leaving, v.task(8).done],
    [[['8'], 'Chairs'], { 8: 'done' }, true],
    'once saved and marked, the box stays under the row until the batch clears',
  );
  delete app.leaving[8];
  app.keepAim();
  assert.deepEqual(aimed(), [['9'], ''], 'once the row leaves with the batch, its task has the box');
});

/* Ticking a row never moves the box (tickRow, views.js). Only a nudge does, or Add a subtask here. */
test('ticking never moves the box, so ticking another row and ticking it back leaves the box where it was', async t => {
  const { v, app, chairs, add, aimed } = underBox(t),
    g = { depth: {} };
  app.tickRow = views.tickRow;
  // Wait until nothing is still on its way: the save, taking the mark back, and the save of that.
  const quiet = async () => {
    for (let k = 0; k < 20; k++) {
      const n = v.requests.length;
      for (let i = 0; i < 20; i++) await new Promise(ok => setImmediate(ok));
      if (v.requests.length === n) return;
    }
  };
  await add('Rope');
  assert.deepEqual(aimed(), [['101'], 'Rope']);
  app.tickRow(chairs, g, {});
  assert.deepEqual(
    [aimed(), app.leaving],
    [[['101'], 'Rope'], { 8: 'done' }],
    'after ticking Chairs, the row is held done and the box is still under Rope',
  );
  app.tickRow(chairs, g, {});
  await quiet();
  assert.deepEqual(
    [aimed(), !!chairs.done, !!v.task(8).done, app.leaving],
    [[['101'], 'Rope'], false, false, {}],
    'after ticking it back, the box is still under Rope',
  );
});

test("a checklist's add box leaves out a ticked line without a chip to tap, and treats an x as a word", () => {
  const app = boxes();
  app.runInsert.text = 'x Wipe the counter\n[x] Mop\nLock up';
  assert.deepEqual(
    app.chips('ins').map(c => [c.text, c.kind]),
    [
      ['1 line is already ticked, so it is left out', undefined],
      ['2 steps', undefined],
    ],
  );
  assert.deepEqual(linesOf(app, 'ins'), [
    ['x Wipe the counter', false],
    ['Lock up', false],
  ]);
});

const notesOfLines = (app, w) => app.boxParsedLines(w).map(p => [p.title, p.notes]);
test('the text after " // " is marked and shown as notes after the other chips, and tapping the chip keeps it in the title', () => {
  const app = boxes();
  app.cap.text = 'Order paper bags +café // the brown ones, 500 count tomorrow';
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', 'Notes: the brown ones, 500 count tomorrow']);
  assert.deepEqual(marksOf(app, 'cap'), ['project:+café', 'notes:// the brown ones, 500 count tomorrow']);
  assert.deepEqual(notesOfLines(app, 'cap'), [['Order paper bags', 'the brown ones, 500 count tomorrow']]);
  tap(app, 'cap', 'Notes:');
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '~Notes: the brown ones, 500 count tomorrow']);
  assert.deepEqual(
    marksOf(app, 'cap'),
    ['project:+café', 'due:tomorrow'],
    'with the chip off, the notes are read as part of the title',
  );
  assert.deepEqual(notesOfLines(app, 'cap'), [['Order paper bags café // the brown ones, 500 count', '']]);
  // A link or a path has no spaces around its slashes, so it stays in the title.
  app.cap = newBox();
  app.cap.text = 'Check http://example.com and a//b';
  assert.deepEqual([chipsOf(app, 'cap'), marksOf(app, 'cap')], [['Café'], []]);
});

test('a pasted list gets one chip counting the lines with notes, and tapping it keeps every line’s notes in its title', () => {
  const app = boxes();
  app.cap.text = 'Order paper bags // the brown ones\nOrder till rolls\nOrder labels // white';
  assert.deepEqual(chipsOf(app, 'cap'), ['3 tasks', 'Café', 'Notes on 2 tasks']);
  assert.deepEqual(marksOf(app, 'cap'), ['notes:// the brown ones', 'notes:// white']);
  tap(app, 'cap', 'Notes on');
  assert.deepEqual(chipsOf(app, 'cap'), ['3 tasks', 'Café', '~Notes on 2 tasks']);
  assert.deepEqual(notesOfLines(app, 'cap'), [
    ['Order paper bags // the brown ones', ''],
    ['Order till rolls', ''],
    ['Order labels // white', ''],
  ]);
  // A subtask box and a checklist's box count subtasks and steps.
  app.sheet.sub.text = 'Load chairs // the folding ones\nTables';
  assert.deepEqual(chipsOf(app, 'sub'), ['2 subtasks', 'Notes on 1 subtask']);
  assert.deepEqual(notesOfLines(app, 'sub'), [
    ['Load chairs', 'the folding ones'],
    ['Tables', ''],
  ]);
  app.runInsert.text = 'Wipe the counter // with the blue cloth\nMop // both rooms';
  assert.deepEqual(chipsOf(app, 'ins'), ['2 steps', 'Notes on 2 steps']);
});

test('an indented line starting with // under a pasted line is more of its notes, marked in the box with them', () => {
  const app = boxes();
  app.cap.text = '- [ ] Tables // Two\n  //\n  // Ask first\n  - [ ] Legs';
  assert.deepEqual(chipsOf(app, 'cap'), ['1 task + 1 subtask', 'Café', 'Notes on 1 task']);
  assert.deepEqual(notesOfLines(app, 'cap'), [
    ['Tables', 'Two\n\nAsk first'],
    ['Legs', ''],
  ]);
  assert.deepEqual(marksOf(app, 'cap'), ['notes:// Two\n  //\n  // Ask first']);
  tap(app, 'cap', 'Notes on');
  assert.deepEqual(
    notesOfLines(app, 'cap')[0],
    ['Tables // Two // // Ask first', ''],
    'tapped off, they stay in the title',
  );
});

test('a line’s notes are sent as its description, in the request that makes it, as one paragraph', async t => {
  t.after(clear);
  const v = fakeVikunja([{ id: 9, title: 'Pack the van', project_id: 5 }]),
    app = adding(t),
    p = parseCapture('Order paper bags // the <brown> ones & lids', []);
  assert.deepEqual(
    packParsed(p).notes,
    'the <brown> ones & lids',
    'the notes are kept with the line, so a line sent later still has them',
  );
  v.trouble = () => 'offline';
  const e = entry([
    { raw: 'Order paper bags', p: packParsed(p), under: null },
    line('Load chairs', { notes: 'the folding ones' }, 0),
  ]);
  assert.equal((await send(app, e)).status, 'offline');
  v.trouble = () => null;
  v.requests.length = 0;
  await resend(app, e);
  assert.deepEqual(sent(v).slice(0, 2), [
    [
      'POST',
      '/projects/5/tasks',
      { title: 'Order paper bags', description: '<p>the &lt;brown&gt; ones &amp; lids</p>' },
    ],
    ['POST', '/projects/5/tasks', { title: 'Load chairs', description: '<p>the folding ones</p>' }],
  ]);
  assert.equal(v.task(101).description, '<p>the &lt;brown&gt; ones &amp; lids</p>');
});

test('typing +project suggests the projects you can add to, Enter takes the first, and a subtask box suggests none', () => {
  const app = boxes(),
    el = { value: '', focus() {}, setSelectionRange() {} };
  app.projects = [
    ...app.projects,
    { id: 6, title: 'Garden' },
    { id: 7, title: 'Garage' },
    { id: 8, title: 'Gardening club' },
    { id: 9, title: 'Home Depot' },
  ];
  Object.assign(app, { canWrite: id => id !== 8, boxEl: () => el });
  const type = (w, text) => Object.assign(app.box(w), { text, focus: true, caret: text.length });
  type('cap', 'Buy seeds +GAR');
  assert.deepEqual(chipsOf(app, 'cap'), ['+Garage  ↵', '+Garden'], 'a project you can only read is left out');
  app.boxEnter('cap');
  assert.equal(app.cap.text, 'Buy seeds +Garage ');
  // A name with a space is quoted, and an underscore stands for the space while typing.
  type('cap', 'Buy paint +home_d');
  app.boxEnter('cap');
  assert.equal(app.cap.text, 'Buy paint +"Home Depot" ');
  // A word that names a project exactly shows its chip, not suggestions.
  type('cap', 'Buy seeds +garden');
  assert.equal(chipsOf(app, 'cap')[0], 'Garden');
  // The start of more than one name picks no project. The task would go to the default project, and the box offers
  // to create the project instead.
  type('cap', 'Buy seeds +gar ');
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '+ Create project “gar”']);
  type('sub', 'Tie up the tomatoes +gar');
  assert.equal(app.suggestions('sub'), null);
});

/* Typing @ offers people. Café (5) is the default project, which carol can see and the bot can't. The bot can see only
   Garden (6), so quick add would move the task there. */
const offering = () => {
  const app = boxes(),
    el = { value: '', focus() {}, setSelectionRange() {} },
    garden = { id: 6, title: 'Garden' },
    person = (id, username, name, pids) => ({ user: { id, username, name }, pids: new Set(pids) });
  app.projects = [...app.projects, garden];
  app.projById.set(6, garden);
  app.people = [person(2, 'carol', 'Carol', [5]), person(3, 'bot-claude', 'Claude', [6])];
  Object.assign(app.access, { '5:carol': true, '6:carol': false, '5:bot-claude': false, '6:bot-claude': true });
  Object.assign(app.userKnown, { carol: true, 'bot-claude': true });
  app.boxEl = () => el;
  Object.defineProperty(app, 'sheetTask', { value: app.sheet.task });
  const type = (w, text) => Object.assign(app.box(w), { text, focus: true, caret: text.length });
  return { app, type };
};
const hintsOf = (app, w) => app.chips(w).map(c => c.hint);

test("in quick add, typing @ offers someone who can't see the project last, with the project the task moves to", () => {
  const { app, type } = offering();
  type('cap', 'Water the beans @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Carol @carol  ↵', 'Claude @bot-claude · Garden']);
  assert.deepEqual(hintsOf(app, 'cap'), ['Assign Carol, or press Enter', 'Assign Claude and add the task to Garden']);
  // Taking the suggestion gives the chip of the project the task moves to.
  app.chips('cap')[1].action();
  assert.equal(app.cap.text, 'Water the beans @bot-claude ');
  app.cap.focus = false;
  assert.deepEqual(chipsOf(app, 'cap'), ['Garden', '@bot-claude']);
  // Once the task goes to Garden, the bot comes first, and carol would leave it with no single project.
  type('cap', 'Water the beans @bot-claude @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Claude @bot-claude · Garden  ↵', 'Carol @carol']);
});

test('in quick add, someone who could move the task to more than one project is offered last with no project', () => {
  const { app, type } = offering(),
    shed = { id: 7, title: 'Shed' };
  app.projects.push(shed);
  app.projById.set(7, shed);
  Object.assign(app.access, { '7:carol': false, '7:bot-claude': true });
  type('cap', 'Water the beans @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Carol @carol  ↵', 'Claude @bot-claude']);
  app.chips('cap')[1].action();
  app.cap.focus = false;
  assert.ok(chipsOf(app, 'cap').includes("@bot-claude can't see Café"));
  // A project whose people haven't loaded yet leaves the project out too.
  delete app.access['7:bot-claude'];
  type('cap', 'Water the beans @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Carol @carol  ↵', 'Claude @bot-claude']);
});

test("a box that can't move the task offers only the people who can see its project", () => {
  const { app, type } = offering();
  type('sub', 'Stake the beans @');
  assert.deepEqual(chipsOf(app, 'sub'), ['Carol @carol  ↵']);
  // A typed +project, or the moved project's chip tapped off, keeps the task where it is.
  type('cap', 'Water the beans +Garden @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Claude @bot-claude  ↵']);
  app.cap.ignore = { autoProject: true };
  type('cap', 'Water the beans @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Carol @carol  ↵']);
  // So does a pasted list.
  app.cap.ignore = {};
  type('cap', 'Water the beans\nPick the peas @');
  assert.deepEqual(chipsOf(app, 'cap'), ['Carol @carol  ↵']);
  // Someone whose access to the project hasn't been looked up yet is offered.
  delete app.access['5:bot-claude'];
  type('sub', 'Stake the beans @');
  assert.deepEqual(chipsOf(app, 'sub'), ['Carol @carol  ↵', 'Claude @bot-claude']);
});

test('a label Vikunja does not have yet says so on its chip, once the labels have loaded', () => {
  const app = boxes();
  app.cap.text = 'Call the bank *urgent *urg';
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '*urgent', '*urg']);
  Object.assign(app, { labels: [{ id: 1, title: 'Urgent' }], labelsLoaded: true });
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '*urgent', '*urg · new label']);
});

const ERRANDS = { id: 1, title: 'errands', hex_color: 'e5a50a' };
const labelsOfLines = (app, w) => app.boxParsedLines(w).map(p => [p.title, p.labels, p.tags?.map(l => l.id)]);
test('while Today is narrowed to a label, its add boxes give each line that label, with a chip that leaves it off', () => {
  const app = boxes();
  Object.assign(app, { route: { name: 'today' }, only: ERRANDS });
  app.cap.text = 'Buy stamps';
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '*errands']);
  assert.deepEqual(labelsOfLines(app, 'cap'), [['Buy stamps', ['errands'], [1]]]);
  assert.deepEqual(labelsOfLines(app, 'under'), [['Buy stamps', ['errands'], [1]]], 'the box under a row too');
  tap(app, 'cap', '*errands');
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '~*errands']);
  assert.deepEqual(labelsOfLines(app, 'cap'), [['Buy stamps', [], undefined]]);
  tap(app, 'cap', '*errands');
  assert.deepEqual(labelsOfLines(app, 'cap'), [['Buy stamps', ['errands'], [1]]], 'tapped again, the label is back');
  // The label typed by hand has its own chip, and the line gets it once.
  app.cap.text = 'Buy stamps *Errands';
  assert.deepEqual(chipsOf(app, 'cap'), ['Café', '*Errands']);
  assert.deepEqual(labelsOfLines(app, 'cap'), [['Buy stamps', ['Errands'], undefined]]);
  app.cap.text = 'Buy stamps\nPost the parcel';
  assert.deepEqual(chipsOf(app, 'cap'), ['2 tasks', 'Café', '*errands']);
  assert.deepEqual(labelsOfLines(app, 'cap'), [
    ['Buy stamps', ['errands'], [1]],
    ['Post the parcel', ['errands'], [1]],
  ]);
  // Only Today is narrowed, and a sheet's box adds to the task in the sheet.
  app.sheet.sub.text = 'Buy stamps';
  assert.deepEqual(labelsOfLines(app, 'sub'), [['Buy stamps', [], undefined]]);
  app.route = { name: 'project', id: 5 };
  assert.deepEqual(chipsOf(app, 'cap'), ['2 tasks', 'Café']);
  assert.deepEqual(labelsOfLines(app, 'cap')[0], ['Buy stamps', [], undefined]);
});

test('a task added while Today is narrowed to a label shows there at once, and Vikunja gives it the label', async t => {
  t.after(clear);
  const v = fakeVikunja(),
    app = adding(t);
  v.labels.push({ ...ERRANDS });
  Object.assign(app, {
    route: { name: 'today' },
    only: ERRANDS,
    labels: [ERRANDS],
    cardAdded: {},
    loadLabels: views.loadLabels,
    projects: [{ id: 5, title: 'Café' }],
    projById: new Map([[5, { id: 5, title: 'Café' }]]),
    defaultProjectId: () => 5,
    $refs: {},
    flash() {},
  });
  Object.assign(app.cap, newBox());
  const today = () => app.listGroups.flatMap(g => g.tasks.map(x => [x.title, x.labels.map(l => l.title)]));
  v.trouble = () => 'offline';
  app.cap.text = 'Buy stamps';
  await app.submitCapture();
  assert.deepEqual(today(), [['Buy stamps', ['errands']]], 'the waiting row has the label, so it shows');
  v.trouble = () => null;
  app.offline = false;
  await app.sendActs(sync.all(1).at(-1).id);
  assert.deepEqual(
    v.task(101).labels.map(l => l.title),
    ['errands'],
  );
  app.cap.text = 'Post the parcel';
  await app.submitCapture();
  assert.deepEqual(
    [v.task(102).labels.map(l => l.title), today().at(-1)],
    [['errands'], ['Post the parcel', ['errands']]],
    'sent at once, the task shows with its label',
  );
});

/* A list's box (footBox, app/sheet.js). At the bottom of the list its label says what the box takes. Under a row, the
   label says what one line makes, and `rest` is the label the box has at the bottom. This holds for a task's subtasks,
   a template's steps and a checklist's steps. */
test("a list's add box under a row is labelled with what one line makes, and at the bottom with what the box takes", () => {
  const box = (of, where = 'sheet') => {
    const b = sheetPart.footBox.call({ subBoxCan: false, boxParsedLines: () => [], ...of }, where);
    return [b.under, b.says, b.rest];
  };
  assert.deepEqual(box({ subBoxW: 'sub', isStepList: false, sheet: { subAt: null } }), [
    false,
    'Add subtasks, or paste a list',
    'Add subtasks, or paste a list',
  ]);
  assert.deepEqual(box({ subBoxW: 'sub', isStepList: false, sheet: { subAt: 8 } }), [
    true,
    'Subtask',
    'Add subtasks, or paste a list',
  ]);
  assert.deepEqual(box({ subBoxW: 'add:+', isStepList: true, sheet: { subAt: 8 } }), [
    true,
    'Step',
    'Add steps, or paste a list',
  ]);
  const above = { title: 'Mop the floor', pending: false };
  assert.deepEqual(box({ runAim: { above }, runBoxAt: null }, 'run'), [
    false,
    'Add steps, or paste a list',
    'Add steps, or paste a list',
  ]);
  assert.deepEqual(box({ runAim: { above }, runBoxAt: 52 }, 'run'), [true, 'Step', 'Add steps, or paste a list']);
  // Under the last row, the box is where it is at the bottom, so it says what it says there.
  assert.deepEqual(box({ runAim: { above }, runBoxAt: 54, runBoxEnd: true }, 'run'), [
    false,
    'Add steps, or paste a list',
    'Add steps, or paste a list',
  ]);
  assert.deepEqual(box({ subBoxW: 'sub', isStepList: false, sheet: { subAt: 9, subEnd: true } }), [
    false,
    'Add subtasks, or paste a list',
    'Add subtasks, or paste a list',
  ]);
});

/* The sheet's own box under a subtask (nudgedSub, app/sheet.js) decides where its lines go. */
test("the sheet's box under a subtask puts new subtasks after it, each after the one before, and at the bottom puts them after the last", t => {
  const { app, chairs } = underBox(t);
  const straps = app.row({ id: 7, title: 'Straps', project_id: 5 });
  Object.defineProperty(app, 'subtasks', { value: [chairs, straps], configurable: true });
  app.positions = { 8: 100, 7: 200 };
  app.sheet = { subView: 3, subAt: null, subAfter: null };
  assert.deepEqual(app.subPlaces(1), [200 + 65536], 'at the bottom, the position is after the last subtask');
  app.sheet.subAt = 8;
  assert.deepEqual(app.subPlaces(2), [150, 175], 'under Chairs, the positions are after Chairs and before Straps');
  assert.deepEqual(
    app.subPlaces(1),
    [187.5],
    'the next subtask, while the first two are still on their way, goes after them',
  );
  app.sheet = { subView: null, subAt: 8, subAfter: null };
  assert.equal(app.subPlaces(1), null, 'when the order is not read yet, there is no position to give');
});
