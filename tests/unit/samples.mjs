/* A sample of each op in OPS, for the tests that run every op: lifecycle.test.mjs and store.model.test.mjs. Each
   sample's tasks are Vikunja's before the op. A test passes its own copy of the ops (src/js/ops/index.js) to `fields`
   where a sample builds its fields with them, since each tab in lifecycle.test.mjs has its own. */
export const ME = { id: 1, username: 'me', name: '' },
  BOB = { id: 7, username: 'bob', name: '' },
  FLOOR = { id: 600, title: 'floor' },
  TEMPLATE = { id: 601, title: 'template' },
  ZERO = '0001-01-01T00:00:00Z',
  D9 = '2026-10-09T09:00:00.000Z';
export const task = (id, title, more = {}) => ({
  id,
  title,
  description: '',
  project_id: 5,
  done: false,
  done_at: ZERO,
  percent_done: 0,
  due_date: ZERO,
  repeat_after: 0,
  repeat_mode: 0,
  position: 100,
  assignees: [],
  labels: [],
  reminders: null,
  reactions: {},
  comments: [],
  ...more,
});
// A checklist, 1, with two steps, 2 and 3. `more` changes a task, by id.
export const checklist = (more = {}) =>
  [
    task(1, 'Closing', { related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }),
    task(2, 'Mop the floor'),
    task(3, 'Lock up'),
  ].map(t => ({ ...t, ...(t.id > 1 && { related_tasks: { parenttask: [{ id: 1 }] } }), ...more[t.id] }));
// The subtask box a line is typed in: the checklist's.
const CLOSING = { id: 1, project_id: 5, title: 'Closing' };
export const line = (title, p) => ({
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
  under: null,
});

/* What each op is tried with: the tasks Vikunja has before (`tasks`), the fields it is queued with (`fields`), and what
   Vikunja has once it is made (`made`). `labels` are the labels Vikunja has besides those on the tasks. The fake Vikunja answers each request as Vikunja does. `fields` may list
   several ops queued together, and the last is the one tried. `queue(app, fields)` queues it where the app has its own
   way. `cannot` names the states that can't arise for the op: an op whose requests are all in one stage is never
   partly done. `unseen` names the fields Vikunja changes that the task's row doesn't show. `parented` says the op needs a task
   with a parent, which a test names in `up`. A sample named other than
   its op says which op it tries (`op`). Keep each sample small. The unit tests read only the HTML Pocket writes in notes (dom.mjs). */
export const SAMPLES = {
  done: {
    tasks: checklist(),
    fields: { op: 'done', task: 2, run: 1 },
    made: v => v.task(2).done && v.task(1).percent_done === 0.5,
  },
  undone: {
    tasks: checklist({ 1: { percent_done: 0.5 }, 2: { done: true, reactions: { '✅': [ME] } } }),
    fields: { op: 'undone', task: 2, run: 1 },
    made: v => !v.task(2).done && !v.task(2).reactions['✅'].length && v.task(1).percent_done === 0,
  },
  skip: {
    tasks: checklist(),
    fields: { op: 'skip', task: 2, run: 1, html: '' },
    made: v => v.task(2).done && v.task(2).reactions['⏭️'].length === 1 && v.task(2).comments.length === 1,
  },
  doneNote: {
    tasks: checklist(),
    fields: { op: 'doneNote', task: 2, run: 1, html: '' },
    made: v => v.task(2).done && v.task(2).comments.length === 1,
  },
  note: {
    tasks: checklist(),
    fields: { op: 'note', task: 2, run: null, html: '' },
    made: v => v.task(2).comments.length === 1,
    cannot: ['partly done'],
  },
  answer: {
    tasks: checklist(),
    fields: { op: 'answer', task: 2, run: 1, html: '' },
    made: v => v.task(2).comments.length === 1,
    cannot: ['partly done'],
  },
  finish: {
    tasks: checklist(),
    fields: { op: 'finish', task: 1, run: 1 },
    made: v => v.task(1).done && v.task(1).reactions['✅'].length === 1,
  },
  reopen: {
    tasks: checklist({ 1: { done: true, reactions: { '✅': [ME] } } }),
    fields: { op: 'reopen', task: 1, run: 1 },
    made: v => !v.task(1).done,
  },
  progress: {
    tasks: checklist(),
    fields: { op: 'progress', task: 2, run: 1, pct: 40, was: 0 },
    made: v => v.task(2).percent_done === 0.4 && v.task(1).percent_done === 0.2,
  },
  claim: {
    tasks: checklist(),
    fields: { op: 'claim', task: 2, run: null },
    made: v => v.task(2).assignees.length === 1,
    cannot: ['partly done'],
  },
  unclaim: {
    tasks: checklist({ 2: { assignees: [ME] } }),
    fields: { op: 'unclaim', task: 2, run: null },
    made: v => !v.task(2).assignees.length,
    cannot: ['partly done'],
  },
  // A delete is held while Restore shows, then sent as the batch clears.
  delete: {
    tasks: checklist({ 1: { percent_done: 0.5 }, 2: { done: true } }),
    fields: { op: 'delete', task: 3, ids: [3], up: 1, run: null },
    async queue(app, f) {
      f.id = (await app.holdDelete(app.tasks[f.task], null, f.ids)).id;
      return app.sendHeld(f.id);
    },
    made: v => !v.task(3) && v.task(1).percent_done === 1,
  },
  /* A checklist deleted with its steps, sent at once with no Restore, as from its sheet (deleteRun). Its entry takes
     the sample's id, which deleteNow would otherwise make. Two deletes may wait for the outbox at once, so each
     wrapper of deleteOf names only its own tree. */
  'delete, with no Restore': {
    op: 'delete',
    tasks: checklist(),
    fields: { op: 'delete', task: 1, ids: [2, 3, 1], run: null },
    queue(app, f) {
      const of = app.deleteOf;
      app.deleteOf = tree => ({ ...of.call(app, tree), ...(tree === f.ids && { id: f.id }) });
      return app.deleteNow([f.ids]);
    },
    made: v => ![1, 2, 3].some(id => v.task(id)),
    cannot: ['partly done'],
  },
  // A list's order is kept by view in `positions`, not on the task's row (`unseen`).
  position: {
    tasks: checklist(),
    fields: { op: 'position', task: 2, view: 5, pos: 300, run: null },
    made: v => v.task(2).position === 300,
    cannot: ['partly done'],
    unseen: ['position'],
  },
  // A line typed in the checklist's subtask box, done.
  add: {
    tasks: checklist(),
    fields: ({ addLines }, parent = CLOSING) => addLines([line('Buy rope', { done: true })], { parent })[0],
    made: v => v.task(101).done && v.task(1).related_tasks.subtask.length === 3 && v.task(1).percent_done === 0.33,
  },
  // Two lines in the checklist's subtask box, the second under the first. The second waits for the first's task.
  'add, a line under a line': {
    op: 'add',
    tasks: checklist(),
    fields: ({ addLines }, parent = CLOSING) =>
      addLines([line('Buy rope'), { ...line('Cut it', { done: true }), under: 0 }], { parent }),
    made: v =>
      v.task(102).done &&
      v.task(101).related_tasks.subtask[0].id === 102 &&
      v.task(101).percent_done === 1 &&
      v.task(1).related_tasks.subtask.length === 3,
  },
  // A template's date taken off: its repeat off, its date off and done, and its repeat back.
  due: {
    tasks: [task(7, 'TEMPLATE: Closing', { due_date: D9, repeat_after: 86400 })],
    fields: { op: 'due', task: 7, tpl: true, was: D9, due: ZERO, done: true, run: null },
    made: v => v.task(7).done && v.task(7).due_date === ZERO && v.task(7).repeat_after === 86400,
  },
  repeat: {
    tasks: [task(7, 'Water the plants', { due_date: D9 })],
    fields: {
      op: 'repeat',
      task: 7,
      set: { repeat_after: 604800, repeat_mode: 0 },
      was: { repeat_after: 0, repeat_mode: 0 },
      run: null,
    },
    made: v => v.task(7).repeat_after === 604800,
    cannot: ['partly done'],
  },
  edit: {
    tasks: [task(7, 'Wipe the till')],
    fields: {
      op: 'edit',
      task: 7,
      set: { title: 'Wipe the till and the counter' },
      was: { title: 'Wipe the till' },
      run: null,
    },
    made: v => v.task(7).title === 'Wipe the till and the counter',
    cannot: ['partly done'],
  },
  // Notes are written over the notes Vikunja has, only while they are the ones the user began from (`base`).
  'edit, notes': {
    op: 'edit',
    tasks: [task(7, 'Wipe the till', { description: '<p>Use the blue cloth</p>' })],
    fields: {
      op: 'edit',
      task: 7,
      rebase: 'notes',
      text: 'Use the green cloth',
      base: 'Use the blue cloth',
      run: null,
    },
    made: v => v.task(7).description === '<p>Use the green cloth</p>',
    cannot: ['partly done'],
  },
  // A reminder an hour before the due time takes the place of the one at the due time.
  'edit, reminders': {
    op: 'edit',
    tasks: [task(7, 'Wipe the till', { due_date: D9, reminders: [{ relative_to: 'due_date', relative_period: 0 }] })],
    fields: {
      op: 'edit',
      task: 7,
      rebase: 'reminders',
      add: [{ relative_to: 'due_date', relative_period: -3600 }],
      drop: [{ relative_to: 'due_date', relative_period: 0 }],
      run: null,
    },
    made: v => v.task(7).reminders.length === 1 && v.task(7).reminders[0].relative_period === -3600,
    cannot: ['partly done'],
  },
  // The checklist moves to project 6 with both its steps. Each test passes the task it moves (`t`), whose steps are the
  // checklist's only when it is the checklist.
  project: {
    tasks: checklist(),
    fields: (ops, t = { id: 1 }) => {
      const subs = t.id === 1 ? [2, 3] : [];
      return {
        op: 'project',
        task: t.id,
        pid: 6,
        subs: Object.fromEntries(subs.map(id => [id, 6])),
        was: Object.fromEntries([t.id, ...subs].map(id => [id, 5])),
        into: 'Errands',
        from: 'Home',
        run: null,
      };
    },
    made: v => [1, 2, 3].every(id => v.task(id).project_id === 6),
  },
  // Step 3 leaves the checklist, so its progress goes from half done to done. A test names the parent (`up`).
  unlink: {
    tasks: checklist({ 1: { percent_done: 0.5 }, 2: { done: true } }),
    fields: { op: 'unlink', task: 3, up: 1, over: 'Closing', was: [1], run: null },
    made: v => !v.task(1).related_tasks.subtask.some(s => s.id === 3) && v.task(1).percent_done === 1,
    parented: true,
  },
  // Step 3, not in the checklist, joins it, so its progress goes from done to half done.
  link: {
    tasks: checklist({
      1: { percent_done: 1, related_tasks: { subtask: [{ id: 2 }] } },
      2: { done: true },
      3: { related_tasks: { parenttask: [] } },
    }),
    fields: { op: 'link', task: 3, up: 1, over: 'Closing', was: [], run: null },
    made: v => v.task(1).related_tasks.subtask.some(s => s.id === 3) && v.task(1).percent_done === 0.5,
    parented: true,
  },
  // Bob is assigned to step 2.
  assign: {
    tasks: checklist(),
    fields: { op: 'assign', task: 2, person: BOB, add: true, was: [], run: null },
    made: v => v.task(2).assignees.some(u => u.id === BOB.id),
    cannot: ['partly done'],
  },
  'assign, taken off': {
    op: 'assign',
    tasks: checklist({ 2: { assignees: [ME, BOB] } }),
    fields: { op: 'assign', task: 2, person: BOB, add: false, was: [ME, BOB], run: null },
    made: v =>
      v
        .task(2)
        .assignees.map(u => u.id)
        .join() === String(ME.id),
    cannot: ['partly done'],
  },
  // A label Vikunja doesn't have yet is made, then put on step 2.
  label: {
    tasks: checklist(),
    fields: { op: 'label', task: 2, tag: { id: null, title: 'Urgent' }, add: true, was: [], run: null },
    made: v => v.task(2).labels.some(l => l.title === 'Urgent'),
  },
  'label, taken off': {
    op: 'label',
    labels: [FLOOR],
    tasks: checklist({ 2: { labels: [FLOOR] } }),
    fields: { op: 'label', task: 2, tag: FLOOR, add: false, was: [FLOOR], run: null },
    made: v => !v.task(2).labels.length,
    cannot: ['partly done'],
  },
  // A template step's ask, a temperature in °C, becomes one in °F. The rest of its notes stays.
  'edit, asks': {
    op: 'edit',
    tasks: [task(7, 'Check the fridge', { description: '<p>Use the probe</p><p>pocket:ask number °C</p>' })],
    fields: { op: 'edit', task: 7, rebase: 'asks', lines: ['pocket:ask number °F'], run: null },
    made: v => v.task(7).description === '<p>Use the probe</p><p>pocket:ask number °F</p>',
    cannot: ['partly done'],
  },
  // Notes typed after " // " when a template step is edited go at the end of its notes, after its ask.
  'edit, notes added': {
    op: 'edit',
    tasks: [task(7, 'Check the fridge', { description: '<p>Use the probe</p><p>pocket:ask number °C</p>' })],
    fields: { op: 'edit', task: 7, rebase: 'addNotes', text: 'Wipe it after', run: null },
    made: v => v.task(7).description === '<p>Use the probe</p><p>pocket:ask number °C</p><p>Wipe it after</p>',
    cannot: ['partly done'],
  },
  // A template's "Enforce step times" is turned on, beside its order line.
  'edit, settings': {
    op: 'edit',
    tasks: [task(7, 'Closing', { description: '<p>Lock the back door too.</p><p>pocket:order 8 9</p>' })],
    fields: { op: 'edit', task: 7, rebase: 'rules', rules: { wait: true }, run: null },
    made: v => v.task(7).description === '<p>Lock the back door too.</p><p>pocket:order 8 9</p><p>pocket:wait</p>',
    cannot: ['partly done'],
  },
  // The checklist's second step moves up, in its order line.
  'edit, order': {
    op: 'edit',
    tasks: checklist({ 1: { description: '<p>pocket:order 2 3</p>' } }),
    fields: {
      op: 'edit',
      task: 1,
      rebase: 'order',
      moves: [{ step: 3, dir: -1, after: null, to: 0, dragged: false, from: 2, at: 1 }],
      run: null,
    },
    made: v => v.task(1).description === '<p>pocket:order 3 2</p>',
    cannot: ['partly done'],
  },
  /* A checklist started from template 7, with its two steps, at the time the template was due, so the template moves
     on to the next day. The checklist gets a copy of the template's settings. In the randomized test, task `t` is the
     template, with steps 2 and 3 when it is the checklist. */
  startRun: {
    labels: [TEMPLATE],
    tasks: [
      task(7, 'Closing', {
        labels: [TEMPLATE],
        due_date: D9,
        repeat_after: 86400,
        description: '<p>Lock the back door too.</p><p>pocket:in-order</p><p>pocket:order 8 9</p>',
        related_tasks: { subtask: [{ id: 8 }, { id: 9 }] },
      }),
      task(8, 'Mop the floor', { related_tasks: { parenttask: [{ id: 7 }] } }),
      task(9, 'Lock up 30m after Mop the floor', { related_tasks: { parenttask: [{ id: 7 }] } }),
    ],
    fields: (ops, t = { id: 7 }) => {
      const steps = { 7: [8, 9], 1: [2, 3] }[t.id] || [];
      return {
        op: 'startRun',
        task: t.id,
        run: null,
        template: { id: t.id, title: 'Closing', project_id: 5 },
        name: '',
        for: [ME],
        steps: steps.map((from, i) => ({
          from,
          title: i ? 'Lock up' : 'Mop the floor',
          due: null,
          timed: !!i,
          remind: !!i,
          tpl: i ? 'Lock up 30m after Mop the floor' : 'Mop the floor',
        })),
        tick: D9,
      };
    },
    made: v => {
      const run = v.task(101);
      return (
        run.title.endsWith(' · #1') &&
        !run.labels.length &&
        run.assignees.some(u => u.id === ME.id) &&
        run.description ===
          '<p>Lock the back door too.</p><p>pocket:run</p><p>pocket:in-order</p><p>pocket:order 102 103</p>' &&
        v.task(103).title === 'Lock up' &&
        v.task(103).reminders.length === 1 &&
        v.task(7).due_date !== D9
      );
    },
    unseen: ['related_tasks'],
  },
  /* Task 7 becomes a template: it gets the "template" label Vikunja has, its two open steps are marked done, and the
     "copied from" link it got when it was duplicated from task 6 is deleted. In the randomized test, task `t` becomes
     the template, with steps 2 and 3 when it is the checklist. */
  makeTemplate: {
    labels: [TEMPLATE],
    tasks: [
      task(6, 'Closing (old)', { related_tasks: { copiedto: [{ id: 7 }] } }),
      task(7, 'Closing', { related_tasks: { subtask: [{ id: 8 }, { id: 9 }], copiedfrom: [{ id: 6 }] } }),
      task(8, 'Mop the floor', { related_tasks: { parenttask: [{ id: 7 }] } }),
      task(9, 'Lock up', { related_tasks: { parenttask: [{ id: 7 }] } }),
    ],
    fields: (ops, t = { id: 7 }) => ({
      op: 'makeTemplate',
      task: t.id,
      steps: { 7: [8, 9], 1: [2, 3] }[t.id] || [],
      label: t.title || 'Closing',
      run: null,
    }),
    made: v =>
      v.task(7).title === 'TEMPLATE: Closing' &&
      v.task(7).done &&
      v.task(7).labels.some(l => l.id === TEMPLATE.id) &&
      !v.task(7).related_tasks.copiedfrom.length &&
      v.task(8).done &&
      v.task(9).done,
    unseen: ['related_tasks'],
  },
  // Task 7 has the "template" label already, as a teammate's Make template that stopped partway leaves it. Cancel
  // leaves the label on.
  'makeTemplate, labelled already': {
    op: 'makeTemplate',
    labels: [TEMPLATE],
    tasks: [
      task(7, 'Closing', { labels: [TEMPLATE], related_tasks: { subtask: [{ id: 8 }] } }),
      task(8, 'Mop the floor', { related_tasks: { parenttask: [{ id: 7 }] } }),
    ],
    fields: (ops, t = { id: 7 }) => ({
      op: 'makeTemplate',
      task: t.id,
      steps: { 7: [8], 1: [2, 3] }[t.id] || [],
      label: t.title || 'Closing',
      run: null,
    }),
    made: v =>
      v.task(7).title === 'TEMPLATE: Closing' && v.task(7).done && v.task(7).labels.length === 1 && v.task(8).done,
  },
  // A step added to template 7 after its first step, as the box under that step sends it. It is made done.
  templateStep: {
    labels: [TEMPLATE],
    tasks: [
      task(7, 'TEMPLATE: Closing', {
        done: true,
        labels: [TEMPLATE],
        description: '<p>pocket:order 8 9</p>',
        related_tasks: { subtask: [{ id: 8 }, { id: 9 }] },
      }),
      task(8, 'Mop the floor', { done: true, related_tasks: { parenttask: [{ id: 7 }] } }),
      task(9, 'Lock up', { done: true, related_tasks: { parenttask: [{ id: 7 }] } }),
    ],
    fields: (ops, t = { id: 7, project_id: 5, title: 'Closing' }) => ({
      op: 'templateStep',
      task: t.id,
      under: t.id,
      pid: t.project_id,
      p: line('Wipe the till').p,
      after: { 7: 8, 1: 2 }[t.id] ?? null,
      label: t.title,
      run: null,
    }),
    made: v =>
      v.task(101).done &&
      v.task(7).description === '<p>pocket:order 8 101 9</p>' &&
      v.task(7).related_tasks.subtask.some(s => s.id === 101),
  },
  // A step inserted in the checklist after its last step, as its add box sends it.
  addStep: {
    tasks: checklist({ 1: { description: '<p>pocket:order 2 3</p>' } }),
    fields: (ops, t = { id: 1, project_id: 5, title: 'Closing' }) => ({
      op: 'addStep',
      task: t.id,
      run: t.id,
      title: 'Sweep up',
      p: line('Sweep up').p,
      from: null,
      tpl: null,
      before: null,
      after: 3,
      under: t.id,
      pid: t.project_id,
      runTitle: t.title,
    }),
    made: v =>
      v.task(101).description === '<p>pocket:added</p>' &&
      v.task(1).description === '<p>pocket:order 2 3 101</p>' &&
      v.task(1).related_tasks.subtask.some(s => s.id === 101),
  },
  // A step inserted with notes typed after " // " keeps them in front of its mark.
  'addStep, with notes': {
    op: 'addStep',
    tasks: checklist({ 1: { description: '<p>pocket:order 2 3</p>' } }),
    fields: (ops, t = { id: 1, project_id: 5, title: 'Closing' }) => ({
      op: 'addStep',
      task: t.id,
      run: t.id,
      title: 'Sweep up',
      p: line('Sweep up', { notes: 'behind the bins' }).p,
      from: null,
      tpl: null,
      before: null,
      after: 3,
      under: t.id,
      pid: t.project_id,
      runTitle: t.title,
    }),
    made: v => v.task(101).description === '<p>behind the bins</p><p>pocket:added</p>',
  },
  // Step 2 repeated in the checklist, as Repeat sends it: a copy of it goes right after it.
  'addStep, repeated': {
    op: 'addStep',
    tasks: checklist({
      1: { description: '<p>pocket:order 2 3</p>' },
      2: { description: '<p>pocket:step Mop the floor</p>' },
    }),
    fields: (ops, t = { id: 1, project_id: 5, title: 'Closing' }) => ({
      op: 'addStep',
      task: t.id,
      run: t.id,
      title: 'Mop the floor',
      from: 2,
      tpl: 'Mop the floor',
      before: 3,
      after: 2,
      under: t.id,
      pid: t.project_id,
      runTitle: t.title,
    }),
    made: v =>
      v.task(101).description === '<p>pocket:step Mop the floor</p><p>pocket:added</p>' &&
      v.task(1).description === '<p>pocket:order 2 101 3</p>',
    unseen: ['related_tasks'],
  },
};
