// Ticking a task or a checklist's step, skipping a step, finishing or reopening a checklist, and setting progress. A
// change to a step changes its checklist's progress, so `figure` writes that last, in the same entry.
import {ApiError} from '../api.js';
import {ZERO} from '../util.js';
import {DONE_MARK, SKIP_MARK} from '../checklists.js';
import {FINISHED_MEANWHILE, OP_WORDS} from '../messages.js';
import {comment, figure, mark, patch, tick, unmark, untick} from './stages.js';
import {marked, said} from './shown.js';

// doneBy: the task done at the op's time, with the user's ✅ or ⏭️, and with `note` the op's comment. Vikunja's answer
// brings its own time.
const closed = t => ({...t, done: true}), open = t => ({...t, done: false}), doneBy = (mark, note) => (t, a) => {
  const d = marked({...t, done: true, done_at: a.at}, a, mark);
  return note ? said(d, a) : d;
};

// An untick that waited offline may arrive after someone finished the checklist. The checklist stays finished, and the
// step stays done.
const untickOpen = async (a, c) => {
  if (a.run && a.task !== a.run && (await c.read('/tasks/' + a.run)).done) throw Object.assign(new ApiError(409, FINISHED_MEANWHILE), {drop: true});
  return untick(a, c);
};

export const done = {apply: doneBy(DONE_MARK), stages: [tick, mark(DONE_MARK), figure], ...OP_WORDS.done,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, cancel: null, sheetPlace: null,
  answered: null, holds: null, waitsOn: null, row: null, files: null, deletes: null};
// Cancel gives a done note's text, or a skip's reason, back to the step's box.
export const doneNote = {apply: doneBy(DONE_MARK, true), stages: [tick, mark(DONE_MARK), comment, figure], cancel: 'text', ...OP_WORDS.doneNote,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, sheetPlace: null, answered: null,
  holds: null, waitsOn: null, row: null, files: null, deletes: null};
export const skip = {apply: doneBy(SKIP_MARK, true), stages: [tick, mark(SKIP_MARK), comment, figure], cancel: 'text', ...OP_WORDS.skip,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, sheetPlace: null, answered: null,
  holds: null, waitsOn: null, row: null, files: null, deletes: null};
export const undone = {apply: (t, a) => marked({...t, done: false, done_at: ZERO}, a, null), stages: [untickOpen, unmark, figure], ...OP_WORDS.undone,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, cancel: null, sheetPlace: null,
  answered: null, holds: null, waitsOn: null, row: null, files: null, deletes: null};
// finishRun and reopenRun redraw the checklist's screen themselves.
export const finish = {apply: closed, stages: [tick, mark(DONE_MARK)], answered: () => {}, ...OP_WORDS.finish,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, cancel: null, sheetPlace: null,
  holds: null, waitsOn: null, row: null, files: null, deletes: null};
export const reopen = {apply: open, stages: [untick, unmark], answered: () => {}, ...OP_WORDS.reopen,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, cancel: null, sheetPlace: null,
  holds: null, waitsOn: null, row: null, files: null, deletes: null};
export const progress = {apply: (t, a) => ({...t, percent_done: a.pct / 100}), stages: [(a, c) => patch(a, c, {percent_done: a.pct / 100}), figure],
  ...OP_WORDS.progress,
  on: null, keepReads: null, invert: null, merge: null, waiting: null, refusal: null, cancel: null, sheetPlace: null,
  answered: null, holds: null, waitsOn: null, row: null, files: null, deletes: null};

// The last tick, skip or untick among a step's waiting ops. The step looks waiting while one is in the outbox.
const TICKS = ['done', 'undone', 'skip', 'doneNote'];
export const lastTick = ops => ops.filter(a => TICKS.includes(a.op)).at(-1);
