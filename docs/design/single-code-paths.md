# Single code paths

Several questions in Pocket have more than one answer, depending on which code path asks:

- **How does a change reach Vikunja?** Checklists, adds and deletes go through the outbox. About 50 other places write
  directly.
- **Can Undo trust what it puts back?** Two Undos check for a change made elsewhere. The rest don't.
- **What kind of task is this?** Template and checklist are decided by four different tests.
- **Which Today group does a date go in?** The rule is written out six times.
- **What does Pocket say?** Rule 6 puts the words in `messages.js`. About 76 messages are written inline.

This plan gives each question one answer, in one place, and makes lint keep it that way. It is a refactor, not a
feature. Delete each old path in the same phase that replaces it. Keep no shims, and no "legacy" branch beside the new
one. Read `AGENTS.md` and `docs/development.md` first. Delete this file when the last phase is done, and move the rules
that last into `development.md`.

Line numbers and counts drift. Run the greps given below again before each phase.

## 1. Writes go through the outbox

Every change Pocket makes in Vikunja is an outbox entry. Today ticks, progress, dates and sheet edits call `saveTask`,
`patchTask` or `api()` with a method. They skip what the outbox gives: the change survives a closed app, waits
offline, is sent in order, and is retried.

### The end state

- **One way to change a task.** A method in `src/js/app/` calls `this.act({op, task, ...})`. Nothing else sends a
  write. `sync.js` defines each op's stages (`ACTS`, `ACT_STEPS`). The act sender is generic, so it moves out of
  `runs.js` into its own file, `app/acts.js`, with `actWhat`, `giveBack` and `wordsBack`.
- **One way to show it.** An act changes the screen at once (rule 4). The row looks waiting after `WAIT_MS`, read by
  task id through `waiting` (rule 10). A refusal says so on the row, or in the outbox sheet if the row is gone.
- **One tick.** `toggleDone`, `tickRunStep`, `tickRunTask` and `arrivedDone` become one tick that queues `done` or
  `undone`. A checklist step adds `mark` and `figure` stages, as now. A plain task gets `mark` too, so every tick
  puts the user's ✅ on, wherever it was made. `signTick` and its separate `marks` chain go.
- **One delete.** Deleting goes through the held `delete` act. `deleteTasks` (Undo of an add), `deleteTree`, and
  the deletes in `runs.js` and `checklists.js` use it too.
- **One label and one assignee add.** `LINE_STEPS.label`, `addLabelTo` and the template-label code in
  `checklists.js` share one function, which creates the label when it is missing. The same goes for assignees.

`saveTask` stays only as the act stage that patches a task. It keeps the lost-reply check (`landed`) and the
`rebase` form. No other code calls it.

### What moves

Found with `grep -n "this\.saveTask(\|this\.saveEach(\|this\.save(\|api(.*method\|patchTask(" src/js/app/*.js`.

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

### Pruning

`sync.add` coalesces when it queues an act. It only touches entries that haven't started (`!stage && !tried`) and
aren't held.

- A new `done` or `undone` on a task cancels an unsent opposite tick on that task. Both entries go, and nothing is
  sent.
- A new `due`, `progress` or `edit` replaces an unsent act of the same op on the same task and fields. It keeps the
  oldest `was`, so Undo returns to where the user started.
- Anything else is queued as it is.

Test it in `tests/unit/` with a fake outbox. Ticking and unticking ten times while offline leaves zero or one entry.

### Traps

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
- **Messages.** A refused act's text comes from `actWhat`. Add an entry for each new op, and a `dropText` for the
  outbox sheet. Both live in `messages.js` once part 5 is done.

## 2. Undo checks before it writes back

Today about 21 places build an Undo. Two check that the task is as Pocket left it: the Undo of a repeating task's tick
(`toggleDone`) and the Undo of date moves (`undoMoves`). Both call `unchanged()`. Every other Undo writes back blindly:
untick, progress, moving to another project, unlinking a subtask, reopening closed subtasks. An Undo tapped after a
teammate's edit overwrites that edit without saying so.

Found with `grep -n "label: 'Undo'\|const undo\|undo: async" src/js/app/*.js`.

### The end state

- **Undo is an act**, made by one helper from what the first act recorded. The first act records `was`, the value
  each field had, and `set`, the value it wrote.
- **The check runs in the stage, at send time.** An Undo queued offline is checked when it is sent, not when it is
  tapped. The stage reads Vikunja's copy and compares each field with `set`. A field that still has `set` goes back
  to `was`. A field changed elsewhere is left alone.
- **Per field, not per task.** `unchanged()` compares `updated`, so any edit to any field blocks the whole Undo.
  Comparing the fields the act wrote lets an Undo of a date go through after someone edits the title.
- **One message** for a field left alone: "Not undone: “title” has changed since then", on the row, or in the outbox
  sheet if the row is gone. The wording goes in `messages.js`.

The inline undo closures in `toggleDone`, `arrivedDone`, `reopenedHead`, `undoMoves`, `moveTask` and `ownTask` go.
So does `unchanged()`.

### Traps

- **A repeating task's Undo** puts back `due_date`, `start_date`, `end_date` and absolute reminders (`back` in
  `toggleDone`). Its `set` is Vikunja's copy after the tick, not the patch sent, because Vikunja moved the dates.
- **An Undo pruned against its act.** If the first act hasn't started, pruning removes both, and no check is needed.

## 3. One answer to "what kind of task is this?"

Today:

- Most of actions, cards and throw ask `hasTemplateLabel(t)`: any task labelled "template", in any project.
- The sheet asks `checklistRole`, which also requires a Checklists project.
- `isTemplate` also requires no parent, and done or dated.
- `withoutTemplates` also matches a parent whose title starts "template:".
- A checklist is `isRun` in some places (open only, any project) and `isRunTask` in others (done or open, Checklists
  project only).

So a plain task labelled "template" in an ordinary project is left out of Move all, gets no ✅, can't be held and
thrown to a date, and never stacks as a card. Its sheet treats it as an ordinary task.

Found with `grep -on "hasTemplateLabel(\|isTemplate(\|isRun(\|isRunTask(\|isRunStepTask(\|stepRun(\|checklistIds.has(" src/js/app/*.js`.

### The end state

- **One function, `roleOf(t, known)`, in `checklists.js`.** It returns `'template'`, `'tplstep'` (a template's step),
  `'run'` (a checklist), `'step'` (a checklist's step), `'candidate'`, or `null` for an ordinary task. `known` holds
  what Vikunja leaves out of a related task, such as a parent's labels: `cache`, `templatesKept`, and the list on
  screen.
- **The component asks `this.role(t)`**, a `memo` keyed by task id, because many rows read it (rule 10).
- **Every caller compares the role.** `checklistRole` becomes `this.role(this.sheet.task)`. `stepRun(t)` stays only to
  find a step's checklist id, and decides nothing.
- **The predicates become private** to `checklists.js`: `hasTemplateLabel`, `isTemplateLabel`, `isTemplate`, `isRun`,
  `isRunStepTask`, `isRunDesc`. The Vikunja-facing code that needs the raw label test (removing the label in
  `RUN_STEPS.unlabel`) lives in `checklists.js` or `sync.js` too.

### Tests

A table in `tests/unit/checklists.test.mjs` with one row per shape: label or not, Checklists project or not, with a
parent or not, done, dated, copied from a template, with a run line. Each row names the role it expects. Write the
table first, against the current behaviour of each predicate, so the differences show as failing rows before you
choose.

### Decide before building

A task labelled "template" outside a Checklists project. Recommended: an ordinary task (`null`), as its sheet treats
it now. Then Move all moves it, a tick adds the ✅, and it can stack as a card. Ask before building this part.

## 4. One rule for Today's groups

The rule that sorts a date into Overdue, Today, Next 7 days or nothing is written out six times:

- `placeDated` (alerts.js) for rows loaded from Vikunja,
- `pendingPlace` (sending.js) for rows waiting to be sent,
- `placeOnToday` (actions.js) after a row is held and thrown to a date,
- `beyond()` in `toggleDone` (actions.js) and in `arrivedDone` (sending.js), for a repeating task's next date,
- the query range in `loadToday` (views.js).

They agree today. A change to one would show a waiting row in one group and the same task, once sent, in another.

Found with `grep -n "addDays(startOfDay(), 8)\|addDays(t0, 8)\|addDays(t0, 1)\|t1 = " src/js/app/*.js src/js/lists.js`.

### The end state

- **`dayGroup(due, now)` in `lists.js`** returns `'overdue'`, `'today'`, `'week'`, or `null` for 8 or more days
  ahead. An unset date returns `'nodate'`. `TODAY_DAYS = 8` is exported for `loadToday`'s query.
- **All six places call it.** A card passes its earliest date (`todayAt`) as `due`, as now.
- **Name it `dayGroup`**, not `todayKey`. `todayKey(t)` in actions.js already means the group a task is in on screen.

### Tests

`tests/unit/lists.test.mjs`: a task with no time due today is not late until the day ends; a timed task is late one
minute after its time; a day of 23 and of 25 hours; the last minute of the 7th day; the first minute of the 8th.

## 5. What Pocket says lives in `messages.js`

Rule 6 says the words are in `messages.js`. About 76 calls to `say` and `notify` pass inline text, and about 10
`confirm()` calls do too. So the same failure reads differently on different screens. A lost connection is "Not
moved: no connection", "no connection to Vikunja" (`why`) or `netHelp()`, depending on where it happened.

Found with `grep -c "this.say(\`\|this.say('\|this.notify(\`\|this.notify('" src/js/app/*.js` and
`grep -n "confirm(" src/js/app/*.js`.

### The end state

- **Every user-facing string comes from a function in `messages.js`**: messages, Undo and Try again labels, confirms,
  and what is announced to screen readers (`this.said`).
- **One wording per situation.** One for a lost connection, one for "changed since then", one for a refusal with
  Vikunja's reason. `why` and `netHelp` become the only sources of the connection wording.
- **Text from Vikunja stays escaped.** `errText` escapes it before it is shown with `x-html`. Keep that in the new
  functions.

### Order

This part goes last, because parts 1 to 4 rewrite many of these calls. From phase 1 on, new code puts its strings in
`messages.js`, so the sweep only has old strings left.

### Tests

`tests/unit/messages.test.mjs` covers each new function, including singular and plural.

## Enforcing it

`eslint.config.js` already bans `fetch` outside `api.js`. Add the rest the same way. Every selector goes in the
existing `no-restricted-syntax` array, beside the `prefers-reduced-motion` one, because a second entry for the same
rule replaces the first.

| Part | Rule | Off for |
|---|---|---|
| Writes | `no-restricted-syntax`: a call to `api` whose argument object has a `method` property, any call to `patchTask`, and calls to `this.saveTask` and `this.saveEach` | `src/js/sync.js`, `src/js/app/acts.js`, and the allowlist |
| Undo | `no-restricted-syntax`: a call to `this.unchanged` | nothing, once `unchanged()` is gone |
| Roles | `no-restricted-imports` with `importNames` for the predicates in `checklists.js` | `src/js/checklists.js` |
| Today's groups | `no-restricted-syntax`: a call to `addDays` whose second argument is the literal `8` | `src/js/lists.js` |
| Messages | `no-restricted-syntax`: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said` | `src/js/messages.js` |

The writes allowlist starts as every file that writes today. Each phase removes the files it finishes. When only the
permanent exceptions are left, the inconsistency can't come back. The other rules are turned on in the phase that
finishes their part.

## Phases

Each phase is its own commits on `dev`, and leaves the app working. Each passes `npm run lint`, `npm run test:unit`
and `npm run test:local`. Each phase that moves an op adds a case to `tests/offline.mjs`: make the change offline,
reload Pocket, reconnect, and check Vikunja's copy.

Roles and Today's groups come first, because the later phases call them. One tick decides by role. A date move places
its row by group.

1. **Ground.** Move the act sender into `app/acts.js`. Add the writes rule with the full allowlist. Nothing the user
   sees changes.
2. **Roles.** Settle the decision in part 3 first. Write the table test, add `roleOf` and `this.role`, move every
   caller, and turn on the roles rule.
3. **Today's groups.** Add `dayGroup`, move all six places, and turn on its rule.
4. **Dates.** The `due` act. Move `reschedule`, `moveOverdueToToday` and the sheet's date edits to it. Undo is a `due`
   act, checked per field. Delete `undoMoves` and `saveEach`.
5. **Ticks and progress.** One tick for every row, card, sheet and checklist. `x` lines in quick add queue the same
   `done` act once their task exists, so they get the ✅ even off screen. Add pruning. Delete `signTick`,
   `arrivedDone`'s own save, `closeSubtasks` and `reopen`.
6. **Sheet fields, project, links, people, labels.** The `edit` act with rebase kinds, `project`, `link`, `unlink`,
   `assign`, `unassign`, `label`, `unlabel`. Delete `save` and the direct calls in sheet.js.
7. **Deletes.** Every delete through the `delete` act. Delete `deleteTasks` and `deleteTree`.
8. **Checklists.** Renames, step edits, answers and template step order. Remove the last non-permanent files from the
   writes allowlist. `saveTask` is now called only from `acts.js`. Delete `unchanged()` and turn on the Undo rule.
9. **Messages.** Move the remaining inline strings to `messages.js` and turn on its rule.
10. **Clean up.** Update `development.md`. Rule 3 becomes "Every change goes through the outbox as an act". Add a rule
    that a task's kind comes from `role()`, and one that Today's groups come from `dayGroup`. Rule 6 now has lint
    behind it. Update the table of where things are. Delete this file.

## Out of scope

These change what the user sees, so they are discussed before they are built:

- Leaving an Undo gap where a moved row was, instead of an Undo on the row where it lands.
- The time Move all gives a task whose time today has passed. It is now the next whole hour, which can be late again
  when Pocket is reopened.
