// A task's place in its project's List view.
import {OP_WORDS} from '../messages.js';

// Vikunja's reply has the position it kept (a.got). That differs from the one sent when Vikunja renumbered the view.
const place = async (a, c) => { a.got = (await c.send(`/tasks/${a.task}/position`, {method: 'PUT', body: {project_view_id: a.view, position: a.pos}}))?.position; };

export const position = {apply: t => ({...t}), stages: [place], invert: null, merge: null, waiting: null, ...OP_WORDS.position};
