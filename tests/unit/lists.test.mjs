// The lists Pocket shows (src/js/lists.js): their order, and subtasks under their parents.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchMs, doneParentIds, drawnOf, FIRST_ROWS, FRAME_MS, LATER_MS, NEAR_ROWS, keptGroups, nestSubtasks, nextBatch, sameGroup, soonestFirst, todayAt, todayGroups, todayOrder, viewKey } from '../../src/js/lists.js';
import { component } from './fake.mjs';
import checklists from '../../src/js/app/checklists.js';
import runs from '../../src/js/app/runs.js';
import views from '../../src/js/app/views.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import lines from '../../src/js/app/lines.js';

const ids = list => list.map(t => t.id);
const NONE = '0001-01-01T00:00:00Z';                        // Vikunja's "no date"

test('soonest first: dated by date, then undated by priority, then newest', () => {
  const list = [
    { id: 1, due_date: NONE, priority: 0 },
    { id: 2, due_date: '2026-10-09T09:00:00Z' },
    { id: 3, due_date: NONE, priority: 3 },
    { id: 4, due_date: '2026-10-08T09:00:00Z' },
    { id: 5, due_date: null, priority: 0 },
  ];
  assert.deepEqual(ids(soonestFirst(list)), [4, 2, 3, 5, 1]);
  assert.deepEqual(ids(list), [1, 2, 3, 4, 5], 'the list given is left as it was');
});

const parentOf = (id, ...parents) => ({ id, related_tasks: { parenttask: parents.map(p => ({ id: p })) } });
const withSubs = (id, ...subs) => ({ id, related_tasks: { subtask: subs.map(s => ({ id: s })) } });

test('each subtask straight after its parent, in the parent\'s order, with its depth', () => {
  const list = [parentOf(4, 1), withSubs(1, 3, 4), parentOf(5, 4), parentOf(3, 1), { id: 2 }];
  list[0].related_tasks.subtask = [{ id: 5 }];
  const { tasks, depth } = nestSubtasks(list);
  assert.deepEqual(ids(tasks), [1, 3, 4, 5, 2]);
  assert.deepEqual(depth, { 1: 0, 3: 1, 4: 1, 5: 2, 2: 0 });
});

test('a subtask whose parent isn\'t in the list stays where it was, at the top', () => {
  const { tasks, depth } = nestSubtasks([{ id: 1 }, parentOf(2, 99), { id: 3 }]);
  assert.deepEqual(ids(tasks), [1, 2, 3]);
  assert.equal(depth[2], 0);
});

test('a done parent with open subtasks is found, and shown over them, not left out with them at the top', () => {
  const sub = (id, parent, more = {}) => ({ id, done: false, related_tasks: { parenttask: [{ id: parent, done: true, project_id: 1 }] }, ...more });
  // As a project's List view gives it: its open tasks, and their subtasks, done ones too (8, under 6, and done).
  const view = [{ id: 1 }, sub(2, 9), sub(3, 9), sub(4, 7, { related_tasks: { parenttask: [{ id: 7, done: true, project_id: 2 }] } }),
    { id: 6, related_tasks: { subtask: [{ id: 8 }] } }, { id: 8, done: true, related_tasks: { parenttask: [{ id: 6, done: false, project_id: 1 }] } }, sub(5, 8)];
  assert.deepEqual(doneParentIds(view, 1), [9, 8], 'not a parent in another project; one the view gave, under an open task, too');
  const head = { id: 9, done: true, related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } };
  const { tasks, depth } = nestSubtasks([...view.filter(t => !t.done), head, view[5]]);
  assert.deepEqual(ids(tasks), [1, 4, 6, 8, 5, 9, 2, 3]);
  assert.deepEqual([depth[9], depth[2], depth[3], depth[8], depth[5]], [0, 1, 1, 1, 2]);
});

test('a task waiting to be sent goes under the parent it names', () => {
  const { tasks, depth } = nestSubtasks([{ id: 'w1', parent: 3 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(ids(tasks), [3, 'w1', 4]);
  assert.equal(depth.w1, 1);
});

test('tasks that are each other\'s subtasks are each shown once', () => {
  const a = { id: 1, related_tasks: { parenttask: [{ id: 2 }], subtask: [{ id: 2 }] } };
  const b = { id: 2, related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 1 }] } };
  const { tasks } = nestSubtasks([a, b]);
  assert.deepEqual(ids(tasks).sort(), [1, 2]);
});

test('a template\'s steps go in their order: by id, with no order line', () => {
  const tpl = { id: 1, labels: [{ title: 'template' }], description: '', related_tasks: { subtask: [{ id: 9 }, { id: 3 }] } };
  const { tasks } = nestSubtasks([tpl, parentOf(9, 1), parentOf(3, 1)]);
  assert.deepEqual(ids(tasks), [1, 3, 9]);
});

test('the key a list is saved under, for opening it offline', () => {
  assert.equal(viewKey({ name: 'project', id: 7, showDone: false }), 'project.7.open');
  assert.equal(viewKey({ name: 'project', id: 7, showDone: true }), 'project.7.done');
  assert.equal(viewKey({ name: 'run', id: 12 }), 'run.12');
  assert.equal(viewKey({ name: 'today' }), 'today');
});

test('Today\'s groups, in order, each new', () => {
  assert.deepEqual(todayGroups().map(g => g.key), ['overdue', 'today', 'runs', 'nodate', 'week']);
  assert.notEqual(todayGroups()[0].tasks, todayGroups()[0].tasks);
});

test('Today’s groups in their order, a task not sent yet already in its place', () => {
  const at = h => `2026-10-07T${String(h).padStart(2, '0')}:00:00Z`;
  const overdue = [{ id: 1, priority: 0, due_date: at(8) }, { id: 2, priority: 3, due_date: at(9) }, { id: 3, priority: 0, due_date: at(7) }];
  assert.deepEqual(ids(overdue.sort(todayOrder().overdue)), [2, 3, 1], 'the most urgent, then the longest overdue');
  const today = [{ id: 4, due_date: at(15) }, { id: 'pending-a', pending: true, due_date: at(12) }, { id: 5, due_date: at(10) }];
  assert.deepEqual(ids(today.sort(todayOrder().today)), [5, 'pending-a', 4], 'soonest first');
  const added = [{ id: 6, created: at(9) }, { id: 7, created: at(11) }, { id: 'pending-b', pending: true }];
  assert.deepEqual(ids(added.sort(todayOrder().nodate)), ['pending-b', 7, 6], 'newest first, one not sent yet before them');
});

test('a card goes in Today’s order by what brought it, a row by its own dates', () => {
  const at = h => `2026-10-07T${String(h).padStart(2, '0')}:00:00Z`;
  const cards = { 8: { when: at(9), made: null }, 9: { when: null, made: at(12) } }, by = todayAt(cards), order = todayOrder(by);
  const today = [{ id: 4, due_date: at(10) }, { id: 8, due_date: at(20) }];
  assert.deepEqual(ids(today.sort(order.today)), [8, 4], 'a card due later itself, but brought by a subtask due at 9');
  const added = [{ id: 6, created: at(11) }, { id: 9, created: at(1) }];
  assert.deepEqual(ids(added.sort(order.nodate)), [9, 6], 'a card made long ago, brought by a subtask of yours made at 12');
  assert.equal(by({ id: 4, due_date: at(10) }).due_date, at(10));
});

/* What lives on Checklists stays out of a project's lists and search (one-concept-plan, part 3): a template marked done,
   and its steps, known with no request: a template in the same list, one kept from Checklists, or "TEMPLATE:" in its
   title. A template that comes round stays, as it's due. A project's Done leaves out a run's steps too; its open list
   has a run in progress as a card, with its open steps on it, and leaves out a finished run's (parent-tasks-plan, part 2). */
test('templates marked done and their steps are left out, and in a project’s Done a run’s steps; anything else stays', () => {
  const app = component(checklists, runs), tpl = { title: 'template' }, DUE = '2026-10-09T09:00:00Z';
  app.checklistIds = new Set([2]);
  localStorage.setItem('pocket.saved.templates', JSON.stringify({ 40: { id: 40, title: 'Old one' } }));
  const t = (id, f = {}) => ({ id, title: 'Task ' + id, done: true, project_id: 2, labels: [], description: '', related_tasks: {}, ...f });
  const under = (id, title) => ({ parenttask: [{ id, title }] });
  const list = [
    t(30, { labels: [tpl] }), t(31, { related_tasks: under(30, 'Opening up') }),           // a template, and its step
    t(32, { related_tasks: under(40, 'Old one') }),                                         // a step of a template kept from Checklists
    t(33, { related_tasks: under(41, 'TEMPLATE: Closing') }),                               // one named as Pocket names templates
    t(50, { done: false, due_date: DUE, labels: [tpl] }),                                  // a template that comes round
    t(60, { done: false, related_tasks: { copiedfrom: [{ id: 30 }] } }), t(61, { done: false, related_tasks: { ...under(60, 'Opening up · run 1'), copiedfrom: [{ id: 31 }] } }),
    t(70), t(71, { related_tasks: under(70, 'Task 70') }),                                  // a task and its subtask
    t(80, { project_id: 1, labels: [tpl] }), t(81, { project_id: 1, related_tasks: under(80, 'TEMPLATE: Not here') }),   // not a project for checklists
  ];
  assert.deepEqual(ids(app.withoutTemplates(list)), [50, 60, 61, 70, 71, 80, 81], 'search: a run’s steps stay');
  assert.deepEqual(ids(app.withoutTemplates(list, true)), [50, 60, 70, 71, 80, 81], 'a project’s Done: its steps are on its screen');
  const open = [t(60, { done: false, related_tasks: { copiedfrom: [{ id: 30 }] } }), t(61, { done: false, related_tasks: { ...under(60, 'Opening up · run 1'), copiedfrom: [{ id: 31 }] } }),
    t(62, { done: false, related_tasks: { ...under(65, 'Opening up · run 0'), copiedfrom: [{ id: 31 }] } }), t(70, { done: false })];
  app.isRunTask = x => [60, 65].includes(x.id); app.stepRun = x => x.related_tasks.parenttask?.[0]?.id ?? null;
  assert.deepEqual(ids(app.onProjectList(open)), [60, 61, 70], 'a project’s open list: a run in progress with its steps, a card; not a finished run’s step');
  app.checklistIds = new Set();
  assert.equal(app.withoutTemplates(list), list, 'no project for checklists: nothing to look at');
  localStorage.removeItem('pocket.saved.templates');
});

/* A project's copy kept on the phone (performance-plan, part 4): its Done section's count and not its tasks, which are
   loaded when it's opened; and shown, its Done is open only if it's open now, not as it was when the copy was kept. */
test('a project\'s kept copy has Done\'s count, not its tasks, and opens Done only if it\'s open now', () => {
  const open = { key: 'open', tasks: [{ id: 1 }] }, done = { key: 'done', fold: true, open: true, loaded: true, count: 2, tasks: [{ id: 8 }, { id: 9 }] };
  assert.deepEqual(keptGroups([open, done]), [open, { ...done, tasks: [], loaded: false, loading: false }]);
  assert.equal(done.tasks.length, 2, 'the groups on screen are left as they are');
  const app = component(views, tasks);
  Object.assign(app, { projById: new Map([[5, { id: 5, title: 'Big' }]]), positions: {}, view: { groups: [] } });
  const copy = { groups: [open, done], project: { id: 5 }, at: new Date().toISOString() };
  app.showSaved({ name: 'project', id: 5 }, copy);
  assert.deepEqual(app.view.groups.map(g => [g.key, g.open, g.tasks.length]), [['open', undefined, 1], ['done', false, 0]], 'closed since: closed, none drawn');
  localStorage.setItem('pocket.done.open', JSON.stringify({ 5: true }));
  app.showSaved({ name: 'project', id: 5 }, { ...copy, groups: [open, { ...done, open: false }] });
  assert.deepEqual(app.view.groups.map(g => [g.key, g.open, g.tasks.length, g.loaded]), [['open', undefined, 1, undefined], ['done', true, 0, false]], 'open now: open, loaded afresh');
  localStorage.removeItem('pocket.done.open');
});

/* A long screen drawn a batch at a time (performance-plan, part 5): its first rows at once, then the rest down its lists
   in order, a batch a frame, each about a frame's work; scrolling near the end of what's drawn draws the rest. */
test('a list draws the rows of the screen’s first rows that are its own', () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(drawnOf(list, 0, 3), [1, 2, 3]);
  assert.deepEqual(drawnOf(list, 4, 6), [1, 2], 'a list further down: what’s left of them');
  assert.deepEqual(drawnOf(list, 10, 6), [], 'none left');
  assert.equal(drawnOf(list, 2, Infinity), list, 'all of it: the list itself');
});

test('a batch is about its time’s work: more rows when it took less, fewer when more, a few at least', () => {
  assert.equal(nextBatch(20, 20, 40), 40, 'twice as fast as wanted: twice the rows, no more');
  assert.equal(nextBatch(20, 1, 40), 40, 'nothing to it: no more than twice');
  assert.equal(nextBatch(20, 80, 40), 10);
  assert.equal(nextBatch(20, 1000, 40), 4, 'a slow phone still draws a few a frame');
  assert.equal(nextBatch(40, 500, 1000), 80, 'a second’s work: more rows, no more than twice');
});

test('the first few screens are drawn a frame’s work at a time, the rest about a second’s', () => {
  assert.equal(NEAR_ROWS, 3 * FIRST_ROWS);
  assert.equal(batchMs(FIRST_ROWS), FRAME_MS);
  assert.equal(batchMs(NEAR_ROWS - 1), FRAME_MS);
  assert.equal(batchMs(NEAR_ROWS), LATER_MS);
  assert.ok(FRAME_MS <= 50 && LATER_MS >= 500);
});

test('a screen draws its first rows, the rest a batch a frame, then everything', async () => {
  const frames = [], listening = new Map();
  Object.assign(globalThis, { requestAnimationFrame: f => frames.push(f), scrollY: 0, innerHeight: 800,
    addEventListener: (k, f) => listening.set(k, f), removeEventListener: k => listening.delete(k) });
  document.documentElement = { scrollHeight: 5000 };
  const frame = async () => { const f = frames.splice(0); for (const x of f) x(); await new Promise(r => setTimeout(r)); };
  const app = component(views);
  Object.assign(app, { drawTo: Infinity, drawing: false, view: { loading: false, groups: [{ key: 'a', tasks: Array.from({ length: 30 }) }, { key: 'b', tasks: Array.from({ length: 200 }) }] } });
  app.drawFrom(0);
  assert.equal(app.drawTo, FIRST_ROWS, 'its first rows at once');
  assert.equal(app.drawing, true, 'busy meanwhile');
  await frame();
  assert.equal(app.drawTo, FIRST_ROWS, 'nothing more until they’re painted');
  const seen = [];
  while (app.drawing && seen.length < 100) { await frame(); seen.push(app.drawTo); }
  assert.ok(seen.length > 2 && seen.slice(0, -1).every((x, i) => !i || x > seen[i - 1]), 'more each frame: ' + seen);
  assert.equal(app.drawTo, Infinity, 'then everything, and anything added later at once');
  assert.equal(listening.has('scroll'), false, 'no longer watching the scroll');

  app.drawFrom(0); await frame(); await frame();
  assert.ok(app.drawTo < 230 && listening.has('scroll'));
  globalThis.scrollY = 3500; listening.get('scroll')();
  assert.equal(app.drawTo, Infinity, 'scrolled within a screen of the end of what’s drawn: the rest at once');
  assert.equal(app.drawing, false);
  await frame();
  assert.equal(app.drawTo, Infinity, 'the batches stopped');
  globalThis.scrollY = 0;
});

test('a list worked out again as it was is the same object, so its rows have nothing to do', () => {
  const t = id => ({ id }), a = t(1), b = t(2), c = t(3);
  const g = { key: 'open', title: 'Open', tasks: [a, b], depth: { 1: 0, 2: 1 }, kids: new Map([[1, [b]]]), before: 0, delete: true };
  assert.equal(sameGroup(g, { ...g, tasks: [a, b], depth: { 1: 0, 2: 1 }, kids: new Map([[1, [b]]]) }), true);
  assert.equal(sameGroup(g, { ...g, tasks: [a, c] }), false, 'another task');
  assert.equal(sameGroup(g, { ...g, tasks: [b, a] }), false, 'in another order');
  assert.equal(sameGroup(g, { ...g, depth: { 1: 0, 2: 0 } }), false, 'not under it now');
  assert.equal(sameGroup(g, { ...g, kids: new Map([[1, [b, c]]]) }), false);
  assert.equal(sameGroup(g, { ...g, before: 4 }), false, 'further down the screen');
  assert.equal(sameGroup(g, { ...g, open: true }), false, 'a field more');
  assert.equal(sameGroup(undefined, g), false);

  const app = component(views, sending, lines);
  Object.assign(app, { route: { name: 'search' }, pending: [], deleting: [], positions: {}, cardOf: () => null,
    view: { groups: [{ key: 'open', tasks: [a, b] }, { key: 'done', tasks: [c] }] } });
  const [open, done] = app.listGroups;
  assert.deepEqual([open.before, done.before], [0, 2], 'how many rows are above each');
  app.view.groups = [{ key: 'open', tasks: [a, b] }, { key: 'done', tasks: [] }];
  const again = app.listGroups;
  assert.equal(again[0], open, 'loaded again, unchanged: the same');
  assert.notEqual(again[1], done, 'changed: a new one');
});

test('the other screens aren’t loaded in the background while a screen’s rows are still being drawn', async () => {
  const app = component(views);
  let asked = 0, loaded = 0;
  Object.assign(app, { drawing: true, user: { id: 1 }, schedulePreload(){ asked++; }, refreshPeople: async () => { loaded++; }, preloads: () => [] });
  await app.preload();
  assert.deepEqual([asked, loaded], [1, 0], 'asked again later, nothing loaded');
  app.drawing = false;
  await app.preload();
  assert.equal(loaded, 1, 'once they’re drawn');
});
