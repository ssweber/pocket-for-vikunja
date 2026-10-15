// Claiming a subtask or a step (assigning yourself to it), and letting it go.
import {ApiError} from '../api.js';
import {assignedJustNow, OP_WORDS} from '../messages.js';
import {ALREADY} from '../sync.js';
import {whoOf} from './shown.js';

/* If another user claimed the task in the meantime, that user keeps it. This happens when two users tap at once, or
   when a claim waited offline. Pocket checks before and after assigning. When two users claim at the same moment, the
   one who signed up to Vikunja first (the lower id) keeps it, because both phones make the same choice. The undo of
   Pocket's own assignment depends on the second read, so it is the stage's last request. */
const claimIt = async (a, c) => {
  const others = async () => ((await c.read('/tasks/' + a.task)).assignees || []).filter(u => u.id !== a.user);
  const taken = list => Object.assign(new ApiError(409, assignedJustNow(list.map(u => u.name || u.username))), {drop: true});
  const before = await others();
  if (before.length) throw taken(before);
  await c.send(`/tasks/${a.task}/assignees`, {method: 'POST', body: {user_id: a.user}}).catch(e => { if (e.code !== ALREADY.assignee) throw e; });
  const after = (await others()).filter(u => u.id < a.user);
  if (after.length) { await c.send(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(() => {}); throw taken(after); }
};
const letGo = (a, c) => c.send(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(e => { if (e.status !== 404) throw e; });

export const claim = {apply: (t, a) => ({...t, assignees: [...(t.assignees || []).filter(u => u.id !== a.user), whoOf(a)]}), stages: [claimIt],
  invert: null, merge: null, ...OP_WORDS.claim};
export const unclaim = {apply: (t, a) => ({...t, assignees: (t.assignees || []).filter(u => u.id !== a.user)}), stages: [letGo],
  invert: null, merge: null, ...OP_WORDS.unclaim};
