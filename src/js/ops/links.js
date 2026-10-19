/* Making a task a subtask of another (`link`), and taking it out of one (`unlink`). Each changes the related tasks of
   the subtask (`task`) and of its parent (`up`), and `figure` writes the parent's progress last. Each is the other's
   Undo. */
import { ALREADY, CANCEL } from '../sync.js';
import { OP_WORDS } from '../messages.js';
import { changed, figure, now } from './stages.js';

// The ids of task `t`'s parents, sorted, so two lists compare as sets.
const parentsOf = t => (t?.related_tasks?.parenttask || []).map(p => p.id).sort((x, y) => x - y);
// The parents `ids` once task `up` is added to them, or taken out.
const withParent = (ids, up, add) => [...ids.filter(id => id !== up), ...(add ? [up] : [])].sort((x, y) => x - y);
const same = (x, y) => x.join() === y.join();
// `list` with `item` in it or out of it, by id. A list that already is so stays the same object.
const toggled = (list, item, add) => {
  const has = (list || []).some(s => s.id === item.id);
  if (add) return has ? list : [...(list || []), item];
  return has ? list.filter(s => s.id !== item.id) : list;
};
// The task with the link made or taken out: the subtask's parents, or the parent's subtasks.
const relink = add => (t, a) => {
  const [k, item] =
    t.id === a.task
      ? ['parenttask', { id: a.up, title: a.over }]
      : t.id === a.up
        ? ['subtask', { id: a.task, title: a.label }]
        : [];
  const list = k && toggled(t.related_tasks?.[k], item, add);
  return !k || list === t.related_tasks?.[k] ? { ...t } : { ...t, related_tasks: { ...t.related_tasks, [k]: list } };
};

/* Vikunja may already have what the request asks: it answers a link it has with 4008, and an unlink of a relation it
   doesn't have with 404. Then the subtask is read, for the op's answer and for its Undo's check. An Undo (`check`, the
   parents Vikunja's subtask had once the op it undoes was made) sends its request only while the subtask still has
   those parents. A subtask that has the parents the Undo gives it needs nothing. Any other parents are a change made
   since, which stays. */
const relate = add => async (a, c) => {
  const go =
    !a.check ||
    (await c.once('back', async () => {
      const t = await now(a, c),
        have = parentsOf(t);
      if (t) c.task = t;
      return t && same(have, a.check) ? 'send' : t && same(have, withParent(a.check, a.up, add)) ? 'back' : 'changed';
    }));
  if (go === 'changed') throw changed('it has');
  if (go === 'back') return;
  if (add)
    await c.app.linkSubtask(a.up, a.task, c.send).catch(e => {
      if (e.code !== ALREADY.link) throw e;
    });
  else
    await c.send(`/tasks/${a.up}/relations/subtask/${a.task}`, { method: 'DELETE' }).catch(e => {
      if (e.status !== 404) throw e;
    });
  c.task = await c.read('/tasks/' + a.task);
};

/* `over` is the parent's title, for the words and the rows, and `was` the subtask's parents before, for its Undo. A link
   and an unlink of the same two tasks cancel out while neither is sent. A task deleted in Vikunja since drops the op. */
const linkOp = add => ({
  apply: relink(add),
  on: a => [a.task, a.up],
  stages: [relate(add), figure],
  invert(a) {
    if (!a.was && !a.got?.task) return null;
    const left = a.got?.task ? parentsOf(a.got.task) : withParent(a.was, a.up, add);
    return { op: add ? 'unlink' : 'link', task: a.task, up: a.up, over: a.over, was: left, check: left };
  },
  merge: (older, newer) => (older.op === (add ? 'unlink' : 'link') && older.up === newer.up ? CANCEL : null),
  refusal: (a, e) => (e?.status === 404 ? 'dropped' : 'kept'),
  ...OP_WORDS[add ? 'link' : 'unlink'],
  asks: ['up', 'check'],
  saw: ['label', 'over', 'was'],
  keepReads: null,
  waiting: null,
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
});
export const link = linkOp(true);
export const unlink = linkOp(false);
