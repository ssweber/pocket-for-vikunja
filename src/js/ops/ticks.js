// Ticking a task or a checklist's step, skipping a step, finishing or reopening a checklist, and setting progress. A
// change to a subtask or a step changes its parent's progress, so `figure` writes that last, in the same entry: the
// progress of the parent `up`, or of the step's checklist.
import { ApiError } from '../api.js';
import { isSet, plainReminders, repeats } from '../dates.js';
import { pctOf } from '../progress.js';
import { CANCEL } from '../sync.js';
import { ZERO } from '../util.js';
import { DONE_MARK, SKIP_MARK } from '../checklists.js';
import { FINISHED_MEANWHILE, OP_WORDS } from '../messages.js';
import { MOVED } from '../app/tasks.js';
import { backOf, changed, comment, figure, mark, patch, tick, unmark, untick } from './stages.js';
import { marked, said } from './shown.js';

// The progress the user set with a tick or an untick (`pct`), as the task's field.
const withPct = a => (a.pct !== undefined ? { percent_done: a.pct / 100 } : {});
/* doneBy: the task done at the op's time, with the user's ✅ or ⏭️, and with `note` the op's comment. Vikunja's answer
   brings its own time. A repeating task gets no ✅, because Vikunja moves it on to its next date instead (mark).
   notDone: the task not done, without the user's ✅ or ⏭️, and with the dates an Undo puts back (`back`). */
const doneBy = (mark, note) => (t, a) => {
  const d = { ...t, done: true, done_at: a.at, ...withPct(a) },
    m = repeats(t) ? d : marked(d, a, mark);
  return note ? said(m, a) : m;
};
/* Pocket's copy may not know that a task repeats, and Vikunja moves a repeating task on to its next dates instead of
   marking it done. So only Vikunja's reply says what a tick leaves in these fields. */
const ticked = () => MOVED;
const notDone = (t, a) => marked({ ...t, done: false, done_at: ZERO, ...withPct(a), ...a.back }, a, null);

/* An untick that waited offline may arrive after someone finished the checklist. The checklist stays finished, and the
   step stays done. An Undo of a repeating task's tick sends the dates the task had (`back`) instead of an untick, each
   only while Vikunja still has the date the tick moved it to (`check`). */
const untickOpen = async (a, c) => {
  if (a.run && a.task !== a.run && (await c.read('/tasks/' + a.run)).done)
    throw Object.assign(new ApiError(409, FINISHED_MEANWHILE), { drop: true });
  if (!a.back) return patch(a, c, { done: false, ...withPct(a) });
  const { body, left } = await backOf(a, c, a.back, a.check);
  if (Object.keys(body).length) await patch(a, c, body);
  if (left) throw changed('it has');
};
// An Undo of a progress sets the progress before only while Vikunja has the progress it undoes (`check`).
const setPct = async (a, c) => {
  const to = { percent_done: a.pct / 100 };
  if (a.check === undefined) return patch(a, c, to);
  const { body, left } = await backOf(a, c, to, { percent_done: a.check / 100 });
  if (Object.keys(body).length) await patch(a, c, body);
  if (left) throw changed('its progress has');
};

// A change to a task deleted in Vikunja since leaves the outbox when Vikunja refuses it, since trying again can't help.
const gone = (a, e) => (e?.status === 404 ? 'dropped' : 'kept');
// The task an op changes, and the parent whose progress it writes, for its Undo.
const where = a => ({ task: a.task, run: a.run ?? null, up: a.up });
/* A tick and an untick of one task cancel out while neither is sent, and both leave the outbox. One that also sets
   progress or puts dates back stays. */
const plain = a => a.pct === undefined && !a.back;
const cancels = other => (older, newer) => (older.op === other && plain(older) && plain(newer) ? CANCEL : null);

/* The fields a repeating task's tick moves on to its next date, as task `t` has them, for the tick's Undo (`was`): its
   due date, its start and end dates when set, and its reminders when one has its own date. */
export const movedFrom = t => ({
  due_date: t.due_date,
  ...(isSet(t.start_date) && { start_date: t.start_date }),
  ...(isSet(t.end_date) && { end_date: t.end_date }),
  ...((t.reminders || []).some(r => !r.relative_to) && { reminders: plainReminders(t) }),
});

/* Undo unticks the task. Vikunja moves a repeating task on to its next date instead of marking it done, so the Undo
   of its tick puts back what the tick moved (`was`, movedFrom), each field only while Vikunja has the value it stored
   for the tick. */
export const done = {
  apply: doneBy(DONE_MARK),
  stages: [tick, mark(DONE_MARK), figure],
  invert: a => {
    const t = a.got?.task;
    if (!a.was || t?.done) return { op: 'undone', ...where(a) };
    return {
      op: 'undone',
      ...where(a),
      back: a.was,
      check: t ? Object.fromEntries(Object.keys(a.was).map(k => [k, t[k]])) : null,
    };
  },
  merge: cancels('undone'),
  refusal: gone,
  ...OP_WORDS.done,
  asks: ['up', 'pct'],
  saw: ['label', 'was'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: ticked,
};
// Cancel gives a done note's text, or a skip's reason, back to the step's box.
export const doneNote = {
  apply: doneBy(DONE_MARK, true),
  stages: [tick, mark(DONE_MARK), comment, figure],
  cancel: 'text',
  ...OP_WORDS.doneNote,
  asks: ['html'],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: ticked,
};
export const skip = {
  apply: doneBy(SKIP_MARK, true),
  stages: [tick, mark(SKIP_MARK), comment, figure],
  cancel: 'text',
  ...OP_WORDS.skip,
  asks: ['html'],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: ticked,
};
/* Undo ticks the task again, and an untick made at a progress (`pct`) puts back the progress before (`was`). An Undo
   of a repeating task's tick has no Undo. */
export const undone = {
  apply: notDone,
  stages: [untickOpen, unmark, figure],
  invert: a => (a.back ? null : { op: 'done', ...where(a), ...(a.was !== undefined && { pct: a.was }) }),
  merge: cancels('done'),
  refusal: gone,
  ...OP_WORDS.undone,
  asks: ['up', 'pct', 'back', 'check'],
  saw: ['label', 'was'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};
// finishRun and reopenRun redraw the checklist's screen themselves. Each is the other's Undo.
export const finish = {
  apply: doneBy(DONE_MARK),
  stages: [tick, mark(DONE_MARK)],
  answered: () => {},
  invert: a => ({ op: 'reopen', task: a.task, run: a.run ?? null }),
  merge: cancels('reopen'),
  refusal: gone,
  ...OP_WORDS.finish,
  asks: [],
  saw: ['label'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  sheetPlace: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: ticked,
};
export const reopen = {
  apply: notDone,
  stages: [untick, unmark],
  answered: () => {},
  invert: a => ({ op: 'finish', task: a.task, run: a.run ?? null }),
  merge: cancels('finish'),
  refusal: gone,
  ...OP_WORDS.reopen,
  asks: [],
  saw: ['label'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  sheetPlace: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};
/* The progress before (`was`) is for its Undo. A progress replaces an earlier one on its task that hasn't been sent,
   and keeps its `was`, so Undo goes back to where the first one started. */
export const progress = {
  apply: (t, a) => ({ ...t, percent_done: a.pct / 100 }),
  stages: [setPct, figure],
  invert: a => {
    if (a.was === undefined) return null;
    const got = a.got?.task ? pctOf(a.got.task) : a.pct;
    return { op: 'progress', ...where(a), pct: a.was, was: got, check: got };
  },
  merge: (older, newer) => (older.op === 'progress' ? { ...newer, was: older.was } : null),
  refusal: gone,
  ...OP_WORDS.progress,
  asks: ['pct', 'up', 'check'],
  saw: ['label', 'was'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};

// The last tick, skip or untick among a step's waiting ops. The step looks waiting while one is in the outbox.
const TICKS = ['done', 'undone', 'skip', 'doneNote'];
export const lastTick = ops => ops.filter(a => TICKS.includes(a.op)).at(-1);
