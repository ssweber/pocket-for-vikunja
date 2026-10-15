// A comment on a task or a checklist's step, and the answers to a step's fields, which are posted as a comment.
import {OP_WORDS} from '../messages.js';
import {comment} from './stages.js';
import {said} from './shown.js';

const add = (t, a) => said({...t}, a);
export const note = {apply: add, stages: [comment], invert: null, merge: null, ...OP_WORDS.note};
export const answer = {apply: add, stages: [comment], invert: null, merge: null, ...OP_WORDS.answer};
