// A comment on a task or a checklist's step, and the answers to a step's fields, which are posted as a comment.
import {OP_WORDS} from '../messages.js';
import {comment} from './stages.js';

export const note = {apply: t => ({...t}), stages: [comment], invert: null, merge: null, waiting: null, ...OP_WORDS.note};
export const answer = {apply: t => ({...t}), stages: [comment], invert: null, merge: null, waiting: null, ...OP_WORDS.answer};
