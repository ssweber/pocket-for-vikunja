/* Every kind of change Pocket sends through the outbox, by name (an entry's `op`). Only the files in src/js/ops/ know
   which op is which. The shared code asks the op what to do (opOf), and lint fails on code elsewhere that compares an
   op's name. An op sets every field below, to its own value or to null for the default in DEFAULTS, so a new op
   decides each one. The registry test checks that it does.
   - asks: the fields of its entry that hold what the user chose. Its stages build their requests from these. A choice
     may be worked out from the screen when the user confirmed it, such as the tasks a delete asked about.
   - saw: the fields that hold what the screen showed when the user chose, for its words and its Undo. The task may
     have changed by the time the op is sent, so a stage that reads one throws (stageView). A request that depends on
     the task is built from Vikunja's copy, read once with c.once. act() throws on a field in none of asks, saw, COMMON
     and SENT, and when it is queued, on a field in SENT too (checkFields).
   - apply(t, a): the task as it will be once the op is made, as a new object. It changes neither argument.
   - on(a): the ids of the tasks it changes, whose rows show it while it waits (shownOn, tasks.js).
   - stages: its requests in order, `(a, c) => Promise` each (stages.js), or a function of the entry giving them.
   - keepReads: Try again keeps what the first try read (`a.fixed`), instead of reading Vikunja's copy again.
   - invert(a): the fields of the op that undoes entry `a`, from what `a` recorded, or null for no Undo.
   - merge(older, newer): what replaces an unsent `older` and the `newer` op on its task: an entry, CANCEL or null.
   - waiting: the key of the component's `waiting` that marks its task's rows once it has waited a while.
   - refusal: what becomes of it when Vikunja refuses it (the values are beside DEFAULTS), or a function of the entry
     and Vikunja's refusal giving that (refusalOf).
   - cancel: what Cancel gives back, and so whether Cancel offers Undo (the values are beside DEFAULTS), or a function
     of the entry giving that (cancelOf).
   - sheetPlace: where the open sheet of its task says it was refused, instead of the usual place, or a function of
     the entry giving that (sheetPlaceOf).
   - answered(app, a, c): what the screen does once Vikunja has answered it.
   - putBack(app, a, error): what puts the screen back and says why when a refusal leaves the outbox ('undone').
   - holds(a): the ids it holds back once it fails, so the ops after it on them wait (heldTasks, app/acts.js).
   - waitsOn(a): the ids it waits behind when an op on one of them has failed.
   - row(a): the waiting row it shows in a list until its task is made, or null (pendingTasks).
   - files(a): the files it still has to upload once its task is made. They move to an entry of their own.
   - deletes(a): the ids of the tasks it deletes, hidden while it waits and forgotten once it is answered.
   - replyOnly(a): the fields of its task that only Vikunja's reply can say, because a stage builds them from Vikunja's
     copy as it is sent. Its apply's value for them is only a guess, which Vikunja's copy never takes (sendingOp).
   - text, refused, dropped and saved: its words, from messages.js. */
import { opsId } from '../app/tasks.js';
import { done, doneNote, finish, progress, reopen, skip, undone } from './ticks.js';
import { answer, note } from './comments.js';
import { claim, unclaim } from './people.js';
import { position } from './order.js';
import { del } from './delete.js';
import { add } from './add.js';
import { due, repeat } from './dates.js';
import { edit } from './edit.js';

// Import an op's helpers from here, never from its own file. Imported first, its file would load the other ops while
// stages.js is still loading, and they fail without it.
export { addLines, dropUnder, LINE, linesUnder, madeStage, passUps, photosOf, refuseLines } from './add.js';
export { waitingComments } from './comments.js';
export { waitingPositions } from './order.js';
export { lastTick, movedFrom } from './ticks.js';
export { movedSteps, notesText } from './edit.js';
export const OPS = {
  done,
  undone,
  skip,
  doneNote,
  note,
  answer,
  finish,
  reopen,
  progress,
  claim,
  unclaim,
  delete: del,
  position,
  add,
  due,
  repeat,
  edit,
};

// What each field is when an op sets it to null.
export const DEFAULTS = {
  asks: [],
  saw: [],
  on: a => [opsId(a.task)],
  keepReads: false,
  invert: null,
  merge: null,
  waiting: null,
  // 'kept': it waits in the Outbox, marked failed, for Try again or Cancel. 'back': it leaves the outbox, and its text
  // goes back where it was typed. 'lines': it and the lines typed after it go back to their add box, which says what
  // became of them (reportSent), so the sender says nothing of such an op. 'undone': it leaves the outbox, and its
  // putBack puts the screen back and says why, whichever code sent it. 'dropped': it leaves the outbox, and the sender
  // says why. A change whose answer is unknown is always kept.
  refusal: 'kept',
  // 'undo': nothing goes back, and Cancel offers Undo. 'text': its text goes back to its box and Cancel says so, or
  // with no text Cancel offers Undo. 'back': its text goes back, and its `dropped` words say so. 'lines': the lines
  // under it go back to their box. An unsent line is cancelled as its waiting row's Cancel does it (cancelPending).
  // 'made': the task it made stays, and the lines under it are sent under that task. Cancel offers no Undo.
  cancel: 'undo',
  sheetPlace: null,
  answered: (app, a) => {
    if (app.view.shownRun?.id === a.run) app.refreshRunTask(a.task);
  },
  putBack: () => {},
  holds: a => [a.task],
  waitsOn: a => [a.task],
  row: () => null,
  files: () => [],
  deletes: () => [],
  replyOnly: () => [],
};
// The fields any op's entry may have when it is queued (actEntry). `undo` marks an op that undoes another, by the id of
// that op's entry (undoOps).
export const COMMON = ['id', 'kind', 'op', 'user', 'who', 'at', 'n', 'task', 'run', 'undo'];
/* The fields the sender and the stages write in an entry as it is sent: how far it got, what it read and what Vikunja
   answered. `until` holds a delete back while Restore shows, and an add's stages keep the task they made. */
export const SENT = [
  'files',
  'stage',
  'fails',
  'sent',
  'key',
  'fixed',
  'got',
  'failed',
  'filed',
  'until',
  'problems',
  'doneAt',
  'taskId',
  'projectId',
  'to',
  'body',
  'people',
  'labels',
  'tags',
  'had',
  'labeled',
  'assigned',
  'linked',
  'arrived',
];
const full = new WeakMap();
/* The op that entry `a` names, with DEFAULTS in place of each field it sets to null or leaves out. An op Pocket doesn't
   know, such as one a newer Pocket saved, takes DEFAULTS. It has no stages, apply or words, so it can't be sent or
   listed in the Outbox. */
export const opOf = a => {
  const op = OPS[a.op];
  if (!op) return DEFAULTS;
  if (!full.has(op))
    full.set(op, Object.fromEntries(Object.entries({ ...DEFAULTS, ...op }).map(([k, v]) => [k, v ?? DEFAULTS[k]])));
  return full.get(op);
};
/* Throw on a field of entry `a` that its op doesn't declare. Nothing reads such a field on purpose, so it is a bug. The
   fields an op is queued with (`queued`) can't include the sender's own (SENT), so no caller can hand a stage a body
   or a read made from what the row showed. */
export const checkFields = (a, queued = false) => {
  const op = opOf(a),
    known = new Set([...COMMON, ...(queued ? [] : SENT), ...op.asks, ...op.saw]);
  for (const k of Object.keys(a))
    if (!known.has(k))
      throw new Error(
        queued && SENT.includes(k)
          ? `The ${a.op} op is queued with the sender's field ${k}`
          : `The ${a.op} op doesn't declare the field ${k}`,
      );
  return a;
};
/* Entry `a` as its stages get it. Reading a field in the op's `saw` throws, because what the screen showed when the op
   was queued may be wrong by the time it is sent. Writes reach the entry. */
export const stageView = a => {
  const saw = new Set(opOf(a).saw);
  return new Proxy(a, {
    get(t, k) {
      if (saw.has(k))
        throw new Error(
          `The ${t.op} op's stage read ${k}, what the screen showed. Read Vikunja's copy with c.once instead.`,
        );
      return t[k];
    },
  });
};
// The stages entry `a` is sent in. A stage builds its requests only from the entry and `a.fixed`, so each part always
// carries the same request, and its key gets the same answer from the relay.
export const stagesOf = a => {
  const s = OPS[a.op].stages;
  return typeof s === 'function' ? s(a) : s;
};
/* What Vikunja's refusal `error` of entry `a` does, and what its Cancel gives back. An add's line decides by whether its
   task is made, and a tick by whether its task is gone. */
export const refusalOf = (a, error = null) => {
  const r = opOf(a).refusal;
  return typeof r === 'function' ? r(a, error) : r;
};
export const cancelOf = a => {
  const r = opOf(a).cancel;
  return typeof r === 'function' ? r(a) : r;
};
// Where the open sheet of entry `a`'s task says it was refused. An edit says it beside the field it changes.
export const sheetPlaceOf = a => {
  const p = opOf(a).sheetPlace;
  return typeof p === 'function' ? p(a) : p;
};
// The component's `waiting` with nothing waiting: the files to upload by task, and the key each op names.
export const noneWaiting = () =>
  Object.fromEntries(
    [
      'files',
      ...Object.values(OPS)
        .map(o => o.waiting)
        .filter(Boolean),
    ].map(k => [k, {}]),
  );
