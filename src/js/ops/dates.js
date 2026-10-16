// Moving a task to another date, and its Undo.
import {ApiError} from '../api.js';
import {changedSince, OP_WORDS} from '../messages.js';
import {patch} from './stages.js';

// Vikunja writes a date in its own format, so two dates are compared as times.
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
// The date Vikunja stored for the move, from its answer. A tab that didn't see the answer has only the date it sent.
const gotOf = a => a.got?.task?.due_date ?? a.due;

/* Set the task's date. An Undo (`check`, the date Vikunja stored for the move it undoes) first reads Vikunja's copy,
   once. If the date has changed since, nothing is sent, and the copy it read shows on the row. A change to another
   field never stops it. */
async function set(a, c){
  if (a.check !== undefined) {
    const same = await c.once('same', async () => {
      const now = await c.read('/tasks/' + a.task);
      if (sameTime(now.due_date, a.check)) return true;
      c.task = now; return false;
    });
    if (!same) throw Object.assign(new ApiError(409, 'its date has changed since then'), {drop: true, said: changedSince(a.label || 'it')});
  }
  await patch(a, c, {due_date: a.due});
}

export const due = {apply: (t, a) => ({...t, due_date: a.due}), stages: [set], waiting: 'dues',
  // Undo puts back the date before the move (`was`), unless the date Vikunja stored for it has changed since.
  invert: a => ({op: 'due', task: a.task, due: a.was, was: gotOf(a), check: gotOf(a)}),
  // A move replaces an earlier move of the task that hasn't been sent, and keeps its `was`, so Undo goes back to where
  // the first move started. An Undo is never folded, because its check would be lost.
  merge: (older, newer) => older.check === undefined && newer.check === undefined ? {...newer, was: older.was} : null,
  ...OP_WORDS.due};
