// The requests several ops share. Each is a stage, `(a, c) => Promise`, which app/acts.js runs with `c`: `c.send` is a
// write with its own key, `c.read` a plain read, and `c.once` a body built once and kept in the entry.
import { ApiError } from '../api.js';
import { changedSince } from '../messages.js';
import { sync } from '../sync.js';
import { TASK } from '../app/tasks.js';
import { DONE_MARK, placeBefore, SKIP_MARK, stepOrder, stepsOf, withOrder } from '../checklists.js';
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
    // When the parent is the op's own task, as for a step added to a checklist, an earlier stage kept an older copy of
    // it as the op's answer, which would take back this progress.
    if (c.task?.id === up) c.task = t;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
};

/* Put one label or person (`kind`, by id) on the task, or take it off (`a.add`), with one request that sends the whole
   set. The set is the one Vikunja has when the op is sent, read once, plus or minus that one. A set built from Pocket's
   copy would remove a label a teammate added since. The task is read afterwards, for the op's answer. An Undo that
   finds the task or the label gone counts it as changed since. */
export const setOne = (kind, idOf) => async (a, c) => {
  const id = idOf(a);
  if (id == null) return;
  const since = e => {
    throw a.undo && e.status === 404 ? changed(`its ${kind === 'labels' ? 'labels' : 'people'} have`) : e;
  };
  const body = await c.once('set', async () => {
    const t = await c.read('/tasks/' + a.task).catch(since),
      others = (t[kind] || []).map(x => x.id).filter(x => x !== id);
    return { [kind]: [...others, ...(a.add ? [id] : [])].map(id => ({ id })) };
  });
  await c.send(`/tasks/${a.task}/${kind}/bulk`, { method: 'PUT', body }).catch(since);
  c.task = await c.read('/tasks/' + a.task);
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
   change made since. A Cancel stage that puts back another task than the op's names it (`id`), and keeps the body
   under its own `name`. */
export const backOf = (a, c, back, check, { id = a.task, name = 'back' } = {}) =>
  c.once(name, async () => {
    const t = await now({ task: id }, c),
      body = {};
    let left = !t;
    for (const [k, v] of Object.entries(t ? back : {}))
      if (check && !sameField(k, t[k], v) && sameField(k, t[k], check[k])) body[k] = v;
      else if (!sameField(k, t[k], v)) left = true;
    if (left && t && id === a.task) c.task = t;
    return { body, left };
  });

/* ---------- shared by the ops that make tasks (runs.js, templates.js) ---------- */
export const notFound = e => {
  if (e.status !== 404) throw e;
};
// Delete task `id`. A task deleted in the meantime is not an error.
export const remove = (c, id) => c.send('/tasks/' + id, { method: 'DELETE', on: { [id]: {} } }).catch(notFound);
/* The stages a cancelled op is sent in: the stages it had sent (`cut` of them), then the ones that take back what it
   made (`undoing`, a list, or a function of the entry giving one). A fresh op that takes back another, such as a
   start's Undo, has only the latter. */
export const cancelledStages = (doing, undoing) => a =>
  a.cancelled
    ? [...doing(a).slice(0, a.cut || 0), ...(typeof undoing === 'function' ? undoing(a) : undoing)]
    : doing(a);
/* Put the step before the step it was inserted at (`before`), in the order of its checklist or template (`task`) as
   Vikunja has it when this stage is first sent, so a step inserted in the meantime stays. If that step was deleted in
   the meantime, or there is none, put it after the step it was inserted under (`after`). */
export async function place(a, c) {
  const body = await c.once('order', async () => {
    const t = await c.read('/tasks/' + a.task);
    if (stepOrder(t.description)?.includes(a.taskId)) return null;
    const after = typeof a.after === 'string' ? sync.taskOf(a.after.replace(/^pending-/, '')) : (a.after ?? null),
      ids = stepsOf(t)
        .map(s => s.id)
        .filter(id => id !== a.taskId);
    return { description: withOrder(t.description, placeBefore(ids, a.taskId, a.before, after)) };
  });
  if (body) await patch(a, c, body);
}
export const unadd = async (a, c) => {
  if (a.taskId) await remove(c, a.taskId);
};
// The step leaves the order line of its checklist or template.
export async function unplace(a, c) {
  const body = await c.once('unorder', async () => {
    const t = await now(a, c),
      ids = stepOrder(t?.description);
    return ids?.includes(a.taskId)
      ? {
          description: withOrder(
            t.description,
            ids.filter(id => id !== a.taskId),
          ),
        }
      : null;
  });
  if (body) await patch(a, c, body);
}
