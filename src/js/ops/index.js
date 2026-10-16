/* Every kind of change Pocket sends through the outbox, by name (an entry's `op`). An op has:
   - apply(t, a): the task as it will be once the op is made, as a new object. It changes neither argument. A row
     shows it while the op waits, and Vikunja's copy takes it when the op is answered (show and answered, tasks.js).
   - on(a): the ids of the tasks it changes, when not just its own (opsId), such as a deleted task's parent.
   - stages: its requests, in order, as `(a, c) => Promise` (ops/stages.js). app/acts.js runs them from `a.stage`.
     A stage's requests and their bodies depend only on the entry and `a.fixed`, so each part number always carries
     the same request, and its key gets the same answer from the relay.
   - invert(a): the fields of the op that undoes entry `a`, from what `a` recorded. Null when it has none.
   - merge(older, newer): the entry that replaces both, when `newer` is queued on the task of `older` before `older`
     has sent anything (fold, app/acts.js), or null when both are sent. An op whose merge is null never folds.
   - waiting: the key of the component's `waiting` that marks the task's rows once the op has waited a while
     (keyWaiting), if the op has one.
   - text, refused, dropped: its words, from messages.js. */
import {done, doneNote, finish, progress, reopen, skip, undone} from './ticks.js';
import {answer, note} from './comments.js';
import {claim, unclaim} from './people.js';
import {position} from './order.js';
import {del} from './delete.js';
import {add} from './add.js';
import {due} from './dates.js';

// Import an op's helpers from here, never from its own file. Imported first, its file would load the other ops while
// stages.js is still loading, and they fail without it.
export {addLines, LINE, madeStage} from './add.js';
export const OPS = {done, undone, skip, doneNote, note, answer, finish, reopen, progress, claim, unclaim, delete: del, position, add, due};
