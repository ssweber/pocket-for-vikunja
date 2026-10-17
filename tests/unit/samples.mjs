/* A sample of each op in OPS, for the tests that run every op: lifecycle.test.mjs and store.model.test.mjs. Each
   sample's tasks are Vikunja's before the op. A test passes its own copy of the ops (src/js/ops/index.js) to `fields`
   where a sample builds its fields with them, since each tab in lifecycle.test.mjs has its own. */
export const ME = { id: 1, username: 'me', name: '' },
  ZERO = '0001-01-01T00:00:00Z',
  D9 = '2026-10-09T09:00:00.000Z';
export const task = (id, title, more = {}) => ({
  id,
  title,
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
   Vikunja has once it is made (`made`). The fake Vikunja answers each request as Vikunja does. `fields` may list
   several ops queued together, and the last is the one tried. `queue(app, fields)` queues it where the app has its own
   way. `cannot` names the states that can't arise for the op: an op whose requests are all in one stage is never
   partly done. `unseen` names the fields Vikunja changes that the task's row doesn't show. A sample named other than
   its op says which op it tries (`op`). Keep each sample small. Unit tests have no DOM, so a comment holds no HTML. */
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
    fields: { op: 'progress', task: 2, run: 1, pct: 40 },
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
};
