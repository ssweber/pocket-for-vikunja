/* Every kind of change Pocket sends through the outbox, by name (an entry's `op`). An op has:
   - apply(t, a): the task as it will be once the op is made, as a new object. It changes neither argument.
   - stages: its requests, in order, as `(a, c) => Promise` (ops/stages.js). app/acts.js runs them from `a.stage`.
     A stage's requests and their bodies depend only on the entry and `a.fixed`, so each part number always carries
     the same request, and its key gets the same answer from the relay.
   - invert, merge: the op that undoes it, and how it folds into an earlier op on the same task. Null for now.
   - waiting: which key of the component's `waiting` it sets for its task while it waits (keyWaiting), and to what.
   - text, refused, dropped: its words, from messages.js. */
import {done, doneNote, finish, progress, reopen, skip, undone} from './ticks.js';
import {answer, note} from './comments.js';
import {claim, unclaim} from './people.js';
import {position} from './order.js';
import {del} from './delete.js';

export const OPS = {done, undone, skip, doneNote, note, answer, finish, reopen, progress, claim, unclaim, delete: del, position};
