// Tests for what happens to a task from its sheet (src/js/app/actions.js), against a fake Vikunja: its title, the
// order its saves go in, its menu, detaching it from its parent, and moving it to another project.
import './browser.mjs';
import { patches, opened } from './actions-helpers.mjs';
import { fakeVikunja, component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import actions from '../../src/js/app/actions.js';
import tasks, { copyOf } from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import sheet from '../../src/js/app/sheet.js';
import views from '../../src/js/app/views.js';
import checklists from '../../src/js/app/checklists.js';
import acts from '../../src/js/app/acts.js';
import outbox from '../../src/js/app/outbox.js';
import { sync } from '../../src/js/sync.js';

test('saves to a task go one after another, in the order they were made', async () => {
  const v = fakeVikunja([{ id: 1, title: 'A', done: false }]),
    app = component(tasks, actions);
  const order = [],
    fetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    order.push('sent ' + o.body);
    await new Promise(r => setTimeout(r, 20));
    const res = await fetch(url, o);
    order.push('back ' + o.body);
    return res;
  };
  await Promise.all([app.saveTask(1, { title: 'B' }), app.saveTask(1, { title: 'C' })]);
  assert.deepEqual(order, ['sent {"title":"B"}', 'back {"title":"B"}', 'sent {"title":"C"}', 'back {"title":"C"}']);
  assert.equal(v.task(1).title, 'C');
  assert.equal(copyOf(1).title, 'C', "Vikunja's copy is its latest");
});
/* A title being edited, in the box in the sheet's own row or in a template's box over its card, is saved when the box
   loses focus. A sheet that is slid down or closed with the phone's Back doesn't take focus from the box, and on an
   iPhone there is no button to move the focus to. So leaving the sheet saves the title too, once, whichever happens
   first. */
test('a title being edited is saved once when its sheet closes, however it closes, and an empty title is not saved', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja([
    { id: 1, title: 'Wipe the menus', project_id: 1 },
    { id: 2, title: 'TEMPLATE: Opening', project_id: 1, done: true, labels: [{ id: 9, title: 'template' }] },
    { id: 3, title: 'Order cups', project_id: 2, labels: [{ id: 9, title: 'template' }] },
  ]);
  const app = component(tasks, actions, views, sheet, checklists, acts, sending, outbox);
  app.checklistIds = new Set([1]);
  // The title goes through the outbox, as an edit op.
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], slow: [], places: {}, endPlace() {}, render() {} });
  Object.defineProperty(app, 'toast', { value: {} });
  c.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  globalThis.history = {
    state: null,
    pushState(s) {
      this.state = s;
    },
    replaceState(s) {
      this.state = s;
    },
  };
  document.getElementById = () => ({ querySelector: () => ({}) });
  Object.defineProperty(app, 'canEdit', { get: () => true });
  Object.assign(app, { picker: {}, $nextTick() {}, keepTemplate() {}, aim() {}, unsay() {} });
  const open = id => {
    app.openSheet('task');
    app.sheet.show = true;
    app.showTask(structuredClone(v.task(id)));
  };
  const sent = async () => {
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    return patches(v);
  };
  try {
    open(1);
    app.editTitle();
    app.sheet.title = 'Wipe the menus and the tables ';
    app.closeSheet(); // closed by sliding down or the phone's Back, so the box keeps the focus
    assert.deepEqual(
      await sent(),
      [[1, { title: 'Wipe the menus and the tables' }]],
      'the title is saved as the sheet is left',
    );
    assert.equal(app.sheet.titleEdit, false);
    app.saveTitle(); // the box's blur comes later
    c.mock.timers.tick(300); // the sheet has closed
    app.saveTitle(); // or the blur comes only now, as the box goes with the sheet
    assert.equal((await sent()).length, 1, 'the title is saved only once');
    // An emptied title stays as it was.
    open(1);
    app.editTitle();
    app.sheet.title = '   ';
    app.closeSheet(true);
    assert.equal((await sent()).length, 1, 'an emptied title sends nothing');
    // A title that is not being edited has nothing to save.
    open(1);
    app.closeSheet(true);
    assert.equal((await sent()).length, 1);
    // A template's name is edited in the box over its card, which has focus. It is saved with "TEMPLATE: " kept in front.
    open(2);
    document.activeElement = { id: 'd-title' };
    app.sheet.title = 'Opening up';
    app.closeSheet(true);
    assert.deepEqual((await sent())[1], [2, { title: 'TEMPLATE: Opening up' }]);
    // A task labelled "template" outside a Checklists project is an ordinary task, and its title is saved as typed.
    open(3);
    app.sheet.title = 'Order cups and lids';
    app.closeSheet(true);
    assert.deepEqual((await sent())[2], [3, { title: 'Order cups and lids' }]);
  } finally {
    delete document.activeElement;
    delete document.getElementById;
    delete globalThis.history;
  }
});
/* On a desktop, Escape closes the innermost thing first. That is the task's ⋯ menu, wherever the focus is, and the
   focus then goes back to ⋯. Only after that does Escape close the sheet. With no sheet open it does nothing. */
test("Escape closes the task's menu before its sheet and moves the focus back to ⋯", () => {
  const app = component(sheet),
    did = [];
  document.getElementById = id => ({ focus: () => did.push('focus ' + id) });
  app.closeSheet = () => did.push('close');
  try {
    app.sheet = { open: true, menu: true };
    app.escapeKey();
    assert.deepEqual(
      [app.sheet.menu, did],
      [false, ['focus d-more']],
      'Escape closes the menu first and leaves the sheet open',
    );
    app.escapeKey();
    assert.deepEqual(did, ['focus d-more', 'close'], 'the next Escape closes the sheet');
    app.sheet = { open: false, menu: false };
    app.escapeKey();
    assert.equal(did.length, 2, 'with nothing open, Escape does nothing');
  } finally {
    delete document.getElementById;
  }
});
/* "Turn into its own task" (ownTask, in the ⋯ menu on a subtask's sheet) removes the subtask from under its parent and
   puts it right after the parent in the project's List view. The old parent's calculated progress is then written
   without the subtask. A message with an Undo appears at the top of the sheet, and Undo puts the subtask back under
   its parent where it was. It is not available for a checklist's step or a template's. */
test('turning a subtask into its own task moves it right after its parent, and Undo puts it back', async () => {
  const parent = {
    id: 10,
    title: 'Pack the van',
    done: false,
    percent_done: 0.5,
    project_id: 5,
    related_tasks: { subtask: [{ id: 11 }, { id: 12 }] },
  };
  const kid = (id, f = {}) => ({
    id,
    title: 'Kid ' + id,
    done: false,
    percent_done: 0,
    project_id: 5,
    related_tasks: { parenttask: [{ id: 10, title: 'Pack the van', project_id: 5 }] },
    ...f,
  });
  const v = fakeVikunja([parent, kid(11, { done: true }), kid(12)]),
    app = component(tasks, actions),
    moves = [];
  Object.defineProperties(
    app,
    Object.getOwnPropertyDescriptors({
      positions: { 10: 1000, 11: 100, 12: 200 },
      projById: new Map([[5, { id: 5, views: [{ id: 7, view_kind: 'list', position: 1 }] }]]),
      cursor: null,
      canEdit: true,
      checklistRole: null,
      get parentTask() {
        return this.sheetTask?.related_tasks?.parenttask?.[0] || null;
      },
      showTask() {},
      linkSubtask: sending.linkSubtask,
      act: async a => {
        moves.push([a.op, a.task, a.view, a.pos]);
        return { status: 'sent' };
      },
    }),
  );
  app.row(v.task(10));
  opened(app, v.task(12), { kind: 'task' });
  app.checklistRole = 'step';
  assert.equal(app.canOwn, false, "a checklist's step cannot become its own task");
  app.checklistRole = null;
  assert.equal(app.canOwn, true);
  await app.ownTask();
  assert.deepEqual(
    [v.task(12).related_tasks.parenttask, v.task(10).related_tasks.subtask.map(s => s.id)],
    [[], [11]],
    'the subtask is removed from the parent, and the parent no longer lists it',
  );
  assert.deepEqual(
    moves,
    [['position', 12, 7, 1000.01]],
    'the task goes right after its old parent, a little after it, because the list is not on screen to give the next position',
  );
  assert.deepEqual(
    [app.sheetTask === app.tasks[12], app.tasks[12].related_tasks.parenttask, app.canOwn],
    [true, [], false],
    'the sheet reads the row, which shows it without a parent',
  );
  assert.deepEqual(
    patches(v).at(-1),
    [10, { percent_done: 1 }],
    "the old parent's progress is calculated without the task",
  );
  assert.deepEqual(
    [app.toast.msg, app.toast.place, app.toast.action.label],
    ['No longer a subtask of “Pack the van”', 'sheet:top', 'Undo'],
  );
  await app.toast.action.fn();
  assert.deepEqual(
    [v.task(12).related_tasks.parenttask.map(p => p.id), v.task(10).related_tasks.subtask.map(s => s.id)],
    [[10], [11, 12]],
    'Undo puts the subtask under its parent again',
  );
  assert.deepEqual(
    [moves.at(-1), patches(v).at(-1)],
    [
      ['position', 12, 7, 200],
      [10, { percent_done: 0.5 }],
    ],
    "Undo restores the subtask's position among the subtasks and counts it in the progress again",
  );
  // If Vikunja refuses, a message with Try again appears and nothing changes.
  v.trouble = r => (r.method === 'DELETE' ? 403 : null);
  await app.ownTask();
  assert.deepEqual(
    [app.toast.action.label, app.toast.cls, v.task(12).related_tasks.parenttask.map(p => p.id), moves.length],
    ['Try again', 'failed', [10], 2],
  );
});
/* Moving a task to another project (moveTask, from "Move to another project" in the ⋯ menu or the Project row under
   Details) takes its subtasks at every level, where Vikunja's web app moves only the task. The message has an Undo,
   which puts the task and each subtask that moved back in the project it came from. */
const twoProjects = c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const t = (id, project_id, subs = []) => ({
    id,
    title: 'Task ' + id,
    done: false,
    project_id,
    related_tasks: { subtask: subs.map(([id, project_id]) => ({ id, project_id })) },
  });
  // Task 10 has the subtasks 11 and 12, and 11 has the subtask 13. Subtask 12 is already in the other project.
  const v = fakeVikunja([
      t(10, 5, [
        [11, 5],
        [12, 6],
      ]),
      t(11, 5, [[13, 5]]),
      t(12, 6),
      t(13, 5),
    ]),
    app = component(tasks, actions);
  Object.defineProperties(
    app,
    Object.getOwnPropertyDescriptors({
      projById: new Map([
        [5, { id: 5, title: 'Inbox' }],
        [6, { id: 6, title: 'Errands' }],
      ]),
      canEdit: true,
      checklistRole: null,
      save: sheet.save,
      showTask() {},
    }),
  );
  opened(app, v.task(10), { kind: 'task' });
  return { v, app, where: () => [10, 11, 12, 13].map(id => v.task(id).project_id) };
};
test('moving a task to another project takes its subtasks at every level, and Undo puts each back', async c => {
  const { v, app, where } = twoProjects(c);
  await app.moveTask(6, 'sheet:top');
  assert.deepEqual(
    patches(v),
    [
      [10, { project_id: 6 }],
      [11, { project_id: 6 }],
      [13, { project_id: 6 }],
    ],
    'the subtask already there is not sent',
  );
  assert.deepEqual([app.sheetTask.project_id, where()], [6, [6, 6, 6, 6]]);
  assert.deepEqual(
    [app.toast.msg, app.toast.place, app.toast.action.label],
    ['Moved to Errands, with its 2 subtasks', 'sheet:top', 'Undo'],
  );
  v.requests.length = 0;
  await app.toast.action.fn();
  assert.deepEqual(patches(v), [
    [10, { project_id: 5 }],
    [11, { project_id: 5 }],
    [13, { project_id: 5 }],
  ]);
  assert.deepEqual(
    [where(), app.sheetTask.project_id, app.said],
    [[5, 5, 6, 5], 5, 'Moved back to Inbox'],
    'the subtask that was in the other project all along stays there',
  );
});
test('a move that stops at a subtask says so, and Undo moves back only what moved', async c => {
  const { v, app, where } = twoProjects(c);
  v.trouble = r => (r.method === 'PATCH' && r.path === '/tasks/13' ? 403 : null);
  await app.moveTask(6);
  assert.deepEqual(where(), [6, 6, 6, 5]);
  assert.match(app.toast.msg, /^Moved, but not all its subtasks: /);
  assert.deepEqual(
    [app.toast.place, app.toast.cls, app.toast.action.label],
    ['sheet:props', 'failed', 'Undo'],
    'from the Project row, the message is under that row',
  );
  v.requests.length = 0;
  await app.toast.action.fn();
  assert.deepEqual(
    [patches(v), where()],
    [
      [
        [10, { project_id: 5 }],
        [11, { project_id: 5 }],
      ],
      [5, 5, 6, 5],
    ],
  );
});
test('a move Vikunja refuses leaves the subtasks where they are', async c => {
  const { v, app, where } = twoProjects(c);
  v.trouble = r => (r.method === 'PATCH' ? 403 : null);
  await app.moveTask(6);
  assert.deepEqual([patches(v).map(([id]) => id), where()], [[10], [5, 5, 6, 5]], 'only the task itself was tried');
  assert.deepEqual([app.toast.place, app.toast.cls, app.toast.action.label], ['sheet:top', 'failed', 'Try again']);
});
test('a template, a checklist and their steps cannot move to another project, and a read-only task cannot either', async c => {
  const { v, app } = twoProjects(c);
  for (const role of ['template', 'tplstep', 'run', 'step']) {
    app.checklistRole = role;
    assert.equal(app.canMove, false, role);
    await app.moveTask(6);
  }
  assert.deepEqual(v.requests, [], 'nothing is sent');
  app.checklistRole = 'candidate';
  assert.equal(app.canMove, true, 'a plain task in a checklist project can move out of it');
  app.canEdit = false;
  assert.equal(app.canMove, false);
});
