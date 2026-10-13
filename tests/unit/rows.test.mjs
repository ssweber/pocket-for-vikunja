// The shared row (src/markup/task-row.html) renders a task, a subtask in a sheet and a step on a checklist's screen.
// These tests check what the row asks the component, given the options of the list it is in (`g`).
import { component } from './fake.mjs';
import { watching } from './reactive.mjs';
import sending from '../../src/js/app/sending.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import views from '../../src/js/app/views.js';
import claims from '../../src/js/app/claims.js';
import leaving from '../../src/js/app/leaving.js';
import progress from '../../src/js/app/progress.js';
import { rowGestures, screenRows, SHEET_ROW } from '../../src/js/lists.js';
import runs from '../../src/js/app/runs.js';
import checklists from '../../src/js/app/checklists.js';
import cards from '../../src/js/app/cards.js';
import quickadd from '../../src/js/app/quickadd.js';
import sheet from '../../src/js/app/sheet.js';
import throwing from '../../src/js/app/throw.js';
import { THROW_STAYS } from '../../src/js/throw.js';
import { HOLD_MS, TEXT_FIELD } from '../../src/js/progress.js';

const RUN = { depth: {}, run: true, at: 0, locked: false };
// A step as the checklist screen builds it (runView, runs.js), with only the fields the row reads.
const step = f => ({ id: 7, i: 0, title: 'Take the croissants out', done: false, skipped: false, slow: false, added: '', notes: [], dueText: '', late: false, slot: null, ...f });

test('a step\'s tick goes through the outbox; a subtask\'s in its sheet, and a task\'s, as before: none moves the add box', () => {
  const app = component(views, claims, leaving), calls = [];
  Object.assign(app, { tickStep: (s, op) => calls.push(['step', s.id, op]), toggleSubtask: t => calls.push(['sub', t.id]),
    toggleDone: (t, row) => calls.push(['task', t.id, row]), aim: t => calls.push(['aim', t.id]) });
  app.tickRow(step({}), RUN);
  app.tickRow(step({ done: true }), RUN);
  app.tickRow({ id: 3 }, { depth: {}, sheet: true });
  app.tickRow({ id: 4 }, { depth: {} }, 'row');
  app.sheetDone = () => calls.push(['sheet']);
  app.tickRow({ id: 5 }, SHEET_ROW, 'row');
  assert.deepEqual(calls, [['step', 7, 'done'], ['step', 7, 'undone'], ['sub', 3], ['task', 4, 'row'], ['sheet']], 'the sheet\'s own row: its tick is the sheet\'s');
});

/* Tapping a row's title (tapRow) does something different depending on where the row is. This replaces one long
   expression in the markup. */
test('a row\'s title tapped: a step goes on the card, the sheet\'s own title is changed, a subtask or a run\'s own row opens its task, a list\'s row what it\'s a row of', () => {
  const app = component(views), calls = [];
  Object.assign(app, { showStep: (i, tap) => calls.push(['step', i, tap]), editTitle: () => calls.push(['edit']), openTask: id => calls.push(['task', id]), openRow: t => calls.push(['row', t.id]) });
  app.tapRow(step({ i: 2 }), RUN);
  app.tapRow({ id: 5 }, SHEET_ROW);
  app.tapRow({ id: 6 }, { depth: {}, sheet: true });
  app.tapRow({ id: 7 }, { depth: {}, top: true });
  app.tapRow({ id: 8 }, { depth: {} });
  app.tapRow({ id: 9 }, { depth: {}, card: {} });
  assert.deepEqual(calls, [['step', 2, true], ['edit'], ['task', 6], ['task', 7], ['row', 8], ['row', 9]]);
  calls.length = 0;
  for (const g of [{ depth: {} }, { depth: {}, sheet: true }, SHEET_ROW]) app.tapRow({ id: 'pending-a-0', pending: true }, g);
  assert.deepEqual(calls, [], 'one not sent yet opens nothing');
  app.tapRow(step({ i: 1, pending: true }), RUN);
  assert.deepEqual(calls, [['step', 1, true]], 'a step added and not sent yet still goes on the card');
});

/* Tapping a ring (tapRing). A checklist's own ring at the top of its screen has its own tap. Any other ring calls
   ringTap, which is told whether the ring is in a sheet (where there is no row to turn into a gap) or which card or
   row of a list it is on. */
test('a ring tapped: a run\'s own tap atop its screen; in a sheet, with no row; in a list, with its card or row', () => {
  const app = component(views), calls = [], t = { id: 4 };
  app.ringTap = (t, el, sheet) => calls.push([t.id, el, sheet]);
  const at = found => ({ closest: sel => found[sel] ?? null });
  app.tapRing(t, { tap: () => calls.push('own') }, at({}));
  app.tapRing(t, {}, at({ '#sheet': 'sheet', '.day-card, .row': 'row in the sheet' }));
  app.tapRing(t, {}, at({ '.day-card, .row': 'card' }));
  assert.deepEqual(calls, ['own', [4, null, true], [4, 'card', false]]);
});

/* Pressing Enter in an add box (boxEnter) or tapping its button (boxSend) sends what that box holds. This replaces a
   separate expression for each box in the add box's form. */
test('what a box sends, by Enter or its button: a task, a run\'s steps, subtasks, a template\'s steps; a template\'s name goes on to its steps\' box', () => {
  const app = component(quickadd), calls = [], focused = [];
  Object.assign(app, { user: { settings: { frontend_settings: { quick_add_magic_mode: 'disabled' } } }, cap: { text: '' },   // nothing to suggest after @ or *
    submitCapture: () => calls.push('task'), insertStep: () => calls.push('steps'), addSubtasks: w => calls.push('subtasks ' + w),
    sendSteps: which => calls.push('steps ' + which), stepBox: () => ({ text: '' }), sheet: { stepEdit: { id: 3 } } });
  document.getElementById = id => ({ focus: () => focused.push(id), blur: () => focused.push('blur ' + id) });
  try {
    for (const w of ['cap', 'ins', 'under', 'sub', 'new:+', 'add:+']) app.boxSend(w);
    assert.deepEqual(calls.splice(0), ['task', 'steps', 'subtasks under', 'subtasks sub', 'steps new', 'steps add'], 'its button');
    for (const w of ['cap', 'ins', 'under', 'sub', 'tname', 'edit', 'new:+', 'add:+']) app.boxEnter(w);
    assert.deepEqual(calls, ['task', 'steps', 'subtasks under', 'subtasks sub', 'steps new', 'steps add'], 'Enter: the same');
    assert.deepEqual(focused, ['d-subin', 'blur step-edit-3'], 'a template\'s name goes on to the box its steps are written in; a step being changed is left, which saves it');
  } finally { delete document.getElementById; }
});

/* A deleted row or card is shown as a gap (markup/gap.html) until the batch clears. One rule (isGap) decides this, for
   both the gap's drawing and the tap that restores it. A done task is never a gap, however it was marked done (tick,
   full swipe or ring). It stays in place as done, and tapping its tick undoes it. */
test('a row deleted is a gap, a card too, and a tap anywhere on it restores it and goes no further; one done never is', () => {
  const app = component(views, leaving), LIST = { depth: {} }, CARDS = { depth: {}, cards: 'list' }, did = [];
  Object.assign(app, { leaving: { 1: 'deleted', 2: 'done' }, restoreRow: id => did.push(['restore', id]) });
  const tap = (id, g) => { const e = { stopPropagation: () => did.push('stop'), preventDefault: () => did.push('prevent') }; app.tapGap({ id }, g, e); return did.splice(0); };
  assert.deepEqual([1, 2, 3].map(id => app.isGap({ id }, LIST)), [true, false, false], 'deleted; done, which stays a row; not marked');
  assert.deepEqual([1, 2].map(id => app.isGap({ id }, CARDS)), [true, false], 'a card, in its list');
  assert.deepEqual([1, 2].map(id => app.isGap({ id }, { depth: {}, sheet: true })), [true, false], 'a subtask in a sheet');
  assert.deepEqual([1, 2].map(id => app.isGap({ id }, RUN)), [false, false], 'a step on a run\'s screen: never');
  assert.deepEqual([1, 2].flatMap(id => [SHEET_ROW, { depth: {}, top: true }].map(g => app.isGap({ id }, g))), [false, false, false, false], 'never the sheet\'s own row, nor a run\'s own');
  assert.deepEqual(tap(1, LIST), ['stop', 'prevent', ['restore', 1]], 'a gap tapped: restored, and the tap is no one else\'s');
  assert.deepEqual(tap(1, CARDS), ['stop', 'prevent', ['restore', 1]]);
  assert.deepEqual(tap(2, LIST), [], 'a row that isn\'t a gap: the tap goes on to its tick or its title');
  assert.deepEqual(tap(1, SHEET_ROW), []);
});

/* Tapping a tick makes the phone vibrate, through haptic(). Here navigator.vibrate stands in for the phone. This
   covers a task's tick, a subtask's tick in its sheet and the sheet's own tick (tickRow), and a step's tick in
   tickStep, from its box or its card's Done. A step done by a swipe does not vibrate a second time, because the
   swipe already vibrated when it passed its full point. */
test('a tick tapped is felt, a task\'s and a step\'s, firmer when it marks it done; a step done by a swipe isn\'t felt twice', async () => {
  const felt = [], app = component(views, claims, leaving, runs);
  navigator.vibrate = p => felt.push(p);
  try {
    Object.assign(app, { toggleSubtask(){}, toggleDone(){}, sheetDone(){}, unlockSound(){}, runDrafts: {}, act: async () => ({}), view: { run: { at: 0 } }, markRow(){} });
    Object.defineProperty(app, 'runView', { get: () => null });
    app.tickRow({ id: 4, done: false }, { depth: {} }, 'row');
    app.tickRow({ id: 4, done: true }, { depth: {} }, 'row');
    app.tickRow({ id: 3, done: false }, { depth: {}, sheet: true });
    app.tickRow({ id: 5, done: false }, SHEET_ROW, 'row');
    assert.deepEqual(felt, [[14, 60, 24], 6, [14, 60, 24], [14, 60, 24]], 'done, opened again, a subtask in its sheet, the sheet\'s own');
    felt.length = 0;
    await app.tickRow(step({}), RUN);
    await app.tickRow(step({ done: true }), RUN);
    await app.tickStep(step({}), 'skip');
    assert.deepEqual(felt, [[14, 60, 24], 6, [14, 60, 24]], 'a step\'s box: done, not done again; and its card\'s Skip');
    felt.length = 0;
    await app.stepProgress(step({}), 100);
    assert.deepEqual(felt, [], 'done by a full swipe: felt as the finger passed the full point, not again');
  } finally { delete navigator.vibrate; }
});

/* A task's sheet starts with the task's row. Under the title it shows only when the task is due and how soon. The
   project, checklist and parent are in the path above the row, and labels and counts are in the sheet below it. */
test('the sheet\'s own row says only when it\'s due, its priority, that it repeats and a reminder to come', () => {
  const app = component(views, claims), soon = new Date(Date.now() + 5 * 36e5).toISOString();
  Object.assign(app, { route: { name: 'today' }, projById: new Map([[1, { id: 1, title: 'Café', hex_color: '1d6b52' }]]), waitingByTask: new Map(),
    stepRun: () => null, isRunTask: () => false, rowRing: () => null, checklistIds: new Set() });
  const t = { id: 5, title: 'Repaint the door', project_id: 1, due_date: soon, priority: 2, repeat_after: 86400, comment_count: 2, attachments: [{ id: 1 }],
    labels: [{ id: 1, title: 'Front' }], reminders: [{ reminder: soon }], related_tasks: { parenttask: [{ id: 4, title: 'Café front' }] } };
  assert.deepEqual(app.rowMeta(t, { depth: {} }).map(m => m.key), ['due', 'prio', 'p', 'up', 'l1', 'rep', 'com', 'att', 'rem'], 'on Today: all of it');
  assert.deepEqual(app.rowMeta(t, SHEET_ROW).map(m => m.key), ['due', 'prio', 'rep', 'rem']);
});

test('under a step\'s title: Inserted or Repeated, its comments, and its countdown until it\'s done', () => {
  const app = component(views, claims);
  assert.deepEqual(app.rowMeta(step({}), RUN), []);
  const meta = app.rowMeta(step({ added: 'Inserted', notes: [{}, {}], dueText: '5m late', late: true }), RUN);
  assert.deepEqual(meta.map(m => [m.key, m.cls, m.text]), [['added', 'added', 'Inserted'], ['notes', 'note-mark num', '2'], ['due', 'due num overdue', '5m late']]);
  assert.equal(meta[1].label, '2 comments');
  assert.equal(app.rowMeta(step({ notes: [{}] }), RUN)[0].label, 'A comment');
  assert.deepEqual(app.rowMeta(step({ done: true, dueText: 'Due in 3m' }), RUN), [], 'a done step has no countdown');
});

// Which projects are for checklists is worked out once, when the projects are set. Otherwise isRunTask would read
// each project's description as HTML every time a row asks.
test('the projects for checklists are worked out when the projects are set, not each time a row asks', () => {
  const app = component(views, runs, checklists);
  let read = 0;
  Object.assign(app, { loadPerms(){}, isChecklistProject: p => { read++; return p.description === 'marked'; } });
  app.setProjects([{ id: 1, description: '' }, { id: 2, description: 'marked' }]);
  assert.deepEqual([[...app.checklistIds], app.checklistProjects.map(p => p.id), read], [[2], [2], 2]);
  const run = { id: 20, project_id: 2, description: '', labels: [], related_tasks: { copiedfrom: [{ id: 9 }] } };
  for (let i = 0; i < 100; i++) assert.equal(app.isRunTask(run), true);
  assert.equal(read, 2, 'not read again for each row');
  app.setProjects([{ id: 1, description: 'marked' }, { id: 2, description: '' }]);
  assert.deepEqual([...app.checklistIds], [1], 'a project made one, another one no longer');
});

/* A checklist's row (on a project's list, in search and on Checklists) shows progress in its ring, so it has no count
   of steps and no "Next: …". Who the checklist is for appears as the pictures in its slot, with a label for screen
   readers, and is hidden on a project only the user can see. A checklist's step has no 🔔, because its reminder is
   Pocket's own and feeds the countdown the row shows. */
test('a run\'s row shows who it\'s for in its slot, not under its title; a run\'s step has no 🔔, a task has', () => {
  const app = component(views, runs, checklists, cards, claims), me = { id: 1, username: 'alex' }, soon = new Date(Date.now() + 18 * 6e4).toISOString();
  app.checklistIds = new Set([2]);
  Object.assign(app, { user: me, perms: {}, pending: [], positions: {}, route: { name: 'project' }, waitingByTask: new Map() });
  const run = { id: 20, title: 'Opening up', done: false, project_id: 2, assignees: [me], description: '', labels: [],
    related_tasks: { copiedfrom: [{ id: 9 }], subtask: [{ id: 21, done: true, title: 'Turn on the machine' }, { id: 22, done: false, title: 'Unlock the door' }] } };
  assert.deepEqual(app.rowMeta(run, { depth: {} }).map(m => [m.key, m.text]), [], 'nothing under its title');
  const bo = { id: 4, username: 'bo', name: 'Bo' }, slot = app.rowSlot({ ...run, assignees: [me, bo] }, { depth: {} });
  assert.deepEqual([slot.users.map(u => u.id), slot.can, slot.label], [[1, 4], false, 'For you and Bo'], 'its pictures, you first; never tapped');
  app.seenBy = { 2: 0 };
  assert.equal(app.rowSlot(run, { depth: {} }), null, 'only you can see its project: no slot');
  app.seenBy = {};
  const task = { id: 30, title: 'Pack the van', project_id: 1, description: '', related_tasks: { subtask: [{ id: 31, done: true }, { id: 32 }] } };
  assert.deepEqual(app.rowMeta(task, { depth: {} }).map(m => [m.key, m.text]), [], 'an open task\'s subtasks done: in its ring');
  assert.deepEqual(app.rowMeta({ ...task, done: true }, { depth: {} }).map(m => [m.key, m.text]), [['sub', '1/2']], 'a done one has a tick, and its count under its title');
  const step = { id: 22, title: 'Unlock the door', done: false, project_id: 2, due_date: soon, reminders: [{ reminder: soon }], description: '', labels: [],
    related_tasks: { parenttask: [{ id: 20, title: 'Opening up' }], copiedfrom: [{ id: 3 }] } };
  assert.deepEqual(app.rowMeta(step, { depth: {} }).map(m => m.key), ['due'], 'its countdown, and no 🔔');
  assert.deepEqual(app.rowMeta({ ...step, project_id: 1, related_tasks: {} }, { depth: {} }).map(m => m.key), ['due', 'rem'], 'a task\'s reminder still to come');
});

test('a step\'s slot is who\'s doing it until it\'s done, when its row shows who did it instead', () => {
  const app = component(views, claims), slot = { id: 7, users: [], can: true };
  assert.equal(app.rowSlot(step({ slot }), RUN), slot);
  assert.equal(app.rowSlot(step({ slot, done: true }), RUN), null);
});

/* Besides progress, which gestures a row allows depends on the screen its list is on. Every screen's rows swipe to
   Delete. Holding a row reorders it on a project's list and in a task's sheet, and moves it to another date on
   Today. Search has no order, so holding does nothing there. The row writes its list's options on itself, and the
   gesture code reads them there. */
test('every screen\'s rows are swiped to Delete; a project\'s and a sheet\'s are moved too, Today\'s to another date, search\'s not', () => {
  const on = name => rowGestures({ depth: {}, ...screenRows(name) });
  assert.equal(on('today'), 'delete reschedule', 'Today: a hold picks it another date');
  assert.equal(on('project'), 'delete reorder');
  assert.equal(on('search'), 'delete');
  assert.equal(on('checklists'), '', 'a screen that says nothing allows neither');
  assert.equal(rowGestures({ depth: {}, sheet: true, delete: true, reorder: true }), 'delete reorder');
  assert.equal(rowGestures(RUN), '', 'a run\'s steps: never swiped, their order is the order line');
});

test('a row swiped or held: its Delete and its move only where its list allows them, its progress everywhere', () => {
  const app = component(progress), asked = [];
  Object.assign(app, { lines: {}, leaving: {}, canTick: () => true, canDelete: () => true, isRunTask: () => false, ringOf: () => null, rowRing: () => null, reorderOf: t => (asked.push(t.id), { start(){} }),
    rescheduleOf: t => (asked.push('ring ' + t.id), { lift(){} }) });
  const row = gestures => ({ dataset: { gestures }, clientWidth: 360, closest: () => null }), t = { id: 5, percent_done: .25 };
  const today = app.rowGesture(t, row(rowGestures({ depth: {}, ...screenRows('today') })), false);
  assert.ok(today.swipe, 'Today: swiped left past 0%, its Delete');
  assert.ok(today.reorder.lift, 'held: its dates, around the finger');
  assert.equal(today.start, 25, 'its progress swipes from where it is');
  assert.deepEqual(asked.splice(0), ['ring 5'], 'its place among its siblings isn\'t looked up');
  const search = app.rowGesture(t, row('delete'), false);
  assert.ok(search.swipe);
  assert.equal(search.reorder, null);
  const project = app.rowGesture(t, row('delete reorder'), false);
  assert.ok(project.swipe && project.reorder);
  assert.deepEqual(asked, [5]);
  const done = app.rowGesture({ id: 6, done: true, percent_done: .5 }, row('delete'), false);
  assert.equal(done.start, 100, 'a done row swipes down from 100%, opened again on the way');
  assert.ok(done.finish && done.swipe);
  assert.equal(app.rowGesture({ id: 7, pending: true }, row(''), false), null, 'one waiting to be sent: only its tap');
});

/* reorderOf (called from rowGesture) runs every time the user touches a row, whether it ends as a tap, a swipe or a
   scroll. It must stay cheap on a long list. It finds the siblings' rows in one pass over the list, and a list still
   being drawn is drawn to its end only once the hold registers. The list here has 3 tasks, and the second has a
   subtask under it on its card. The fake list can't be searched (it has no querySelectorAll), only iterated. */
test('a finger down on a row doesn\'t search a long list, nor draw the rest of one still being drawn: that waits for the hold', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(progress), drawn = [], read = { n: 0 };
  const list = { get children(){ read.n++; return kids; } }, item = id => ({ dataset: { id: String(id) }, parentElement: list, matches: sel => sel === '.item', classList: { add(){}, remove(){} } });
  const kids = [{ dataset: {} }, item(1), item(2), item(3)];                // the <template> comes first, as Alpine leaves it
  const row = { parentElement: kids[2], matches: () => false, dataset: { id: '2', gestures: 'reorder' }, clientWidth: 360, closest: () => null, classList: { add(){}, remove(){} } };
  const sibs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  Object.assign(app, { drawing: false, drawAll: () => drawn.push('all'), orderOf: () => ({ sibs, view: 5, blocks: [{ ids: [1] }, { ids: [2, 21] }, { ids: [3] }] }), $refs: {} });
  const still = app.reorderOf({ id: 2 }, row, false);
  assert.ok(still.start && !still.held, 'a list all drawn: ready to move from the start');
  assert.equal(read.n, 1, 'its siblings\' rows found by going over the list once');
  app.drawing = true;
  const hold = app.reorderOf({ id: 2 }, row, false);
  assert.deepEqual([drawn, read.n], [[], 1], 'a list still being drawn: nothing drawn, nothing looked for, as the finger goes down');
  // Use the real listeners: pointer down, then the hold registers 450 ms later.
  const on = {}, win = {}, area = { addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  document.addEventListener = () => {}; globalThis.addEventListener = (type, fn) => { (win[type] ||= []).push(fn); }; globalThis.getSelection = () => null;
  c.after(() => { delete document.addEventListener; delete globalThis.addEventListener; delete globalThis.getSelection; });
  app.holdToSlide(area, () => ({ el: row, reorder: hold }));
  for (const fn of on.pointerdown) fn({ isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, target: { closest: () => null } });
  c.mock.timers.tick(HOLD_MS - 1);
  assert.deepEqual(drawn, [], 'not before the hold');
  c.mock.timers.tick(1);
  assert.deepEqual(drawn, ['all'], 'the hold felt: the rest of the list is drawn, for the row to be moved among all its siblings');
  for (const fn of win.pointerup) fn({ pointerId: 1 });                     // release, so no hold carries into later tests
});

/* A touch that moves past SWIPE_PX is scrolling or swiping, so pausing afterwards must not start a hold. This includes
   a move that is mostly sideways but not clearly so (SWIPE_SLOPE), which holdToSlide leaves undecided. A move within
   SWIPE_PX is a wobble of the thumb, and the hold still starts. */
test('a finger moved past the swipe threshold on a slant, then held still, lifts nothing; one that only wobbles is held', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(progress), felt = [], on = {}, win = {}, area = { addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  const row = { dataset: { id: '2' }, clientWidth: 360, closest: () => null, classList: { add(){}, remove(){} } };
  document.addEventListener = () => {}; globalThis.addEventListener = (type, fn) => { (win[type] ||= []).push(fn); }; globalThis.getSelection = () => null; navigator.vibrate = p => felt.push(p);
  c.after(() => { delete document.addEventListener; delete globalThis.addEventListener; delete globalThis.getSelection; delete navigator.vibrate; });
  app.holdToSlide(area, () => ({ el: row, reorder: { start(){}, move(){}, end(){} } }));
  const finger = (type, e) => { for (const fn of (type === 'pointerdown' ? on : win)[type] || []) fn({ isPrimary: true, pointerType: 'touch', pointerId: 1, target: { closest: () => null }, preventDefault(){}, ...e }); };
  c.after(() => finger('pointerup', {}));                                   // release, so no hold carries into later tests
  finger('pointerdown', { clientX: 100, clientY: 100 });
  finger('pointermove', { clientX: 109, clientY: 108 });                   // 12px, past SWIPE_PX. 9px across and 8px down, short of SWIPE_SLOPE
  c.mock.timers.tick(HOLD_MS);
  assert.deepEqual(felt, [], 'moved that far on a slant, then still: no hold');
  finger('pointerup', {});
  finger('pointerdown', { clientX: 100, clientY: 100 });
  finger('pointermove', { clientX: 104, clientY: 104 });                   // under SWIPE_PX, so a wobble
  c.mock.timers.tick(HOLD_MS);
  assert.deepEqual(felt, [12], 'a wobble within the threshold, then still: the hold is felt');
  finger('pointerup', {});
});

/* A checklist's step swipes like a task's row. Swiping sets progress either way, and a done step swipes down. Past
   0%, only a step that was inserted or repeated during the checklist and is not done has a Delete. A template's step
   stops at 0%. */
test('a run\'s step: swiped for its progress as a task is; only one inserted during the run goes on into a Delete', () => {
  const app = component(progress), steps = [step({ id: 1, pct: 50 }), step({ id: 2, added: 'Inserted' }), step({ id: 3, done: true, pct: 25 }), step({ id: 4, pending: true })];
  Object.assign(app, { runView: { steps, finished: false }, view: { run: { run: { project_id: 1 } } }, canWrite: () => true });
  const row = id => ({ dataset: { id: String(id) }, clientWidth: 360 }), target = { closest: () => null };
  const at = id => app.stepSlide(row(id), target);
  assert.deepEqual([at(1).start, at(1).swipe], [50, null], 'a template\'s step: no Delete, it stops at 0%');
  assert.ok(at(2).swipe, 'an inserted one: on into its Delete');
  assert.deepEqual([at(3).start, at(3).swipe], [100, null], 'a done one swipes down from 100%');
  assert.equal(at(4), null, 'one waiting to be sent: only its tap');
  app.runView.finished = true;
  assert.equal(at(1), null, 'a finished run: nothing');
});

// Deleting a step added during a checklist asks for confirmation, from its × or from its row's Delete. A swipe asks
// before the row moves (swipeDeleteStep), so the deletion itself does not ask again.
test('a step added during a run is asked about once before it\'s deleted: by its ×, or beforehand by its row\'s swipe', async () => {
  const app = component(runs), asked = [], was = globalThis.confirm;
  let yes = false;
  globalThis.confirm = q => { asked.push(q); return yes; };
  try {
    const s = step({ added: 'Inserted', pending: 'e1' });
    Object.assign(app, { runAdded: null, dropStep: async () => true });
    assert.equal(app.askDeleteStep(s), false);
    assert.deepEqual(asked, ['Delete “Take the croissants out”? This step was added to this checklist only. The template doesn\'t change.']);
    assert.deepEqual([app.askDeleteStep(step({})), app.askDeleteStep(step({ added: 'Inserted', done: true })), asked.length], [false, false, 1], 'a template\'s step, or a done one: not asked, not deleted');
    assert.deepEqual([await app.deleteAddedStep(s), asked.length], [false, 2], 'its ×: asked, and said no');
    assert.deepEqual([await app.deleteAddedStep(s, false, true), asked.length], [true, 2], 'asked beforehand: deleted, not asked again');
  } finally { globalThis.confirm = was; }
});

test('a done step swiped down is not done again first, then at that progress; asked and said no, it stays done', async () => {
  const app = component(runs), sent = [];
  let answer = true;
  Object.assign(app, { tickStep: async (s, op) => answer ? sent.push(op) : false, act: async a => { sent.push([a.op, a.pct]); return {}; } });
  await app.stepProgress(step({ done: true }), 75);
  assert.deepEqual(sent, ['undone', ['progress', 75]]);
  sent.length = 0; answer = false;
  await app.stepProgress(step({ done: true }), 75);
  assert.deepEqual(sent, [], 'someone else\'s ✅ kept: nothing sent');
  await app.stepProgress(step({}), 50);
  assert.deepEqual(sent, [['progress', 50]], 'an open step: only its progress');
});

/* A step swiped right past half its row is done through the outbox, the same as tapping its box. The step stays in
   place as done, with nothing marked and no gap, and unticking its box undoes it. The component announces it to
   screen readers, because a swipe has no focused box to do that. */
test('a step done by a full swipe is done as its box tapped is: in its place, with no gap and nothing marked', async () => {
  const app = component(runs, leaving), sent = [];
  Object.assign(app, { tickStep: async (s, op) => { sent.push(op); } });
  await app.stepProgress(step({ id: 4, title: 'Wipe the tables' }), 100);
  assert.deepEqual([sent, app.leaving], [['done'], {}]);
  assert.equal(app.said, 'Done: Wipe the tables');
  assert.equal(app.isGap({ id: 4 }, RUN), false);
});

/* Sliding progress on a row that nobody is doing means the user is doing it. The user's picture shows when the slide
   starts. The claim is sent only if the slide changed something, and it never replaces someone else's claim. */
test('a slide shows you on a task no one is doing, and claims it only once it has changed something', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, acts = [];
  const app = component(claims);
  Object.assign(app, { user: me, pending: [], canWrite: () => true, act: async a => { acts.push(a); } });
  const free = app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: 1 }, [], false);
  const end = app.claimOnSlide(free);
  assert.deepEqual(app.slideClaim, { 5: true });
  assert.deepEqual(app.peopleOf(5, []), [me], 'your picture takes the place of "+ me" as it starts');
  await end(false);
  assert.deepEqual(app.slideClaim, {});
  assert.deepEqual(app.peopleOf(5, []), [], 'let go where it started: no one claimed');
  assert.deepEqual(acts, []);
  await app.claimOnSlide(free)(true);
  assert.deepEqual(acts, [{ op: 'claim', task: 5, run: null }], 'changed: claimed, through the outbox');
  assert.deepEqual(app.slideClaim, {}, 'from then on the outbox says who');
  const theirs = app.claimSlot({ id: 6, title: 'Count the till', project_id: 1 }, [priya], false);
  await app.claimOnSlide(theirs)(true);
  assert.deepEqual(app.slideClaim, {});
  assert.equal(acts.length, 1, 'someone else\'s stays theirs');
  await app.claimOnSlide(app.claimSlot({ id: 7, title: 'Mine', project_id: 1 }, [me], false))(true);
  assert.equal(acts.length, 1, 'yours already: nothing to send, and sliding back to 0% later keeps it');
});

/* Claims and files waiting in the outbox are kept by task (keyWaiting, sending.js). A row asks only about its own
   claim and files, so a change in the outbox does not make the other rows ask again. The test uses Alpine's
   reactivity (reactive.mjs). Each row's question is watched and counted every time it is asked again. */
test('a claim, a let-go and files waiting to be sent are kept by their task: the last claim counts, and only that task\'s row is asked again', c => {
  const { Alpine, flush } = watching(c), me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' };
  const app = Alpine.reactive(component(claims, sending));
  Object.assign(app, { user: me, pending: [] });
  const asked = {}, seen = {};
  for (const id of [5, 6]) Alpine.effect(() => { asked[id] = (asked[id] || 0) + 1; seen[id] = [app.peopleOf(id, [priya]).map(u => u.username), app.waiting.files[id] || 0]; });
  const act = (task, op) => ({ kind: 'act', id: op + task, task, op, items: [] });
  const outbox = list => { app.pending = list; app.keyWaiting(); flush(); };
  outbox([act(5, 'claim')]);
  assert.deepEqual([seen[5], asked], [[['priya', 'alex'], 0], { 5: 2, 6: 1 }], 'a claim waiting: you\'re on it, and the other row wasn\'t asked');
  outbox([act(5, 'claim'), act(5, 'unclaim'), { kind: 'task', id: 'e1', items: [{ taskId: 6 }], files: [{ key: 'a' }, { key: 'b', sent: true }, { key: 'c' }] }]);
  assert.deepEqual([seen[5], seen[6], asked], [[['priya'], 0], [['priya'], 2], { 5: 3, 6: 2 }], 'let go after: the last counts; two of its files still to upload');
  outbox([act(5, 'claim'), act(5, 'unclaim'), { kind: 'task', id: 'e1', items: [{ taskId: 6 }], files: [{ key: 'a' }, { key: 'b', sent: true }, { key: 'c' }] }, { kind: 'task', id: 'e2', items: [{ p: { title: 'New' } }] }]);
  assert.deepEqual(asked, { 5: 3, 6: 2 }, 'something else put in the outbox: neither row is asked');
  app.dropping.push('c'); app.keyWaiting(); flush();
  assert.deepEqual([seen[6], asked], [[['priya'], 1], { 5: 3, 6: 3 }], 'one called off: it no longer counts');
  outbox([]);
  assert.deepEqual([seen, { ...Alpine.raw(app).waiting.claims }], [{ 5: [['priya'], 0], 6: [['priya'], 0] }, {}], 'all sent: nothing waits');
});

/* "+ me" appears only where someone else could take the task. In a project nobody else can see (seenBy, loaded with
   who can see each project), there is no slot and no picture of the user. Someone else's assignment still shows, and
   a slide claims nothing. Until seenBy is known, or for an API token that can't ask, the slot appears as it does
   everywhere else. */
test('in a project only you can see, no "+ me" nor your picture, someone else\'s still, and a slide claims nothing', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, acts = [];
  const app = component(claims);
  Object.assign(app, { user: me, pending: [], canWrite: () => true, act: async a => { acts.push(a); }, seenBy: { 1: 2, 4: 0 } });
  const slot = (people, pid = 4, done = false) => app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: pid }, people, done);
  assert.equal(slot([]), null, 'no one on it: no "+ me"');
  assert.equal(slot([me]), null, 'yours: not your picture either');
  const theirs = slot([priya, me]);
  assert.deepEqual([theirs.users, theirs.can, theirs.label], [[priya], false, 'Assigned to priya: Wipe the menus'], 'someone else given it: shown, not tapped');
  assert.deepEqual(slot([priya], 4, true).users, [priya], 'done too');
  await app.claimOnSlide(slot([]))(true);
  assert.deepEqual(app.slideClaim, {}, 'a slide shows no one');
  assert.deepEqual(acts, [], 'and claims nothing');
  assert.equal(slot([], 7).can, true, 'unknown (a project not loaded yet): "+ me", as anywhere');
  assert.equal(slot([], 1).can, true, 'shared with someone: "+ me"');
  app.accessBlocked = true;
  assert.equal(slot([], 4).can, true, 'a token that can\'t ask who can see it: as anywhere');
});

test('a checklist step\'s box is square, on its run\'s screen, in its run\'s sheet and on a list; a subtask\'s is round', () => {
  const app = component(runs), step = { id: 9 }, sub = { id: 10 };
  app.stepRun = t => t.id === 9 ? 3 : null;
  assert.equal(app.isStepRow(step, RUN), true);
  assert.equal(app.isStepRow(step, { depth: {} }), true, 'a step you\'ve claimed, on Today');
  assert.equal(app.isStepRow(sub, { depth: {} }), false);
  Object.defineProperty(app, 'checklistRole', { get: () => 'run', configurable: true });
  assert.equal(app.isStepRow(sub, { depth: {}, sheet: true }), true, 'a run\'s sheet: its subtasks are its steps');
  Object.defineProperty(app, 'checklistRole', { get: () => null, configurable: true });
  assert.equal(app.isStepRow(sub, { depth: {}, sheet: true }), false);
});

/* The one-time hint appears on the first row of a screen that takes a slide, when the screen is first drawn. On Today
   a card's step line counts as a row. The hint then belongs to the card, so the card's next step keeps it. */
test('the hint goes on the first open row that takes a swipe, a card\'s step line counting, and is said once', () => {
  const app = component(progress, leaving);
  const ro ={ id: 1, project_id: 9 }, done = { id: 2, done: true }, waiting = { id: 3, pending: true }, card = { id: 4 }, row = { id: 5 }, folded = { id: 6 };
  const steps = { 4: { id: 40, done: true } };
  Object.assign(app, { lines: {}, hint: { at: null, pick: true, done: false }, canTick: t => t.project_id !== 9, ringOf: () => null, cardOf: t => steps[t.id] ? { id: t.id, step: steps[t.id] } : null });
  Object.defineProperty(app, 'listGroups', { get: () => [{ fold: true, tasks: [folded] }, { tasks: [ro, done, waiting] }, { tasks: [card, row] }] });
  localStorage.removeItem('pocket.hint.slide');
  app.pickHint();
  assert.equal(app.hint.at, 5, 'not read only, done, waiting to send, a folded Done section, nor a card on a step done');
  assert.equal(app.hint.pick, false, 'picked once, as the screen is drawn');
  assert.match(app.said, /swipe a task to the right to start working on it/);
  steps[4] = { id: 41 };
  app.said = ''; app.hint.at = null;
  app.pickHint();
  assert.equal(app.hint.at, 4, 'a card whose step takes a slide: the card has it');
  assert.equal(app.said, '', 'a screen reader hears it once');
  assert.equal(app.hintOn({ id: 41 }, { depth: {}, card: { id: 4, step: { id: 41 } } }), true, 'shown on its top row');
  assert.equal(app.hintOn({ id: 42 }, { depth: {}, card: { id: 4, step: { id: 42 } } }), true, 'and on its next top row');
  assert.equal(app.hintOn({ id: 43 }, { depth: {}, card: { id: 4, step: { id: 42 } } }), false, 'not on its other rows, opened');
  assert.equal(app.hintOn({ id: 4 }, { depth: {}, sheet: true }), false, 'never in a sheet');
  app.hint.at = 9;
  assert.equal(app.hintOn({ id: 9 }, SHEET_ROW), false, 'nor on a sheet\'s own row, its task the list\'s first');
  app.hint.at = 4;
  app.hintSeen();
  assert.equal(localStorage.getItem('pocket.hint.slide'), 'done', 'remembered on the phone');
  app.hint.at = null;
  app.pickHint();
  assert.equal(app.hint.at, null, 'gone for good');
});

/* The sheet's own row swipes like a row in a list, but acts on the one open task. Swiping sets progress from where it
   is now, and the row springs back whatever it set. A full swipe ticks the task in place, with no gap. Swiping left
   at 0% is Delete, which deletes the task the same way the sheet's ⋯ menu does. A parent task has no progress swipe,
   and swiping all the way taps its ring from the sheet. The row does not swipe for a template, a read-only task, or
   while the title is being edited. */
test('the sheet\'s own row: swiped for its progress, springing back; at 0% its Delete; a parent\'s is its ring\'s', () => {
  const app = component(progress, cards), taps = [];
  const t = { id: 5, title: 'Wipe the menus', project_id: 1, percent_done: 0.25 };
  let ring = null, role = null, edit = true;
  Object.defineProperty(app, 'sheetRing', { get: () => ring });
  Object.defineProperty(app, 'ofTemplate', { get: () => ['template', 'tplstep'].includes(role) });
  Object.defineProperty(app, 'canEdit', { get: () => edit });
  Object.assign(app, { sheet: { task: t, titleEdit: false }, canDelete: () => true, canWrite: () => true, ringTap: (x, el, sheet) => taps.push([x.id, el, sheet]) });
  const row = { clientWidth: 360, classList: { add(){}, remove(){}, toggle(){} }, style: { setProperty(){}, removeProperty(){} } };
  const s = app.sheetRowGesture(row);
  assert.deepEqual([s.start, s.springs, !!s.swipe, s.reorder], [25, true, true, undefined], 'from 25%, springing back; its Delete; not held to move');
  t.done = true;
  assert.equal(app.sheetRowGesture(row).start, 100, 'done: swiped down from 100%, opened again');
  t.done = false;
  ring = { pct: 13 };
  const p = app.sheetRowGesture(row);
  assert.deepEqual([p.start, p.one, p.springs], [0, true, true], 'a parent: one stop, its full point');
  p.finish(100);
  assert.deepEqual(taps, [[5, null, true]], 'its ring\'s tap, asked from the sheet');
  ring = null;
  app.sheet.titleEdit = true;
  assert.equal(app.sheetRowGesture(row), null, 'its title being changed: the box takes the finger');
  app.sheet.titleEdit = false; role = 'template';
  assert.equal(app.sheetRowGesture(row), null, 'a template has no row');
  role = null; edit = false;
  assert.equal(app.sheetRowGesture(row), null, 'shared with you to read');
});

/* These helpers run the start of a gesture (holdToSlide, watchNudges) on a fake screen. `area` keeps the listeners
   they add and `fire` calls them. The touch target answers only what it is inside (`closest`): a text field or a row. */
function screen(){
  const on = {}, area = { addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  return { area, fire: (type, e) => { for (const fn of on[type] || []) fn(e); } };
}
const within = (field, rows) => ({ closest: sel => sel === TEXT_FIELD ? (field ? {} : null) : Object.entries(rows).find(([k]) => sel.includes(k))?.[1] || null });
const noWindow = fn => { document.addEventListener = () => {}; globalThis.addEventListener = () => {}; try { fn(); } finally { delete document.addEventListener; delete globalThis.addEventListener; } };
const down = target => ({ isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, target });

test('in a sheet, a touch that starts in a text field is never a row\'s: the title being changed, in its row; beside it, it is', () => noWindow(() => {
  const app = component(progress, cards), asked = [], { area, fire } = screen(), own = { id: 'own' };
  Object.assign(app, { $refs: { sheet: area }, sheetRowGesture: row => { asked.push(row.id); return null; } });
  app.initSheetProgress();
  fire('pointerdown', down(within(true, { '.row.own': own })));
  assert.deepEqual(asked, [], 'in the title\'s box, in the sheet\'s own row: the box takes the finger');
  fire('pointerdown', down(within(false, { '.row.own': own })));
  assert.deepEqual(asked, ['own'], 'on the row beside it: the row is asked (whatever has the focus)');
  fire('pointerdown', down(within(false, { '.row-del': {} })));
  assert.deepEqual(asked, ['own'], 'its Delete, shown: laid under the row, not in it, so only a tap');
}));

test('on a list, a touch that starts in a text field is never a row\'s swipe or hold, nor a nudge', () => noWindow(() => {
  const app = component(progress, cards), asked = [], nudged = [], { area, fire } = screen(), row = { dataset: { id: '7' }, parentElement: { id: 'run-steps' } };
  document.getElementById = () => area;
  try {
    Object.assign(app, { route: { name: 'project' }, stepSlide: r => { asked.push(r.dataset.id); return null; }, nudged: id => nudged.push(id) });
    app.initProgressDrag();
    // Touching a row, moving 30px down over 300ms and releasing is a slow scroll, which counts as a nudge.
    const nudge = target => {
      const at = (y, t) => ({ target, timeStamp: t, touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }] });
      fire('touchstart', at(100, 0)); fire('touchmove', at(110, 100)); fire('touchmove', at(120, 200)); fire('touchend', { ...at(130, 300), touches: [] });
    };
    const on = field => within(field, { '.item > .row': row });
    fire('pointerdown', down(on(true))); nudge(on(true));
    assert.deepEqual([asked, nudged], [[], []], 'in a field: the field takes the finger');
    fire('pointerdown', down(on(false))); nudge(on(false));
    assert.deepEqual([asked, nudged], [['7'], [7]], 'on the row: its swipe or hold is asked for, and a short, slow scroll is a nudge');
  } finally { delete document.getElementById; }
}));

/* A nudge always selects the row, including the row touched before a subtask was added. The test uses the real
   listeners (watchNudges) and `nudged` (quickadd.js). The phone vibrates whenever the highlighted row changes, and
   navigator.vibrate stands in for that here. The task is Pack the van with Load chairs as its subtask, and both rows
   are on the fake screen. */
test('a nudge lights the row it starts on, the one touched before too, and is felt when the lit row changes; a waiting or a done row is left alone', () => noWindow(() => {
  const app = component(progress, cards, quickadd), felt = [], { area, fire } = screen(), els = {};
  const rowEl = id => els[id] ||= { dataset: { id: String(id) }, parentElement: {}, getBoundingClientRect: () => ({ top: 100, bottom: 150 }) };
  document.getElementById = () => area;
  document.querySelector = sel => els[sel.match(/data-id="([^"]+)"/)[1]] || null;
  navigator.vibrate = p => felt.push(p);
  globalThis.innerHeight = 800;
  try {
    const van = { id: 10, title: 'Pack the van', project_id: 1, done: false }, chairs = { id: 11, title: 'Load chairs', project_id: 1, done: false, related_tasks: { parenttask: [{ id: 10 }] } };
    Object.assign(app, { route: { name: 'project', id: 1 }, cursor: null, lit: {}, deleting: [], pendingTasks: [], lines: {}, checklistIds: new Set(), canWrite: () => true, $refs: {},
      tasks: { 10: van, 11: chairs }, positions: { 10: 1000, 11: 100 }, view: { groups: [{ key: 'open', tasks: [van, chairs] }], listView: 5 } });
    app.initProgressDrag();
    // Touching a row, moving 30px down over 300ms and releasing is a slow scroll, which counts as a nudge.
    const nudge = id => {
      const target = within(false, { '.item > .row': rowEl(id) }), at = (y, t) => ({ target, timeStamp: t, touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }] });
      fire('touchstart', at(100, 0)); fire('touchmove', at(110, 100)); fire('touchmove', at(120, 200)); fire('touchend', { ...at(130, 300), touches: [] });
    };
    const now = () => [Object.keys(app.lit), app.capTarget, felt.length];
    nudge(10);
    assert.deepEqual(now(), [['10'], { to: 'Pack the van', after: '' }, 1], 'lit, and felt');
    nudge(10);
    assert.deepEqual(now(), [['10'], { to: 'Pack the van', after: '' }, 1], 'the lit row again: nothing changes, nothing felt');
    // A subtask added from the box becomes the highlighted row (aimAdded). Nudging its row while it is still waiting to be sent changes nothing.
    app.aimAdded({ id: 'e1', items: [{ p: { title: 'Rope', position: 2000 }, under: null }] }, 0, van);
    nudge('pending-e1-0');
    assert.deepEqual(now(), [['pending-e1-0'], { to: 'Pack the van', after: 'Rope' }, 1]);
    // Nudging the task touched before selects it again, the add box goes back to it, and the phone vibrates.
    nudge(10);
    assert.deepEqual(now(), [['10'], { to: 'Pack the van', after: '' }, 2]);
    nudge(11);
    assert.deepEqual(now(), [['11'], { to: 'Pack the van', after: 'Load chairs' }, 3], 'a subtask: after it, under its task');
    van.done = true;
    nudge(10);
    assert.deepEqual([Object.keys(app.lit), felt.length], [['11'], 3], 'a done row can\'t be one: the target stays where it was');
  } finally { delete document.getElementById; delete document.querySelector; delete navigator.vibrate; delete globalThis.innerHeight; }
}));

// Setting progress in the sheet, by swiping its row or tapping a quarter in Details, claims the task the same way a
// swipe on a list row does. The claim is sent after the save, because the save's reply would otherwise replace the
// claim on screen.
test('the sheet\'s progress, swiped or a quarter tapped, claims a task no one is doing, after its save; someone else\'s stays theirs', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, order = [];
  const app = component(progress, claims);
  const t = { id: 5, title: 'Wipe the menus', project_id: 1, percent_done: 0, assignees: [] };
  let ring = null;
  Object.defineProperty(app, 'sheetRing', { get: () => ring });
  Object.assign(app, { user: me, pending: [], canWrite: () => true, sheet: { task: t }, stepRun: () => null,
    act: async a => { order.push(['claim', a.task]); }, sheetProgress: async (x, pct) => { order.push(['save', pct]); } });
  const setting = app.setSheetProgress(25);
  assert.deepEqual(app.peopleOf(5, t.assignees), [me], 'shown in Assigned at once');
  await setting;
  assert.deepEqual(order, [['save', 25], ['claim', 5]]);
  order.length = 0;
  assert.equal(app.setSheetProgress(0), undefined, 'the quarter it\'s at: nothing to set');
  assert.deepEqual(order, []);
  t.assignees = [priya];
  await app.setSheetProgress(50);
  assert.deepEqual(order, [['save', 50]], 'someone else\'s is never replaced');
  order.length = 0; t.done = true;
  await app.setSheetProgress(0);
  assert.deepEqual(order, [['save', 0]], 'a done task: its quarter opens it again at that, even 0%');
  order.length = 0; t.done = false; ring = { pct: 50 };
  await app.setSheetProgress(75);
  assert.deepEqual(order, [], 'a parent\'s progress is its subtasks\'');
});

// Who can see each project is loaded in the background after sign-in and kept in seenBy, so the claim slots are right
// when Today opens. On a later load, a project that is no longer shared counts as only the user's again. A project
// that can't be read keeps its earlier value.
test('who can see each project: how many besides you, kept on the phone, and loaded again now and then', async () => {
  const me = { id: 1, username: 'alex' }, bob = { id: 2, username: 'bob' }, seen = { 1: [me], 2: [me, bob] }, fail = new Set();
  const app = component(quickadd, claims);
  Object.assign(app, { user: me, projects: [{ id: 1 }, { id: 2 }, { id: -1 }], access: {}, userKnown: {}, accessBlocked: false, people: null, seenBy: {} });
  globalThis.fetch = async url => {
    const pid = +new URL(url).pathname.match(/projects\/(\d+)\/users/)[1];
    return fail.has(pid) ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ items: seen[pid] }), { status: 200 });
  };
  await app.refreshPeople();
  assert.deepEqual(app.seenBy, { 1: 0, 2: 1 }, 'none besides you, and one; not a saved filter (-1)');
  assert.deepEqual(JSON.parse(localStorage.getItem('pocket.saved.seenBy')), { 1: 0, 2: 1 }, 'kept on the phone');
  assert.deepEqual([app.onlyYou(1), app.onlyYou(2)], [true, false]);
  assert.equal(app.access['2:bob'], true, 'and who can see what, for @username');
  assert.equal(app.refreshPeople(), null, 'not again so soon');
  seen[2] = [me]; fail.add(1); seen[1] = [me, bob];
  await app.loadPeople(true);
  assert.deepEqual(app.seenBy, { 1: 0, 2: 0 }, 'no longer shared: only you; one not read: as it was');
  assert.notEqual(app.access['2:bob'], true, 'bob no longer seen to see it (asked again if typed)');
});

/* Holding a row or card on Today shows its dates around the touch point (app/throw.js). A card's row holds its card.
   A task that Move all to today leaves where it is shows every date dimmed, with a line saying why. A task the user
   can't change shows nothing. */
test('a row held on Today has its dates, but one that repeats, a checklist, a run or its step can\'t move, and says why', () => {
  const app = component(progress, throwing), held = [];
  Object.assign(app, { lines: {}, leaving: {}, canWrite: pid => pid !== 9, isRunTask: t => t.id === 4, stepRun: t => t.id === 5 ? 4 : null,
    tasks: { 9: { id: 9, project_id: 1 } }, throwOf: (t, el, why) => (held.push([t.id, el.name, why]), { lift(){} }) });
  const row = { name: 'row', closest: () => null }, card = { name: 'card', dataset: { id: '9' } };
  for (const t of [{ id: 1, done: true }, { id: 1, pending: true }, { id: 1, project_id: 9 }]) assert.equal(app.rescheduleOf(t, row), null, 'done, waiting to be sent, or read only: nothing');
  app.lines[6] = { text: 'Not saved' };
  assert.equal(app.rescheduleOf({ id: 6, project_id: 1 }, row), null, 'a line in its place: nothing');
  for (const [id, more] of Object.entries({ 1: {}, 2: { repeat_after: 86400 }, 3: { labels: [{ title: 'template' }] }, 4: {}, 5: {} })) app.rescheduleOf({ id: +id, project_id: 1, ...more }, row);
  app.holdOf({ id: 10, project_id: 1 }, { closest: () => card }, false, new Set(['reschedule']));
  assert.deepEqual(held, [[1, 'row', null], [2, 'row', 'repeats'], [3, 'row', 'checklist'], [4, 'row', 'run'], [5, 'row', 'run'], [9, 'card', null]],
    'a card\'s row holds its card, by its task');
  assert.deepEqual(Object.keys(THROW_STAYS), ['repeats', 'checklist', 'run'], 'each says why, over its dates');
});

/* Runs a hold on a fake screen. holdToSlide (app/progress.js) drives the row's gesture (rowGesture, throwOf in
   app/throw.js). throwView stands in for what is drawn, and `seen` records what it is told to show. When the dates are
   left open to tap, `tap(id)` taps a date and `pickDay(day)` picks one in the phone's date picker. `moved` records
   the reschedule the hold ends in. `touch(x, y)` touches the row and waits until the hold registers. `to(x, y)`
   moves the touch, `up()` releases it, and `away()` is the phone cancelling the touch (pointercancel). `felt`
   records navigator.vibrate, which stands in for haptic(): 12 when the hold registers and 6 for each highlighted
   date. The clock is set to Wednesday 7 October 2026, 2:20 PM. The task `t` (a test may change it between holds) was
   due the morning before. */
function heldOnToday(c){
  c.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 9, 7, 14, 20) });
  const app = component(progress, throwing), t = { id: 1, title: 'Call the plumber', project_id: 1, due_date: new Date(2026, 9, 6, 9).toISOString() };
  const seen = [], moved = [], felt = [], on = {}, win = {}, classes = new Set();
  let tap = null, choose = null;
  const area = { addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  const row = { dataset: { gestures: rowGestures({ depth: {}, ...screenRows('today') }) }, clientWidth: 360, closest: () => null, classList: { add: (...k) => k.forEach(x => classes.add(x)), remove: (...k) => k.forEach(x => classes.delete(x)) } };
  Object.assign(app, { lines: {}, canWrite: () => true, canTick: () => true, canDelete: () => false, ringOf: () => null, rowRing: () => null, hintSeen(){}, flash(){}, $nextTick(){},
    reschedule: (x, to) => { moved.push([x.id, to.label, to.due]); },
    throwView: (x, held, targets, why, px, py) => { seen.push(['drawn', why, px, py]); return { light: p => seen.push(['lit', p?.id ?? null]), close: () => seen.push(['closed']), open: (pick, picked) => { seen.push(['open']); tap = pick; choose = picked; } }; } });
  document.addEventListener = () => {}; globalThis.addEventListener = (type, fn) => { (win[type] ||= []).push(fn); }; globalThis.getSelection = () => null; navigator.vibrate = p => felt.push(p);
  c.after(() => { delete document.addEventListener; delete globalThis.addEventListener; delete globalThis.getSelection; delete navigator.vibrate; });
  app.holdToSlide(area, () => app.rowGesture(t, row, false));
  const fire = (fns, e) => { for (const fn of fns || []) fn({ isPrimary: true, pointerType: 'touch', pointerId: 1, target: { closest: () => null }, preventDefault(){}, ...e }); };
  let x0 = 0, y0 = 0;
  return { app, t, seen, moved, felt, tap: id => tap(id), pickDay: day => choose(day),
    touch(x = 180, y = 300){ x0 = x; y0 = y; seen.length = 0; felt.length = 0; fire(on.pointerdown, { clientX: x, clientY: y }); c.mock.timers.tick(HOLD_MS); },
    to(dx, dy){ fire(win.pointermove, { clientX: x0 + dx, clientY: y0 + dy }); },
    up(){ fire(win.pointerup, {}); },
    away(){ fire(win.pointercancel, {}); } };
}
const oct = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();

test('held on Today, a row\'s dates are drawn where the finger is; moved out, the date it points at lights, a tick felt, and let go there it moves', c => {
  const h = heldOnToday(c);
  h.touch(180, 300);
  assert.deepEqual([h.seen, h.felt], [[['drawn', null, 180, 300]], [12]], 'as the hold is felt: drawn around the finger');
  h.to(10, 2); h.to(20, 4);
  assert.equal(h.seen.length, 1, 'short of 24px: none lit');
  h.to(30, 4);
  assert.deepEqual([h.seen.at(-1), h.felt], [['lit', 'tomorrow'], [12, 6]], 'to the right: Tomorrow lit, a tick felt');
  h.to(60, 10);
  assert.equal(h.seen.length, 2, 'further the same way: nothing new to show or feel');
  h.to(8, -40);
  assert.deepEqual([h.seen.at(-1), h.felt], [['lit', 'week'], [12, 6, 6]], 'round to above: Next week, another tick');
  h.to(4, 40);
  assert.deepEqual(h.seen.at(-1), ['lit', 'none'], 'down, the same short way: No date');
  h.to(30, 4);
  h.up();
  assert.deepEqual(h.seen.at(-1), ['closed']);
  assert.deepEqual(h.moved, [[1, 'Tomorrow', oct(8, 9)]], 'let go: moved to tomorrow, at the time of day it had');
});

test('held on Today and let go back near where it was held, or taken away by the phone, a row isn\'t moved; a flick counts before any date is lit', c => {
  const h = heldOnToday(c);
  h.touch();
  h.to(-40, 0);
  assert.deepEqual(h.seen.at(-1), ['lit', 'today']);
  h.to(-6, 2);
  assert.deepEqual([h.seen.at(-1), h.felt], [['lit', null], [12, 6]], 'back near where it was held: none lit, and no tick for that');
  h.up();
  assert.deepEqual([h.seen.at(-1), h.moved], [['closed'], []], 'let go there: closed, nothing changed');
  h.touch();
  h.to(0, -50);
  h.away();
  assert.deepEqual([h.seen.at(-1), h.moved], [['closed'], []], 'the touch taken away with a date lit: nothing');
  h.touch();
  h.to(14, -2);
  assert.equal(h.seen.length, 1, 'short of 24px: nothing lit');
  h.up();
  assert.deepEqual(h.moved, [[1, 'Tomorrow', oct(8, 9)]], 'but let go that fast: a flick to the right');
});

test('held on Today, a date that would change nothing isn\'t lit or picked; nor any date of a task that repeats', c => {
  const h = heldOnToday(c);
  h.t.due_date = oct(7, 16);
  h.touch();
  h.to(-40, 0);
  assert.deepEqual([h.seen.at(-1), h.felt], [['lit', null], [12]], 'due later today, towards Today: not lit, no tick');
  h.up();
  assert.deepEqual(h.moved, [], 'let go there: nothing');
  h.t.repeat_after = 86400;
  h.touch();
  assert.deepEqual(h.seen, [['drawn', 'repeats', 180, 300]], 'a repeating task: drawn with why it can\'t move');
  h.to(40, 0); h.up();
  assert.deepEqual([h.felt, h.moved, h.seen.at(-1)], [[12], [], ['closed']], 'no date lit, none picked');
});

test('held on Today and let go without ever having moved out, a row\'s dates stay open to tap, each moving it as its direction does', c => {
  const h = heldOnToday(c);
  h.touch();
  h.to(6, -8); h.to(2, 3);
  h.up();
  assert.deepEqual([h.seen.at(-1), h.moved], [['open'], []], 'a wobble short of 24px, then let go: left open, nothing moved yet');
  h.tap('week');
  assert.deepEqual(h.moved, [[1, 'Mon 12', oct(12, 9)]], 'Next week tapped: next Monday, at the time of day it had');
  h.touch(); h.up(); h.tap('none');
  assert.deepEqual(h.moved.at(-1), [1, null, '0001-01-01T00:00:00Z'], 'No date tapped: its date off');
  h.t.repeat_after = 86400;
  h.touch(); h.up();
  assert.deepEqual(h.seen, [['drawn', 'repeats', 180, 300], ['open']], 'a repeating task: left open too, every date dimmed, to read why');
});

test('open to tap, a day picked in the phone\'s own picker moves the task there, at the time of day it had; the day it has, or one gone by, nothing', c => {
  const h = heldOnToday(c);
  h.touch(); h.up();
  h.pickDay('2026-10-15');
  assert.deepEqual(h.moved, [[1, new Date(2026, 9, 15).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), oct(15, 9)]], 'Thursday the 15th, at 9 AM, said by its day');
  h.t.due_date = oct(15, 9);
  h.touch(); h.up(); h.pickDay('2026-10-15');
  assert.equal(h.moved.length, 1, 'the day it has: nothing');
  h.touch(); h.up(); h.pickDay('2026-10-01');
  assert.equal(h.moved.length, 1, 'a day gone by: nothing');
  h.touch(); h.up(); h.pickDay('2026-10-08');
  assert.deepEqual(h.moved.at(-1), [1, 'Tomorrow', oct(8, 9)], 'tomorrow, picked: said as Tomorrow');
});

/* The steps of a new template (app/checklists.js, sheet/sub-list.html) exist only as rows on the phone. They are
   written through the one box at the bottom of the list, and Vikunja knows nothing about them until Create template. */
test('in New template the box\'s lines join the rows, after the row the box is under, and the box follows the last; one taken out hands the box to the row before', () => {
  const app = component(checklists, quickadd, sheet);
  Object.assign(app, { user: { settings: { frontend_settings: {} } }, projects: [], sheet: { kind: 'newtpl', subAt: null, stepEdit: null, newTpl: { rows: [], add: { text: '', keep: false, from: null, ignore: {} } } } });
  const box = app.sheet.newTpl.add, rows = () => app.sheet.newTpl.rows.map(r => r.text);
  box.text = 'Turn on the machine'; app.sendSteps('new');
  box.text = 'Wipe the tables\nLock up'; app.sendSteps('new');
  assert.deepEqual([rows(), box.text, app.sheet.subAt], [['Turn on the machine', 'Wipe the tables', 'Lock up'], '', null], 'at the foot: after the last, a pasted list a row a line');
  assert.ok(app.sheet.newTpl.rows.every(r => r.id === 'new-' + r.key), 'each shaped for the task row, by its id, and for its reading, by its key');
  // With the box under the first row, a new step goes after that row, and the box then sits under the new step.
  app.sheet.subAt = app.sheet.newTpl.rows[0].id;
  box.text = 'Fill the grinder'; app.sendSteps('new');
  assert.deepEqual(rows(), ['Turn on the machine', 'Fill the grinder', 'Wipe the tables', 'Lock up']);
  assert.equal(app.sheet.subAt, app.sheet.newTpl.rows[1].id, 'under the one just written');
  box.text = '   '; app.sendSteps('new');
  assert.equal(rows().length, 4, 'nothing typed: nothing added');
  // Deleting a step by swipe moves the box that was under it to the row before it. Deleting the first step moves the box to the bottom.
  app.removeStep(1);
  assert.deepEqual([rows(), app.sheet.subAt], [['Turn on the machine', 'Wipe the tables', 'Lock up'], app.sheet.newTpl.rows[0].id]);
  // Holding and dragging a step changes its position among the rows. Nothing is sent.
  app.moveStep(2, -2, true);
  assert.deepEqual(rows(), ['Lock up', 'Turn on the machine', 'Wipe the tables']);
  // A row shows the same title a saved step would. The title leaves out !priority, which quick add reads when the step
  // is created. It keeps the text of a chip the user tapped off, because that text stays in the title.
  box.text = 'Count the till !4'; app.sendSteps('new');
  const till = app.sheet.newTpl.rows.find(r => r.text.startsWith('Count'));
  assert.equal(app.stepShown(till).title, 'Count the till');
  till.ignore = { priority: true };
  assert.equal(app.stepShown(till).title, 'Count the till !4');
});
