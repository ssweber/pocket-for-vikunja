// The requests several ops share. Each is a stage, `(a, c) => Promise`, which app/acts.js runs with `c`: `c.send` is a
// write with its own key, `c.read` a plain read, and `c.once` a body built once and kept in the entry.
import { ApiError } from '../api.js';
import { changedSince } from '../messages.js';
import { TASK } from '../app/tasks.js';
import { DONE_MARK, SKIP_MARK } from '../checklists.js';
import { figurePatch } from '../progress.js';
import { plainReminders, reminderKey } from '../dates.js';

// Change some of the task's fields and return Vikunja's copy, which is also the op's answer (c.task). When nothing
// changes Vikunja sends no body back, so the task is read instead.
export const patch = async (a, c, fields) =>
  (c.task =
    (await c.send('/tasks/' + a.task, { method: 'PATCH', body: fields })) || (await c.read('/tasks/' + a.task)));
/* Tick the task, with the progress the user set (`pct`), if any. Vikunja's time for the tick lets a countdown that waits
   on a checklist's step keep the time it was ticked here (keepTick). */
export const tick = async (a, c) => {
  const t = await patch(a, c, { done: true, ...(a.pct !== undefined && { percent_done: a.pct / 100 }) });
  if (a.run && t?.done_at) c.app.keepTick(a, (a.doneAt = t.done_at));
};
export const untick = (a, c) => patch(a, c, { done: false });
/* Put the user's ✅ or ⏭️ on the task in place of their other one, as the op shows it (marked, ops/shown.js). Vikunja
   deletes only the user's own reaction, and a reaction the user hasn't given is no error, so the body never depends
   on the task, as for unmark. A repeating task that the tick moved on to its next date is open, so it gets none. */
export const mark = value => async (a, c) => {
  if (a.got?.task?.done === false) return;
  const other = value === DONE_MARK ? SKIP_MARK : DONE_MARK;
  await c.send(`/tasks/${a.task}/reactions/delete`, { method: 'POST', body: { value: other } });
  await c.send(`/tasks/${a.task}/reactions`, { method: 'POST', body: { value } });
};
export const unmark = async (a, c) => {
  for (const value of [DONE_MARK, SKIP_MARK])
    await c.send(`/tasks/${a.task}/reactions/delete`, { method: 'POST', body: { value } });
};
// The comment Vikunja made takes the place of the op's waiting comment in Vikunja's copy (answered, app/tasks.js).
export const comment = async (a, c) => {
  const out = await c.send(`/tasks/${a.task}/comments`, { method: 'POST', body: { comment: a.html } });
  if (out?.id) c.comment = out;
};
/* Write the parent's progress, calculated from its subtasks as Vikunja has them now, and only if it changed. The
   parent is the run after one of its steps (a.run), or the parent of a deleted subtask (a.up). The body is worked out
   once: after a lost reply Vikunja's copy already has the new progress, and a body read again would differ from the
   one the relay holds for this key. A parent that a waiting delete deletes is left alone. */
export const figure = (a, c) => figureOf(c, a.up ?? (a.run && a.task !== a.run ? a.run : null));
// Write task `up`'s progress, with its body kept in the entry under `name`.
export const figureOf = async (c, up, name = 'figure') => {
  if (!up || c.app.beingDeleted(up)) return;
  // A parent deleted in the meantime, by Pocket or in the web app, is not an error.
  try {
    const body = await c.once(name, async () => {
      const now = await c.read('/tasks/' + up);
      return c.app.role(now) === 'template' ? null : figurePatch(now);
    });
    if (!body) return;
    const sent = await c.send('/tasks/' + up, { method: 'PATCH', body, on: { [up]: body } }),
      t = sent || (await c.read('/tasks/' + up));
    c.app.change(w => {
      w.made(up, c.from(sent), body);
      w.answer([t], TASK, c.from(t));
    });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
};

// Reads Vikunja's copy, or null for a task deleted since.
export const now = (a, c) =>
  c.read('/tasks/' + a.task).catch(e => {
    if (e.status === 404) return null;
    throw e;
  });
// A stage can't read the title the row showed, so the sender gives `said` the entry itself (sendAct).
export const changed = what =>
  Object.assign(new ApiError(409, what + ' changed since then'), {
    drop: true,
    said: a => changedSince(a.label || 'it'),
  });
// Whether field `k` has the same value in two copies of a task. Vikunja writes dates and reminders in its own format.
const sameField = (k, x, y) => {
  if (k.endsWith('_date')) return Date.parse(x) === Date.parse(y);
  if (k === 'percent_done') return Math.round((x || 0) * 100) === Math.round((y || 0) * 100);
  if (k !== 'reminders') return x === y;
  const keys = list => JSON.stringify(plainReminders({ reminders: list }).map(reminderKey).sort());
  return keys(x) === keys(y);
};
/* What an Undo sends of `back`, each field's value before the op it undoes, built once from Vikunja's copy when it is
   first sent. A field Vikunja still has as the op left it (`check`) goes back, and a field that has its value before
   needs nothing. Any other value is a change made since, which stays, and the Undo ends as changed since once it has
   sent the rest (`left`). Without `check`, as when this tab never saw the op's answer, any other value counts as a
   change made since. */
export const backOf = (a, c, back, check) =>
  c.once('back', async () => {
    const t = await now(a, c),
      body = {};
    let left = !t;
    for (const [k, v] of Object.entries(t ? back : {}))
      if (check && !sameField(k, t[k], v) && sameField(k, t[k], check[k])) body[k] = v;
      else if (!sameField(k, t[k], v)) left = true;
    if (left && t) c.task = t;
    return { body, left };
  });
