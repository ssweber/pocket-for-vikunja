// Moving a task to another project, with its subtasks at every level, in one op.
import { OP_WORDS } from '../messages.js';
import { changed, patch } from './stages.js';

// The subtasks the op moves, by id, as numbers.
const subsOf = a => Object.keys(a.subs || {}).map(Number);
// The project the op moves task `id` to.
const target = (a, id) => (id === a.task ? a.pid : a.subs?.[id]);
const read = (c, id) =>
  c.read('/tasks/' + id).catch(e => {
    if (e.status === 404) return null;
    throw e;
  });

/* What an Undo sends, read once from Vikunja's copy of each task when it is first sent. A task still in the project the
   move left it in (`check`) goes back, and a task already back needs nothing. Any other project, or a task deleted
   since, is a change made since, which stays, and the Undo ends as changed since once it has sent the rest (`left`). */
const goingBack = (a, c) =>
  c.once('back', async () => {
    const send = [];
    let left = false;
    for (const id of [a.task, ...subsOf(a)]) {
      const t = await read(c, id);
      if (t && t.project_id === a.check[id]) send.push(id);
      else if (!t || t.project_id !== target(a, id)) {
        left = true;
        if (t && id === a.task) c.task = t;
      }
    }
    return { send, left };
  });

/* The task moves first, in a stage of its own, so Cancel's words can say where it is once a subtask's move is refused
   (a.stage). A subtask deleted since is not an error. */
const moveIt = async (a, c) => {
  if (!a.check || (await goingBack(a, c)).send.includes(a.task)) await patch(a, c, { project_id: a.pid });
};
const moveSubs = async (a, c) => {
  const back = a.check && (await goingBack(a, c));
  for (const id of subsOf(a)) {
    if (back && !back.send.includes(id)) {
      c.skip();
      continue;
    }
    await c.send('/tasks/' + id, { method: 'PATCH', body: { project_id: a.subs[id] } }).catch(e => {
      if (e.status !== 404) throw e;
    });
  }
  if (back?.left) throw changed('its project has');
};

/* `pid` is the task's new project and `subs` each subtask's, by id. What each was in before (`was`) is for its Undo,
   and the projects' titles (`into`, `from`) for its words. A second move of a task replaces one not sent yet, and keeps
   its `was`, so Undo goes back to where the first move began. A task deleted in Vikunja since drops the op. */
export const project = {
  apply: (t, a) => ({ ...t, project_id: target(a, t.id) ?? t.project_id }),
  on: a => [a.task, ...subsOf(a)],
  stages: [moveIt, moveSubs],
  invert(a) {
    if (!a.was) return null;
    const stored = Object.fromEntries(
      [a.task, ...subsOf(a)].map(id => [id, id === a.task ? (a.got?.task?.project_id ?? a.pid) : a.subs[id]]),
    );
    return {
      op: 'project',
      task: a.task,
      pid: a.was[a.task],
      subs: Object.fromEntries(subsOf(a).map(id => [id, a.was[id]])),
      was: stored,
      check: stored,
      into: a.from,
      from: a.into,
    };
  },
  merge: (older, newer) =>
    older.op === 'project'
      ? {
          ...newer,
          subs: { ...older.subs, ...newer.subs },
          was: { ...newer.was, ...older.was },
          from: older.from,
        }
      : null,
  refusal: (a, e) => (e?.status === 404 ? 'dropped' : 'kept'),
  sheetPlace: 'sheet:props',
  ...OP_WORDS.project,
  asks: ['pid', 'subs', 'check'],
  saw: ['label', 'was', 'into', 'from'],
  keepReads: null,
  waiting: null,
  cancel: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  putBack: null,
  deletes: null,
  replyOnly: null,
};
