/* Every kind of change Pocket sends through the outbox, by name (an entry's `op`). Only the files in src/js/ops/ know
   which op is which. The shared code asks the op what to do (opOf), and lint fails on code elsewhere that compares an
   op's name. An op sets every field below, to its own value or to null for the default in DEFAULTS, so a new op
   decides each one. The registry test checks that it does.
   - apply(t, a): the task as it will be once the op is made, as a new object. It changes neither argument.
   - on(a): the ids of the tasks it changes, whose rows show it while it waits (shownOn, tasks.js).
   - stages: its requests in order, `(a, c) => Promise` each (stages.js), or a function of the entry giving them.
   - keepReads: Try again keeps what the first try read (`a.fixed`), instead of reading Vikunja's copy again.
   - invert(a): the fields of the op that undoes entry `a`, from what `a` recorded, or null for no Undo.
   - merge(older, newer): what replaces an unsent `older` and the `newer` op on its task: an entry, CANCEL or null.
   - waiting: the key of the component's `waiting` that marks its task's rows once it has waited a while.
   - refusal: what becomes of it when Vikunja refuses it (the values are beside DEFAULTS).
   - cancel: what Cancel gives back, and so whether Cancel offers Undo (the values are beside DEFAULTS).
   - sheetPlace: where the open sheet of its task says it was refused, instead of the usual place.
   - answered(app, a, c): what the screen does once Vikunja has answered it.
   - holds(a): the ids it holds back once it fails, so the ops after it on them wait (heldTasks, app/acts.js).
   - waitsOn(a): the ids it waits behind when an op on one of them has failed.
   - row(a): the waiting row it shows in a list until its task is made, or null (pendingTasks).
   - files(a): the files it still has to upload once its task is made. They move to an entry of their own.
   - deletes(a): the ids of the tasks it deletes, hidden while it waits and forgotten once it is answered.
   - text, refused, dropped and saved: its words, from messages.js. */
import {opsId} from '../app/tasks.js';
import {done, doneNote, finish, progress, reopen, skip, undone} from './ticks.js';
import {answer, note} from './comments.js';
import {claim, unclaim} from './people.js';
import {position} from './order.js';
import {del} from './delete.js';
import {add} from './add.js';
import {due, repeat} from './dates.js';

// Import an op's helpers from here, never from its own file. Imported first, its file would load the other ops while
// stages.js is still loading, and they fail without it.
export {addLines, dropUnder, LINE, linesUnder, madeStage, passUps, photosOf, refuseLines} from './add.js';
export {waitingComments} from './comments.js';
export {waitingPositions} from './order.js';
export {lastTick} from './ticks.js';
export const OPS = {done, undone, skip, doneNote, note, answer, finish, reopen, progress, claim, unclaim, delete: del, position, add, due, repeat};

// What each field is when an op sets it to null.
export const DEFAULTS = {
  on: a => [opsId(a.task)],
  keepReads: false,
  invert: null,
  merge: null,
  waiting: null,
  // 'kept': it waits in the Outbox, marked failed, for Try again or Cancel. 'back': it leaves the outbox, and its text
  // goes back where it was typed. 'lines': it and the lines typed after it go back to their add box, which says what
  // became of them (reportSent), so the sender says nothing of such an op. 'undone': it leaves the outbox, and the
  // code that queued it puts the screen back and says why (reorder). A change whose answer is unknown is always kept.
  refusal: 'kept',
  // 'undo': nothing goes back, and Cancel offers Undo. 'text': its text goes back to its box and Cancel says so, or
  // with no text Cancel offers Undo. 'back': its text goes back, and its `dropped` words say so. 'lines': the lines
  // under it go back to their box. An unsent line is cancelled as its waiting row's Cancel does it (cancelPending).
  cancel: 'undo',
  sheetPlace: null,
  answered: (app, a) => { if (app.view.shownRun?.id === a.run) app.refreshRunTask(a.task); },
  holds: a => [a.task],
  waitsOn: a => [a.task],
  row: () => null,
  files: () => [],
  deletes: () => [],
};
const full = new WeakMap();
/* The op that entry `a` names, with DEFAULTS in place of each field it sets to null or leaves out. An op Pocket doesn't
   know, such as one an older Pocket saved, takes every default. */
export const opOf = a => {
  const op = OPS[a.op];
  if (!op) return DEFAULTS;
  if (!full.has(op)) full.set(op, Object.fromEntries(Object.entries({...DEFAULTS, ...op}).map(([k, v]) => [k, v ?? DEFAULTS[k]])));
  return full.get(op);
};
// The stages entry `a` is sent in. A stage builds its requests only from the entry and `a.fixed`, so each part always
// carries the same request, and its key gets the same answer from the relay.
export const stagesOf = a => { const s = OPS[a.op].stages; return typeof s === 'function' ? s(a) : s; };
// The component's `waiting` with nothing waiting: the files to upload by task, and the key each op names.
export const noneWaiting = () => Object.fromEntries(['files', ...Object.values(OPS).map(o => o.waiting).filter(Boolean)].map(k => [k, {}]));
