// Moving a task to another date, and its Undo.
import {ApiError} from '../api.js';
import {changedSince, OP_WORDS} from '../messages.js';
import {patch} from './stages.js';

// Vikunja writes a date in its own format, so two dates are compared as times.
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
// The date Vikunja stored for the move, from its answer. A tab that didn't see the answer has only the date it sent.
const gotOf = a => a.got?.task?.due_date ?? a.due;

/* Set the task's date. An Undo (`check`, the date Vikunja stored for the move it undoes) first reads Vikunja's copy,
   once. If the date is still `check`, the Undo sends the date before. If Vikunja already has that date, as after a
   move whose answer was unknown and that never arrived, nothing is sent. Any other date, or a task deleted since, is
   a change made since, and the copy it read shows on the row. A change to another field never stops it. */
async function set(a, c){
  if (a.check !== undefined) {
    const found = await c.once('found', async () => {
      const now = await c.read('/tasks/' + a.task).catch(e => { if (e.status === 404) return null; throw e; });
      if (now && !sameTime(now.due_date, a.check)) c.task = now;
      return !now ? 'changed' : sameTime(now.due_date, a.check) ? 'same' : sameTime(now.due_date, a.due) ? 'back' : 'changed';
    });
    if (found === 'changed') throw Object.assign(new ApiError(409, 'its date has changed since then'), {drop: true, said: changedSince(a.label || 'it')});
    if (found === 'back') return;
  }
  await patch(a, c, {due_date: a.due});
}

export const due = {apply: (t, a) => ({...t, due_date: a.due}), stages: [set], waiting: 'dues',
  // Undo puts back the date before the move (`was`), unless the date Vikunja stored for it has changed since.
  invert: a => ({op: 'due', task: a.task, due: a.was, was: gotOf(a), check: gotOf(a)}),
  // A move replaces an earlier move of the task, and keeps its `was`, so Undo goes back to where the first move started.
  merge: (older, newer) => older.op === 'due' ? {...newer, was: older.was} : null,
  ...OP_WORDS.due};
