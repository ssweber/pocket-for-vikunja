// Claiming a subtask or a step (assigning yourself to it), letting it go, and assigning anyone or unassigning them.
import { ApiError } from '../api.js';
import { assignedJustNow, OP_WORDS } from '../messages.js';
import { ALREADY, CANCEL } from '../sync.js';
import { setOne } from './stages.js';
import { whoOf } from './shown.js';

/* If another user claimed the task in the meantime, that user keeps it. This happens when two users tap at once, or
   when a claim waited offline. Pocket checks before and after assigning. When two users claim at the same moment, the
   one who signed up to Vikunja first (the lower id) keeps it, because both phones make the same choice. The undo of
   Pocket's own assignment depends on the second read, so it is the stage's last request. */
const claimIt = async (a, c) => {
  const others = async () => ((await c.read('/tasks/' + a.task)).assignees || []).filter(u => u.id !== a.user);
  const taken = list =>
    Object.assign(new ApiError(409, assignedJustNow(list.map(u => u.name || u.username))), { drop: true });
  const before = await others();
  if (before.length) throw taken(before);
  await c.send(`/tasks/${a.task}/assignees`, { method: 'POST', body: { user_id: a.user } }).catch(e => {
    if (e.code !== ALREADY.assignee) throw e;
  });
  const after = (await others()).filter(u => u.id < a.user);
  if (after.length) {
    await c.send(`/tasks/${a.task}/assignees/${a.user}`, { method: 'DELETE' }).catch(() => {});
    throw taken(after);
  }
};
const letGo = (a, c) =>
  c.send(`/tasks/${a.task}/assignees/${a.user}`, { method: 'DELETE' }).catch(e => {
    if (e.status !== 404) throw e;
  });

export const claim = {
  apply: (t, a) => ({ ...t, assignees: [...(t.assignees || []).filter(u => u.id !== a.user), whoOf(a)] }),
  stages: [claimIt],
  ...OP_WORDS.claim,
  asks: [],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
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
};
export const unclaim = {
  apply: (t, a) => ({ ...t, assignees: (t.assignees || []).filter(u => u.id !== a.user) }),
  stages: [letGo],
  ...OP_WORDS.unclaim,
  asks: [],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  refusal: null,
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
};

// A person as an entry keeps them: what the words and the rows show.
export const personOf = u => ({ id: u.id, username: u.username || '', name: u.name || '' });
const withPerson = (list, u, add) => [...(list || []).filter(x => x.id !== u.id), ...(add ? [u] : [])];
/* `person` is assigned (`add`) or unassigned, on the people Vikunja has when it is sent (setOne), so a person a teammate
   assigned since stays. `was` is the people the row showed, for Cancel's words when Pocket has no copy. A claim keeps
   its own op, so two people claiming at once still settle on one. Assigning and unassigning one person cancel out
   while neither is sent. Each is the other's Undo. A task deleted in Vikunja since drops the op. */
export const assign = {
  apply: (t, a) => ({ ...t, assignees: withPerson(t.assignees, a.person, a.add) }),
  stages: [setOne('assignees', a => a.person.id)],
  invert: a => ({
    op: 'assign',
    task: a.task,
    person: a.person,
    add: !a.add,
    was: a.got?.task?.assignees ?? withPerson(a.was, a.person, a.add),
  }),
  merge: (older, newer) =>
    older.op === 'assign' && older.person.id === newer.person.id && older.add !== newer.add ? CANCEL : null,
  refusal: (a, e) => (e?.status === 404 ? 'dropped' : 'kept'),
  sheetPlace: 'sheet:props',
  replyOnly: () => ['assignees'],
  ...OP_WORDS.assign,
  asks: ['person', 'add'],
  saw: ['label', 'was'],
  on: null,
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
};
