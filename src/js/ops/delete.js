/* Deleting a task with its subtasks. A delete from a row or a task's sheet is held while Restore shows (holdDelete,
   app/actions.js). Any other is sent at once, with no Restore (deleteNow). */
import { OP_WORDS } from '../messages.js';
import { figure } from './stages.js';

// a.ids holds the task and its subtasks, deepest first. A task someone else deleted in the meantime is not an error.
const deleteAll = async (a, c) => {
  for (const id of a.ids)
    await c.send('/tasks/' + id, { method: 'DELETE' }).catch(e => {
      if (e.status !== 404) throw e;
    });
};
// The parent that stays (a.up) no longer lists the tasks. The tasks themselves are hidden by the rows (hiddenRows).
const apply = (t, a) =>
  a.ids.includes(t.id) || !t.related_tasks?.subtask
    ? { ...t }
    : {
        ...t,
        related_tasks: { ...t.related_tasks, subtask: t.related_tasks.subtask.filter(s => !a.ids.includes(s.id)) },
      };

/* `figure` writes the progress of the parent that stays. A template deleted from its sheet waits for its answer there,
   so a refusal is said at the top of the sheet. */
export const del = {
  apply,
  on: a => [...a.ids, ...(a.up != null ? [a.up] : [])],
  stages: [deleteAll, figure],
  deletes: a => a.ids,
  sheetPlace: 'sheet:top',
  ...OP_WORDS.delete,
  asks: ['ids', 'up'],
  saw: ['label'],
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
  cancel: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  replyOnly: null,
};
