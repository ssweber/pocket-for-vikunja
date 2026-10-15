// Deleting a task with its subtasks. The entry is held while Restore shows (holdDelete, app/actions.js).
import {OP_WORDS} from '../messages.js';
import {figure} from './stages.js';

// a.ids holds the task and its subtasks, deepest first. A task someone else deleted in the meantime is not an error.
const deleteAll = async (a, c) => { for (const id of a.ids) await c.send('/tasks/' + id, {method: 'DELETE'}).catch(e => { if (e.status !== 404) throw e; }); };

// `figure` writes the progress of the parent that stays (a.up).
export const del = {apply: t => ({...t}), stages: [deleteAll, figure], invert: null, merge: null, waiting: null, ...OP_WORDS.delete};
