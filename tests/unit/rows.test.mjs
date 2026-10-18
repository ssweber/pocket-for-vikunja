// The shared row (src/markup/task-row.html) renders a task, a subtask in a sheet and a step on a checklist's screen.
// These tests check what the row asks the component, given the options of the list it is in (`g`).
import { component, outboxOf } from './fake.mjs';
import { watching } from './reactive.mjs';
import sending from '../../src/js/app/sending.js';
import tasks, { started, TASK } from '../../src/js/app/tasks.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import views from '../../src/js/app/views.js';
import claims from '../../src/js/app/claims.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';
import { rowGestures, screenRows, SHEET_ROW } from '../../src/js/lists.js';
import runs from '../../src/js/app/runs.js';
import asks from '../../src/js/app/asks.js';
import checklists from '../../src/js/app/checklists.js';
import cards from '../../src/js/app/cards.js';
import quickadd from '../../src/js/app/quickadd.js';
import sheet from '../../src/js/app/sheet.js';
import throwing from '../../src/js/app/throw.js';
import { THROW_STAYS } from '../../src/js/throw.js';
import { HOLD_MS, TEXT_FIELD } from '../../src/js/progress.js';

const RUN = { depth: {}, run: true, at: 0, locked: false };
// A step as the checklist screen builds it (runView, runs.js), with only the fields the row reads.
const step = f => ({
  id: 7,
  i: 0,
  title: 'Take the croissants out',
  done: false,
  skipped: false,
  slow: false,
  added: '',
  notes: [],
  dueText: '',
  late: false,
  slot: null,
  ...f,
});

test("ticking a step, a subtask, a task or the sheet's own row calls the matching action", () => {
  const app = component(views, claims, leaving),
    calls = [];
  Object.assign(app, {
    tickStep: (s, op) => calls.push(['step', s.id, op]),
    toggleSubtask: t => calls.push(['sub', t.id]),
    toggleDone: (t, row) => calls.push(['task', t.id, row]),
    aim: t => calls.push(['aim', t.id]),
  });
  app.tickRow(step({}), RUN);
  app.tickRow(step({ done: true }), RUN);
  app.tickRow({ id: 3 }, { depth: {}, sheet: true });
  app.tickRow({ id: 4 }, { depth: {} }, 'row');
  app.sheetDone = () => calls.push(['sheet']);
  app.tickRow({ id: 5 }, SHEET_ROW, 'row');
  assert.deepEqual(
    calls,
    [['step', 7, 'done'], ['step', 7, 'undone'], ['sub', 3], ['task', 4, 'row'], ['sheet']],
    "the sheet's own row uses the sheet's tick",
  );
});

/* Tapping a row's title (tapRow) does something different depending on where the row is. This replaces one long
   expression in the markup. */
test("tapping a row's title does what suits the row: show a step, edit the sheet's title, or open the task", () => {
  const app = component(views),
    calls = [];
  Object.assign(app, {
    showStep: (i, tap) => calls.push(['step', i, tap]),
    editTitle: () => calls.push(['edit']),
    openTask: id => calls.push(['task', id]),
    openRow: t => calls.push(['row', t.id]),
  });
  app.tapRow(step({ i: 2 }), RUN);
  app.tapRow({ id: 5 }, SHEET_ROW);
  app.tapRow({ id: 6 }, { depth: {}, sheet: true });
  app.tapRow({ id: 7 }, { depth: {}, top: true });
  app.tapRow({ id: 8 }, { depth: {} });
  app.tapRow({ id: 9 }, { depth: {}, card: {} });
  assert.deepEqual(calls, [['step', 2, true], ['edit'], ['task', 6], ['task', 7], ['row', 8], ['row', 9]]);
  calls.length = 0;
  for (const g of [{ depth: {} }, { depth: {}, sheet: true }, SHEET_ROW])
    app.tapRow({ id: 'pending-a-0', pending: true }, g);
  assert.deepEqual(calls, [], 'a task waiting to be sent opens nothing');
  app.tapRow(step({ i: 1, pending: true }), RUN);
  assert.deepEqual(calls, [['step', 1, true]], 'a step waiting to be sent still shows on the card');
  // A template's step opens its edit box only for someone who may change the template, or in New template
  calls.length = 0;
  Object.assign(app, { editStep: t => calls.push(['edit step', t.id]), sheet: { kind: 'task' }, canEdit: false });
  app.tapRow({ id: 10 }, { depth: {}, step: true });
  Object.assign(app, { sheet: { kind: 'newtpl' } });
  app.tapRow({ id: 11 }, { depth: {}, step: true });
  Object.assign(app, { sheet: { kind: 'task' }, canEdit: true });
  app.tapRow({ id: 12 }, { depth: {}, step: true });
  assert.deepEqual(calls, [
    ['edit step', 11],
    ['edit step', 12],
  ]);
});

/* Tapping a ring (tapRing). A checklist's own ring at the top of its screen has its own tap. Any other ring calls
   ringTap, which is told whether the ring is in a sheet (where there is no row to turn into a gap) or which card or
   row of a list it is on. */
test('tapping a ring passes on whether it is in a sheet or on a card or row of a list', () => {
  const app = component(views),
    calls = [],
    t = { id: 4 };
  app.ringTap = (t, el, sheet) => calls.push([t.id, el, sheet]);
  const at = found => ({ closest: sel => found[sel] ?? null });
  app.tapRing(t, { tap: () => calls.push('own') }, at({}));
  app.tapRing(t, {}, at({ '#sheet': 'sheet', '.day-card, .row': 'row in the sheet' }));
  app.tapRing(t, {}, at({ '.day-card, .row': 'card' }));
  assert.deepEqual(calls, ['own', [4, null, true], [4, 'card', false]]);
});

/* Pressing Enter in an add box (boxEnter) or tapping its button (boxSend) sends what that box holds. This replaces a
   separate expression for each box in the add box's form. */
test('an add box sends its own kind of content on Enter or on its button', () => {
  const app = component(quickadd),
    calls = [],
    focused = [];
  Object.assign(app, {
    user: { settings: { frontend_settings: { quick_add_magic_mode: 'disabled' } } },
    cap: { text: '' }, // nothing to suggest after @ or *
    submitCapture: () => calls.push('task'),
    insertStep: () => calls.push('steps'),
    addSubtasks: w => calls.push('subtasks ' + w),
    sendSteps: which => calls.push('steps ' + which),
    stepBox: () => ({ text: '' }),
    sheet: { stepEdit: { id: 3 } },
  });
  document.getElementById = id => ({ focus: () => focused.push(id), blur: () => focused.push('blur ' + id) });
  try {
    for (const w of ['cap', 'ins', 'under', 'sub', 'new:+', 'add:+']) app.boxSend(w);
    assert.deepEqual(
      calls.splice(0),
      ['task', 'steps', 'subtasks under', 'subtasks sub', 'steps new', 'steps add'],
      "the button sends each box's content",
    );
    for (const w of ['cap', 'ins', 'under', 'sub', 'tname', 'edit', 'new:+', 'add:+']) app.boxEnter(w);
    assert.deepEqual(
      calls,
      ['task', 'steps', 'subtasks under', 'subtasks sub', 'steps new', 'steps add'],
      'Enter sends the same content as the button',
    );
    assert.deepEqual(
      focused,
      ['d-subin', 'blur step-edit-3'],
      "Enter in a template's name moves to the steps box, and Enter in a step being edited leaves it, which saves it",
    );
  } finally {
    delete document.getElementById;
  }
});

/* A deleted row or card is shown as a gap (markup/gap.html) until the batch clears. One rule (isGap) decides this, for
   both the gap's drawing and the tap that restores it. A done task is never a gap, however it was marked done (tick,
   full swipe or ring). It stays in place as done, and tapping its tick undoes it. */
test('a deleted row or card is a gap and tapping it restores it, but a done row is never a gap', () => {
  const app = component(views, leaving),
    LIST = { depth: {} },
    CARDS = { depth: {}, cards: 'list' },
    did = [];
  Object.assign(app, { leaving: { 1: 'deleted', 2: 'done' }, restoreRow: id => did.push(['restore', id]) });
  const tap = (id, g) => {
    const e = { stopPropagation: () => did.push('stop'), preventDefault: () => did.push('prevent') };
    app.tapGap({ id }, g, e);
    return did.splice(0);
  };
  assert.deepEqual(
    [1, 2, 3].map(id => app.isGap({ id }, LIST)),
    [true, false, false],
    'a deleted row is a gap, a done row stays a row, and an unmarked row is not a gap',
  );
  assert.deepEqual(
    [1, 2].map(id => app.isGap({ id }, CARDS)),
    [true, false],
    'a card in a list follows the same rule',
  );
  assert.deepEqual(
    [1, 2].map(id => app.isGap({ id }, { depth: {}, sheet: true })),
    [true, false],
    'a subtask in a sheet follows the same rule',
  );
  assert.deepEqual(
    [1, 2].map(id => app.isGap({ id }, RUN)),
    [false, false],
    "a step on a checklist's screen is never a gap",
  );
  assert.deepEqual(
    [1, 2].flatMap(id => [SHEET_ROW, { depth: {}, top: true }].map(g => app.isGap({ id }, g))),
    [false, false, false, false],
    "neither the sheet's own row nor a checklist's own row is ever a gap",
  );
  assert.deepEqual(
    tap(1, LIST),
    ['stop', 'prevent', ['restore', 1]],
    'tapping a gap restores the row and stops the tap there',
  );
  assert.deepEqual(tap(1, CARDS), ['stop', 'prevent', ['restore', 1]]);
  assert.deepEqual(tap(2, LIST), [], 'tapping a row that is not a gap passes the tap on to its tick or title');
  assert.deepEqual(tap(1, SHEET_ROW), []);
});

/* Tapping a tick makes the phone vibrate, through haptic(). Here navigator.vibrate stands in for the phone. This
   covers a task's tick, a subtask's tick in its sheet and the sheet's own tick (tickRow), and a step's tick in
   tickStep, from its box or its card's Done. A step done by a swipe does not vibrate a second time, because the
   swipe already vibrated when it passed its full point. */
test('tapping a tick makes the phone vibrate, but a step done by a swipe does not vibrate twice', async () => {
  const felt = [],
    app = component(views, claims, leaving, runs, asks);
  navigator.vibrate = p => felt.push(p);
  try {
    Object.assign(app, {
      toggleSubtask() {},
      toggleDone() {},
      sheetDone() {},
      unlockSound() {},
      runDrafts: {},
      act: async () => ({}),
      view: { shownRun: { at: 0 } },
      markRow() {},
    });
    Object.defineProperty(app, 'runView', { get: () => null });
    app.tickRow({ id: 4, done: false }, { depth: {} }, 'row');
    app.tickRow({ id: 4, done: true }, { depth: {} }, 'row');
    app.tickRow({ id: 3, done: false }, { depth: {}, sheet: true });
    app.tickRow({ id: 5, done: false }, SHEET_ROW, 'row');
    assert.deepEqual(
      felt,
      [[14, 60, 24], 6, [14, 60, 24], [14, 60, 24]],
      "vibrations for done, open again, a subtask in a sheet and the sheet's own row",
    );
    felt.length = 0;
    await app.tickRow(step({}), RUN);
    await app.tickRow(step({ done: true }), RUN);
    await app.tickStep(step({}), 'skip');
    assert.deepEqual(
      felt,
      [[14, 60, 24], 6, [14, 60, 24]],
      'vibrations for a step done, a step not done again, and Skip on its card',
    );
    felt.length = 0;
    await app.stepProgress(step({}), 100);
    assert.deepEqual(felt, [], 'a full swipe vibrated when it passed the full point, and does not vibrate again');
  } finally {
    delete navigator.vibrate;
  }
});

/* A task's sheet starts with the task's row. Under the title it shows only when the task is due and how soon. The
   project, checklist and parent are in the path above the row, and labels and counts are in the sheet below it. */
test("the sheet's own row shows only the due date, priority, repeat and upcoming reminder", () => {
  const app = component(views, claims),
    soon = new Date(Date.now() + 5 * 36e5).toISOString();
  Object.assign(app, {
    route: { name: 'today' },
    projById: new Map([[1, { id: 1, title: 'Café', hex_color: '1d6b52' }]]),
    waitingByTask: new Map(),
    stepRun: () => null,
    isRunTask: () => false,
    rowRing: () => null,
    checklistIds: new Set(),
  });
  const t = {
    id: 5,
    title: 'Repaint the door',
    project_id: 1,
    due_date: soon,
    priority: 2,
    repeat_after: 86400,
    comment_count: 2,
    attachments: [{ id: 1 }],
    labels: [{ id: 1, title: 'Front' }],
    reminders: [{ reminder: soon }],
    related_tasks: { parenttask: [{ id: 4, title: 'Café front' }] },
  };
  assert.deepEqual(
    app.rowMeta(t, { depth: {} }).map(m => m.key),
    ['due', 'prio', 'p', 'up', 'l1', 'rep', 'com', 'att', 'rem'],
    'a row on Today shows every item',
  );
  assert.deepEqual(
    app.rowMeta(t, SHEET_ROW).map(m => m.key),
    ['due', 'prio', 'rep', 'rem'],
  );
});

test("under a step's title the row shows Inserted or Repeated, the latest comment, its files and a countdown until it is done", () => {
  const app = component(views, claims);
  assert.deepEqual(app.rowMeta(step({}), RUN), []);
  const meta = app.rowMeta(
    step({
      added: 'Inserted',
      said: { who: 'Sam', text: 'Skipped: no milk yet' },
      attachments: [{}],
      dueText: '5m late',
      late: true,
    }),
    RUN,
  );
  assert.deepEqual(
    meta.map(m => [m.key, m.cls, m.text]),
    [
      ['added', 'added', 'Inserted'],
      ['said', 'step-said', 'Sam: Skipped: no milk yet'],
      ['att', 'note-mark num strong', '1'],
      ['due', 'due num overdue', '5m late'],
    ],
  );
  assert.deepEqual([meta[1].label, meta[2].label], ['Latest comment, by Sam: Skipped: no milk yet', 'A file attached']);
  app.waiting.files[7] = 2;
  assert.equal(
    app.rowMeta(step({ attachments: [{}] }), RUN)[0].label,
    '3 files attached',
    'files still uploading count too',
  );
  delete app.waiting.files[7];
  assert.equal(
    app.rowMeta(step({ said: { who: 'Sam', text: '' } }), RUN)[0].text,
    'Sam commented',
    'a comment with no text, such as a photo, says who',
  );
  assert.deepEqual(app.rowMeta(step({ done: true, dueText: 'Due in 3m' }), RUN), [], 'a done step has no countdown');
});

// Which projects are for checklists is worked out once, when the projects are set. Otherwise isRunTask would read
// each project's description as HTML every time a row asks.
test('the projects for checklists are found when the projects are set, not each time a row asks', () => {
  const app = component(views, runs, checklists);
  let read = 0;
  Object.assign(app, {
    loadPerms() {},
    isChecklistProject: p => {
      read++;
      return p.description === 'marked';
    },
  });
  app.setProjects([
    { id: 1, description: '' },
    { id: 2, description: 'marked' },
  ]);
  assert.deepEqual([[...app.checklistIds], app.checklistProjects.map(p => p.id), read], [[2], [2], 2]);
  const run = { id: 20, project_id: 2, description: '', labels: [], related_tasks: { copiedfrom: [{ id: 9 }] } };
  for (let i = 0; i < 100; i++) assert.equal(app.isRunTask(run), true);
  assert.equal(read, 2, 'the projects are not read again for each row');
  app.setProjects([
    { id: 1, description: 'marked' },
    { id: 2, description: '' },
  ]);
  assert.deepEqual(
    [...app.checklistIds],
    [1],
    'a project that became a checklist project is included, and one that stopped is not',
  );
});

/* A checklist's row (on a project's list, in search and on Checklists) shows progress in its ring, so it has no count
   of steps and no "Next: …". Who the checklist is for appears as the pictures in its slot, with a label for screen
   readers, and is hidden on a project only the user can see. A checklist's step has no 🔔, because its reminder is
   Pocket's own and feeds the countdown the row shows. */
test('a checklist row shows who it is for in its slot, and a checklist step has no 🔔 but a task has', () => {
  const app = component(views, runs, checklists, cards, claims),
    me = { id: 1, username: 'alex' },
    soon = new Date(Date.now() + 18 * 6e4).toISOString();
  app.checklistIds = new Set([2]);
  Object.assign(app, {
    user: me,
    perms: {},
    pending: [],
    positions: {},
    route: { name: 'project' },
    waitingByTask: new Map(),
  });
  const run = {
    id: 20,
    title: 'Opening up',
    done: false,
    project_id: 2,
    assignees: [me],
    description: '',
    labels: [],
    related_tasks: {
      copiedfrom: [{ id: 9 }],
      subtask: [
        { id: 21, done: true, title: 'Turn on the machine' },
        { id: 22, done: false, title: 'Unlock the door' },
      ],
    },
  };
  assert.deepEqual(
    app.rowMeta(run, { depth: {} }).map(m => [m.key, m.text]),
    [],
    "nothing is shown under the checklist's title",
  );
  const bo = { id: 4, username: 'bo', name: 'Bo' },
    slot = app.rowSlot({ ...run, assignees: [me, bo] }, { depth: {} });
  assert.deepEqual(
    [slot.users.map(u => u.id), slot.can, slot.label],
    [[1, 4], false, 'For you and Bo'],
    'the slot shows the pictures with you first, and cannot be tapped',
  );
  app.seenBy = { 2: 0 };
  assert.equal(app.rowSlot(run, { depth: {} }), null, 'a project only you can see has no slot');
  app.seenBy = {};
  const task = {
    id: 30,
    title: 'Pack the van',
    project_id: 1,
    description: '',
    related_tasks: { subtask: [{ id: 31, done: true }, { id: 32 }] },
  };
  assert.deepEqual(
    app.rowMeta(task, { depth: {} }).map(m => [m.key, m.text]),
    [],
    "an open task shows its subtasks' progress in its ring, not as a count",
  );
  assert.deepEqual(
    app.rowMeta({ ...task, done: true }, { depth: {} }).map(m => [m.key, m.text]),
    [['sub', '1/2']],
    'a done task has a tick and shows the subtask count under its title',
  );
  const step = {
    id: 22,
    title: 'Unlock the door',
    done: false,
    project_id: 2,
    due_date: soon,
    reminders: [{ reminder: soon }],
    description: '',
    labels: [],
    related_tasks: { parenttask: [{ id: 20, title: 'Opening up' }], copiedfrom: [{ id: 3 }] },
  };
  assert.deepEqual(
    app.rowMeta(step, { depth: {} }).map(m => m.key),
    ['due'],
    'a checklist step shows the countdown and no 🔔',
  );
  assert.deepEqual(
    app.rowMeta({ ...step, project_id: 1, related_tasks: {} }, { depth: {} }).map(m => m.key),
    ['due', 'rem'],
    'a task shows a reminder that is still to come',
  );
});

test("a step's slot shows who is doing it until it is done, and then shows who did it", () => {
  const app = component(views, claims),
    slot = { id: 7, users: [], can: true };
  assert.equal(app.rowSlot(step({ slot }), RUN), slot);
  assert.equal(app.rowSlot(step({ slot, done: true }), RUN), null);
});

/* Besides progress, which gestures a row allows depends on the screen its list is on. Every screen's rows swipe to
   Delete. Holding a row reorders it on a project's list and in a task's sheet, and moves it to another date on
   Today. Search has no order, so holding does nothing there. The row writes its list's options on itself, and the
   gesture code reads them there. */
test("every screen's rows swipe to Delete, and holding reorders, reschedules or does nothing by screen", () => {
  const on = name => rowGestures({ depth: {}, ...screenRows(name) });
  assert.equal(on('today'), 'delete reschedule', 'on Today, holding a row picks another date for it');
  assert.equal(on('project'), 'delete reorder');
  assert.equal(on('search'), 'delete');
  assert.equal(on('checklists'), '', 'a screen that sets no options allows neither gesture');
  assert.equal(rowGestures({ depth: {}, sheet: true, delete: true, reorder: true }), 'delete reorder');
  assert.equal(
    rowGestures(RUN),
    '',
    "a checklist's steps allow neither gesture, because their order is in the order line",
  );
});

test('a row allows Delete and moving only where its list does, and progress everywhere', () => {
  const app = component(progress),
    asked = [];
  Object.assign(app, {
    lines: {},
    leaving: {},
    canTick: () => true,
    canDelete: () => true,
    isRunTask: () => false,
    ringOf: () => null,
    rowRing: () => null,
    reorderOf: t => (asked.push(t.id), { start() {} }),
    rescheduleOf: t => (asked.push('ring ' + t.id), { lift() {} }),
  });
  const row = gestures => ({ dataset: { gestures }, clientWidth: 360, closest: () => null }),
    t = { id: 5, percent_done: 0.25 };
  const today = app.rowGesture(t, row(rowGestures({ depth: {}, ...screenRows('today') })), false);
  assert.ok(today.swipe, 'on Today, swiping left past 0% deletes the task');
  assert.ok(today.reorder.lift, 'holding the row shows its dates around the touch point');
  assert.equal(today.start, 25, "the progress swipe starts from the task's current progress");
  assert.deepEqual(asked.splice(0), ['ring 5'], "the task's position among its siblings is not looked up");
  const search = app.rowGesture(t, row('delete'), false);
  assert.ok(search.swipe);
  assert.equal(search.reorder, null);
  const project = app.rowGesture(t, row('delete reorder'), false);
  assert.ok(project.swipe && project.reorder);
  assert.deepEqual(asked, [5]);
  const done = app.rowGesture({ id: 6, done: true, percent_done: 0.5 }, row('delete'), false);
  assert.equal(done.start, 100, 'a done row swipes down from 100% and opens again on the way');
  assert.ok(done.finish && done.swipe);
  assert.equal(
    app.rowGesture({ id: 7, pending: true }, row(''), false),
    null,
    'a task waiting to be sent allows only a tap',
  );
});

/* reorderOf (called from rowGesture) runs every time the user touches a row, whether it ends as a tap, a swipe or a
   scroll. It must stay cheap on a long list. It finds the siblings' rows in one pass over the list, and a list still
   being drawn is drawn to its end only once the hold registers. The list here has 3 tasks, and the second has a
   subtask under it on its card. The fake list can't be searched (it has no querySelectorAll), only iterated. */
test('touching a row does not search a long list or draw the rest of it until the hold registers', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(progress),
    drawn = [],
    read = { n: 0 };
  const list = {
      get children() {
        read.n++;
        return kids;
      },
    },
    item = id => ({
      dataset: { id: String(id) },
      parentElement: list,
      matches: sel => sel === '.item',
      classList: { add() {}, remove() {} },
    });
  const kids = [{ dataset: {} }, item(1), item(2), item(3)]; // the <template> comes first, as Alpine leaves it
  const row = {
    parentElement: kids[2],
    matches: () => false,
    dataset: { id: '2', gestures: 'reorder' },
    clientWidth: 360,
    closest: () => null,
    classList: { add() {}, remove() {} },
  };
  const sibs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  Object.assign(app, {
    drawing: false,
    drawAll: () => drawn.push('all'),
    orderOf: () => ({ sibs, view: 5, blocks: [{ ids: [1] }, { ids: [2, 21] }, { ids: [3] }] }),
    $refs: {},
  });
  const still = app.reorderOf({ id: 2 }, row, false);
  assert.ok(still.start && !still.held, 'a list that is fully drawn is ready to move from the start');
  assert.equal(read.n, 1, "the siblings' rows are found in one pass over the list");
  app.drawing = true;
  const hold = app.reorderOf({ id: 2 }, row, false);
  assert.deepEqual(
    [drawn, read.n],
    [[], 1],
    'touching a row in a list still being drawn neither draws more nor searches',
  );
  // Use the real listeners: pointer down, then the hold registers 450 ms later.
  const on = {},
    win = {},
    area = {
      addEventListener: (type, fn) => {
        (on[type] ||= []).push(fn);
      },
    };
  document.addEventListener = () => {};
  globalThis.addEventListener = (type, fn) => {
    (win[type] ||= []).push(fn);
  };
  globalThis.getSelection = () => null;
  c.after(() => {
    delete document.addEventListener;
    delete globalThis.addEventListener;
    delete globalThis.getSelection;
  });
  app.holdToSlide(area, () => ({ el: row, reorder: hold }));
  for (const fn of on.pointerdown)
    fn({
      isPrimary: true,
      pointerType: 'touch',
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      target: { closest: () => null },
    });
  c.mock.timers.tick(HOLD_MS - 1);
  assert.deepEqual(drawn, [], 'nothing is drawn before the hold registers');
  c.mock.timers.tick(1);
  assert.deepEqual(
    drawn,
    ['all'],
    'when the hold registers, the rest of the list is drawn so the row can move among all its siblings',
  );
  for (const fn of win.pointerup) fn({ pointerId: 1 }); // release, so no hold carries into later tests
});

/* A touch that moves past SWIPE_PX is scrolling or swiping, so pausing afterwards must not start a hold. This includes
   a move that is mostly sideways but not clearly so (SWIPE_SLOPE), which holdToSlide leaves undecided. A move within
   SWIPE_PX is a wobble of the thumb, and the hold still starts. */
test('a touch that moves past the swipe threshold on a slant and then stops does not start a hold', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(progress),
    felt = [],
    on = {},
    win = {},
    area = {
      addEventListener: (type, fn) => {
        (on[type] ||= []).push(fn);
      },
    };
  const row = { dataset: { id: '2' }, clientWidth: 360, closest: () => null, classList: { add() {}, remove() {} } };
  document.addEventListener = () => {};
  globalThis.addEventListener = (type, fn) => {
    (win[type] ||= []).push(fn);
  };
  globalThis.getSelection = () => null;
  navigator.vibrate = p => felt.push(p);
  c.after(() => {
    delete document.addEventListener;
    delete globalThis.addEventListener;
    delete globalThis.getSelection;
    delete navigator.vibrate;
  });
  app.holdToSlide(area, () => ({ el: row, reorder: { start() {}, move() {}, end() {} } }));
  const finger = (type, e) => {
    for (const fn of (type === 'pointerdown' ? on : win)[type] || [])
      fn({
        isPrimary: true,
        pointerType: 'touch',
        pointerId: 1,
        target: { closest: () => null },
        preventDefault() {},
        ...e,
      });
  };
  c.after(() => finger('pointerup', {})); // release, so no hold carries into later tests
  finger('pointerdown', { clientX: 100, clientY: 100 });
  finger('pointermove', { clientX: 109, clientY: 108 }); // 12px, past SWIPE_PX. 9px across and 8px down, short of SWIPE_SLOPE
  c.mock.timers.tick(HOLD_MS);
  assert.deepEqual(felt, [], 'moving that far on a slant and then stopping starts no hold');
  finger('pointerup', {});
  finger('pointerdown', { clientX: 100, clientY: 100 });
  finger('pointermove', { clientX: 104, clientY: 104 }); // under SWIPE_PX, so a wobble
  c.mock.timers.tick(HOLD_MS);
  assert.deepEqual(felt, [12], 'a wobble within the threshold and then stopping starts a hold, and the phone vibrates');
  finger('pointerup', {});
});

/* A checklist's step swipes like a task's row. Swiping sets progress either way, and a done step swipes down. Past
   0%, only a step that was inserted or repeated during the checklist and is not done has a Delete. A template's step
   stops at 0%. */
test('a checklist step swipes for progress like a task, and only an inserted step swipes on to Delete', () => {
  const app = component(progress),
    steps = [
      step({ id: 1, pct: 50 }),
      step({ id: 2, added: 'Inserted' }),
      step({ id: 3, done: true, pct: 25 }),
      step({ id: 4, pending: true }),
    ];
  Object.assign(app, {
    runView: { steps, finished: false },
    tasks: { 9: { id: 9, project_id: 1 } },
    view: { shownRun: { id: 9 } },
    canWrite: () => true,
  });
  const row = id => ({ dataset: { id: String(id) }, clientWidth: 360 }),
    target = { closest: () => null };
  const at = id => app.stepSlide(row(id), target);
  assert.deepEqual([at(1).start, at(1).swipe], [50, null], 'a step from the template has no Delete and stops at 0%');
  assert.ok(at(2).swipe, 'an inserted step swipes on to Delete');
  assert.deepEqual([at(3).start, at(3).swipe], [100, null], 'a done step swipes down from 100%');
  assert.equal(at(4), null, 'a step waiting to be sent allows only a tap');
  app.runView.finished = true;
  assert.equal(at(1), null, "a finished checklist's steps do not swipe");
});

// Deleting a step added during a checklist asks for confirmation, from its × or from its row's Delete. A swipe asks
// before the row moves (swipeDeleteStep), so the deletion itself does not ask again.
test('deleting a step added during a checklist asks once, whether from its × or from a swipe', async () => {
  const app = component(runs),
    asked = [],
    was = globalThis.confirm;
  let yes = false;
  globalThis.confirm = q => {
    asked.push(q);
    return yes;
  };
  try {
    const s = step({ added: 'Inserted', pending: 'e1' });
    Object.assign(app, { runAdded: null, cancelMade: async () => true });
    assert.equal(app.askDeleteStep(s), false);
    assert.deepEqual(asked, [
      "Delete “Take the croissants out”? This step was added to this checklist only. The template doesn't change.",
    ]);
    assert.deepEqual(
      [app.askDeleteStep(step({})), app.askDeleteStep(step({ added: 'Inserted', done: true })), asked.length],
      [false, false, 1],
      'a step from the template or a done step is neither asked about nor deleted',
    );
    assert.deepEqual(
      [await app.deleteAddedStep(s), asked.length],
      [false, 2],
      'tapping × asks, and answering no keeps the step',
    );
    assert.deepEqual(
      [await app.deleteAddedStep(s, false, true), asked.length],
      [true, 2],
      'after the swipe asked, the step is deleted without asking again',
    );
  } finally {
    globalThis.confirm = was;
  }
});

test('swiping a done step down marks it not done first, and then sets the progress', async () => {
  const app = component(runs),
    sent = [];
  let answer = true;
  Object.assign(app, {
    tickStep: async (s, op) => (answer ? sent.push(op) : false),
    act: async a => {
      sent.push([a.op, a.pct]);
      return {};
    },
  });
  await app.stepProgress(step({ done: true }), 75);
  assert.deepEqual(sent, ['undone', ['progress', 75]]);
  sent.length = 0;
  answer = false;
  await app.stepProgress(step({ done: true }), 75);
  assert.deepEqual(sent, [], 'when the step stays done, nothing is sent');
  await app.stepProgress(step({}), 50);
  assert.deepEqual(sent, [['progress', 50]], 'an open step sends only its progress');
});

/* A step swiped right past half its row is done through the outbox, the same as tapping its box. The step stays in
   place as done, with nothing marked and no gap, and unticking its box undoes it. The component announces it to
   screen readers, because a swipe has no focused box to do that. */
test('a step done by a full swipe is done like a tap on its box, in place with no gap and nothing marked', async () => {
  const app = component(runs, leaving),
    sent = [];
  Object.assign(app, {
    tickStep: async (s, op) => {
      sent.push(op);
    },
  });
  await app.stepProgress(step({ id: 4, title: 'Wipe the tables' }), 100);
  assert.deepEqual([sent, app.leaving], [['done'], {}]);
  assert.equal(app.said, 'Done: Wipe the tables');
  assert.equal(app.isGap({ id: 4 }, RUN), false);
});

/* Sliding progress on a row that nobody is doing means the user is doing it. The user's picture shows when the slide
   starts. The claim is sent only if the slide changed something, and it never replaces someone else's claim. */
test('sliding progress shows you on a task nobody has, and claims it only once the slide changed something', async () => {
  const me = { id: 1, username: 'alex' },
    priya = { id: 2, username: 'priya' },
    acts = [];
  const app = component(claims);
  Object.assign(app, {
    user: me,
    pending: [],
    canWrite: () => true,
    act: async a => {
      acts.push(a);
    },
  });
  const free = app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: 1 }, [], false);
  const end = app.claimOnSlide(free);
  assert.deepEqual(app.slideClaim, { 5: true });
  assert.deepEqual(app.peopleOf(5, []), [me], 'your picture replaces "+ me" as the slide starts');
  await end(false);
  assert.deepEqual(app.slideClaim, {});
  assert.deepEqual(app.peopleOf(5, []), [], 'releasing where the slide started leaves the task unclaimed');
  assert.deepEqual(acts, []);
  await app.claimOnSlide(free)(true);
  assert.deepEqual(
    acts,
    [{ op: 'claim', task: 5, run: null }],
    'a slide that changed something claims the task through the outbox',
  );
  assert.deepEqual(app.slideClaim, {}, 'from then on the outbox shows who has the task');
  const theirs = app.claimSlot({ id: 6, title: 'Count the till', project_id: 1 }, [priya], false);
  await app.claimOnSlide(theirs)(true);
  assert.deepEqual(app.slideClaim, {});
  assert.equal(acts.length, 1, 'a task someone else has stays theirs');
  await app.claimOnSlide(app.claimSlot({ id: 7, title: 'Mine', project_id: 1 }, [me], false))(true);
  assert.equal(acts.length, 1, 'a task already yours sends nothing, and sliding back to 0% later keeps it');
});

/* Claims and files waiting in the outbox are kept by task (keyOps, tasks.js, and keyWaiting, sending.js). A row asks
   only about its own claim and files, so a change in the outbox does not make the other rows ask again. The test uses
   Alpine's reactivity (reactive.mjs). Each row's question is watched and counted every time it is asked again. */
test("waiting claims and files are kept by task, and only that task's row is updated", c => {
  const { Alpine, flush } = watching(c),
    me = { id: 1, username: 'alex' },
    priya = { id: 2, username: 'priya' };
  const app = Alpine.reactive(component(tasks, claims, sending));
  Object.assign(app, { user: me, pending: [], failed: [] });
  app.change(w =>
    w.read(
      [5, 6].map(id => ({ id, title: 'Task ' + id, assignees: [priya] })),
      TASK,
      started(),
    ),
  );
  for (const id of [5, 6]) app.row({ id });
  const asked = {},
    seen = {};
  for (const id of [5, 6])
    Alpine.effect(() => {
      asked[id] = (asked[id] || 0) + 1;
      seen[id] = [app.peopleOf(id, app.tasks[id].assignees).map(u => u.username), app.waiting.files[id] || 0];
    });
  const act = (task, op) => ({ kind: 'act', id: op + task, task, op, user: me.id, who: me, items: [] });
  const outbox = list => {
    app.pending = list;
    outboxOf(app, app.pending);
    app.keyWaiting();
    flush();
  };
  outbox([act(5, 'claim')]);
  assert.deepEqual(
    [seen[5], asked],
    [[['priya', 'alex'], 0], { 5: 2, 6: 1 }],
    'a waiting claim shows you on the task, and the other row is not updated',
  );
  outbox([
    act(5, 'claim'),
    act(5, 'unclaim'),
    { id: 'e1', taskId: 6, files: [{ key: 'a' }, { key: 'b', sent: true }, { key: 'c' }] },
  ]);
  assert.deepEqual(
    [seen[5], seen[6], asked],
    [[['priya'], 0], [['priya'], 2], { 5: 3, 6: 2 }],
    'a later release overrides the claim, and two files are still to upload',
  );
  outbox([
    act(5, 'claim'),
    act(5, 'unclaim'),
    { id: 'e1', taskId: 6, files: [{ key: 'a' }, { key: 'b', sent: true }, { key: 'c' }] },
    { kind: 'act', op: 'add', id: 'e2', p: { title: 'New' }, files: [] },
  ]);
  assert.deepEqual(asked, { 5: 3, 6: 2 }, 'an unrelated change in the outbox updates neither row');
  app.dropping.push('c');
  app.keyWaiting();
  flush();
  assert.deepEqual([seen[6], asked], [[['priya'], 1], { 5: 3, 6: 3 }], 'a cancelled file no longer counts');
  outbox([]);
  assert.deepEqual(
    [seen, { ...Alpine.raw(app).opsOn }],
    [{ 5: [['priya'], 0], 6: [['priya'], 0] }, {}],
    'when everything is sent, nothing is waiting',
  );
});

/* "+ me" appears only where someone else could take the task. In a project nobody else can see (seenBy, loaded with
   who can see each project), there is no slot and no picture of the user. Someone else's assignment still shows, and
   a slide claims nothing. Until seenBy is known, the slot appears as it does everywhere else. */
test('in a project only you can see, there is no "+ me" or picture of you, and a slide claims nothing', async () => {
  const me = { id: 1, username: 'alex' },
    priya = { id: 2, username: 'priya' },
    acts = [];
  const app = component(claims);
  Object.assign(app, {
    user: me,
    pending: [],
    canWrite: () => true,
    act: async a => {
      acts.push(a);
    },
    seenBy: { 1: 2, 4: 0 },
  });
  const slot = (people, pid = 4, done = false) =>
    app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: pid }, people, done);
  assert.equal(slot([]), null, 'a task nobody has shows no "+ me"');
  assert.equal(slot([me]), null, 'a task that is yours does not show your picture either');
  const theirs = slot([priya, me]);
  assert.deepEqual(
    [theirs.users, theirs.can, theirs.label],
    [[priya], false, 'Assigned to priya: Wipe the menus'],
    'a task assigned to someone else shows them and cannot be tapped',
  );
  assert.deepEqual(slot([priya], 4, true).users, [priya], 'a done task also shows the other person');
  await app.claimOnSlide(slot([]))(true);
  assert.deepEqual(app.slideClaim, {}, 'a slide shows nobody on the task');
  assert.deepEqual(acts, [], 'a slide claims nothing');
  assert.equal(slot([], 7).can, true, 'a project not loaded yet shows "+ me", as on any other screen');
  assert.equal(slot([], 1).can, true, 'a project shared with someone shows "+ me"');
});

test("a checklist step's box is square on every screen, and a subtask's box is round", () => {
  const app = component(runs),
    step = { id: 9 },
    sub = { id: 10 };
  app.role = t => (t.id === 9 ? 'step' : null);
  assert.equal(app.isStepRow(step, RUN), true);
  assert.equal(app.isStepRow(step, { depth: {} }), true, 'a step you claimed is a step row on Today');
  assert.equal(app.isStepRow(sub, { depth: {} }), false);
  Object.defineProperty(app, 'checklistRole', { get: () => 'run', configurable: true });
  assert.equal(app.isStepRow(sub, { depth: {}, sheet: true }), true, "in a checklist's sheet the subtasks are steps");
  Object.defineProperty(app, 'checklistRole', { get: () => null, configurable: true });
  assert.equal(app.isStepRow(sub, { depth: {}, sheet: true }), false);
});

/* The one-time hint appears on the first row of a screen that takes a slide, when the screen is first drawn. On Today
   a card's step line counts as a row. The hint then belongs to the card, so the card's next step keeps it. */
test('the hint goes on the first open row that takes a swipe, and a screen reader hears it once', () => {
  const app = component(progress, leaving);
  const ro = { id: 1, project_id: 9 },
    done = { id: 2, done: true },
    waiting = { id: 3, pending: true },
    card = { id: 4 },
    row = { id: 5 },
    folded = { id: 6 };
  const steps = { 4: { id: 40, done: true } };
  Object.assign(app, {
    lines: {},
    hint: { at: null, pick: true, done: false },
    canTick: t => t.project_id !== 9,
    ringOf: () => null,
    cardOf: t => (steps[t.id] ? { id: t.id, step: steps[t.id] } : null),
  });
  Object.defineProperty(app, 'listGroups', {
    get: () => [{ fold: true, tasks: [folded] }, { tasks: [ro, done, waiting] }, { tasks: [card, row] }],
  });
  localStorage.removeItem('pocket.hint.slide');
  app.pickHint();
  assert.equal(
    app.hint.at,
    5,
    'the hint skips read-only, done and waiting rows, a folded Done section and a card whose step is done',
  );
  assert.equal(app.hint.pick, false, 'the row is picked once, when the screen is drawn');
  assert.match(app.said, /swipe a task to the right to start working on it/);
  steps[4] = { id: 41 };
  app.said = '';
  app.hint.at = null;
  app.pickHint();
  assert.equal(app.hint.at, 4, 'a card whose step takes a slide gets the hint');
  assert.equal(app.said, '', 'the screen reader message is not repeated');
  assert.equal(
    app.hintOn({ id: 41 }, { depth: {}, card: { id: 4, step: { id: 41 } } }),
    true,
    "the hint shows on the card's top row",
  );
  assert.equal(
    app.hintOn({ id: 42 }, { depth: {}, card: { id: 4, step: { id: 42 } } }),
    true,
    "the hint moves to the card's next top row",
  );
  assert.equal(
    app.hintOn({ id: 43 }, { depth: {}, card: { id: 4, step: { id: 42 } } }),
    false,
    "the hint does not show on the card's other open rows",
  );
  assert.equal(app.hintOn({ id: 4 }, { depth: {}, sheet: true }), false, 'the hint never shows in a sheet');
  app.hint.at = 9;
  assert.equal(
    app.hintOn({ id: 9 }, SHEET_ROW),
    false,
    "the hint does not show on a sheet's own row, even for the first task in the list",
  );
  app.hint.at = 4;
  app.hintSeen();
  assert.equal(localStorage.getItem('pocket.hint.slide'), 'done', 'the phone remembers that the hint was shown');
  app.hint.at = null;
  app.pickHint();
  assert.equal(app.hint.at, null, 'the hint does not come back');
});

/* The sheet's own row swipes like a row in a list, but acts on the one open task. Swiping sets progress from where it
   is now, and the row springs back whatever it set. A full swipe ticks the task in place, with no gap. Swiping left
   at 0% is Delete, which deletes the task the same way the sheet's ⋯ menu does. A parent task has no progress swipe,
   and swiping all the way taps its ring from the sheet. The row does not swipe for a template, a read-only task, or
   while the title is being edited. */
test("the sheet's own row swipes for progress and springs back, and a parent's swipe taps its ring", () => {
  const app = component(progress, cards),
    taps = [];
  const t = { id: 5, title: 'Wipe the menus', project_id: 1, percent_done: 0.25 };
  let ring = null,
    role = null,
    edit = true;
  Object.defineProperty(app, 'sheetRing', { get: () => ring });
  Object.defineProperty(app, 'ofTemplate', { get: () => ['template', 'tplstep'].includes(role) });
  Object.defineProperty(app, 'canEdit', { get: () => edit });
  Object.assign(app, {
    tasks: { 5: t },
    sheet: { id: 5, titleEdit: false },
    canDelete: () => true,
    canWrite: () => true,
    ringTap: (x, el, sheet) => taps.push([x.id, el, sheet]),
  });
  const row = {
    clientWidth: 360,
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {}, removeProperty() {} },
  };
  const s = app.sheetRowGesture(row);
  assert.deepEqual(
    [s.start, s.springs, !!s.swipe, s.reorder],
    [25, true, true, undefined],
    'the swipe starts from 25%, springs back, has a Delete and cannot be held to move',
  );
  t.done = true;
  assert.equal(app.sheetRowGesture(row).start, 100, 'a done task swipes down from 100% and opens again');
  t.done = false;
  ring = { pct: 13 };
  const p = app.sheetRowGesture(row);
  assert.deepEqual([p.start, p.one, p.springs], [0, true, true], 'a parent task has one stop, at the full point');
  p.finish(100);
  assert.deepEqual(taps, [[5, null, true]], 'the full swipe taps the ring from the sheet');
  ring = null;
  app.sheet.titleEdit = true;
  assert.equal(app.sheetRowGesture(row), null, 'while the title is edited, the box takes the touch');
  app.sheet.titleEdit = false;
  role = 'template';
  assert.equal(app.sheetRowGesture(row), null, "a template's sheet row does not swipe");
  role = null;
  edit = false;
  assert.equal(app.sheetRowGesture(row), null, 'a task shared with you read-only does not swipe');
});

/* These helpers run the start of a gesture (holdToSlide, watchNudges) on a fake screen. `area` keeps the listeners
   they add and `fire` calls them. The touch target answers only what it is inside (`closest`): a text field or a row. */
function screen() {
  const on = {},
    area = {
      addEventListener: (type, fn) => {
        (on[type] ||= []).push(fn);
      },
    };
  return {
    area,
    fire: (type, e) => {
      for (const fn of on[type] || []) fn(e);
    },
  };
}
const within = (field, rows) => ({
  closest: sel =>
    sel === TEXT_FIELD ? (field ? {} : null) : Object.entries(rows).find(([k]) => sel.includes(k))?.[1] || null,
});
const noWindow = fn => {
  document.addEventListener = () => {};
  globalThis.addEventListener = () => {};
  try {
    fn();
  } finally {
    delete document.addEventListener;
    delete globalThis.addEventListener;
  }
};
const down = target => ({ isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, target });

test('in a sheet, a touch that starts in a text field never starts a row gesture', () =>
  noWindow(() => {
    const app = component(progress, cards),
      asked = [],
      { area, fire } = screen(),
      own = { id: 'own' };
    Object.assign(app, {
      $refs: { sheet: area },
      sheetRowGesture: row => {
        asked.push(row.id);
        return null;
      },
    });
    app.initSheetProgress();
    fire('pointerdown', down(within(true, { '.row.own': own })));
    assert.deepEqual(asked, [], "in the title box of the sheet's own row, the box takes the touch");
    fire('pointerdown', down(within(false, { '.row.own': own })));
    assert.deepEqual(asked, ['own'], 'beside the text field, the row is asked for its gesture, whatever has the focus');
    fire('pointerdown', down(within(false, { '.row-del': {} })));
    assert.deepEqual(asked, ['own'], 'a shown Delete lies under the row, not in it, so it takes only a tap');
  }));

test('on a list, a touch that starts in a text field never starts a swipe, a hold or a nudge', () =>
  noWindow(() => {
    const app = component(progress, cards),
      asked = [],
      nudged = [],
      { area, fire } = screen(),
      row = { dataset: { id: '7' }, parentElement: { id: 'run-steps' } };
    document.getElementById = () => area;
    try {
      Object.assign(app, {
        route: { name: 'project' },
        stepSlide: r => {
          asked.push(r.dataset.id);
          return null;
        },
        nudged: id => nudged.push(id),
      });
      app.initProgressDrag();
      // Touching a row, moving 30px down over 300ms and releasing is a slow scroll, which counts as a nudge.
      const nudge = target => {
        const at = (y, t) => ({
          target,
          timeStamp: t,
          touches: [{ clientX: 100, clientY: y }],
          changedTouches: [{ clientX: 100, clientY: y }],
        });
        fire('touchstart', at(100, 0));
        fire('touchmove', at(110, 100));
        fire('touchmove', at(120, 200));
        fire('touchend', { ...at(130, 300), touches: [] });
      };
      const on = field => within(field, { '.item > .row': row });
      fire('pointerdown', down(on(true)));
      nudge(on(true));
      assert.deepEqual([asked, nudged], [[], []], 'in a text field, the field takes the touch');
      fire('pointerdown', down(on(false)));
      nudge(on(false));
      assert.deepEqual(
        [asked, nudged],
        [['7'], [7]],
        'on the row, its swipe or hold is asked for, and a short, slow scroll is a nudge',
      );
    } finally {
      delete document.getElementById;
    }
  }));

/* A nudge always selects the row, including the row touched before a subtask was added. The test uses the real
   listeners (watchNudges) and `nudged` (quickadd.js). The phone vibrates whenever the highlighted row changes, and
   navigator.vibrate stands in for that here. The task is Pack the van with Load chairs as its subtask, and both rows
   are on the fake screen. */
test('a nudge highlights the row it starts on, and the phone vibrates when the highlighted row changes', () =>
  noWindow(() => {
    const app = component(progress, cards, quickadd),
      felt = [],
      { area, fire } = screen(),
      els = {};
    const rowEl = id =>
      (els[id] ||= {
        dataset: { id: String(id) },
        parentElement: {},
        getBoundingClientRect: () => ({ top: 100, bottom: 150 }),
      });
    document.getElementById = () => area;
    document.querySelector = sel => els[sel.match(/data-id="([^"]+)"/)[1]] || null;
    navigator.vibrate = p => felt.push(p);
    globalThis.innerHeight = 800;
    try {
      const van = { id: 10, title: 'Pack the van', project_id: 1, done: false },
        chairs = {
          id: 11,
          title: 'Load chairs',
          project_id: 1,
          done: false,
          related_tasks: { parenttask: [{ id: 10 }] },
        };
      Object.assign(app, {
        route: { name: 'project', id: 1 },
        cursor: null,
        lit: {},
        pendingTasks: [],
        lines: {},
        checklistIds: new Set(),
        canWrite: () => true,
        $refs: {},
        tasks: { 10: van, 11: chairs },
        positions: { 10: 1000, 11: 100 },
        view: { groups: [{ key: 'open', tasks: [van, chairs] }], listView: 5 },
      });
      app.initProgressDrag();
      // Touching a row, moving 30px down over 300ms and releasing is a slow scroll, which counts as a nudge.
      const nudge = id => {
        const target = within(false, { '.item > .row': rowEl(id) }),
          at = (y, t) => ({
            target,
            timeStamp: t,
            touches: [{ clientX: 100, clientY: y }],
            changedTouches: [{ clientX: 100, clientY: y }],
          });
        fire('touchstart', at(100, 0));
        fire('touchmove', at(110, 100));
        fire('touchmove', at(120, 200));
        fire('touchend', { ...at(130, 300), touches: [] });
      };
      const now = () => [Object.keys(app.lit), app.capTarget, felt.length];
      nudge(10);
      assert.deepEqual(
        now(),
        [['10'], { to: 'Pack the van', after: '' }, 1],
        'the row is highlighted and the phone vibrates',
      );
      nudge(10);
      assert.deepEqual(
        now(),
        [['10'], { to: 'Pack the van', after: '' }, 1],
        'nudging the highlighted row again changes nothing and does not vibrate',
      );
      // A subtask added from the box becomes the highlighted row (aimAdded). Nudging its row while it is still waiting to be sent changes nothing.
      app.aimAdded({ id: 'e1', op: 'add', p: { title: 'Rope', position: 2000 } }, van);
      nudge('pending-e1');
      assert.deepEqual(now(), [['pending-e1'], { to: 'Pack the van', after: 'Rope' }, 1]);
      // Nudging the task touched before selects it again, the add box goes back to it, and the phone vibrates.
      nudge(10);
      assert.deepEqual(now(), [['10'], { to: 'Pack the van', after: '' }, 2]);
      nudge(11);
      assert.deepEqual(
        now(),
        [['11'], { to: 'Pack the van', after: 'Load chairs' }, 3],
        'nudging a subtask puts the add box after it, under its task',
      );
      van.done = true;
      nudge(10);
      assert.deepEqual(
        [Object.keys(app.lit), felt.length],
        [['11'], 3],
        'a done row cannot be highlighted, so the add box stays where it was',
      );
    } finally {
      delete document.getElementById;
      delete document.querySelector;
      delete navigator.vibrate;
      delete globalThis.innerHeight;
    }
  }));

// Setting progress in the sheet, by swiping its row or tapping a quarter in Details, claims the task the same way a
// swipe on a list row does. The claim is sent after the save, because the save's reply would otherwise replace the
// claim on screen.
test("setting progress in the sheet claims a task nobody has, after the save, and leaves another person's claim", async () => {
  const me = { id: 1, username: 'alex' },
    priya = { id: 2, username: 'priya' },
    order = [];
  const app = component(progress, claims);
  const t = { id: 5, title: 'Wipe the menus', project_id: 1, percent_done: 0, assignees: [] };
  let ring = null;
  Object.defineProperty(app, 'sheetRing', { get: () => ring });
  Object.assign(app, {
    user: me,
    pending: [],
    canWrite: () => true,
    tasks: { 5: t },
    sheet: { id: 5 },
    stepRun: () => null,
    act: async a => {
      order.push(['claim', a.task]);
    },
    sheetProgress: async (x, pct) => {
      order.push(['save', pct]);
    },
  });
  const setting = app.setSheetProgress(25);
  assert.deepEqual(app.peopleOf(5, t.assignees), [me], 'you appear in Assigned at once');
  await setting;
  assert.deepEqual(order, [
    ['save', 25],
    ['claim', 5],
  ]);
  order.length = 0;
  assert.equal(app.setSheetProgress(0), undefined, 'setting the progress the task already has does nothing');
  assert.deepEqual(order, []);
  t.assignees = [priya];
  await app.setSheetProgress(50);
  assert.deepEqual(order, [['save', 50]], "another person's claim is never replaced");
  order.length = 0;
  t.done = true;
  await app.setSheetProgress(0);
  assert.deepEqual(order, [['save', 0]], 'on a done task, a quarter opens it again at that progress, even 0%');
  order.length = 0;
  t.done = false;
  ring = { pct: 50 };
  await app.setSheetProgress(75);
  assert.deepEqual(order, [], "a parent task's progress comes from its subtasks, so nothing is set");
});

// Who can see each project is loaded in the background after sign-in and kept in seenBy, so the claim slots are right
// when Today opens. On a later load, a project that is no longer shared counts as only the user's again. A project
// that can't be read keeps its earlier value.
test('who can see each project is loaded, kept on the phone and loaded again later', async () => {
  const me = { id: 1, username: 'alex' },
    bob = { id: 2, username: 'bob' },
    seen = { 1: [me], 2: [me, bob] },
    fail = new Set();
  const app = component(quickadd, claims);
  Object.assign(app, {
    user: me,
    projects: [{ id: 1 }, { id: 2 }, { id: -1 }],
    access: {},
    userKnown: {},
    people: null,
    seenBy: {},
  });
  globalThis.fetch = async url => {
    const pid = +new URL(url).pathname.match(/projects\/(\d+)\/users/)[1];
    return fail.has(pid)
      ? new Response('{}', { status: 500 })
      : new Response(JSON.stringify({ items: seen[pid] }), { status: 200 });
  };
  await app.refreshPeople();
  assert.deepEqual(
    app.seenBy,
    { 1: 0, 2: 1 },
    'the count of other people is 0 and 1, and a saved filter (-1) is skipped',
  );
  assert.deepEqual(
    JSON.parse(localStorage.getItem('pocket.saved.seenBy')),
    { 1: 0, 2: 1 },
    'the counts are kept on the phone',
  );
  assert.deepEqual([app.onlyYou(1), app.onlyYou(2)], [true, false]);
  assert.equal(app.access['2:bob'], true, 'it also records who can see which project, for @username');
  assert.equal(app.refreshPeople(), null, 'it does not load again so soon');
  seen[2] = [me];
  fail.add(1);
  seen[1] = [me, bob];
  await app.loadPeople(true);
  assert.deepEqual(
    app.seenBy,
    { 1: 0, 2: 0 },
    'a project no longer shared counts as only you, and a project that cannot be read keeps its value',
  );
  assert.notEqual(
    app.access['2:bob'],
    true,
    'bob is no longer recorded as seeing the project, and is looked up again if typed',
  );
});

/* Holding a row or card on Today shows its dates around the touch point (app/throw.js). A card's row holds its card.
   A task that Move all to today leaves where it is shows every date dimmed, with a line saying why. A task the user
   can't change shows nothing. */
test('holding a row on Today shows its dates, but a repeating task, a template or a checklist shows why it cannot move', () => {
  const app = component(progress, throwing),
    held = [];
  Object.assign(app, {
    lines: {},
    leaving: {},
    canWrite: pid => pid !== 9,
    role: t => ({ 3: 'template', 4: 'run', 5: 'step' })[t.id] ?? null,
    tasks: { 9: { id: 9, project_id: 1 } },
    throwOf: (t, el, why) => (held.push([t.id, el.name, why]), { lift() {} }),
  });
  const row = { name: 'row', closest: () => null },
    card = { name: 'card', dataset: { id: '9' } };
  for (const t of [
    { id: 1, done: true },
    { id: 1, pending: true },
    { id: 1, project_id: 9 },
  ])
    assert.equal(app.rescheduleOf(t, row), null, 'a done, waiting or read-only task shows no dates');
  app.lines[6] = { text: 'Not saved' };
  assert.equal(
    app.rescheduleOf({ id: 6, project_id: 1 }, row),
    null,
    'a task with a message in its place shows no dates',
  );
  for (const [id, more] of Object.entries({
    1: {},
    2: { repeat_after: 86400 },
    3: { labels: [{ title: 'template' }] },
    4: {},
    5: {},
  }))
    app.rescheduleOf({ id: +id, project_id: 1, ...more }, row);
  app.holdOf({ id: 10, project_id: 1 }, { closest: () => card }, false, new Set(['reschedule']));
  assert.deepEqual(
    held,
    [
      [1, 'row', null],
      [2, 'row', 'repeats'],
      [3, 'row', 'checklist'],
      [4, 'row', 'run'],
      [5, 'row', 'run'],
      [9, 'card', null],
    ],
    "holding a card's row holds the whole card",
  );
  assert.deepEqual(Object.keys(THROW_STAYS), ['repeats', 'checklist', 'run'], 'each reason is shown over the dates');
});

/* Runs a hold on a fake screen. holdToSlide (app/progress.js) drives the row's gesture (rowGesture, throwOf in
   app/throw.js). throwView stands in for what is drawn, and `seen` records what it is told to show. When the dates are
   left open to tap, `tap(id)` taps a date and `pickDay(day)` picks one in the phone's date picker. `moved` records
   the reschedule the hold ends in. `touch(x, y)` touches the row and waits until the hold registers. `to(x, y)`
   moves the touch, `up()` releases it, and `away()` is the phone cancelling the touch (pointercancel). `felt`
   records navigator.vibrate, which stands in for haptic(): 12 when the hold registers and 6 for each highlighted
   date. The clock is set to Wednesday 7 October 2026, 2:20 PM. The task `t` (a test may change it between holds) was
   due the morning before. */
function heldOnToday(c) {
  c.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 9, 7, 14, 20) });
  const app = component(progress, throwing),
    t = { id: 1, title: 'Call the plumber', project_id: 1, due_date: new Date(2026, 9, 6, 9).toISOString() };
  const seen = [],
    moved = [],
    felt = [],
    on = {},
    win = {},
    classes = new Set();
  let tap = null,
    choose = null;
  const area = {
    addEventListener: (type, fn) => {
      (on[type] ||= []).push(fn);
    },
  };
  const row = {
    dataset: { gestures: rowGestures({ depth: {}, ...screenRows('today') }) },
    clientWidth: 360,
    closest: () => null,
    classList: { add: (...k) => k.forEach(x => classes.add(x)), remove: (...k) => k.forEach(x => classes.delete(x)) },
  };
  Object.assign(app, {
    lines: {},
    canWrite: () => true,
    canTick: () => true,
    canDelete: () => false,
    ringOf: () => null,
    rowRing: () => null,
    hintSeen() {},
    flash() {},
    $nextTick() {},
    reschedule: (x, to) => {
      moved.push([x.id, to.label, to.due]);
    },
    throwView: (x, held, targets, why, px, py) => {
      seen.push(['drawn', why, px, py]);
      return {
        light: p => seen.push(['lit', p?.id ?? null]),
        close: () => seen.push(['closed']),
        open: (pick, picked) => {
          seen.push(['open']);
          tap = pick;
          choose = picked;
        },
      };
    },
  });
  document.addEventListener = () => {};
  globalThis.addEventListener = (type, fn) => {
    (win[type] ||= []).push(fn);
  };
  globalThis.getSelection = () => null;
  navigator.vibrate = p => felt.push(p);
  c.after(() => {
    delete document.addEventListener;
    delete globalThis.addEventListener;
    delete globalThis.getSelection;
    delete navigator.vibrate;
  });
  app.holdToSlide(area, () => app.rowGesture(t, row, false));
  const fire = (fns, e) => {
    for (const fn of fns || [])
      fn({
        isPrimary: true,
        pointerType: 'touch',
        pointerId: 1,
        target: { closest: () => null },
        preventDefault() {},
        ...e,
      });
  };
  let x0 = 0,
    y0 = 0;
  return {
    app,
    t,
    seen,
    moved,
    felt,
    tap: id => tap(id),
    pickDay: day => choose(day),
    touch(x = 180, y = 300) {
      x0 = x;
      y0 = y;
      seen.length = 0;
      felt.length = 0;
      fire(on.pointerdown, { clientX: x, clientY: y });
      c.mock.timers.tick(HOLD_MS);
    },
    to(dx, dy) {
      fire(win.pointermove, { clientX: x0 + dx, clientY: y0 + dy });
    },
    up() {
      fire(win.pointerup, {});
    },
    away() {
      fire(win.pointercancel, {});
    },
  };
}
const oct = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();

test('holding a row on Today draws its dates around the touch, and releasing on a date moves the task there', c => {
  const h = heldOnToday(c);
  h.touch(180, 300);
  assert.deepEqual(
    [h.seen, h.felt],
    [[['drawn', null, 180, 300]], [12]],
    'when the hold registers, the dates are drawn around the touch',
  );
  h.to(10, 2);
  h.to(20, 4);
  assert.equal(h.seen.length, 1, 'no date is highlighted within 24px');
  h.to(30, 4);
  assert.deepEqual(
    [h.seen.at(-1), h.felt],
    [
      ['lit', 'tomorrow'],
      [12, 6],
    ],
    'dragging right highlights Tomorrow and the phone vibrates',
  );
  h.to(60, 10);
  assert.equal(h.seen.length, 2, 'dragging further the same way changes nothing and does not vibrate');
  h.to(8, -40);
  assert.deepEqual(
    [h.seen.at(-1), h.felt],
    [
      ['lit', 'week'],
      [12, 6, 6],
    ],
    'dragging up highlights Next week and the phone vibrates again',
  );
  h.to(4, 40);
  assert.deepEqual(h.seen.at(-1), ['lit', 'none'], 'dragging down the same short distance highlights No date');
  h.to(30, 4);
  h.up();
  assert.deepEqual(h.seen.at(-1), ['closed']);
  assert.deepEqual(
    h.moved,
    [[1, 'Tomorrow', oct(8, 9)]],
    'releasing moves the task to tomorrow, at the time of day it had',
  );
});

test('releasing near where the hold began, or a cancelled touch, moves nothing, and a fast flick still counts', c => {
  const h = heldOnToday(c);
  h.touch();
  h.to(-40, 0);
  assert.deepEqual(h.seen.at(-1), ['lit', 'today']);
  h.to(-6, 2);
  assert.deepEqual(
    [h.seen.at(-1), h.felt],
    [
      ['lit', null],
      [12, 6],
    ],
    'back near where the hold began, no date is highlighted and the phone does not vibrate',
  );
  h.up();
  assert.deepEqual([h.seen.at(-1), h.moved], [['closed'], []], 'releasing there closes the dates and changes nothing');
  h.touch();
  h.to(0, -50);
  h.away();
  assert.deepEqual(
    [h.seen.at(-1), h.moved],
    [['closed'], []],
    'a cancelled touch with a date highlighted changes nothing',
  );
  h.touch();
  h.to(14, -2);
  assert.equal(h.seen.length, 1, 'no date is highlighted within 24px');
  h.up();
  assert.deepEqual(h.moved, [[1, 'Tomorrow', oct(8, 9)]], 'releasing that fast counts as a flick to the right');
});

test('holding a row on Today never highlights or picks a date that changes nothing, or any date of a repeating task', c => {
  const h = heldOnToday(c);
  h.t.due_date = oct(7, 16);
  h.touch();
  h.to(-40, 0);
  assert.deepEqual(
    [h.seen.at(-1), h.felt],
    [['lit', null], [12]],
    'for a task due later today, dragging towards Today highlights nothing and does not vibrate',
  );
  h.up();
  assert.deepEqual(h.moved, [], 'releasing there moves nothing');
  h.t.repeat_after = 86400;
  h.touch();
  assert.deepEqual(
    h.seen,
    [['drawn', 'repeats', 180, 300]],
    'a repeating task is drawn with the reason it cannot move',
  );
  h.to(40, 0);
  h.up();
  assert.deepEqual([h.felt, h.moved, h.seen.at(-1)], [[12], [], ['closed']], 'no date is highlighted or picked');
});

test('releasing a hold without dragging leaves the dates open, and tapping a date moves the task like dragging to it', c => {
  const h = heldOnToday(c);
  h.touch();
  h.to(6, -8);
  h.to(2, 3);
  h.up();
  assert.deepEqual(
    [h.seen.at(-1), h.moved],
    [['open'], []],
    'a wobble within 24px and a release leaves the dates open and moves nothing yet',
  );
  h.tap('week');
  assert.deepEqual(
    h.moved,
    [[1, 'Mon 12', oct(12, 9)]],
    'tapping Next week moves the task to next Monday, at the time of day it had',
  );
  h.touch();
  h.up();
  h.tap('none');
  assert.deepEqual(h.moved.at(-1), [1, null, '0001-01-01T00:00:00Z'], 'tapping No date removes the date');
  h.t.repeat_after = 86400;
  h.touch();
  h.up();
  assert.deepEqual(
    h.seen,
    [['drawn', 'repeats', 180, 300], ['open']],
    'a repeating task also leaves the dates open, all dimmed, so the reason can be read',
  );
});

test("a day picked in the phone's date picker moves the task there, but not to its own day or a past day", c => {
  const h = heldOnToday(c);
  h.touch();
  h.up();
  h.pickDay('2026-10-15');
  assert.deepEqual(
    h.moved,
    [
      [
        1,
        new Date(2026, 9, 15).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        oct(15, 9),
      ],
    ],
    'the task moves to Thursday the 15th at 9 AM and is labelled with its day',
  );
  h.t.due_date = oct(15, 9);
  h.touch();
  h.up();
  h.pickDay('2026-10-15');
  assert.equal(h.moved.length, 1, 'picking the day the task already has moves nothing');
  h.touch();
  h.up();
  h.pickDay('2026-10-01');
  assert.equal(h.moved.length, 1, 'picking a past day moves nothing');
  h.touch();
  h.up();
  h.pickDay('2026-10-08');
  assert.deepEqual(h.moved.at(-1), [1, 'Tomorrow', oct(8, 9)], 'picking tomorrow labels the date Tomorrow');
});

/* The steps of a new template (app/checklists.js, sheet/sub-list.html) exist only as rows on the phone. They are
   written through the one box at the bottom of the list, and Vikunja knows nothing about them until Create template. */
test('in New template, each line from the add box becomes a step row after the row the box is under', () => {
  const app = component(checklists, quickadd, sheet);
  Object.assign(app, {
    user: { settings: { frontend_settings: {} } },
    projects: [],
    sheet: {
      kind: 'newtpl',
      subAt: null,
      stepEdit: null,
      newTpl: { rows: [], add: { text: '', keep: false, from: null, ignore: {} } },
    },
  });
  const box = app.sheet.newTpl.add,
    rows = () => app.sheet.newTpl.rows.map(r => r.text);
  box.text = 'Turn on the machine';
  app.sendSteps('new');
  box.text = 'Wipe the tables\nLock up';
  app.sendSteps('new');
  assert.deepEqual(
    [rows(), box.text, app.sheet.subAt],
    [['Turn on the machine', 'Wipe the tables', 'Lock up'], '', null],
    'with the box at the bottom, new steps go after the last, and a pasted list adds a row per line',
  );
  assert.ok(
    app.sheet.newTpl.rows.every(r => r.id === 'new-' + r.key),
    'each row has an id for the task row and a key for reading it',
  );
  // With the box under the first row, a new step goes after that row, and the box then sits under the new step.
  app.sheet.subAt = app.sheet.newTpl.rows[0].id;
  box.text = 'Fill the grinder';
  app.sendSteps('new');
  assert.deepEqual(rows(), ['Turn on the machine', 'Fill the grinder', 'Wipe the tables', 'Lock up']);
  assert.equal(app.sheet.subAt, app.sheet.newTpl.rows[1].id, 'the box is under the step just added');
  box.text = '   ';
  app.sendSteps('new');
  assert.equal(rows().length, 4, 'empty text adds no step');
  // Deleting a step by swipe moves the box that was under it to the row before it. Deleting the first step moves the box to the bottom.
  app.removeStep(1);
  assert.deepEqual(
    [rows(), app.sheet.subAt],
    [['Turn on the machine', 'Wipe the tables', 'Lock up'], app.sheet.newTpl.rows[0].id],
  );
  // Holding and dragging a step changes its position among the rows. Nothing is sent.
  app.moveStep(2, -2, true);
  assert.deepEqual(rows(), ['Lock up', 'Turn on the machine', 'Wipe the tables']);
  // A row shows the same title a saved step would. The title leaves out !priority, which quick add reads when the step
  // is created. It keeps the text of a chip the user tapped off, because that text stays in the title.
  box.text = 'Count the till !4';
  app.sendSteps('new');
  const till = app.sheet.newTpl.rows.find(r => r.text.startsWith('Count'));
  assert.equal(app.stepShown(till).title, 'Count the till');
  till.ignore = { priority: true };
  assert.equal(app.stepShown(till).title, 'Count the till !4');
});

test('a finished checklist under Checklists shows when it finished, how many steps were skipped and how many comments it has', () => {
  const app = component(views, claims),
    at = '2026-10-13T18:40:00Z',
    when = new Date(at).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const g = { depth: {}, ended: { 5: { skipped: 1, comments: 3 }, 6: { skipped: 0, comments: 0 } } };
  assert.deepEqual(
    app.rowMeta({ id: 5, done: true, done_at: at }, g).map(m => [m.key, m.text, m.label]),
    [
      ['at', when, 'Finished ' + when],
      ['skip', '1 skipped', undefined],
      ['com', '3', '3 comments'],
    ],
  );
  assert.deepEqual(
    app.rowMeta({ id: 6, done: true, done_at: at }, g).map(m => m.key),
    ['at'],
    'nothing skipped and no comments says nothing more',
  );
  // A checklist finished today shows the time alone. One finished on another day has its date, since a week holds the same weekday twice.
  const now = new Date();
  assert.equal(
    app.rowMeta({ id: 6, done: true, done_at: now.toISOString() }, g)[0].text,
    now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  );
});
