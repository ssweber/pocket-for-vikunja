# One write path

Every change Pocket makes in Vikunja goes through the outbox. Today about 50 places write directly, with `saveTask`,
`patchTask` or `api()` with a method. They skip what the outbox gives: the change survives a closed app, waits
offline, is sent in order, and is retried. Ticking and moving dates behave differently from checklist steps for no
reason the user can see.

This plan is a refactor, not a feature. Delete each old path in the same phase that replaces it. Keep no shims, and
no "legacy" branch beside the new one. Read `AGENTS.md` and `docs/development.md` first. Delete this file when the
last phase is done, and move the rules that last into `development.md`.

## The end state

- **One way to change a task.** A method in `src/js/app/` calls `this.act({op, task, ...})`. Nothing else sends a
  write. `sync.js` defines each op's stages (`ACTS`, `ACT_STEPS`). The act sender is generic, so it moves out of
  `runs.js` into its own file, `app/acts.js`, with `actWhat`, `giveBack` and `wordsBack`.
- **One way to show it.** An act changes the screen at once (rule 4). The row looks waiting after `WAIT_MS`, read by
  task id through `waiting` (rule 10). A refusal says so on the row, or in the outbox sheet if the row is gone.
- **One Undo.** Undo is another act, made from what the first act recorded (`was`). There is one helper for it. The
  inline undo closures in `toggleDone`, `arrivedDone`, `reopenedHead` and `undoMoves` go.
- **One tick.** `toggleDone`, `tickRunStep`, `tickRunTask` and `arrivedDone` become one tick that queues `done` or
  `undone`. A checklist step adds `mark` and `figure` stages, as now. A plain task gets `mark` too, so every tick
  puts the user's ✅ on, wherever it was made. `signTick` and its separate `marks` chain go.
- **One delete.** Deleting goes through the held `delete` act. `deleteTasks` (Undo of an add), `deleteTree`, and
  the deletes in `runs.js` and `checklists.js` use it too.
- **One label and one assignee add.** `LINE_STEPS.label`, `addLabelTo` and the template-label code in
  `checklists.js` share one function, which creates the label when it is missing. The same goes for assignees.
- **Lint enforces it.** See Enforcing it.

`saveTask` stays only as the act stage that patches a task. It keeps the lost-reply check (`landed`) and the
`rebase` form. No other code calls it.

## What moves

Found with `grep -n "this\.saveTask(\|this\.saveEach(\|this\.save(\|api(.*method\|patchTask(" src/js/app/*.js`.
Run it again before starting. Line numbers drift.

| Area | Today | Becomes |
|---|---|---|
| Tick, untick, progress | `toggleDone`, `setProgress`, `sheetDone`, `sheetProgress`, `closeSubtasks`, `reopen`, `writeFigure` (actions.js) | `done`, `undone`, `progress` acts, with `figure` as their last stage. Closing subtasks with their parent is one act with `ids`. |
| Dates | `reschedule`, `moveOverdueToToday`, `undoMoves` (actions.js), date and repeat edits (sheet.js) | `due` act carrying `{due_date, was}`. A repeat change is a `repeat` act. |
| Sheet fields | `save` and its callers in sheet.js (title, priority, notes, reminders) | One `edit` act with the changed fields. Notes, reminders and step order need the copy Vikunja has now, so their act names a rebase kind (`notes`, `reminders`, `order`), and the stage applies it at send time. A function can't be stored in IndexedDB. |
| Project | `moveTask` (actions.js) | `project` act with `ids` for the subtasks, in one entry. |
| Subtask links | `ownTask`, `linkSubtask` callers | `unlink` and `link` acts. |
| People and labels | `addAssignee`, `removeAssignee`, `addLabelTo`, `removeLabelFrom` | `assign`, `unassign`, `label`, `unlabel` acts. The `claim` act stays for claiming. |
| Delete | `deleteTasks`, `deleteTree`, deletes in runs.js and checklists.js | The held `delete` act. A template is deleted without a hold, after its confirm, by queuing the act with no `until`. |
| Checklists | renames, `saveRun`, the step edits in checklists.js and runs.js, answers in asks.js | The same acts. A template step's order is the `order` rebase. |

### What stays direct

These need Vikunja's answer before anything else can happen, and the user waits for it on screen:

- signing in (`auth.js`),
- creating a project, including the Checklists project (`views.js`, `checklists.js`),
- renaming, archiving and deleting a project (`checklists.js`),
- seeding the example template (`checklists.js`).

Each stays in an allowlist with a comment saying why. Nothing else goes on the list.

## Pruning

`sync.add` coalesces when it queues an act. It only touches entries that haven't started (`!stage && !tried`) and
aren't held.

- A new `done` or `undone` on a task cancels an unsent opposite tick on that task. Both entries go, and nothing is
  sent.
- A new `due`, `progress` or `edit` replaces an unsent act of the same op on the same task and fields. It keeps the
  oldest `was`, so Undo returns to where the user started.
- Anything else is queued as it is.

Test it in `tests/unit/` with a fake outbox. Ticking and unticking ten times while offline leaves zero or one entry.

## Traps

- **A repeating task ticked twice skips a date.** The `done` stage must check Vikunja's copy after a cut-off try,
  as `landed` and `LINE_STEPS.arrive` do now. The act stage `done` doesn't check this today, because steps never
  repeat.
- **Acts wait behind a refused act on the same task** (`heldTasks`). Move all queues one act per task, so one refusal
  holds back only that task.
- **Entries from an older Pocket** are already in IndexedDB on users' phones. Every existing `kind` and `op` must
  still send. Add new ops, never rename old ones.
- **Ids not yet sent.** An act on a waiting row has a string task id (`pending-…`). `sendAct` already waits for the
  real id. Every new op must handle that.
- **The ✅ needs order.** A slow untick's ✅ request must not land after the next tick's. Acts are sent in order, so
  this holds once `signTick` is gone. Don't add a second chain.
- **Rows leaving with the batch** (`holdRow`, `markRow`, leaving.js) work as they do now. An act returns once it is
  queued, not once it is sent, so `holdRow` lets go sooner. Check that a ticked row still never jumps.
- **Rule 10.** Every row reads `waiting`. Add a key per op the row shows (`ticks`, `pcts`, a new `dues`), written by
  `keyWaiting`. Run `npm run perf:rows -- counts` before and after.
- **`data-sync`.** The tests wait on `sendState`. It reads `writing`, which `saveTask` counts today. Acts sent by
  `sendActs` don't set `flushing`. So the act sender must count itself as busy, or the tests read `idle` while a
  change is still on its way.
- **Messages.** Wording lives in `messages.js`. A refused act's text comes from `actWhat`. Add an entry for each new
  op, and a `dropText` for the outbox sheet.

## Enforcing it

Extend `eslint.config.js` the way it already bans `fetch`. Add `no-restricted-syntax` selectors for:

- `CallExpression[callee.name='api']` whose argument object has a `method` property,
- any call to `patchTask`,
- `this.saveTask(` and `this.saveEach(`.

The selectors go in the existing `no-restricted-syntax` array, beside the `prefers-reduced-motion` one, because a
second entry for the same rule replaces the first. Turn the rule off for `src/js/sync.js`, `src/js/app/acts.js` and
the allowlist. The allowlist starts as every file that writes today. Each phase removes the files it finishes. When
only the permanent exceptions are left, the inconsistency can't come back.

## Phases

Each phase is its own commits on `dev`, and leaves the app working. Each passes `npm run lint`, `npm run test:unit`
and `npm run test:local`. Each adds a case to `tests/offline.mjs` for every op it moves: make the change offline,
reload Pocket, reconnect, and check Vikunja's copy.

1. **Ground.** Move the act sender into `app/acts.js`. Add the lint rule and the full allowlist. Nothing the user sees
   changes.
2. **Dates.** `due` act. Move `reschedule`, `moveOverdueToToday` and the sheet's date edits to it. Undo becomes a
   `due` act back to `was`. Delete `undoMoves` and `saveEach`.
3. **Ticks and progress.** One tick for every row, card, sheet and checklist. `x` lines in quick add queue the same
   `done` act once their task exists, so they get the ✅ even off screen. Add pruning. Delete `signTick`,
   `arrivedDone`'s own save, `closeSubtasks` and `reopen`.
4. **Sheet fields, project, links, people, labels.** The `edit` act with rebase kinds, `project`, `link`, `unlink`,
   `assign`, `unassign`, `label`, `unlabel`. Delete `save` and the direct calls in sheet.js.
5. **Deletes.** Every delete through the `delete` act. Delete `deleteTasks` and `deleteTree`.
6. **Checklists.** Renames, step edits, answers and template step order. Remove the last non-permanent files from the
   allowlist. `saveTask` is now called only from `acts.js`.
7. **Clean up.** Update `development.md`: rule 3 becomes "Every change goes through the outbox as an act". Update the
   table of where things are. Delete this file.

## Out of scope

These change what the user sees, so they are discussed before they are built:

- Leaving an Undo gap where a moved row was, instead of an Undo on the row where it lands.
- The time Move all gives a task whose time today has passed. It is now the next whole hour, which can be late again
  when Pocket is reopened.
