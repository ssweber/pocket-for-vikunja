// A comment on a task or a checklist's step, and the answers to a step's fields, which are posted as a comment.
import { OP_WORDS } from '../messages.js';
import { comment } from './stages.js';
import { said } from './shown.js';
import { DEFAULTS } from './defaults.js';

const add = (t, a) => said({ ...t }, a);
/* A comment's text goes back to its box when Vikunja refuses it or Cancel takes it out, so the text is never both in
   the box and sent. Once Vikunja has it, a comment from a task's sheet reloads the sheet's comments. */
export const note = {
  apply: add,
  stages: [comment],
  refusal: 'back',
  cancel: 'back',
  ...OP_WORDS.note,
  answered(app, a, c) {
    if (!a.run && app.sheet.id === a.task) app.loadComments(a.task);
    DEFAULTS.answered(app, a, c);
  },
  asks: ['html'],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  sheetPlace: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};
// An answer's text doesn't go back on Cancel, because the step's comment box is not where it was typed.
export const answer = {
  apply: add,
  stages: [comment],
  ...OP_WORDS.answer,
  asks: ['html'],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
  cancel: null,
  sheetPlace: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};

// The comments still waiting to be posted on task `id` from its sheet, among the outbox's `entries`.
export const waitingComments = (entries, id) =>
  entries.filter(e => e.kind === 'act' && e.op === 'note' && e.task === id && !e.run);
