// What each field of an op is when the op sets it to null (opOf, ops/index.js). It has a file of its own because
// ops/comments.js calls the default `answered`, and ops/index.js imports every op.
import { opsId } from '../tasks.js';

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
  // 'made': the task it made stays, and the lines under it are sent under that task. Cancel offers no Undo. 'unmade':
  // the tasks it made are deleted by its own stages, which Cancel marks `cancelled` (cancelMade). Cancel offers no Undo.
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
