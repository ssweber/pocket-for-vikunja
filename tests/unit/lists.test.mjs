// The lists Pocket shows (src/js/lists.js): their order, and where subtasks go under their parents.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchMs,
  dayGroup,
  doneParentIds,
  drawnOf,
  FIRST_ROWS,
  FRAME_MS,
  gapIndex,
  intoGroup,
  isMovedGap,
  LATER_MS,
  NEAR_ROWS,
  keptGroups,
  nestSubtasks,
  nextBatch,
  opened,
  saved,
  sameGroup,
  savedScreen,
  soonestFirst,
  TODAY_DAYS,
  todayAt,
  todayGroups,
  todayOrder,
  viewKey,
} from '../../src/js/lists.js';
import { component, fakeVikunja } from './fake.mjs';
import { watching } from './reactive.mjs';
import checklists from '../../src/js/app/checklists.js';
import runs from '../../src/js/app/runs.js';
import views, { renderSeq } from '../../src/js/app/views.js';
import tasks, { copyOf, started } from '../../src/js/app/tasks.js';
import { TASK } from '../../src/js/tasks.js';
import sending from '../../src/js/app/sending.js';
import lines from '../../src/js/app/lines.js';
import auth from '../../src/js/app/auth.js';
import actions from '../../src/js/app/actions.js';
import leaving from '../../src/js/app/leaving.js';
import cards from '../../src/js/app/cards.js';
import { fingers } from './actions-helpers.mjs';
import { noConnection, sender } from './ops-helpers.mjs';
import { sync, uuid7 } from '../../src/js/sync.js';

const ids = list => list.map(t => t.id);
const NONE = '0001-01-01T00:00:00Z'; // Vikunja's "no date"

test('soonest first sorts dated tasks by date, then undated tasks by priority, then newest', () => {
  const list = [
    { id: 1, due_date: NONE, priority: 0 },
    { id: 2, due_date: '2026-10-09T09:00:00Z' },
    { id: 3, due_date: NONE, priority: 3 },
    { id: 4, due_date: '2026-10-08T09:00:00Z' },
    { id: 5, due_date: null, priority: 0 },
  ];
  assert.deepEqual(ids(soonestFirst(list)), [4, 2, 3, 5, 1]);
  assert.deepEqual(ids(list), [1, 2, 3, 4, 5], 'the list passed in is not changed');
});

const parentOf = (id, ...parents) => ({ id, related_tasks: { parenttask: parents.map(p => ({ id: p })) } });
const withSubs = (id, ...subs) => ({ id, related_tasks: { subtask: subs.map(s => ({ id: s })) } });

test("each subtask comes straight after its parent, in the parent's order, with its depth", () => {
  const list = [parentOf(4, 1), withSubs(1, 3, 4), parentOf(5, 4), parentOf(3, 1), { id: 2 }];
  list[0].related_tasks.subtask = [{ id: 5 }];
  const { tasks, depth } = nestSubtasks(list);
  assert.deepEqual(ids(tasks), [1, 3, 4, 5, 2]);
  assert.deepEqual(depth, { 1: 0, 3: 1, 4: 1, 5: 2, 2: 0 });
});

test('a subtask whose parent is not in the list stays where it was, at the top level', () => {
  const { tasks, depth } = nestSubtasks([{ id: 1 }, parentOf(2, 99), { id: 3 }]);
  assert.deepEqual(ids(tasks), [1, 2, 3]);
  assert.equal(depth[2], 0);
});

test('a done parent with open subtasks is found and shown above them, so they do not sit at the top level', () => {
  const sub = (id, parent, more = {}) => ({
    id,
    done: false,
    related_tasks: { parenttask: [{ id: parent, done: true, project_id: 1 }] },
    ...more,
  });
  // This is what a project's List view returns. It has the open tasks and their subtasks, including done subtasks such as task 8, which is done and under task 6.
  const view = [
    { id: 1 },
    sub(2, 9),
    sub(3, 9),
    sub(4, 7, { related_tasks: { parenttask: [{ id: 7, done: true, project_id: 2 }] } }),
    { id: 6, related_tasks: { subtask: [{ id: 8 }] } },
    { id: 8, done: true, related_tasks: { parenttask: [{ id: 6, done: false, project_id: 1 }] } },
    sub(5, 8),
  ];
  assert.deepEqual(
    doneParentIds(view, 1),
    [9, 8],
    'a parent in another project is skipped, and a done parent the view returned under an open task is included',
  );
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

test("tasks that are each other's subtasks are each shown once", () => {
  const a = { id: 1, related_tasks: { parenttask: [{ id: 2 }], subtask: [{ id: 2 }] } };
  const b = { id: 2, related_tasks: { parenttask: [{ id: 1 }], subtask: [{ id: 1 }] } };
  const { tasks } = nestSubtasks([a, b]);
  assert.deepEqual(ids(tasks).sort(), [1, 2]);
});

test("a template's steps are sorted by id when it has no order line", () => {
  const tpl = {
    id: 1,
    labels: [{ title: 'template' }],
    description: '',
    related_tasks: { subtask: [{ id: 9 }, { id: 3 }] },
  };
  const { tasks } = nestSubtasks([tpl, parentOf(9, 1), parentOf(3, 1)], null, t => t.id === 1);
  assert.deepEqual(ids(tasks), [1, 3, 9]);
});

test('a list is saved under a key so it can open offline', () => {
  assert.equal(viewKey({ name: 'project', id: 7, showDone: false }), 'project.7.open');
  assert.equal(viewKey({ name: 'project', id: 7, showDone: true }), 'project.7.done');
  assert.equal(viewKey({ name: 'run', id: 12 }), 'run.12');
  assert.equal(viewKey({ name: 'today' }), 'today');
});

test("Today's groups come in a fixed order, and each call returns new lists", () => {
  assert.deepEqual(
    todayGroups().map(g => g.key),
    ['overdue', 'today', 'runs', 'nodate', 'week', 'donetoday'],
  );
  assert.notEqual(todayGroups()[0].tasks, todayGroups()[0].tasks);
});

test("Today's groups sort their tasks, and a task waiting to be sent is already in position", () => {
  const at = h => `2026-10-07T${String(h).padStart(2, '0')}:00:00Z`;
  const overdue = [
    { id: 1, priority: 0, due_date: at(8) },
    { id: 2, priority: 3, due_date: at(9) },
    { id: 3, priority: 0, due_date: at(7) },
  ];
  assert.deepEqual(
    ids(overdue.sort(todayOrder().overdue)),
    [2, 3, 1],
    'overdue tasks sort by priority, then by how long they have been overdue',
  );
  const today = [
    { id: 4, due_date: at(15) },
    { id: 'pending-a', pending: true, due_date: at(12) },
    { id: 5, due_date: at(10) },
  ];
  assert.deepEqual(ids(today.sort(todayOrder().today)), [5, 'pending-a', 4], 'tasks due today sort soonest first');
  const added = [
    { id: 6, created: at(9) },
    { id: 7, created: at(11) },
    { id: 'pending-b', pending: true },
  ];
  assert.deepEqual(
    ids(added.sort(todayOrder().nodate)),
    ['pending-b', 7, 6],
    'tasks with no date sort newest first, and a task waiting to be sent comes before them',
  );
});

test('the gap a moved row leaves goes under the row that was above it, or at its old index once that row has gone', () => {
  const rows = [{ id: 1 }, { id: 'moved-a', gapOf: 2 }, { id: 3 }];
  assert.deepEqual(rows.map(isMovedGap), [false, true, false]);
  assert.equal(gapIndex(rows, { after: null, at: 2 }), 0, 'the first row has nothing above it');
  assert.equal(gapIndex(rows, { after: 'moved-a', at: 0 }), 2, 'under another gap');
  assert.equal(gapIndex(rows, { after: 9, at: 1 }), 1, 'the row above has gone');
  assert.equal(gapIndex(rows, { after: 9, at: 7 }), 3, 'and the group is shorter now');
});
test('Today sorts a card by the subtask that put it there, and a row by its own dates', () => {
  const at = h => `2026-10-07T${String(h).padStart(2, '0')}:00:00Z`;
  const cards = { 8: { when: at(9), made: null }, 9: { when: null, made: at(12) } },
    by = todayAt(cards),
    order = todayOrder(by);
  const today = [
    { id: 4, due_date: at(10) },
    { id: 8, due_date: at(20) },
  ];
  assert.deepEqual(
    ids(today.sort(order.today)),
    [8, 4],
    'a card due later itself sorts first, because a subtask due at 9 put it on Today',
  );
  const added = [
    { id: 6, created: at(11) },
    { id: 9, created: at(1) },
  ];
  assert.deepEqual(
    ids(added.sort(order.nodate)),
    [9, 6],
    'a card made long ago sorts first, because a subtask made at 12 put it on Today',
  );
  assert.equal(by({ id: 4, due_date: at(10) }).due_date, at(10));
});

/* Things that belong on Checklists stay out of a project's lists and search. That means a template marked done and its
   steps. Pocket recognises them without a request. A template is recognised by being in the same list, by being saved
   from Checklists, or by "TEMPLATE:" in its title. A template that is due again stays in the list. A project's Done
   list also leaves out the steps of a checklist. A project's open list shows a checklist in progress as a card with its
   open steps on it, and leaves out the steps of a finished checklist. */
test('templates marked done and their steps are left out of project lists and search, and anything else stays', () => {
  const app = component(checklists, runs),
    tpl = { title: 'template' },
    DUE = '2026-10-09T09:00:00Z';
  app.checklistIds = new Set([2]);
  localStorage.setItem('pocket.saved.templates', JSON.stringify({ 40: { id: 40, title: 'Old one' } }));
  const t = (id, f = {}) => ({
    id,
    title: 'Task ' + id,
    done: true,
    project_id: 2,
    labels: [],
    description: '',
    related_tasks: {},
    ...f,
  });
  const under = (id, title) => ({ parenttask: [{ id, title }] });
  const list = [
    t(30, { labels: [tpl] }),
    t(31, { related_tasks: under(30, 'Opening up') }), // a template and its step
    t(32, { related_tasks: under(40, 'Old one') }), // a step of a template saved from Checklists
    t(33, { related_tasks: under(41, 'TEMPLATE: Closing') }), // a template named the way Pocket names templates
    t(50, { done: false, due_date: DUE, labels: [tpl] }), // a template that is due again
    t(60, { done: false, related_tasks: { copiedfrom: [{ id: 30 }] } }),
    t(61, { done: false, related_tasks: { ...under(60, 'Opening up · run 1'), copiedfrom: [{ id: 31 }] } }),
    t(70),
    t(71, { related_tasks: under(70, 'Task 70') }), // a task and its subtask
    t(80, { project_id: 1, labels: [tpl] }),
    t(81, { project_id: 1, related_tasks: under(80, 'TEMPLATE: Not here') }), // a project that isn't for checklists
  ];
  assert.deepEqual(ids(app.withoutTemplates(list)), [50, 60, 61, 70, 71, 80, 81], "search keeps a checklist's steps");
  assert.deepEqual(
    ids(app.withoutTemplates(list, true)),
    [50, 60, 70, 71, 80, 81],
    "a project's Done list leaves out a checklist's steps, because they show on the checklist's own screen",
  );
  const open = [
    t(60, { done: false, related_tasks: { copiedfrom: [{ id: 30 }] } }),
    t(61, { done: false, related_tasks: { ...under(60, 'Opening up · run 1'), copiedfrom: [{ id: 31 }] } }),
    t(62, { done: false, related_tasks: { ...under(65, 'Opening up · run 0'), copiedfrom: [{ id: 31 }] } }),
    t(70, { done: false }),
  ];
  app.isRunTask = x => [60, 65].includes(x.id);
  app.stepRun = x => x.related_tasks.parenttask?.[0]?.id ?? null;
  assert.deepEqual(
    ids(app.onProjectList(open)),
    [60, 61, 70],
    "a project's open list shows a checklist in progress as a card with its steps, and leaves out the step of a finished checklist",
  );
  app.checklistIds = new Set();
  assert.equal(app.withoutTemplates(list), list, 'with no project for checklists, the list is returned unchanged');
  localStorage.removeItem('pocket.saved.templates');
});

/* A project's copy saved on the phone keeps the count of its Done section, not the tasks in it. Those load when the
   user opens Done. When the copy is shown, Done is open only if it is open now, not if it was open when the copy was
   saved. */
test("a project's saved copy keeps the Done count but not its tasks, and opens Done only if it is open now", () => {
  const open = { key: 'open', tasks: [{ id: 1 }] },
    done = { key: 'done', fold: true, open: true, loaded: true, count: 2, tasks: [{ id: 8 }, { id: 9 }] };
  assert.deepEqual(keptGroups([open, done]), [open, { ...done, tasks: [], loaded: false, loading: false }]);
  assert.equal(done.tasks.length, 2, 'the groups on screen are not changed');
  const app = component(views, tasks);
  Object.assign(app, { projById: new Map([[5, { id: 5, title: 'Big' }]]), positions: {}, view: { groups: [] } });
  app.change(w => w.read([{ id: 1, title: 'Mop the floor' }], TASK, started()));
  const copy = { ...savedScreen({ groups: [open, done] }), project: { id: 5 }, at: new Date().toISOString() };
  app.showSaved({ name: 'project', id: 5 }, copy);
  assert.deepEqual(
    app.view.groups.map(g => [g.key, g.open, g.tasks.length]),
    [
      ['open', undefined, 1],
      ['done', false, 0],
    ],
    'Done was closed since the copy was saved, so it is closed and draws no tasks',
  );
  localStorage.setItem('pocket.done.open', JSON.stringify({ 5: true }));
  app.showSaved({ name: 'project', id: 5 }, { ...copy, ...savedScreen({ groups: [open, { ...done, open: false }] }) });
  assert.deepEqual(
    app.view.groups.map(g => [g.key, g.open, g.tasks.length, g.loaded]),
    [
      ['open', undefined, 1, undefined],
      ['done', true, 0, false],
    ],
    'Done is open now, so it is open and loads again',
  );
  localStorage.removeItem('pocket.done.open');
});

/* Each kind of screen is saved on the phone as the ids of its tasks. Shown again, it shows the store's newest copy of
   each, also after a reload, and a task Vikunja answers with 404 leaves it. `screen` is the screen as its load saves
   it, from rows 11 and 12, and `shown` gives the titles of the rows it shows. */
const SCREENS = [
  [
    'Today',
    { name: 'today' },
    rows => ({ groups: [{ key: 'today', tasks: rows }], cards: {}, steps: [] }),
    app => app.view.groups.find(g => g.key === 'today').tasks,
  ],
  [
    'A project',
    { name: 'project', id: 7 },
    rows => ({ groups: [{ key: 'open', tasks: rows }], project: { id: 7 } }),
    app => app.view.groups.find(g => g.key === 'open').tasks,
  ],
  [
    'Checklists',
    { name: 'checklists' },
    rows => ({ checklists: [{ project: { id: 7 }, runs: rows, finished: [] }] }),
    app => app.view.checklists[0].runs,
  ],
  [
    'A checklist',
    { name: 'run', id: 20 },
    () => ({ shownRun: { id: 20, steps: [11, 12], at: null, last: null } }),
    app => app.view.shownRun.steps.map(id => app.tasks[id]).filter(Boolean),
  ],
];
for (const [kind, route, screen, shown] of SCREENS)
  test(`${kind}, saved as ids, shows the store's newest copy of each task, and a task deleted in Vikunja leaves it`, async () => {
    await sync.ready;
    const v = fakeVikunja([
        { id: 11, title: 'Wipe the menus', project_id: 7 },
        { id: 12, title: 'Mop the floor', project_id: 7 },
        { id: 20, title: 'Close up', project_id: 7, related_tasks: { subtask: [{ id: 11 }, { id: 12 }] } },
      ]),
      open = () =>
        Object.assign(component(views, tasks, runs), {
          user: { id: 1 },
          projById: new Map([[7, { id: 7, title: 'Cafe' }]]),
          positions: {},
        }),
      key = viewKey(route),
      app = open();
    app.change(w =>
      w.read(
        [...v.tasks.values()].map(t => structuredClone(t)),
        TASK,
        started(),
      ),
    );
    if (route.id) opened(route.name, route.id);
    app.keepScreen(key, { ...screen([11, 12].map(id => app.row(copyOf(id)))), at: new Date().toISOString() });
    assert.equal(JSON.stringify(saved.get(key)).includes('Wipe'), false, 'the saved screen holds no task');
    v.task(11).title = 'Wipe all the menus';
    await app.readCopy(11);
    v.tasks.delete(12);
    await app.readCopy(12).catch(() => {});
    app.showSaved(route, app.keptScreen(key));
    assert.deepEqual(
      shown(app).map(t => t.title),
      ['Wipe all the menus'],
    );
    app.sweep(); // as the next load does
    const again = open();
    again.showSaved(route, again.keptScreen(key));
    assert.deepEqual(
      shown(again).map(t => t.title),
      ['Wipe all the menus'],
      'after a reload',
    );
    localStorage.clear();
  });

/* A long screen is rendered in batches. The first rows render at once, then the rest render down the lists in order,
   one batch per frame, each batch sized to about a frame's work. Scrolling near the end of the rendered rows renders
   the rest. */
test("a list draws only those of the screen's first rows that belong to it", () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(drawnOf(list, 0, 3), [1, 2, 3]);
  assert.deepEqual(drawnOf(list, 4, 6), [1, 2], 'a list further down draws the rows that remain');
  assert.deepEqual(drawnOf(list, 10, 6), [], 'no rows remain');
  assert.equal(drawnOf(list, 2, Infinity), list, 'drawing everything returns the list itself');
});

test('the next batch is sized to the time available, with more rows when the last batch was quick and a few at least', () => {
  assert.equal(nextBatch(20, 20, 40), 40, 'a batch twice as fast as wanted doubles the rows');
  assert.equal(nextBatch(20, 1, 40), 40, 'the rows never more than double');
  assert.equal(nextBatch(20, 80, 40), 10);
  assert.equal(nextBatch(20, 1000, 40), 4, 'a slow phone still draws a few rows a frame');
  assert.equal(nextBatch(40, 500, 1000), 80, 'a batch sized to a second still never more than doubles');
});

test('the first few screens are drawn in frame-sized batches, and the rest in batches of about a second', () => {
  assert.equal(NEAR_ROWS, 3 * FIRST_ROWS);
  assert.equal(batchMs(FIRST_ROWS), FRAME_MS);
  assert.equal(batchMs(NEAR_ROWS - 1), FRAME_MS);
  assert.equal(batchMs(NEAR_ROWS), LATER_MS);
  assert.ok(FRAME_MS <= 50 && LATER_MS >= 500);
});

test('a screen draws its first rows at once, then one batch a frame, then everything', async () => {
  const frames = [],
    listening = new Map();
  Object.assign(globalThis, {
    requestAnimationFrame: f => frames.push(f),
    scrollY: 0,
    innerHeight: 800,
    addEventListener: (k, f) => listening.set(k, f),
    removeEventListener: k => listening.delete(k),
  });
  document.documentElement = { scrollHeight: 5000 };
  const frame = async () => {
    const f = frames.splice(0);
    for (const x of f) x();
    await new Promise(r => setTimeout(r));
  };
  const app = component(views);
  Object.assign(app, {
    drawTo: Infinity,
    drawing: false,
    view: {
      loading: false,
      groups: [
        { key: 'a', tasks: Array.from({ length: 30 }) },
        { key: 'b', tasks: Array.from({ length: 200 }) },
      ],
    },
  });
  app.drawFrom(0);
  assert.equal(app.drawTo, FIRST_ROWS, 'the first rows are drawn at once');
  assert.equal(app.drawing, true, 'the screen is busy drawing meanwhile');
  await frame();
  assert.equal(app.drawTo, FIRST_ROWS, 'no more rows are drawn until the first rows are painted');
  const seen = [];
  while (app.drawing && seen.length < 100) {
    await frame();
    seen.push(app.drawTo);
  }
  assert.ok(
    seen.length > 2 && seen.slice(0, -1).every((x, i) => !i || x > seen[i - 1]),
    'each frame draws more rows: ' + seen,
  );
  assert.equal(app.drawTo, Infinity, 'then everything is drawn, and anything added later is drawn at once');
  assert.equal(listening.has('scroll'), false, 'the screen stops listening for scrolls');

  app.drawFrom(0);
  await frame();
  await frame();
  assert.ok(app.drawTo < 230 && listening.has('scroll'));
  globalThis.scrollY = 3500;
  listening.get('scroll')();
  assert.equal(app.drawTo, Infinity, 'scrolling to within a screen of the last drawn row draws the rest at once');
  assert.equal(app.drawing, false);
  await frame();
  assert.equal(app.drawTo, Infinity, 'the batches stop');
  globalThis.scrollY = 0;
});

test('a list recalculated with the same content is the same object, so its rows do not update', () => {
  const t = id => ({ id }),
    a = t(1),
    b = t(2),
    c = t(3);
  const g = {
    key: 'open',
    title: 'Open',
    tasks: [a, b],
    depth: { 1: 0, 2: 1 },
    kids: new Map([[1, [b]]]),
    before: 0,
    delete: true,
  };
  assert.equal(sameGroup(g, { ...g, tasks: [a, b], depth: { 1: 0, 2: 1 }, kids: new Map([[1, [b]]]) }), true);
  assert.equal(sameGroup(g, { ...g, tasks: [a, c] }), false, 'a different task makes it a different group');
  assert.equal(sameGroup(g, { ...g, tasks: [b, a] }), false, 'a different order makes it a different group');
  assert.equal(
    sameGroup(g, { ...g, depth: { 1: 0, 2: 0 } }),
    false,
    'a subtask that is no longer under its parent makes it a different group',
  );
  assert.equal(sameGroup(g, { ...g, kids: new Map([[1, [b, c]]]) }), false);
  assert.equal(sameGroup(g, { ...g, before: 4 }), false, 'a group further down the screen is a different group');
  assert.equal(sameGroup(g, { ...g, open: true }), false, 'an extra field makes it a different group');
  assert.equal(sameGroup(undefined, g), false);

  const app = component(views, sending, lines);
  Object.assign(app, {
    route: { name: 'search' },
    pending: [],
    positions: {},
    cardOf: () => null,
    view: {
      groups: [
        { key: 'open', tasks: [a, b] },
        { key: 'done', tasks: [c] },
      ],
    },
  });
  const [open, done] = app.listGroups;
  assert.deepEqual([open.before, done.before], [0, 2], 'the number of rows above each group');
  app.view.groups = [
    { key: 'open', tasks: [a, b] },
    { key: 'done', tasks: [] },
  ];
  const again = app.listGroups;
  assert.equal(again[0], open, 'a group loaded again without changes is the same object');
  assert.notEqual(again[1], done, 'a changed group is a new object');
});

test("other screens are not preloaded in the background while a screen's rows are still being drawn", async () => {
  const app = component(views);
  let asked = 0,
    loaded = 0;
  Object.assign(app, {
    drawing: true,
    user: { id: 1 },
    schedulePreload() {
      asked++;
    },
    refreshPeople: async () => {
      loaded++;
    },
    preloads: () => [],
  });
  await app.preload();
  assert.deepEqual([asked, loaded], [1, 0], 'the preload is scheduled for later and nothing is loaded');
  app.drawing = false;
  await app.preload();
  assert.equal(loaded, 1, 'the other screens load once the rows are drawn');
});

/* A list of done tasks is shown a part at a time. A project's Done shows its latest 100 tasks, its heading counts all
   of them, and a row at the end loads the 100 done before those, starting from the last task shown. Done matches in
   search work the same way, 50 at a time. */
function doneVikunja(n) {
  const v = {
    done: Array.from({ length: n }, (_, k) => ({ id: k + 1, title: 'done ' + (k + 1), done: true, project_id: 5 })),
    asked: [],
  };
  globalThis.fetch = async url => {
    const u = new URL(url),
      q = u.searchParams,
      page = +q.get('page'),
      per = Math.min(+q.get('per_page'), 50);
    v.asked.push(u.pathname.replace('/api/v2', '') + ' ' + page + '/' + per);
    return new Response(JSON.stringify({ items: v.done.slice((page - 1) * per, page * per), total: v.done.length }), {
      status: 200,
    });
  };
  return v;
}
function doneApp(route) {
  const app = component(views, tasks, checklists);
  Object.assign(app, {
    route,
    checklistIds: new Set(),
    projById: new Map([[5, { id: 5 }]]),
    positions: {},
    searchQ: 'done',
    showingMore: null,
    view: { groups: [], project: { id: 5 } },
    listGroups: [],
    drawFrom() {},
    $nextTick() {},
  });
  return app;
}

test("a project's Done shows its latest 100 tasks, counts all of them, and has a row that loads 100 earlier ones", async () => {
  const v = doneVikunja(250),
    app = doneApp({ name: 'project', id: 5 });
  const g = app.doneGroup(null, 250, true);
  app.view.groups = [{ key: 'open', tasks: [] }, g];
  await app.loadDoneSection(g);
  assert.deepEqual(
    [g.tasks.length, g.tasks[0].id, g.count],
    [100, 1, 250],
    'the most recently done task is first, and the count includes all of them',
  );
  assert.deepEqual(
    v.asked.sort(),
    ['/projects/5/tasks 1/50', '/projects/5/tasks 2/50'],
    'only one part of the list is requested, not the whole list',
  );
  assert.deepEqual(app.moreOf('done'), { title: 'Show 100 done earlier', note: '150 more not shown' });

  v.asked = [];
  await app.showMore('done');
  assert.deepEqual(
    ids(g.tasks),
    Array.from({ length: 200 }, (_, k) => k + 1),
    'the next 100 tasks follow the first 100',
  );
  assert.deepEqual(v.asked.sort(), ['/projects/5/tasks 3/50', '/projects/5/tasks 4/50']);
  assert.deepEqual(app.moreOf('done'), { title: 'Show the last 50', note: '' });

  // One task was reopened and two were marked done elsewhere. The next part loads from the last task shown, and no task appears twice.
  g.tasks.splice(5, 1);
  g.count--;
  v.done.splice(5, 1);
  v.done.unshift({ id: 900, done: true }, { id: 901, done: true });
  await app.showMore('done');
  assert.equal(new Set(ids(g.tasks)).size, g.tasks.length, 'no task appears twice');
  assert.equal(g.tasks.length, 249);
  assert.equal(g.count, 251, 'the count is the one Vikunja reports now');
  assert.deepEqual(
    app.moreOf('done'),
    { title: 'Show the last 2', note: '' },
    'the two tasks done since are not on the list yet',
  );

  const kept = keptGroups([g])[0];
  assert.deepEqual([kept.tasks.length, kept.count], [0, 251], 'the saved copy keeps the count and none of the tasks');

  // Without a connection, a message appears under the row. The row stays so the user can tap it again.
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await app.showMore('done');
  assert.equal(g.tasks.length, 249);
  assert.deepEqual(
    [app.toast.msg, app.toast.place, app.toast.cls],
    ["Couldn't load the done tasks: no connection to Vikunja", 'more', 'failed'],
  );
  assert.equal(app.showingMore, null);
  assert.ok(app.moreOf('done'));
});

test("reloading a project's Done keeps as many tasks as it showed, and a new visit shows the latest 100", async () => {
  const v = doneVikunja(400),
    app = doneApp({ name: 'project', id: 5 });
  Object.assign(app, {
    pending: [],
    onProjectList: l => l,
    settle: async () => true,
    keepMarked: g => g,
    saveProject() {},
    loadProjects: async () => {},
  });
  localStorage.setItem('pocket.done.open', JSON.stringify({ 5: true }));
  app.projById = new Map([[5, { id: 5, views: [] }]]);
  const shown = app.doneGroup({ tasks: v.done.slice(0, 300), total: 400, skip: 0 }, 400, true);
  app.view.groups = [{ key: 'open', tasks: [] }, shown];
  await app.loadProject(renderSeq, { name: 'project', id: 5 });
  const g = app.view.groups.find(x => x.key === 'done');
  assert.deepEqual([g.tasks.length, g.count], [300, 400], 'reloading shows the 300 tasks it showed before');
  app.view.groups = [];
  await app.loadProject(renderSeq, { name: 'project', id: 5 });
  assert.equal(app.view.groups.find(x => x.key === 'done').tasks.length, 100, 'a new visit shows the latest 100');
  localStorage.removeItem('pocket.done.open');
});

/* A user signs out while a load is on its way, and the next user may sign in before it returns. What it brings is the
   last user's tasks, and none of them reaches the store, the screen or the phone. Vikunja answers each request once
   the test calls `go`, with task 1 open and task 2 done in project 5. */
function signingOut() {
  localStorage.clear();
  const open = [{ id: 1, title: 'Order cups', done: false, project_id: 5 }],
    done = [{ id: 2, title: 'Count the float', done: true, project_id: 5 }];
  let go, came;
  const gate = new Promise(ok => {
      go = ok;
    }),
    arrived = new Promise(ok => {
      came = ok;
    });
  globalThis.fetch = async url => {
    came();
    await gate;
    const items = /done = true/.test(new URL(url).searchParams.get('filter')) ? done : open;
    return new Response(JSON.stringify({ items, total: items.length }), { status: 200 });
  };
  const app = Object.assign(doneApp({ name: 'project', id: 5 }), {
    user: { id: 1 },
    pending: [],
    onProjectList: l => l,
    settle: async () => true,
    keepMarked: g => g,
    loadProjects: async () => {},
    forgetPeople: auth.forgetPeople,
  });
  app.projById = new Map([[5, { id: 5, views: [] }]]);
  app.view.groups = [];
  return { app, go, arrived };
}

test("a project's load that started before sign-out shows and saves none of the last user's tasks", async () => {
  await sync.ready;
  const { app, go, arrived } = signingOut(),
    loading = app.loadProject(renderSeq, { name: 'project', id: 5 });
  await arrived;
  app.forgetPeople();
  app.user = { id: 2 }; // the next user signs in
  go();
  await loading;
  assert.deepEqual(
    [copyOf(1), app.tasks, app.view.groups, saved.get('project.5.open'), saved.get('task.1')],
    [undefined, {}, [], null, null],
  );
  localStorage.clear();
});

test("a project's Done that loads across a sign-out gives none of the last user's tasks a row", async () => {
  const { app, go, arrived } = signingOut(),
    g = app.doneGroup(null, 1, true);
  app.view.groups = [{ key: 'open', tasks: [] }, g];
  const loading = app.loadDoneSection(g);
  await arrived;
  app.forgetPeople();
  app.user = { id: 2 };
  go();
  await loading;
  assert.deepEqual([copyOf(2), app.tasks], [undefined, {}]);
  localStorage.clear();
});

test('a screen loaded in the background across a sign-out is not saved for the next user', async () => {
  await sync.ready;
  const { app, go, arrived } = signingOut();
  saved.set('user', { id: 1 });
  Object.assign(app, {
    drawing: false,
    refreshPeople: async () => {},
    preloads: () => [
      {
        hash: '#/project/5',
        key: 'project.5.open',
        load: async () => ({ groups: [{ key: 'open', tasks: (await app.readProject({ id: 5 }, false)).list }] }),
      },
    ],
  });
  const loading = app.preload();
  await arrived;
  app.forgetPeople();
  app.user = { id: 2 };
  go();
  await loading;
  assert.equal(saved.get('project.5.open'), null);
  localStorage.clear();
});

test('done matches in search show 50 tasks, count all of them, and have a row that loads 50 more', async () => {
  const v = doneVikunja(120),
    app = doneApp({ name: 'search' });
  app.readCards = async () => ({ steps: [], positions: {} });
  app.keepMarked = g => g;
  await app.loadSearch(renderSeq);
  const g = app.view.groups.find(x => x.key === 'done');
  assert.deepEqual([g.tasks.length, g.count, g.title], [50, 120, 'Done']);
  assert.ok(v.asked.includes('/tasks 1/50'));
  assert.deepEqual(app.moreOf('done'), { title: 'Show 50 done earlier', note: '70 more not shown' });
  await app.showMore('done');
  await app.showMore('done');
  assert.deepEqual(
    ids(g.tasks),
    Array.from({ length: 120 }, (_, k) => k + 1),
  );
  assert.equal(app.moreOf('done'), null, 'once all tasks are shown, there is no row');
});

/* This keeps the cost of each row low. A list's group stays one object for as long as the screen is the same
   (shownGroups in app/sending.js). Each group that listGroups works out is written into that object (intoGroup), and
   only what changed is written. That includes depths and the subtasks of cards, updated one task at a time. A row
   reads its list's options from the object, so removing or adding a row doesn't make the unchanged rows update. The
   test uses Alpine's own reactivity (reactive.mjs). It watches everything a row might read and counts how often each
   watcher runs again. */
test('a group on screen stays one object, and removing or adding a row updates only what read the change', c => {
  const { Alpine, flush } = watching(c);
  const a = { id: 1 },
    b = { id: 2 },
    s = { id: 3, related_tasks: { parenttask: [{ id: 2 }] } },
    x = { id: 4 },
    n = { id: 9, related_tasks: { parenttask: [{ id: 2 }] } };
  const group = (tasks, more = {}) => ({
    key: 'open',
    title: 'Open',
    cards: 'list',
    delete: true,
    reorder: true,
    ...nestSubtasks(tasks),
    before: 0,
    ...more,
  });
  const g = Alpine.reactive({ depth: {}, kids: new Map() }),
    into = (tasks, more) => {
      intoGroup(g, group(tasks, more), Alpine.raw);
      flush();
    };
  into([a, b, s, x]);
  assert.deepEqual(
    [Alpine.raw(g).tasks, { ...Alpine.raw(g).depth }, [...Alpine.raw(g.kids)]],
    [[a, b, s, x], { 1: 0, 2: 0, 3: 1, 4: 0 }, [[2, [s]]]],
  );
  const asked = {},
    watch = (what, read) =>
      Alpine.effect(() => {
        asked[what] = (asked[what] || 0) + 1;
        read();
      });
  watch('row 1', () => [g.cards, g.delete, g.depth[1], g.kids.get(1)]);
  watch('card 2', () => [g.cards, g.depth[2], g.kids.get(2)]);
  watch('row 3', () => g.depth[3]);
  watch('the list', () => g.tasks.length);
  watch('row 9', () => g.depth[9]); // task 9 isn't in the list yet
  const once = { 'row 1': 1, 'card 2': 1, 'row 3': 1, 'the list': 1, 'row 9': 1 };
  into([a, b, s, x]);
  assert.deepEqual(asked, once, 'recalculating the same group runs no watcher again');
  into([a, b, s]); // task x is removed
  assert.deepEqual(asked, { ...once, 'the list': 2 }, 'removing a row redraws the list and updates no other row');
  assert.equal(4 in Alpine.raw(g).depth, false);
  into([a, b, s, n]); // a subtask is added under task 2
  assert.deepEqual(
    asked,
    { ...once, 'the list': 3, 'card 2': 2, 'row 9': 2 },
    "adding a subtask updates its card, the list and the subtask's own row",
  );
  assert.deepEqual([...Alpine.raw(g.kids).get(2)], [s, n]);
  into([a, b, s, n], { before: 3 });
  assert.deepEqual(
    [Alpine.raw(g).before, asked],
    [3, { ...once, 'the list': 3, 'card 2': 2, 'row 9': 2 }],
    'a changed field is written, and only a watcher that read it would run again',
  );
  into([a]);
  assert.deepEqual(
    [{ ...Alpine.raw(g).depth }, Alpine.raw(g.kids).size, asked['row 1']],
    [{ 1: 0 }, 0, 1],
    'removing all but one row also removes their depths and subtasks, and the remaining row never updated',
  );
  into([a], { cards: null });
  assert.equal(asked['row 1'], 2, "changing the list's options updates every row");
});

test('a group written into the one the screen keeps drops the fields it no longer has, without Alpine too', () => {
  const a = { id: 1 },
    g = { depth: {}, kids: new Map() };
  const first = intoGroup(g, { key: 'done', fold: true, open: true, tasks: [a], ...nestSubtasks([a]), count: 3 });
  assert.equal(first, g, 'the result is the same object');
  assert.deepEqual([g.tasks, g.depth, g.count, g.open], [[a], { 1: 0 }, 3, true]);
  const tasks = g.tasks;
  intoGroup(g, { key: 'done', fold: true, tasks: [a], ...nestSubtasks([a]) });
  assert.deepEqual(
    ['open' in g, 'count' in g, g.tasks === tasks],
    [false, false, true],
    'missing fields are removed, and an identical list is kept as the same array',
  );
});

/* Rows that are highlighted for a moment (flash in app/lines.js) are stored by task id and changed one row at a time.
   The rows are highlighted when they were just added, just became due, or are new to the screen. Each row reads only
   its own entry, so highlighting one row doesn't make the others update. A single new list of ids would make every row
   on the screen search through it. */
test('briefly highlighted rows are stored by id, so highlighting one row updates no other, and the highlight ends after 2 seconds', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const { Alpine, flush } = watching(c),
    app = Alpine.reactive(component(lines));
  app.flashed = { fresh: {}, due: {}, arrived: {} };
  const asked = {},
    lit = () =>
      Object.fromEntries(Object.entries(Alpine.raw(app).flashed).map(([k, v]) => [k, Object.keys(Alpine.raw(v))]));
  for (const id of [1, 2])
    Alpine.effect(() => {
      asked[id] = (asked[id] || 0) + 1;
      return [app.flashed.fresh[id], app.flashed.arrived[id]];
    });
  app.flash([1]);
  flush();
  assert.deepEqual(
    [lit(), asked],
    [
      { fresh: ['1'], due: [], arrived: [] },
      { 1: 2, 2: 1 },
    ],
    'adding one task updates its row and not the other',
  );
  app.flash([2]);
  flush();
  assert.deepEqual(
    [lit().fresh, asked],
    [['2'], { 1: 3, 2: 2 }],
    'adding another task ends the first highlight and starts the second',
  );
  app.flash([2]);
  app.flash([3, 4], 'arrived');
  flush();
  assert.deepEqual(
    [lit(), asked],
    [
      { fresh: ['2'], due: [], arrived: ['3', '4'] },
      { 1: 3, 2: 2 },
    ],
    'highlighting a row again, and rows new to the screen, updates neither row',
  );
  c.mock.timers.tick(2000);
  flush();
  assert.deepEqual(
    [lit(), asked],
    [
      { fresh: [], due: [], arrived: [] },
      { 1: 3, 2: 3 },
    ],
    'after 2 seconds the highlights end',
  );
});

// Runs `fn` with the local time zone set to `zone`, where a clock change makes a day of 23 or 25 hours.
const inZone = (zone, fn) => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
};
const on = (y, mo, d, h = 0, m = 0) => new Date(y, mo, d, h, m),
  iso = (...a) => on(...a).toISOString();

test('a task with no time due today is late once the day ends, and a timed task one minute after its time', () => {
  assert.deepEqual(
    [dayGroup(iso(2026, 9, 7), on(2026, 9, 7, 23, 59)), dayGroup(iso(2026, 9, 7), on(2026, 9, 8))],
    ['today', 'overdue'],
  );
  assert.deepEqual(
    [dayGroup(iso(2026, 9, 7, 14), on(2026, 9, 7, 14)), dayGroup(iso(2026, 9, 7, 14), on(2026, 9, 7, 14, 1))],
    ['today', 'overdue'],
  );
});

test('Today shows 7 days after today: the last minute of the 7th day is in Next 7 days, and the 8th day is off Today', () => {
  const now = on(2026, 9, 7, 14);
  assert.deepEqual(
    [dayGroup(iso(2026, 9, 8), now), dayGroup(iso(2026, 9, 14, 23, 59), now), dayGroup(iso(2026, 9, 15), now)],
    ['week', 'week', null],
  );
  assert.deepEqual(
    [dayGroup('0001-01-01T00:00:00Z', now), dayGroup(null, now)],
    ['nodate', 'nodate'],
    'an unset date has no date',
  );
  assert.equal(TODAY_DAYS, 8, 'readToday asks Vikunja for the same days');
});

test('on a day of 23 or 25 hours, Today and the 8th day start at midnight', () => {
  inZone('America/New_York', () => {
    const spring = on(2026, 2, 8, 12),
      fall = on(2026, 10, 1, 12); // 8 March 2026 has 23 hours there, 1 November 25
    assert.deepEqual(
      [dayGroup(iso(2026, 2, 8, 23, 30), spring), dayGroup(iso(2026, 2, 9, 0, 30), spring)],
      ['today', 'week'],
      'on a 23-hour day',
    );
    assert.deepEqual(
      [dayGroup(iso(2026, 10, 1, 23, 30), fall), dayGroup(iso(2026, 10, 2), fall)],
      ['today', 'week'],
      'on a 25-hour day',
    );
    assert.deepEqual(
      [dayGroup(iso(2026, 2, 15, 23, 59), spring), dayGroup(iso(2026, 2, 16, 0, 30), spring)],
      ['week', null],
      'the 8th day after a 23-hour day',
    );
  });
});

test('a task moved to another project leaves the project’s list as the batch lets rows move, offline too', async t => {
  const { v, app } = sender(
    t,
    [
      { id: 1, title: 'Book the van', project_id: 5 },
      { id: 2, title: 'Pack the boxes', project_id: 5 },
    ],
    actions,
    leaving,
    views,
    cards,
  );
  t.after(async () => {
    app.clearNow();
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  Object.assign(app, { route: { name: 'project', id: 5 }, render() {} });
  noConnection(app, v);
  app.change(w =>
    w.read(
      [1, 2].map(id => ({ id, title: 'Task ' + id, project_id: 5 })),
      TASK,
      started(),
    ),
  );
  app.view.groups = [
    { key: 'open', cls: '', title: 'Open', tasks: [app.row({ id: 1 }), app.row({ id: 2 })] },
    { key: 'done', loaded: false, count: 0, tasks: [] },
  ];
  const finger = fingers(t, app);
  await app.act({
    id: uuid7(),
    op: 'project',
    task: 1,
    pid: 6,
    subs: {},
    was: { 1: 5 },
    into: 'B',
    from: 'A',
    run: null,
  });
  assert.deepEqual(ids(app.view.groups[0].tasks), [1, 2], 'the row stays while the sheet is open');
  // The sheet closes (closeSheet) while a finger is still down.
  finger('pointerdown');
  app.regroupSoon();
  t.mock.timers.tick(5000);
  await new Promise(setImmediate);
  assert.deepEqual(ids(app.view.groups[0].tasks), [1, 2], 'no row moves under a finger');
  finger('pointerup');
  t.mock.timers.tick(3000);
  await new Promise(setImmediate);
  assert.deepEqual(
    [ids(app.view.groups[0].tasks), app.view.groups[1].count, sync.all(1).length],
    [[2], 0, 1],
    'the task leaves, though the move still waits to be sent',
  );
});

/* Checklist 30 in progress on its project's list, with its steps 31 and 32, as a sender with the batch. Done is loaded
   and empty. */
const checklistOnProject = t => {
  const step = (id, title) => ({
      id,
      title,
      project_id: 7,
      related_tasks: { parenttask: [{ id: 30, project_id: 7 }], copiedfrom: [{ id: id + 100 }] },
    }),
    list = [
      {
        id: 30,
        title: 'Opening up · Oct 19',
        project_id: 7,
        related_tasks: { subtask: [{ id: 31 }, { id: 32 }], copiedfrom: [{ id: 130 }] },
      },
      step(31, 'Lights'),
      step(32, 'Chairs'),
    ];
  const s = sender(t, list, actions, leaving, views, cards, checklists);
  t.after(async () => {
    s.app.clearNow();
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  Object.assign(s.app, { route: { name: 'project', id: 7 }, checklistIds: new Set([7]), render() {} });
  s.app.change(w => w.read(structuredClone(list), TASK, started()));
  s.app.view.groups = [
    { key: 'open', cls: '', title: 'Open', heads: [], tasks: [30, 31, 32].map(id => s.app.row({ id })) },
    { key: 'done', loaded: true, count: 0, tasks: [] },
  ];
  return { ...s, list, groups: () => s.app.view.groups.map(g => [g.key, ids(g.tasks), g.count]) };
};
test('a checklist’s step ticked on its project’s list leaves the list when rows regroup, and never joins Done', async t => {
  const { app, groups } = checklistOnProject(t);
  await app.act({ id: uuid7(), op: 'done', task: 31, run: 30 });
  app.regroup();
  assert.deepEqual(
    groups(),
    [
      ['open', [30, 32], undefined],
      ['done', [], 0],
    ],
    'the step leaves the open list, and Done, which leaves out steps when it loads, doesn’t take it',
  );
});
test('a checklist finished elsewhere goes to Done on its project’s list when rows regroup, and its open steps leave', t => {
  const { app, list, groups } = checklistOnProject(t);
  app.change(w => w.read([{ ...list[0], done: true, done_at: new Date().toISOString() }], TASK, started()));
  app.regroup();
  assert.deepEqual(groups(), [
    ['open', [], undefined],
    ['done', [30], 1],
  ]);
});
test('rows wait to regroup while the list scrolls, and move 3 seconds after it stops', async t => {
  const { app, groups } = checklistOnProject(t),
    scroll = fingers(t, app);
  await app.act({ id: uuid7(), op: 'done', task: 31, run: 30 });
  scroll('scroll');
  app.regroupSoon(); // the sheet closes while the list is still scrolling
  for (let i = 0; i < 40; i++) {
    t.mock.timers.tick(100);
    scroll('scroll');
  }
  await new Promise(setImmediate);
  assert.deepEqual(groups()[0][1], [30, 31, 32], 'nothing moves while the list scrolls');
  t.mock.timers.tick(150); // the list stops
  t.mock.timers.tick(2999);
  await new Promise(setImmediate);
  assert.deepEqual(groups()[0][1], [30, 31, 32], 'nor for 3 seconds after it stops');
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.deepEqual(groups()[0][1], [30, 32], 'then the step leaves');
});
test('a reload’s rows settle only once the finger lifts', async t => {
  const app = doneApp({ name: 'project', id: 5 });
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(leaving));
  Object.assign(app.view, { groups: [{ key: 'open', tasks: [] }], checklists: [] });
  const finger = fingers(t, app);
  finger('pointerdown');
  let settled = null;
  const settling = app.settle([1], renderSeq).then(ok => (settled = ok));
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.equal(settled, null, 'it waits while the finger is down');
  finger('pointerup');
  await settling;
  assert.equal(settled, true, 'and goes on once it lifts');
});
test('a reload whose answer arrives while a finger is down changes the lists only once the finger lifts', async t => {
  doneVikunja(3);
  const app = doneApp({ name: 'search' });
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(leaving));
  const finger = fingers(t, app),
    before = app.view.groups;
  finger('pointerdown');
  const loading = app.loadSearch(renderSeq);
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.equal(app.view.groups, before, 'the lists stay as they are under the finger');
  finger('pointerup');
  await loading;
  assert.deepEqual(
    app.view.groups.map(g => [g.key, g.tasks.length]),
    [
      ['open', 3],
      ['done', 3],
    ],
    'then the reload shows what it read',
  );
});
