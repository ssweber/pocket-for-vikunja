// The one row (src/markup/task-row.html), for a task, a subtask in its sheet, and a step on a run's screen: what it asks
// the component, by the options of the list it's in (g).
import { component } from './fake.mjs';
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
import throwing from '../../src/js/app/throw.js';
import { THROW_STAYS } from '../../src/js/throw.js';

const RUN = { depth: {}, run: true, at: 0, locked: false };
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
  app.sheetDone = () => calls.push(['sheet']);
  app.tickRow({ id: 5 }, SHEET_ROW, 'row');
  assert.deepEqual(calls, [['step', 7, 'done'], ['step', 7, 'undone'], ['sub', 3], ['task', 4, 'row'], ['aim', 4], ['sheet']], 'the sheet\'s own row: its tick is the sheet\'s');
});

/* A task's sheet leads with its row (parent-tasks-plan, 6b): under its title only when it's due and how soon, as its
   project, run or parent are in the path over it, and its labels and counts in the sheet under it. */
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

// Which projects are for checklists is worked out once, as the projects are set, not each time a row asks (isRunTask):
// it reads each project's description as HTML.
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

/* A run's row, on a project's list, in search and under Checklists (one-concept-plan, part 3): its ring says how far it
   is, so no count of its steps and no "Next: …"; who it's for is its slot's pictures, said to a screen reader as its
   line said it, and not on a project only you can see. A run's step has no 🔔: its reminder is Pocket's own, for the
   countdown the row shows. */
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

/* What a finger can do on a row, besides its progress, by the screen its list is on (parent-tasks-plan, part 1): a row
   acts the same everywhere, so every screen's rows are swiped to Delete; a hold moves a row on a project's list and in
   a task's sheet, on Today throws it at a ring of dates (plan 4b), and search has no order of its own. The row writes
   its list's options on itself, and the gesture code reads them there. */
test('every screen\'s rows are swiped to Delete; a project\'s and a sheet\'s are moved too, Today\'s thrown, search\'s not', () => {
  const on = name => rowGestures({ depth: {}, ...screenRows(name) });
  assert.equal(on('today'), 'delete reschedule', 'Today: a hold throws it at the ring');
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
  assert.ok(today.reorder.lift, 'held: thrown at the ring of dates');
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

/* A run's step is swiped as a task's row is (parent-tasks-plan, part 1): its progress either way, a done one down, and
   past 0% only a step inserted or repeated during the run, not done, has a Delete; a template's step stops at 0%. */
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

/* A step swiped right past half its row is done (parent-tasks-plan, 1b), through the outbox, and its row a gap holding
   Undo until the batch clears, as a task's row is; Undo unticks it. The batch over, it's done in its place. */
test('a step done by a full swipe: its row a gap with Undo, which unticks it; the batch over, done in its place', async c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(runs, leaving), sent = [];
  Object.assign(app, { tickStep: async (s, op) => { sent.push(op); } });
  await app.stepProgress(step({ id: 4, title: 'Wipe the tables' }), 100);
  assert.deepEqual([sent, app.swept, app.leaving], [['done'], { 4: true }, { 4: 'done' }]);
  assert.equal(app.said, 'Done: Wipe the tables');
  await app.unmark(4);
  assert.deepEqual([sent, app.swept], [['done', 'undone'], {}], 'Undo: not done, the gap gone');
  await app.stepProgress(step({ id: 4, title: 'Wipe the tables' }), 100);
  await app.clearBatch(true);
  assert.deepEqual([app.swept, app.leaving], [{}, {}], 'the batch over: no gap, the step done in its place');
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

/* "+ me" only where someone else could take it (one-concept-plan, part 4): in a project no one else can see (seenBy,
   loaded with who can see each project), no slot, nor your own picture; someone else given it still shows, and a slide
   claims nothing. Until that's known, or for an API token that can't ask, the slot is as anywhere else. */
test('in a project only you can see, no "+ me" nor your picture, someone else\'s still, and a slide claims nothing', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, acts = [];
  const app = component(claims);
  Object.assign(app, { user: me, pending: [], slideClaim: null, canWrite: () => true, act: async a => { acts.push(a); }, seenBy: { 1: 2, 4: 0 } });
  const slot = (people, pid = 4, done = false) => app.claimSlot({ id: 5, title: 'Wipe the menus', project_id: pid }, people, done);
  assert.equal(slot([]), null, 'no one on it: no "+ me"');
  assert.equal(slot([me]), null, 'yours: not your picture either');
  const theirs = slot([priya, me]);
  assert.deepEqual([theirs.users, theirs.can, theirs.label], [[priya], false, 'Assigned to priya: Wipe the menus'], 'someone else given it: shown, not tapped');
  assert.deepEqual(slot([priya], 4, true).users, [priya], 'done too');
  await app.claimOnSlide(slot([]))(true);
  assert.equal(app.slideClaim, null, 'a slide shows no one');
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

/* The one-time hint (motion-and-rows-plan, section 8): on the first row of a screen that takes a slide, as the screen is
   first drawn; on Today, a card's step line counts, the hint then being the card's, so its next step keeps it. */
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

/* The sheet's own row (parent-tasks-plan, 6b) swiped as a list's row, about this one task: its progress from where it
   is, springing back whatever it set (a full swipe ticks it in place, with no gap); left at 0%, its Delete, which
   deletes it as the sheet's ⋯ does. A parent's: no progress, all the way its ring's tap from the sheet. Not a template's,
   one shared with you to read, nor while its title is being changed. */
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

// Progress set in the sheet, by a swipe on its row or a quarter in Details, claims as a row's swipe does (user,
// 2026-10-08: the same rule everywhere), after its save, whose reply would otherwise be shown over the claim.
test('the sheet\'s progress, swiped or a quarter tapped, claims a task no one is doing, after its save; someone else\'s stays theirs', async () => {
  const me = { id: 1, username: 'alex' }, priya = { id: 2, username: 'priya' }, order = [];
  const app = component(progress, claims);
  const t = { id: 5, title: 'Wipe the menus', project_id: 1, percent_done: 0, assignees: [] };
  let ring = null;
  Object.defineProperty(app, 'sheetRing', { get: () => ring });
  Object.assign(app, { user: me, pending: [], slideClaim: null, canWrite: () => true, sheet: { task: t }, stepRun: () => null,
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

// Who can see each project is loaded in the background once signed in, and kept (seenBy), so the claim slots are right
// as Today opens; loaded again, a project no longer shared counts again, and one that can't be read keeps what was known.
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

/* A hold on Today (parent-tasks-plan, 4b): a row or a card thrown at a ring of dates (app/throw.js), a card's row
   throwing its card; what Move all to today leaves where it is opens the ring with every target dimmed and a line saying
   why; one that can't be changed, nothing. */
test('a row held on Today is thrown at the ring, but one that repeats, a checklist, a run or its step can\'t be, and says why', () => {
  const app = component(progress, throwing), thrown = [];
  Object.assign(app, { lines: {}, leaving: {}, canWrite: pid => pid !== 9, isRunTask: t => t.id === 4, stepRun: t => t.id === 5 ? 4 : null,
    tasks: { 9: { id: 9, project_id: 1 } }, throwOf: (t, el, why) => (thrown.push([t.id, el.name, why]), { lift(){} }) });
  const row = { name: 'row', closest: () => null }, card = { name: 'card', dataset: { id: '9' } };
  for (const t of [{ id: 1, done: true }, { id: 1, pending: true }, { id: 1, project_id: 9 }]) assert.equal(app.rescheduleOf(t, row), null, 'done, waiting to be sent, or read only: nothing');
  app.lines[6] = { text: 'Not saved' };
  assert.equal(app.rescheduleOf({ id: 6, project_id: 1 }, row), null, 'a line in its place: nothing');
  for (const [id, more] of Object.entries({ 1: {}, 2: { repeat_after: 86400 }, 3: { labels: [{ title: 'template' }] }, 4: {}, 5: {} })) app.rescheduleOf({ id: +id, project_id: 1, ...more }, row);
  app.holdOf({ id: 10, project_id: 1 }, { closest: () => card }, false, new Set(['reschedule']));
  assert.deepEqual(thrown, [[1, 'row', null], [2, 'row', 'repeats'], [3, 'row', 'checklist'], [4, 'row', 'run'], [5, 'row', 'run'], [9, 'card', null]],
    'a card\'s row throws its card, by its task');
  assert.deepEqual(Object.keys(THROW_STAYS), ['repeats', 'checklist', 'run'], 'each says why in the ring');
});
