// The requests several ops share. Each is a stage, `(a, c) => Promise`, which app/acts.js runs with `c`: `c.send` is a
// write with its own key, `c.read` a plain read, and `c.once` a body built once and kept in the entry.
import {TASK} from '../app/tasks.js';
import {DONE_MARK, SKIP_MARK} from '../checklists.js';
import {figurePatch} from '../progress.js';

// Change some of the task's fields and return Vikunja's copy, which is also the op's answer (c.task). When nothing
// changes Vikunja sends no body back, so the task is read instead.
export const patch = async (a, c, fields) => c.task = await c.send('/tasks/' + a.task, {method: 'PATCH', body: fields}) || await c.read('/tasks/' + a.task);
// Vikunja's time for the tick lets a countdown that waits on this step keep the time it was ticked here (keepTick).
export const tick = async (a, c) => { const t = await patch(a, c, {done: true}); if (t?.done_at) c.app.keepTick(a, a.doneAt = t.done_at); };
export const untick = (a, c) => patch(a, c, {done: false});
export const mark = value => (a, c) => c.send(`/tasks/${a.task}/reactions`, {method: 'POST', body: {value}});
export const unmark = async (a, c) => { for (const value of [DONE_MARK, SKIP_MARK]) await c.send(`/tasks/${a.task}/reactions/delete`, {method: 'POST', body: {value}}); };
// The comment Vikunja made takes the place of the op's waiting comment in Vikunja's copy (answered, app/tasks.js).
export const comment = async (a, c) => { const out = await c.send(`/tasks/${a.task}/comments`, {method: 'POST', body: {comment: a.html}}); if (out?.id) c.comment = out; };
/* Write the parent's progress, calculated from its subtasks as Vikunja has them now, and only if it changed. The
   parent is the run after one of its steps (a.run), or the parent of a deleted subtask (a.up). The body is worked out
   once: after a lost reply Vikunja's copy already has the new progress, and a body read again would differ from the
   one the relay holds for this key. A parent that a waiting delete deletes is left alone. */
export const figure = async (a, c) => {
  const up = a.up ?? (a.run && a.task !== a.run ? a.run : null);
  if (!up || c.app.beingDeleted(up)) return;
  // A parent deleted in the meantime, by Pocket or in the web app, is not an error.
  try {
    const body = await c.once('figure', async () => { const now = await c.read('/tasks/' + up); return c.app.role(now) === 'template' ? null : figurePatch(now); });
    if (!body) return;
    const t = await c.send('/tasks/' + up, {method: 'PATCH', body}) || await c.read('/tasks/' + up);
    c.app.change(w => w.put([t], TASK));
  } catch (e) { if (e.status !== 404) throw e; }
};
