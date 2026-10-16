// Moving a task to another date, changing how it repeats, and the Undo of each.
import {ApiError} from '../api.js';
import {isSet} from '../dates.js';
import {changedSince, OP_WORDS} from '../messages.js';
import {patch} from './stages.js';

// Vikunja writes a date in its own format, so two dates are compared as times.
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
const same = (k, a, b) => k === 'due_date' ? sameTime(a, b) : a === b;
// The date Vikunja stored for the move, from its answer. A tab that didn't see the answer has only the date it sent.
const gotOf = a => a.got?.task?.due_date ?? a.due;
// Reads Vikunja's copy for an Undo, or null for a task deleted since.
const now = (a, c) => c.read('/tasks/' + a.task).catch(e => { if (e.status === 404) return null; throw e; });
const changed = (a, what) => Object.assign(new ApiError(409, what + ' changed since then'), {drop: true, said: changedSince(a.label || 'it')});

/* Whether a move still sends anything. An Undo (`check`, the date Vikunja stored for the move it undoes) first reads
   Vikunja's copy, once. If the date is still `check`, the Undo sends the date before. If Vikunja already has that date,
   as after a move whose answer was unknown and that never arrived, nothing is sent. Any other date, or a task deleted
   since, is a change made since, and the copy it read shows on the row. A change to another field never stops it. */
async function checked(a, c){
  if (a.check === undefined) return true;
  const found = await c.once('found', async () => {
    const t = await now(a, c);
    if (t && !sameTime(t.due_date, a.check)) c.task = t;
    return !t ? 'changed' : sameTime(t.due_date, a.check) ? 'same' : sameTime(t.due_date, a.due) ? 'back' : 'changed';
  });
  if (found === 'changed') throw changed(a, 'its date has');
  return found === 'same';
}
/* The requests of a move. A template's date is when it next repeats, and `done` comes with it. Taking a repeating
   template's date off (`rep`, its repeat) takes three: the repeat off, the date and done, then the repeat back. Saved
   in one request with the repeat, Vikunja would move the template on to its next time and leave it not done. Putting
   the repeat back means a date given later repeats as before. */
const bodies = a => {
  const date = {due_date: a.due, ...a.done !== undefined && {done: a.done}};
  return a.tpl && a.rep && !isSet(a.due) ? [{repeat_after: 0, repeat_mode: 0}, date, a.rep] : [date];
};
const move = i => async (a, c) => { const body = bodies(a)[i]; if (body && await checked(a, c)) await patch(a, c, body); };

export const due = {apply: (t, a) => ({...t, due_date: a.due, ...a.done !== undefined && {done: a.done}}), stages: [0, 1, 2].map(move), waiting: 'dues',
  /* Undo puts back the date before the move (`was`), unless the date Vikunja stored for it has changed since. A
     template is done without a date, so its Undo takes the date off again, or gives it back and leaves it not done. */
  invert: a => ({op: 'due', task: a.task, due: a.was, was: gotOf(a), check: gotOf(a),
    ...a.tpl && {tpl: true, rep: a.rep, ...!isSet(a.was) ? {done: true} : a.done !== undefined && {done: false}}}),
  // A move replaces an earlier move of the task, and keeps its `was`, so Undo goes back to where the first move started.
  // It keeps the earlier move's `done` when it has none of its own, because Vikunja doesn't have that `done` yet.
  merge: (older, newer) => older.op === 'due' ? {...older.done !== undefined && {done: older.done}, ...newer, was: older.was} : null,
  ...OP_WORDS.due};

// The fields an Undo of a repeat compares. The repeat is two fields, compared together.
const PARTS = [['repeat_after', 'repeat_mode'], ['due_date'], ['done']];
const gotSet = a => Object.fromEntries(Object.keys(a.set).map(k => [k, a.got?.task?.[k] ?? a.set[k]]));
/* Set the fields in `set`. An Undo (`check`, the values Vikunja stored for the change it undoes) first reads Vikunja's
   copy, once, and puts back only the fields still as the change left them. A field changed since is left alone, and
   the Undo ends as changed since once it has sent the rest. */
async function setFields(a, c){
  let body = a.set, left = false;
  if (a.check) ({body, left} = await c.once('body', async () => {
    const t = await now(a, c), out = {};
    let off = !t;
    for (const ks of t ? PARTS.map(p => p.filter(k => k in a.set)).filter(p => p.length) : []) {
      if (ks.every(k => same(k, t[k], a.check[k]))) for (const k of ks) out[k] = a.set[k];
      else if (!ks.every(k => same(k, t[k], a.set[k]))) off = true;
    }
    if (t && off) c.task = t;
    return {body: out, left: off};
  }));
  if (Object.keys(body).length) await patch(a, c, body);
  if (left) throw changed(a, 'it has');
}

/* How a task repeats (`set`: repeat_after and repeat_mode, and a date when a repeat needs one), with what each field
   had before (`was`). */
export const repeat = {apply: (t, a) => ({...t, ...a.set}), stages: [setFields], waiting: 'dues',
  invert: a => ({op: 'repeat', task: a.task, set: a.was, was: gotSet(a), check: gotSet(a)}),
  // A change replaces an earlier one that hasn't been sent, with the fields of both, and keeps the oldest `was`.
  merge: (older, newer) => older.op === 'repeat' ? {...newer, set: {...older.set, ...newer.set}, was: {...newer.was, ...older.was}} : null,
  ...OP_WORDS.repeat};
