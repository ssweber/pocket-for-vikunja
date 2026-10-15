// Ticking a task or a checklist's step, skipping a step, finishing or reopening a checklist, and setting progress. A
// change to a step changes its checklist's progress, so `figure` writes that last, in the same entry.
import {ApiError} from '../api.js';
import {DONE_MARK, SKIP_MARK} from '../checklists.js';
import {FINISHED_MEANWHILE, OP_WORDS} from '../messages.js';
import {comment, figure, mark, patch, tick, unmark, untick} from './stages.js';

const closed = t => ({...t, done: true}), open = t => ({...t, done: false});
const TICK = {key: 'ticks', value: () => true};

// An untick that waited offline may arrive after someone finished the checklist. The checklist stays finished, and the
// step stays done.
const untickOpen = async (a, c) => {
  if (a.run && a.task !== a.run && (await c.read('/tasks/' + a.run)).done) throw Object.assign(new ApiError(409, FINISHED_MEANWHILE), {drop: true});
  return untick(a, c);
};

export const done = {apply: closed, stages: [tick, mark(DONE_MARK), figure], invert: null, merge: null, waiting: TICK, ...OP_WORDS.done};
export const doneNote = {apply: closed, stages: [tick, mark(DONE_MARK), comment, figure], invert: null, merge: null, waiting: TICK, ...OP_WORDS.doneNote};
export const skip = {apply: closed, stages: [tick, mark(SKIP_MARK), comment, figure], invert: null, merge: null, waiting: TICK, ...OP_WORDS.skip};
export const undone = {apply: open, stages: [untickOpen, unmark, figure], invert: null, merge: null, waiting: {key: 'ticks', value: () => false}, ...OP_WORDS.undone};
export const finish = {apply: closed, stages: [tick, mark(DONE_MARK)], invert: null, merge: null, waiting: null, ...OP_WORDS.finish};
export const reopen = {apply: open, stages: [untick, unmark], invert: null, merge: null, waiting: null, ...OP_WORDS.reopen};
export const progress = {apply: (t, a) => ({...t, percent_done: a.pct / 100}), stages: [(a, c) => patch(a, c, {percent_done: a.pct / 100}), figure],
  invert: null, merge: null, waiting: {key: 'pcts', value: a => a.pct}, ...OP_WORDS.progress};
