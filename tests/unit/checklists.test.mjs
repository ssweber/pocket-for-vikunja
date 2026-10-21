// Checklist steps that don't need HTML (src/js/checklists.js): their order, their times, and what is shown for them.
// tests/parse.mjs covers the parts that need a browser. Those are reading and writing Pocket's lines in a description,
// and parsing steps as the user types them.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  durText,
  inOrder,
  placeBefore,
  plainStep,
  problemText,
  roleOf,
  runParts,
  runWithoutDay,
  stepFrom,
  stepInfos,
  stepProblems,
  SKIP_MARK,
  stepsOf,
  stepWords,
  parseStep,
} from '../../src/js/checklists.js';
import { runTitle } from '../../src/js/sync.js';

const ids = list => list.map(s => s.id);

test('steps follow their order line, then the other steps by id, and ids that are no longer steps are skipped', () => {
  const steps = [{ id: 5 }, { id: 2 }, { id: 9 }, { id: 7 }];
  assert.deepEqual(ids(inOrder(steps, [9, 44, 5])), [9, 5, 2, 7]);
  assert.deepEqual(ids(inOrder(steps, null)), [2, 5, 7, 9]);
  assert.deepEqual(ids(steps), [5, 2, 9, 7], 'the list passed in is not changed');
});

test('an inserted step goes before the step it was put before, else after the step above it, else at the end', () => {
  assert.deepEqual(placeBefore([1, 2, 3], 9, 2, 1), [1, 9, 2, 3]);
  assert.deepEqual(placeBefore([1, 3], 9, 2, 1), [1, 9, 3]);
  assert.deepEqual(placeBefore([3], 9, 2, 1), [3, 9]);
  assert.deepEqual(
    placeBefore([1, 9, 2], 9, 2, 1),
    [1, 9, 2],
    'a step that is already in the order is not added again',
  );
});

test("a template's or checklist's steps with no order line are in id order", () => {
  assert.deepEqual(ids(stepsOf({ related_tasks: { subtask: [{ id: 8 }, { id: 3 }] } })), [3, 8]);
  assert.deepEqual(stepsOf(null), []);
});

test('a countdown is written with its two largest units', () => {
  assert.equal(durText(5400000), '1h 30m');
  assert.equal(durText(90061000), '1d 1h');
  assert.equal(durText(59000), '59s');
  assert.equal(durText(400), '0s');
  assert.equal(durText(0), '0s');
});

test('a timed step counts from the previous step, a named earlier step, or the start', () => {
  const steps = ['Heat the oven {#oven}', 'Roast T#40m:oven', 'Rest T#10m', 'Plate', 'Serve T#5m:later {#later}'].map(
    parseStep,
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(i => stepFrom(steps, i)),
    [null, 0, 1, null, null],
  );
  assert.equal(stepFrom([parseStep('First T#5m')], 0), -1, 'the first step counts from the start of the checklist');
});

test('a step timed with !T# is due as with T#, counts from the same step, and is marked strict', () => {
  const steps = ['Mix the dough {#dough}', 'Shape the loaves !T#20m', 'Bake !T#40m:dough', 'Cool T#10m'].map(parseStep);
  assert.deepEqual(
    steps.map(s => [s.title, s.offset, s.strict]),
    [
      ['Mix the dough', null, false],
      ['Shape the loaves', 20 * 6e4, true],
      ['Bake', 40 * 6e4, true],
      ['Cool', 10 * 6e4, false],
    ],
  );
  assert.deepEqual(
    [1, 2, 3].map(i => stepFrom(steps, i)),
    [0, 0, 2],
  );
  assert.deepEqual(stepProblems(['A !T#5m:b', 'B {#b}']).length, 1, 'it must count from an earlier step, as T# must');
});

test("a template's steps are shown with when each is due, its name, and any problem", () => {
  const shown = stepInfos(['Heat the oven T#0m {#oven}', 'Roast T#40m:oven', 'Baste T#20m:gravy', 'Plate']);
  assert.deepEqual(shown, [
    { title: 'Heat the oven', text: 'Due at the start · named “oven”', problem: '' },
    { title: 'Roast', text: 'Due 40m after “Heat the oven”', problem: '' },
    { title: 'Baste', text: '', problem: 'no step is named “gravy”' },
    { title: 'Plate', text: '', problem: '' },
  ]);
  assert.equal(
    problemText(stepProblems(['A T#5m:b', 'B {#b}', 'C T#x'])),
    'step 1, “A”: its time counts from “b”, which has to be an earlier step (and 1 more)',
  );
});

test("a step's time is written in words, as Pocket shows it", () => {
  const titles = ['Put the roast in {#roast}', 'Baste T#40m:roast', 'Peel T#1h30m', 'Lost T#5m:nobody'];
  assert.equal(stepWords(titles[1], titles), 'Baste 40m after Put the roast in');
  assert.equal(stepWords(titles[2], titles), 'Peel in 1h 30m');
  assert.equal(stepWords(titles[3], titles), titles[3], 'a step that counts from a missing step is left as written');
  assert.equal(stepWords('Plate', titles), 'Plate');
});

/* What a task is in Checklists. Only a task in a Checklists project (7 here) has a role, so a task labelled "template"
   anywhere else is an ordinary task. Vikunja leaves the labels out of a subtask's parent, so Pocket goes by what it has
   seen of the parent: 100 is a template in Vikunja's copies, 101 a template kept from Checklists, and 102 a template in the
   same list. A parent titled "TEMPLATE: ..." counts too. The run, step and added lines need a browser, so their rows
   are in tests/parse.mjs. */
test("a task's role in Checklists comes from its project, its label, its links, its dates and its parent", () => {
  const L = [{ title: 'template' }],
    DUE = '2026-10-20T09:00:00Z',
    copied = { copiedfrom: [{ id: 900 }] },
    under = (id, title = 'Task') => ({ parenttask: [{ id, title }] });
  const t = (project_id, f = {}) => ({
    id: 1,
    title: 'Task',
    done: false,
    project_id,
    labels: [],
    description: '',
    due_date: '0001-01-01T00:00:00Z',
    related_tasks: {},
    ...f,
  });
  const known = {
    checklistIds: new Set([7]),
    copyOf: id => (id === 100 ? { id: 100, labels: L } : undefined),
    kept: { 101: { id: 101 } },
    list: [{ id: 102, done: true, project_id: 7, labels: L, related_tasks: {} }],
  };
  const rows = [
    ['labelled, done', t(7, { labels: L, done: true }), 'template'],
    ['labelled, open with a date (a template that repeats)', t(7, { labels: L, due_date: DUE }), 'template'],
    ["labelled, open with no date (Make template didn't finish)", t(7, { labels: L }), 'template'],
    [
      'labelled, copied, open with a date (a checklist being set up)',
      t(7, { labels: L, due_date: DUE, related_tasks: copied }),
      'template',
    ],
    ['labelled, copied, open with no date', t(7, { labels: L, related_tasks: copied }), 'template'],
    ['labelled, copied, done', t(7, { labels: L, done: true, related_tasks: copied }), 'template'],
    ['copied, open', t(7, { related_tasks: copied }), 'run'],
    ['copied, done (a finished checklist)', t(7, { done: true, related_tasks: copied }), 'run'],
    ['open', t(7), 'candidate'],
    ['done, with a date', t(7, { done: true, due_date: DUE }), 'candidate'],
    ['a subtask copied from a step', t(7, { related_tasks: { ...under(200), ...copied } }), 'step'],
    ['a labelled subtask copied from a step', t(7, { labels: L, related_tasks: { ...under(200), ...copied } }), 'step'],
    [
      'a subtask copied from a step, under a template',
      t(7, { done: true, related_tasks: { ...under(100), ...copied } }),
      'step',
    ],
    ["a subtask of a template in Vikunja's copies", t(7, { done: true, related_tasks: under(100) }), 'tplstep'],
    ['a subtask of a template kept from Checklists', t(7, { done: true, related_tasks: under(101) }), 'tplstep'],
    ['a subtask of a template in the same list', t(7, { done: true, related_tasks: under(102) }), 'tplstep'],
    [
      'a subtask of a parent titled "TEMPLATE: ..."',
      t(7, { done: true, related_tasks: under(103, 'TEMPLATE: Closing') }),
      'tplstep',
    ],
    ['a subtask of an ordinary task', t(7, { related_tasks: under(104) }), null],
    ['a labelled subtask of an ordinary task', t(7, { labels: L, related_tasks: under(104) }), null],
    ['elsewhere: labelled, done', t(5, { labels: L, done: true }), null],
    ['elsewhere: labelled, open with a date', t(5, { labels: L, due_date: DUE }), null],
    ['elsewhere: copied, open', t(5, { related_tasks: copied }), null],
    ['elsewhere: a subtask copied from a step', t(5, { related_tasks: { ...under(200), ...copied } }), null],
    ['elsewhere: a labelled subtask', t(5, { labels: L, related_tasks: under(104) }), null],
    [
      'elsewhere: a subtask of a parent titled "TEMPLATE: ..."',
      t(5, { related_tasks: under(103, 'TEMPLATE: Closing') }),
      null,
    ],
    ['no task', null, null],
  ];
  assert.deepEqual(
    rows.map(([shape, task]) => [shape, roleOf(task, known)]),
    rows.map(([shape, , role]) => [shape, role]),
  );
});

test('a template and a checklist order their steps by their own line, and a task labelled "template" elsewhere follows the List view', async () => {
  const { component } = await import('./fake.mjs'),
    { default: checklists } = await import('../../src/js/app/checklists.js');
  const app = component(checklists),
    L = [{ title: 'template' }];
  app.checklistIds = new Set([7]);
  const own = f =>
    app.hasOwnOrder({ id: 1, done: true, project_id: 7, labels: [], description: '', related_tasks: {}, ...f });
  assert.deepEqual(
    [
      own({ labels: L }),
      own({ related_tasks: { copiedfrom: [{ id: 2 }] } }),
      own({}),
      own({ project_id: 5, labels: L }),
    ],
    [true, true, false, false],
  );
});

// A template that Make template didn't finish, or a copy still being set up as a checklist, has the sheet of a task that
// can become a template, so Make template can finish it.
test("a template that isn't ready to start has the sheet of a candidate", async () => {
  const { component } = await import('./fake.mjs'),
    { default: checklists } = await import('../../src/js/app/checklists.js');
  const app = component(checklists),
    L = [{ title: 'template' }],
    DUE = '2026-10-20T09:00:00Z';
  app.checklistIds = new Set([7]);
  const sheet = f => {
    app.tasks = {
      1: {
        id: 1,
        done: false,
        project_id: 7,
        labels: L,
        description: '',
        due_date: '0001-01-01T00:00:00Z',
        related_tasks: {},
        ...f,
      },
    };
    app.sheet = { id: 1 };
    return [app.role(app.sheetTask), app.checklistRole];
  };
  assert.deepEqual(sheet({ done: true }), ['template', 'template']);
  assert.deepEqual(sheet({ due_date: DUE }), ['template', 'template'], 'a template that comes round');
  assert.deepEqual(sheet({}), ['template', 'candidate'], 'open with no date');
  assert.deepEqual(
    sheet({ due_date: DUE, related_tasks: { copiedfrom: [{ id: 2 }] } }),
    ['template', 'candidate'],
    'a copy being set up',
  );
  assert.deepEqual(sheet({ labels: [] }), ['candidate', 'candidate']);
});

// A start before the due day leaves the template as it is (tickOf), so the note can't promise that every start marks
// it done.
test('the note on a template due once says that only a start on or after its due day marks it done', async () => {
  const { component } = await import('./fake.mjs'),
    { default: checklists } = await import('../../src/js/app/checklists.js');
  const app = component(checklists);
  app.checklistIds = new Set([7]);
  app.tasks = {
    1: {
      id: 1,
      title: 'TEMPLATE: Closing',
      done: false,
      project_id: 7,
      labels: [{ title: 'template' }],
      description: '',
      due_date: '2026-10-20T09:00:00Z',
      repeat_after: 0,
      related_tasks: {},
    },
  };
  app.sheet = { id: 1 };
  assert.match(
    app.comesRoundNote,
    / Starting a checklist on or after its due day marks “Closing” done, because it doesn't repeat\. Choose Repeats/,
  );
});

test("a checklist's title is its template's name, the day, then its number or typed name, and a title with the day last is still read", () => {
  const made = new Date(2026, 9, 8, 7, 30),
    created = made.toISOString(),
    day = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  assert.equal(runTitle('Opening up', '#3', made), `Opening up · ${day(made)} · #3`);
  assert.equal(runTitle('Opening up', 'Saturday', made), `Opening up · ${day(made)} · Saturday`);
  assert.deepEqual(runParts(`Opening up · ${day(made)} · #3`, created), {
    template: 'Opening up',
    day: day(made),
    name: '#3',
    old: false,
  });
  assert.deepEqual(
    runParts(`Bar · late · ${day(made)} · Night · shift`, created),
    { template: 'Bar · late', day: day(made), name: 'Night · shift', old: false },
    'a dot in a name stays in the name',
  );
  assert.deepEqual(
    runParts(`Opening up · run 3 · ${day(made)}`, created),
    { template: 'Opening up', day: day(made), name: 'run 3', old: true },
    'a title from when the day was written last is marked old',
  );
  assert.deepEqual(
    runParts(`Opening up · ${day(new Date(2026, 9, 5))} · Saturday`, created)?.name,
    'Saturday',
    'a checklist started offline and created in Vikunja days later',
  );
  const other = day(new Date(2026, 8, 20));
  assert.equal(
    runParts(`Opening up · ${other} · #3`, created),
    null,
    'a day other than the start day is not taken apart',
  );
  assert.equal(runParts('Opening up', created), null);
  assert.equal(runParts(`Opening up · ${day(made)}`, created), null);
  assert.deepEqual(
    runParts(`Opening up · ${other} · #3`, created, true),
    { template: 'Opening up', day: other, name: '#3', old: false },
    'when changing the name, the title is read by its look, with the number last',
  );
  assert.deepEqual(
    runParts(`Opening up · Nights · ${other}`, created, true),
    { template: 'Opening up', day: other, name: 'Nights', old: true },
    'otherwise the title is read as older titles were written, with the day last',
  );
  assert.equal(runWithoutDay(`Opening up · ${day(made)} · #3`, created), 'Opening up · #3');
  assert.equal(runWithoutDay(`Opening up · run 3 · ${day(made)}`, created), 'Opening up · run 3');
  assert.equal(
    runWithoutDay('Stocktake · back room', created),
    'Stocktake · back room',
    'any other name is left whole',
  );
});

test("a checklist's screen keeps a step's title in the template, taken from the step it was copied from", () => {
  const s = plainStep({
    id: 4,
    title: 'Roast',
    done: false,
    related_tasks: { copiedfrom: [{ id: 2, title: 'Roast T#40m:oven' }] },
  });
  assert.equal(s.tpl, 'Roast T#40m:oven');
  assert.equal(s.from, 2);
  assert.equal(s.added, '');
  assert.equal(s.percent_done, 0);
});

test("a template and its steps change only for the person who made it or a project admin, and read access can't start one", async () => {
  const { component } = await import('./fake.mjs'),
    { default: runs } = await import('../../src/js/app/runs.js');
  const app = component(runs),
    tpl = { id: 1, project_id: 7, created_by: { id: 1 } };
  const show = t => ({ tasks: { [t.id]: t }, sheet: { id: t.id } });
  Object.assign(app, { user: { id: 2 }, perms: { 7: 1 }, ...show(tpl), checklistRole: 'template', parentTask: null });
  const say = () => [app.canEdit, app.templateNote.split('. ').slice(1).join('. ')];
  assert.deepEqual(
    say(),
    [false, 'Only the person who made this template or a project admin can change it.'],
    "write access, someone else's template",
  );
  app.user = { id: 1 };
  assert.deepEqual(say(), [true, 'Tap to edit. Hold to reorder. Swipe left to delete.'], 'its maker');
  Object.assign(app, { user: { id: 2 }, perms: { 7: 2 } });
  assert.equal(app.canEdit, true, 'a project admin');
  Object.assign(app, { perms: {} });
  assert.equal(app.canEdit, true, 'access not loaded yet counts as admin, as it counts as write');
  Object.assign(app, {
    perms: { 7: 1 },
    ...show({ id: 9, project_id: 7, created_by: { id: 2 } }),
    checklistRole: 'tplstep',
    parentTask: tpl,
  });
  assert.equal(app.canEdit, false, "a template's step goes by its template's maker, not its own");
  Object.assign(app, { ...show({ id: 3, project_id: 7, created_by: { id: 1 } }), checklistRole: 'run' });
  assert.equal(app.canEdit, true, 'a checklist started from it stays open to everyone with write');
  Object.assign(app, { perms: { 7: 0 }, ...show(tpl), checklistRole: 'template' });
  assert.deepEqual(
    [app.canEdit, app.templateNote],
    [
      false,
      "Read only. You can see this template, but not start a checklist from it. Ask the project's owner for write access.",
    ],
  );
});

// Checklists for a project with checklist `run` finished today, and `open` its open tasks. `more` answers any other
// path.
const loaded = async (run, open, more = () => null) => {
  const { component } = await import('./fake.mjs'),
    parts = await Promise.all(['tasks', 'checklists', 'runs', 'cards'].map(p => import(`../../src/js/app/${p}.js`)));
  const app = component(...parts.map(p => p.default)),
    json = x => new Response(JSON.stringify(x), { status: 200 });
  Object.assign(app, {
    checklistProjects: [{ id: 7, title: 'Checklists' }],
    checklistIds: new Set([7]),
    perms: {},
    pending: [],
    loadLabels: async () => [],
  });
  globalThis.fetch = async url => {
    const u = new URL(url),
      f = u.searchParams.get('filter');
    return json(
      more(u.pathname, u.searchParams) ??
        (f?.startsWith('done = true')
          ? { items: [run], total_pages: 1 }
          : f === 'done = false'
            ? { items: open, total_pages: 1 }
            : { id: 7, max_permission: 2 }),
    );
  };
  return app;
};
const finishedRun = (subtask, more = {}) => ({
  id: 1,
  project_id: 7,
  title: 'Closing up',
  done: true,
  done_at: new Date().toISOString(),
  description: '',
  related_tasks: { copiedfrom: [{ id: 99 }], subtask },
  ...more,
});

test("a finished checklist's ring counts its steps as Vikunja has them, also a step done on this phone and undone elsewhere", async () => {
  const step = {
      id: 2,
      project_id: 7,
      title: 'Mop',
      done: false,
      description: '',
      related_tasks: { parenttask: [{ id: 1 }] },
    },
    run = finishedRun([step]);
  const app = await loaded(run, [step]);
  app.row({ ...step, done: true }); // this phone last saw it done
  const [cl] = await app.readChecklists(t => app.row(t));
  assert.equal(app.ringOf(cl.finished[0]).done, 0);
});

test('a finished checklist counts all its comments, past the 50 that Vikunja sends with the task', async () => {
  const note = i => ({ id: i, comment: '<p>Note</p>' }),
    run = finishedRun([], { comments: Array.from({ length: 50 }, (_, i) => note(i)) });
  const app = await loaded(run, [], path =>
    path.endsWith('/tasks/1/comments')
      ? { items: Array.from({ length: 55 }, (_, i) => note(i)), total_pages: 1 }
      : null,
  );
  const [cl] = await app.readChecklists(t => t);
  assert.equal(cl.ended[1].comments, 55);
});

// A task list as Vikunja 2.7.1 answers it. With expand=comments it gives the oldest 50 comments of all the tasks it
// lists, not 50 for each. With expand=comment_count it gives each task's whole count.
const capped = (tasks, query) =>
  tasks.map(({ comments, ...t }) => {
    const oldest = new Set(
        tasks
          .flatMap(x => x.comments)
          .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
          .slice(0, 50),
      ),
      some = comments.filter(c => oldest.has(c)),
      asked = query.getAll('expand');
    return {
      ...t,
      ...(asked.includes('comments') && { comments: some.length ? some : null }),
      ...(asked.includes('comment_count') && { comment_count: comments.length }),
    };
  });

test("a finished checklist counts its steps' skips and comments when they have more than 50 comments between them", async () => {
  const start = Date.now() - 60e3,
    at = s => new Date(start + s * 1000).toISOString(),
    note = (id, s, comment = '<p>Note</p>') => ({ id, comment, author: { id: 1 }, created: at(s) }),
    step = (id, comments, more = {}) => ({
      id,
      project_id: 7,
      title: 'Step ' + id,
      done: true,
      done_at: at(0),
      description: '',
      related_tasks: { parenttask: [{ id: 1 }] },
      comments,
      ...more,
    });
  const done = [
    finishedRun([], { comments: [] }),
    step(
      2,
      Array.from({ length: 55 }, (_, i) => note(100 + i, 1)),
    ),
    step(3, [note(200, 2, '<p>Skipped: no milk</p>')], { reactions: { [SKIP_MARK]: [{ id: 1 }] } }),
    step(
      4,
      [1, 2, 3].map(i => note(300 + i, 3)),
    ),
  ];
  const app = await loaded(null, [], (path, query) => {
    if (query.get('filter')?.startsWith('done = true')) return { items: capped(done, query), total_pages: 1 };
    const id = +path.match(/\/tasks\/(\d+)\/comments$/)?.[1];
    return id ? { items: done.find(t => t.id === id).comments, total_pages: 1 } : null;
  });
  const [cl] = await app.readChecklists(t => t);
  assert.deepEqual(cl.ended[1], { skipped: 1, comments: 59 });
});

test("a template's step being edited isn't saved when the user's access arrives and doesn't let them change the template", async () => {
  const { component } = await import('./fake.mjs'),
    { default: runs } = await import('../../src/js/app/runs.js'),
    { default: checklists } = await import('../../src/js/app/checklists.js');
  const app = component(runs, checklists),
    step = { id: 2, title: 'Mop', done: true, project_id: 7 },
    saves = [];
  const tpl = {
    id: 1,
    title: 'TEMPLATE: Closing up',
    done: true,
    project_id: 7,
    created_by: { id: 1 },
    labels: [{ title: 'template' }],
    related_tasks: { subtask: [step] },
  };
  Object.assign(app, {
    user: { id: 2 },
    perms: {},
    subtasks: [step],
    checklistIds: new Set([7]),
    tasks: { 1: tpl },
    sheet: { id: 1, kind: 'task', stepEdit: null },
    actAll: async list => {
      saves.push(...list.map(f => f.task));
    },
  });
  app.sheet.stepEdit = { id: 2, text: 'Mop the floor', ignore: {} };
  app.perms[7] = 1; // write, and someone else made the template
  await app.saveStepEdit(0);
  assert.deepEqual([saves, app.sheet.stepEdit, step.title], [[], null, 'Mop']);
  assert.equal(app.toast.msg, 'Not changed. Only the person who made this template or a project admin can change it.');
});

/* The padlock in a step's time chip (sheet/step-time.html) sets the row's `strict`, and the step is saved with !T# or
   T#. The editor shows the time in words, which have no !, so a strict step opens with `strict` set. */
test("the padlock in a step's time chip writes !T# in the step's title, and a second tap takes the ! out", async () => {
  const { component } = await import('./fake.mjs'),
    { default: checklists } = await import('../../src/js/app/checklists.js');
  const app = component(checklists),
    steps = [
      { id: 1, title: 'Mix the dough' },
      { id: 2, title: 'Shape the loaves !T#20m' },
    ];
  Object.assign(app, {
    subtasks: steps,
    sheet: { kind: 'task', stepEdit: null },
    stepParsed: title => ({ title, assignees: [], labels: [], priority: 0 }),
    keepFocus() {},
  });
  const was = document.getElementById;
  document.getElementById = () => null;
  try {
    app.editStep(steps[1]);
    const e = app.sheet.stepEdit,
      saved = () => [app.stepEditDraft(1).strict, app.stepEditDraft(1).saved];
    assert.deepEqual([e.text, e.strict], ['Shape the loaves in 20m', true]);
    assert.deepEqual(saved(), [true, 'Shape the loaves !T#20m']);
    e.strict = false; // the padlock is tapped
    assert.deepEqual(saved(), [false, 'Shape the loaves T#20m']);
    e.strict = true;
    assert.deepEqual(saved(), [true, 'Shape the loaves !T#20m']);
    // A step typed in the box under the template, with the padlock on, is added as !T#.
    app.sheet.addBox = { key: '+', text: 'Bake in 40 min', keep: false, from: null, strict: true };
    app.sheet.addRows = [];
    assert.deepEqual(app.draft('add').info.get('+').saved, 'Bake !T#40m');
    await new Promise(ok => setTimeout(ok, 60)); // editStep's focus timer
  } finally {
    document.getElementById = was;
  }
});
