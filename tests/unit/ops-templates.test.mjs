// Tests for the template ops (src/js/ops/templates.js) and the template editor that queues them
// (src/js/app/checklists.js), against a fake Vikunja behind the plugin's relay: Make template, New template, steps added
// under a template, and a step's edit box.
import './browser.mjs';
import { sender, noConnection, settle, lastSaid } from './ops-helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyOf, started, TASK } from '../../src/js/app/tasks.js';
import { sync } from '../../src/js/sync.js';
import checklists from '../../src/js/app/checklists.js';
import quickadd from '../../src/js/app/quickadd.js';

const TEMPLATE = { id: 601, title: 'template' },
  FLOOR = { id: 600, title: 'floor' },
  BOB = { id: 7, username: 'bob', name: 'Bob' };
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
// Connect again, and send what waits.
const online = async (t, app, v) => {
  v.trouble = () => null;
  app.offline = false;
  await app.flush();
  await settle(t, () => !outbox().some(e => !e.failed));
};

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

// Task 7 was duplicated from tasks 5 and 6 in the web app, so it has two "copied from" links.
const copied = () =>
  [
    ...closing({ 7: { related_tasks: { subtask: [{ id: 8 }, { id: 9 }], copiedfrom: [{ id: 5 }, { id: 6 }] } } }),
    { id: 5, title: 'Closing (old)', related_tasks: { copiedto: [{ id: 7 }] } },
    { id: 6, title: 'Closing (older)', related_tasks: { copiedto: [{ id: 7 }] } },
  ].map(t => ({ project_id: 5, done: false, description: '', labels: [], assignees: [], ...t }));
test('Make template refused as it deletes its second "copied from" link puts back the first on Cancel', async t => {
  const { v, app } = editor(t, copied());
  v.trouble = r => (r.method === 'DELETE' && r.path === '/tasks/7/relations/copiedfrom/6' ? 403 : null);
  await app.act({ op: 'makeTemplate', task: 7, run: null, steps: [8, 9] });
  assert.deepEqual(ids(v.task(7).related_tasks.copiedfrom), [6], 'the first link is deleted');
  v.trouble = () => null;
  await app.dropAct(outbox()[0].id);
  await settle(t, () => !outbox().length);
  assert.deepEqual(
    [ids(v.task(7).related_tasks.copiedfrom).sort(), ids(v.task(7).labels), v.task(8).done, outbox()],
    [[5, 6], [], false, []],
  );
});

test("Cancel of Make template leaves a step a teammate ticked first, and puts back a repeating step's date", async t => {
  const due = '2026-10-09T09:00:00.000Z',
    { v, app } = editor(t, closing({ 8: { due_date: due, repeat_after: 86400 } }));
  noConnection(app, v);
  await app.act({ op: 'makeTemplate', task: 7, run: null, steps: [8, 9] });
  v.task(9).done = true; // a teammate ticks step 9 in the web app
  // Vikunja refuses the last request, which marks the task done and names it.
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/7' ? 403 : null);
  app.offline = false;
  await app.flush();
  await settle(t, () => outbox()[0]?.failed);
  assert.notEqual(v.task(8).due_date, due, 'Vikunja moves the repeating step on to its next date');
  v.trouble = () => null;
  await app.dropAct(outbox()[0].id);
  await settle(t, () => !outbox().length);
  assert.deepEqual([v.task(8).due_date, v.task(8).done, v.task(9).done, outbox()], [due, false, true, []]);
});

test('Try again after Vikunja refused to name the template keeps a rename made since', async t => {
  const { v, app } = editor(t, closing());
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/7' ? 403 : null);
  await app.act({ op: 'makeTemplate', task: 7, run: null, steps: [8, 9] });
  v.trouble = () => null;
  v.task(7).title = 'Closing up'; // a teammate renames it in the web app
  await app.retryAct(outbox()[0].id);
  await settle(t, () => !outbox().length);
  assert.deepEqual([v.task(7).title, v.task(7).done, outbox()], ['TEMPLATE: Closing up', true, []]);
});

test('Make template shows the template at once, waits in the Outbox offline, and is sent whole', async t => {
  const { v, app } = editor(t, closing({ 9: { done: true } }));
  Object.defineProperty(app, 'subtasks', { get: () => [8, 9].map(id => app.tasks[id]) });
  app.sheet = { id: 7, kind: 'task', sub: {} };
  noConnection(app, v);
  await app.makeTemplate();
  assert.deepEqual(
    [app.tasks[7].done, app.tasks[7].title, app.tasks[7].labels.map(l => l.title), outbox()[0].steps],
    [true, 'TEMPLATE: Closing', ['template'], [8]],
    'the row is the template, and only the open step is marked done',
  );
  assert.equal(lastSaid(app).msg, "Saved offline. It goes to Vikunja when you're back online.");
  await online(t, app, v);
  assert.deepEqual(
    [ids(v.task(7).labels), v.task(7).done, v.task(7).title, v.task(8).done, outbox()],
    [[601], true, 'TEMPLATE: Closing', true, []],
  );
});

/* New template (sheet/new-template.html) in project 5, named "Opening up", with the lines typed as its steps. */
const newTemplate = (app, lines) => {
  app.sheet = {
    kind: 'newtpl',
    sub: {},
    newTpl: {
      project: { id: 5, title: 'Café' },
      box: { text: 'Opening up', ignore: {} },
      rows: lines.map(text => app.newStepRow(text)),
      add: { text: '' },
      busy: false,
    },
  };
  return app.sheet.newTpl;
};
test('New template makes its task, its steps done under it, and then the template, as ops', async t => {
  const { v, app } = editor(t, []);
  newTemplate(app, ['Turn on the machine', 'Wipe the tables T#10m']);
  await app.createTemplate();
  assert.deepEqual(
    [101, 102, 103].map(id => [v.task(id).title, v.task(id).done]),
    [
      ['TEMPLATE: Opening up', true],
      ['Turn on the machine', true],
      ['Wipe the tables T#10m', true],
    ],
  );
  assert.deepEqual(
    [ids(v.task(101).labels), ids(v.task(101).related_tasks.subtask), lastSaid(app).msg],
    [[601], [102, 103], 'Created Opening up. Start it here.'],
  );
});

test('New template offline waits in the Outbox and is made once Pocket reaches Vikunja', async t => {
  const { v, app } = editor(t, []);
  noConnection(app, v);
  const nt = newTemplate(app, ['Turn on the machine']);
  await app.createTemplate();
  assert.deepEqual(
    [outbox().map(e => e.op), nt.made, lastSaid(app).msg],
    [['add', 'templateStep', 'makeTemplate'], true, "Saved offline. It goes to Vikunja when you're back online."],
  );
  await online(t, app, v);
  assert.deepEqual(
    [v.task(101).title, v.task(101).done, ids(v.task(101).labels), v.task(102).done, outbox()],
    ['TEMPLATE: Opening up', true, [601], true, []],
  );
});

test('New template keeps its sheet open when Vikunja refuses its name, and sends none of its steps', async t => {
  const { v, app } = editor(t, []);
  v.trouble = r => (r.method === 'POST' && r.path === '/projects/5/tasks' ? 403 : null);
  const nt = newTemplate(app, ['Turn on the machine']);
  await app.createTemplate();
  assert.deepEqual(
    [nt.busy, nt.made, lastSaid(app).msg, outbox(), v.tasks.size],
    [false, undefined, 'Not created: HTTP 403 from the fake', [], 0],
  );
});

test('steps added under a step of a template go after it, each after the one before, and are made done', async t => {
  const { v, app } = editor(
    t,
    closing({
      7: { title: 'TEMPLATE: Closing', done: true, labels: [TEMPLATE], description: '<p>pocket:order 8 9</p>' },
    }),
  );
  app.sheet = { id: 7, kind: 'task', sub: {}, subAt: 8, subAfter: null, addRows: [] };
  const draft = added =>
    Object.defineProperty(app, 'draft', { value: () => ({ added, renames: [] }), configurable: true });
  Object.defineProperty(app, 'draftIgnores', { value: () => [] });
  draft(['Wipe the till', 'Count the float']);
  noConnection(app, v);
  await app.addTemplateSteps();
  assert.equal(lastSaid(app).msg, "Saved offline. They go to Vikunja when you're back online.");
  // A second batch, added while the first waits, goes after the first.
  draft(['Turn off the lights']);
  await app.addTemplateSteps();
  await online(t, app, v);
  assert.deepEqual(
    [v.task(7).description, [101, 102, 103].map(id => v.task(id).done)],
    ['<p>pocket:order 8 101 102 103 9</p>', [true, true, true]],
  );
  draft(['Set the alarm']);
  await app.addTemplateSteps();
  assert.deepEqual(
    [v.task(7).description, app.sheet.subAt],
    ['<p>pocket:order 8 101 102 103 104 9</p>', 104],
    'once its steps are made, the box sits under the last of them',
  );
});

// A template's step, 8, open in its edit box. `titles` is every step's title once it is saved (stepEditDraft).
const editing = (app, edit, titles) => {
  Object.defineProperty(app, 'subtasks', { get: () => [8, 9].map(id => app.tasks[id]) });
  Object.defineProperty(app, 'stepEditDraft', { value: () => ({ titles }) });
  Object.defineProperty(app, 'canEdit', { value: true });
  Object.assign(app, { canSee: async () => true, findUser: async () => BOB });
  app.projById = new Map();
  app.sheet = { id: 7, kind: 'task', sub: {}, stepEdit: { id: 8, ignore: {}, ...edit } };
};
test("a step's new title applies its @person, *label and !priority as ops, and saves the title without them", async t => {
  const { v, app } = editor(t, closing({ 7: { title: 'TEMPLATE: Closing', done: true, labels: [TEMPLATE] } }));
  editing(app, { text: 'Mop the floor twice @bob *floor !3' }, ['Mop the floor twice @bob *floor !3', 'Lock up']);
  await app.saveStepEdit(0);
  assert.deepEqual(
    [v.task(8).title, v.task(8).priority, ids(v.task(8).assignees), ids(v.task(8).labels), outbox()],
    ['Mop the floor twice', 3, [7], [600], []],
  );
});

test("a step's people and labels tapped off in its edit box are taken off as ops, and leave Vikunja's copy", async t => {
  const { v, app } = editor(t, closing({ 8: { assignees: [BOB], labels: [FLOOR] } }));
  editing(app, { text: 'Mop the floor', drop: { u7: true, l600: true } }, ['Mop the floor', 'Lock up']);
  await app.saveStepEdit(0);
  assert.deepEqual(
    [ids(v.task(8).assignees), ids(v.task(8).labels), ids(copyOf(8).assignees), ids(copyOf(8).labels)],
    [[], [], [], []],
  );
});

test("a template's step whose add is cancelled after it was made is hidden until Vikunja deletes it", async t => {
  const { v, app } = editor(
    t,
    closing({
      7: { title: 'TEMPLATE: Closing', done: true, labels: [TEMPLATE], description: '<p>pocket:order 8 9</p>' },
    }),
  );
  // Vikunja refuses the step's place in the template's order, after it made the step.
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/7' ? 403 : null);
  const p = { title: 'Wipe the till', labels: [], assignees: [] };
  await app.act({ op: 'templateStep', task: 7, under: 7, pid: 5, p, after: 8, run: null });
  v.trouble = () => 'offline';
  await app.cancelMade(outbox()[0].id, true);
  assert.deepEqual([v.tasks.has(101), app.hiddenRows.has(101)], [true, true], 'the step is hidden while Cancel waits');
  await online(t, app, v);
  assert.deepEqual([v.tasks.has(101), app.hiddenRows.has(101), outbox()], [false, false, []]);
});
