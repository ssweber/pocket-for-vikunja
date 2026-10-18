// Moving a task to another date, changing how it repeats, and the Undo of each.
import { isSet, repeats } from '../dates.js';
import { OP_WORDS } from '../messages.js';
import { changed, now, patch } from './stages.js';

// Vikunja writes a date in its own format, so two dates are compared as times.
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
const same = (k, a, b) => (k === 'due_date' ? sameTime(a, b) : a === b);
/* The date Vikunja stored for the move, from its answer. A tab that didn't see the answer has only the date it sent. A
   template's date taken off answers its first stage with the date still on, which is not the move's date. */
const gotOf = a => {
  const d = a.got?.task?.due_date;
  return d && sameTime(d, a.due) ? d : a.due;
};
const OFF = { repeat_after: 0, repeat_mode: 0 };
const repeatOf = t => (t && repeats(t) ? { repeat_after: t.repeat_after, repeat_mode: t.repeat_mode } : null);
const sameRepeat = (t, r) => t.repeat_after === r.repeat_after && t.repeat_mode === r.repeat_mode;
/* Sent with done: true while the task repeats, Vikunja moves the task on to its next time and leaves it not done. So
   such a body is sent in up to three requests: the repeat off, the rest, then the repeat back. That is the repeat in
   `body`, or else `rep`, the one Vikunja has. Each request is a stage of its own, so a retry finishes the same way. */
const split = (body, rep) => {
  if (body.done !== true) return [body];
  const { repeat_after, repeat_mode, ...rest } = body,
    back = 'repeat_after' in body ? repeatOf({ repeat_after, repeat_mode }) : rep;
  return [...(rep ? [OFF] : []), rest, ...(back ? [back] : [])];
};

/* What a move needs from Vikunja's copy, read once when it is first sent. An Undo (`check`, the date Vikunja stored for
   the move it undoes) sends the date before only while Vikunja still has `check` ('same'). If Vikunja already has that
   date, as after a move whose answer was unknown and that never arrived, nothing is sent ('back'). Any other date, or a
   task deleted since, is a change made since, and the copy it read shows on the row. A change to another field never
   stops it. A template's date taken off (done: true) puts back the repeat Vikunja has (`rep`), not the one its row
   showed, which a waiting repeat or a change in the web app can make wrong. An Undo that puts back a template's
   repeat (`repeat`) sends it only while Vikunja's copy has no repeat ('off'). */
const seen = (a, c) =>
  c.once('seen', async () => {
    const t = await now(a, c),
      check = a.check !== undefined;
    if (t && check && !sameTime(t.due_date, a.check)) c.task = t;
    return {
      ...(check && {
        found: !t
          ? 'changed'
          : sameTime(t.due_date, a.check)
            ? 'same'
            : sameTime(t.due_date, a.due)
              ? 'back'
              : 'changed',
      }),
      ...(a.done === true && { rep: repeatOf(t) }),
      ...(a.repeat && { repeat: !t ? 'changed' : !repeats(t) ? 'off' : sameRepeat(t, a.repeat) ? 'back' : 'changed' }),
    };
  });
/* The request of a move, or of one of the three stages of a template's date taken off. A template's date is when it
   next repeats, and `done` comes with it. An Undo sends each field still as the move left it, then ends as changed
   since if Vikunja has another date or repeat. */
const move = i => async (a, c) => {
  const s = a.check !== undefined || a.done === true ? await seen(a, c) : {};
  const body = {
    ...(s.found !== 'changed' &&
      s.found !== 'back' && { due_date: a.due, ...(a.done !== undefined && { done: a.done }) }),
    ...(s.repeat === 'off' && a.repeat),
  };
  const part = Object.keys(body).length && split(body, s.rep)[i];
  if (part) await patch(a, c, part);
  if (s.found === 'changed' || s.repeat === 'changed')
    throw changed(s.found === 'changed' ? 'its date has' : 'its repeat has');
};
const MOVES = [0, 1, 2].map(move);

/* Try again keeps what the first try read (keepReads). An earlier stage may have turned the repeat off since, and a new
   read would lose the repeat to put back. A date or a repeat set in the open sheet says it was refused under the
   sheet's date until the sheet closes, as the sheet's own saves do (sheetPlace). */
export const due = {
  apply: (t, a) => ({ ...t, due_date: a.due, ...(a.done !== undefined && { done: a.done }), ...a.repeat }),
  stages: a => (a.done === true ? MOVES : MOVES.slice(0, 1)),
  waiting: 'dues',
  keepReads: true,
  sheetPlace: 'sheet:due',
  /* Undo puts back the date before the move (`was`), unless the date Vikunja stored for it has changed since. A
     template is done without a date, so its Undo takes the date off again, or gives it back and leaves it not done. A
     template's date taken off turns its repeat off first. Stopped before its last stage, it may have left the repeat
     off, so its Undo puts back the repeat its first stage read from Vikunja. */
  invert: a => ({
    op: 'due',
    task: a.task,
    due: a.was,
    was: gotOf(a),
    check: gotOf(a),
    ...(a.tpl && { tpl: true, ...(!isSet(a.was) ? { done: true } : a.done !== undefined && { done: false }) }),
    ...(a.stage < MOVES.length && a.fixed?.seen?.rep && { repeat: a.fixed.seen.rep }),
  }),
  // A move replaces an earlier move of the task, and keeps its `was`, so Undo goes back to where the first move started.
  // It keeps the earlier move's `done` when it has none of its own, because Vikunja doesn't have that `done` yet.
  merge: (older, newer) =>
    older.op === 'due' ? { ...(older.done !== undefined && { done: older.done }), ...newer, was: older.was } : null,
  ...OP_WORDS.due,
  asks: ['due', 'done', 'check', 'repeat'],
  saw: ['label', 'was', 'tpl'],
  on: null,
  refusal: null,
  cancel: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
};

// The fields an Undo of a repeat compares. The repeat is two fields, compared together.
const PARTS = [['repeat_after', 'repeat_mode'], ['due_date'], ['done']];
// The fields a repeat sent (`body`, fieldsOf), or all of `set` before it is sent.
const sentOf = a => a.fixed?.body?.body ?? a.set;
const gotSet = (a, ks) => Object.fromEntries(ks.map(k => [k, a.got?.task?.[k] ?? a.set[k]]));
/* What a repeat sends, built once from Vikunja's copy when it is first sent, and the repeat Vikunja has (`rep`, for
   split). A repeat sets a date only when Vikunja's copy has none, not when only its row shows none. A done template
   counts as having none, because its date is when it next repeats. An Undo (`check`, the values Vikunja stored for the
   change it undoes) puts back only the fields still as the change left them. A field changed since is left alone, and
   the Undo ends as changed since once it has sent the rest (`left`). */
const fieldsOf = (a, c) =>
  !a.check && !('due_date' in a.set)
    ? { body: a.set }
    : c.once('body', async () => {
        const t = await now(a, c);
        let body = a.set,
          left = false;
        if (a.check) {
          body = {};
          left = !t;
          for (const ks of t ? PARTS.map(p => p.filter(k => k in a.set)).filter(p => p.length) : []) {
            if (ks.every(k => same(k, t[k], a.check[k]))) for (const k of ks) body[k] = a.set[k];
            else if (!ks.every(k => same(k, t[k], a.set[k]))) left = true;
          }
          if (t && left) c.task = t;
        } else if (t && isSet(t.due_date) && !('done' in a.set && t.done))
          body = Object.fromEntries(Object.entries(a.set).filter(([k]) => k !== 'due_date' && k !== 'done'));
        return { body, left, rep: repeatOf(t) };
      });
// Only an Undo that leaves a template done takes three stages (split).
const setCount = a => (a.set?.done === true ? 3 : 1);
const SETS = [0, 1, 2].map(i => async (a, c) => {
  const { body, left, rep } = await fieldsOf(a, c),
    part = split(body, rep)[i];
  if (part && Object.keys(part).length) await patch(a, c, part);
  if (left && i === setCount(a) - 1) throw changed('it has');
});

/* How a task repeats (`set`: repeat_after and repeat_mode, and a date when a repeat needs one), with what each field
   had before (`was`). */
export const repeat = {
  apply: (t, a) => ({ ...t, ...a.set }),
  stages: a => SETS.slice(0, setCount(a)),
  waiting: 'dues',
  keepReads: true,
  sheetPlace: 'sheet:due',
  invert: a => {
    const ks = Object.keys(sentOf(a));
    return {
      op: 'repeat',
      task: a.task,
      set: Object.fromEntries(ks.map(k => [k, a.was[k]])),
      was: gotSet(a, ks),
      check: gotSet(a, ks),
    };
  },
  // A change replaces an earlier one that hasn't been sent, with the fields of both, and keeps the oldest `was`.
  merge: (older, newer) =>
    older.op === 'repeat'
      ? { ...newer, set: { ...older.set, ...newer.set }, was: { ...newer.was, ...older.was } }
      : null,
  ...OP_WORDS.repeat,
  asks: ['set', 'check'],
  saw: ['label', 'was'],
  on: null,
  refusal: null,
  cancel: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
};
