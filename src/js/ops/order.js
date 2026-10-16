// A task's place in its project's List view.
import {OP_WORDS} from '../messages.js';

// Vikunja's reply has the position it kept (a.got). That differs from the one sent when Vikunja renumbered the view.
const place = async (a, c) => { a.got = (await c.send(`/tasks/${a.task}/position`, {method: 'PUT', body: {project_view_id: a.view, position: a.pos}}))?.position; };

/* A refused move leaves the outbox at once instead of waiting to be tried again, and reorder puts the old order back.
   Once Vikunja answers, positionSent reloads the list if Vikunja renumbered it. */
export const position = {apply: t => ({...t}), stages: [place], refusal: 'undone', answered: (app, a) => app.positionSent(a), ...OP_WORDS.position,
  asks: ['view', 'pos'], saw: ['label'], on: null, keepReads: null, invert: null, merge: null, waiting: null, cancel: null, sheetPlace: null, holds: null,
  waitsOn: null, row: null, files: null, deletes: null};

// The positions the moves among the outbox's `entries` give their tasks, by task id.
export const waitingPositions = entries => Object.fromEntries(entries.filter(e => e.kind === 'act' && e.op === 'position').map(e => [e.task, e.pos]));
