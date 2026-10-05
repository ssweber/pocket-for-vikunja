// A task's progress, and marking it done.
import {repeats} from './dates.js';

/* Vikunja keeps a task's progress in percent_done, from 0 to 1. Pocket sets it in steps of 10%, and 100% marks the
   task done. A repeating task then starts its next time at 0%. */
export const pctOf = t => Math.round((t?.percent_done || 0) * 100);
/* A task's subtasks still open, to mark done with it. Not for a repeating task, which only moves to its next date. */
export const openSubtasks = t => repeats(t) ? [] : (t.related_tasks?.subtask || []).filter(s => !s.done);
// An Undo putting back what was there: no message of its own.
export const undoing = extra => 'percent_done' in extra && !extra.done;
export const doneText = (closed, open, title) => (title ? `Done: ${title.length > 40 ? title.slice(0, 38) + '…' : title}` : 'Done')
  + (!open ? '' : closed === open ? `, with ${open} subtask${open === 1 ? '' : 's'}` : `, with ${closed} of its ${open} open subtasks. The rest couldn't be saved.`);
export const progressPatch = (t, pct) => pct >= 100 ? {done: true, percent_done: repeats(t) ? 0 : 1} : {percent_done: pct / 100};
export const HOLD_MS = 450;                             // hold this long to start setting progress
