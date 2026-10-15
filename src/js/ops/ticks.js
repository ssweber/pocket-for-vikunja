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

export const done = {apply: doneBy(DONE_MARK), stages: [tick, mark(DONE_MARK), figure], invert: null, merge: null, ...OP_WORDS.done};
export const doneNote = {apply: doneBy(DONE_MARK, true), stages: [tick, mark(DONE_MARK), comment, figure], invert: null, merge: null, ...OP_WORDS.doneNote};
export const skip = {apply: doneBy(SKIP_MARK, true), stages: [tick, mark(SKIP_MARK), comment, figure], invert: null, merge: null, ...OP_WORDS.skip};
export const undone = {apply: (t, a) => marked({...t, done: false, done_at: ZERO}, a, null), stages: [untickOpen, unmark, figure], invert: null, merge: null, ...OP_WORDS.undone};
export const finish = {apply: closed, stages: [tick, mark(DONE_MARK)], invert: null, merge: null, ...OP_WORDS.finish};
export const reopen = {apply: open, stages: [untick, unmark], invert: null, merge: null, ...OP_WORDS.reopen};
export const progress = {apply: (t, a) => ({...t, percent_done: a.pct / 100}), stages: [(a, c) => patch(a, c, {percent_done: a.pct / 100}), figure],
  invert: null, merge: null, ...OP_WORDS.progress};
