# Single code paths

Several questions in Pocket have more than one answer, depending on which code path asks:

- **How does a change reach Vikunja?** Checklists, adds and deletes go through the outbox. About 50 other places write
  directly. Each kind of change is defined in up to six places across four files.
- **What happens when a reply is lost?** Vikunja's creates aren't safe to send twice, so Pocket guesses after the fact
  (`findSent`, `findCopy`, `findNote`, `hasAttachment`), and resumes multi-step changes stage by stage.
- **Can Undo trust what it puts back?** Two Undos check for a change made elsewhere. The rest don't.
- **What kind of task is this?** Template and checklist are decided by four different tests.
- **Which Today group does a date go in?** The rule is written out six times.
- **What does Pocket say?** Rule 6 puts the words in `messages.js`. About 76 messages are written inline.

This plan gives each question one answer, in one place, and makes lint keep it that way. It is a refactor, not a
feature. Delete each old path in the same phase that replaces it. Keep no shims, and no "legacy" branch beside the new
one, except the one named under Older outbox entries. Read `AGENTS.md` and `docs/development.md` first. Delete this
file when the last phase is done, and move the rules that last into `development.md`.

Line numbers and counts drift. Run the greps given below again before each phase.

## 0. The gate: can the plugin make writes safe to repeat?

Part 1 has two forms. Which one is built depends on a spike that has been written but not yet run.

**The idea.** Pocket's plugin runs inside Vikunja, so it can do what Vikunja's API can't. Each change Pocket makes is
sent to the plugin with a key. The plugin runs the whole change in one database transaction and stores its reply under
(user, key) in the same transaction. A request sent again with the same key gets the stored reply and changes nothing.
So a lost reply is never a guess, and a change either happened in full or not at all.

**What reading Vikunja 2.7's source established:**

- A plugin can register routes that need the user to be signed in (`NewAuthenticatedRouterPlugin`), at
  `/api/v1/plugins/...`. It can add tables of its own (`NewMigrationPlugin`), and Vikunja runs their migrations at
  start.
- Under Yaegi a plugin can call only what `pkg/yaegi_symbols` exposes. That includes `db.NewSession`,
  `events.DispatchPending` and `CleanupPending`, `user.GetCurrentUserFromDB`, and the model types Pocket needs:
  `Task`, `TaskComment`, `LabelTaskBulk`, `BulkAssignees`, `TaskRelation`, `Reaction`, `TaskAttachment`,
  `BulkTaskCreation`. Their `CanCreate`, `Create`, `CanUpdate` and `Update` methods come with them.
- `handler.DoCreate`, which Vikunja's own API uses, is not exposed. A plugin repeats its five steps instead: open a
  session, check `CanCreate`, `Create`, commit, then `DispatchPending`. Events (webhooks, notifications, mentions) are
  queued inside the model methods and sent on commit, so a plugin that does this sends them as the API would.
- The `Create` and `Update` signatures haven't changed since v1.0. Vikunja's API calls every model through them.

**The spike** is on the branch `spike/keyed-create`. `pocket/keyed.go` adds one route, a keyed task create, and the
`pocket_keys` table. `scripts/spike-keyed.mjs` checks it against `npm run dev`:

1. a keyed create makes a task;
2. the same key returns the same task and makes no second one;
3. five requests with one key at the same moment make one task;
4. a project the user can't write to is refused, and nothing is created;
5. events fire: a mention in the description notifies the mentioned user;
6. what an API token gets when it calls the route (reported, not checked).

**Open questions the spike answers:**

- Do the model calls run under Yaegi as they do compiled?
- Can an API token reach a plugin route? Vikunja limits a token to the routes its permissions list. If plugin routes
  can't be listed, Pocket's API-token sign-in can't use the plugin, and that sign-in needs the fallback.
- Does the plain-SQL table work on SQLite, Postgres and MySQL? The spike uses SQL rather than a Go struct, because a
  struct defined in the plugin is a type Yaegi makes at runtime, and xorm may not read it.

**If checks 1 to 5 pass,** build part 1 with the plugin (1A). **If any fails,** build part 1 with Vikunja's v2
endpoints (1B). Either way, parts 2 to 5 and the op registry are the same.

## 1. Every change is an op, sent through the outbox

### The op registry

Each kind of change is one object in `src/js/ops/`, with everything about it in one place. Today one op is spread over
`ACTS` and `ACT_STEPS` (sync.js), `actText` and `dropText` (outbox.js), `actWhat` (runs.js) and `keyWaiting`
(sending.js).

```js
export const due = {
  apply(app, a){ … },             // show the change on screen at once (rule 4)
  invert(a){ … },                 // the op that undoes it, built from what this one recorded (part 2)
  merge(older, newer){ … },       // pruning, below
  waiting: 'dues',                // the key a row reads in `waiting` (rule 10)
  text, refused, dropped,         // the words, from messages.js
  send: …,                        // 1A: the plugin op's name. 1B: the stages, as ACT_STEPS has them now
};
```

A method in `src/js/app/` calls `this.act({op, task, ...})`. Nothing else sends a write. The act sender moves out of
`runs.js` into `app/acts.js`, with `giveBack`. A unit test checks that every op defines every field, so no op is
missing its words in the outbox sheet.

### 1A. With the plugin

- **One route,** `POST /api/v1/plugins/pocket/do`, body `{key, op, args}`. The plugin has one Go function per op. Each
  runs in one transaction, through the model methods and their permission checks, as the spike does.
- **The outbox entry is `{key, op, args}`.** The key is made when the entry is made, so every retry sends the same
  one. There are no stages. An entry is sent until the plugin answers, then removed. `stage`, `tried`, `triedAt`,
  `arriving` and `fails` go.
- **What the plugin's ops do in one transaction,** each replacing client code:

  | Op | Replaces |
  |---|---|
  | `addTask`: a task, its labels and people, its link under a parent, done or progress | `LINE_STEPS`, `createTask`, `findSent`, `claims` |
  | `addTasks`: a pasted list, with its lines under each other | the loop in `sendEntry`, and the progress written afterwards |
  | `startChecklist`: copy, steps, links, order, assignees, unlabel, tick the template | `RUN_STEPS`, `findCopy`, `duplicate` |
  | `insertStep` | `INSERT_STEPS` |
  | `tick` and `untick`: done, the ✅, and the parent's progress | `toggleDone`, `signTick`, `writeFigure`, the repeating-task double tick |
  | `due`, `edit`, `project`, `link`, `unlink`, `assign`, `label`, `delete` | the direct writes in actions.js and sheet.js |
  | `comment` | `findNote` |
  | `undo`: reads, compares and writes back in the transaction (part 2) | `unchanged()` and every undo closure |

- **Attachments** stay on v2's upload with `hasAttachment`, until the spike shows the plugin can take a multipart
  body and store a file through `TaskAttachment`.
- **`api()` calls `/api/v2`.** The plugin is at `/api/v1/plugins`, so `api()` gets an option for that base. It keeps
  signing the request and renewing the session.
- **Keys are kept 30 days,** then deleted by the plugin on start and once a day. An outbox entry still unsent after
  30 days would lose that protection. So it is marked failed instead of sent, and the outbox sheet offers Try again
  or Don't send it, as for any refused change.
- **The trust promise changes.** The plugin now writes what the user does in Pocket, as that user, with Vikunja's own
  permission checks, plus the `pocket_keys` table. Update `main.go`'s header, the Privacy and security section of
  `docs/guide.md`, and the release notes. Admins review the plugin before installing it, so they need to hear this.

### 1B. Without the plugin

The stage machinery stays, and uses v2's endpoints that are safe to send twice:

| v2 endpoint | Replaces |
|---|---|
| `PUT /tasks/{task}/labels/bulk` sets the exact label set | adding labels one by one, and the `ALREADY` codes for them |
| `PUT /tasks/{task}/assignees/bulk` sets the exact assignees | the same for people |
| `PUT /tasks/bulk` applies the same fields to many tasks, all or nothing | Move all as one request per distinct new date |
| `POST /projects/{project}/tasks/bulk` creates up to 100 tasks, all or nothing | a pasted list as one request. A lost reply means finding one batch. |

Creating one task, a comment, a checklist copy and an attachment keep their `find…` checks. So does `done` on a
repeating task. Everything else in this part applies as written.

### What moves

Found with `grep -n "this\.saveTask(\|this\.saveEach(\|this\.save(\|api(.*method\|patchTask(" src/js/app/*.js`.

| Area | Today | Becomes |
|---|---|---|
| Tick, untick, progress | `toggleDone`, `tickRunStep`, `tickRunTask`, `arrivedDone`, `setProgress`, `sheetDone`, `sheetProgress`, `closeSubtasks`, `reopen`, `writeFigure` | `tick`, `untick`, `progress`. A plain task gets the ✅ as a step does, wherever it was ticked, including `x` lines in quick add. |
| Dates | `reschedule`, `moveOverdueToToday`, `undoMoves`, the sheet's date and repeat edits | `due`, `repeat` |
| Sheet fields | `save` and its callers (title, priority, notes, reminders) | `edit`. Notes, reminders and step order need the copy Vikunja has now. In 1A the plugin reads it in the transaction. In 1B the op names a rebase kind (`notes`, `reminders`, `order`), because a function can't be stored in IndexedDB. |
| Project | `moveTask` | `project`, with the subtasks, in one op |
| Subtask links | `ownTask`, `linkSubtask` callers | `link`, `unlink` |
| People and labels | `addAssignee`, `removeAssignee`, `addLabelTo`, `removeLabelFrom`, `LINE_STEPS.label`, the template label in checklists.js | `assign`, `label`, each setting the whole set |
| Delete | `deleteTasks`, `deleteTree`, the deletes in runs.js and checklists.js | `delete`, held as now. A template is deleted after its confirm with no hold. |
| Checklists | renames, `saveRun`, the step edits in checklists.js and runs.js, answers in asks.js | the same ops |

`saveTask` and `shared.saveChain` go. In 1B `saveTask` survives as the stage that patches a task, with `landed` and
`rebase`, and nothing else calls it.

### What stays direct

These need Vikunja's answer before anything else can happen, and the user waits for it on screen: signing in
(`auth.js`), creating a project, including the Checklists project (`views.js`, `checklists.js`), renaming, archiving
and deleting a project (`checklists.js`), and seeding the example template (`checklists.js`). Each stays in the lint
allowlist with a comment saying why. Nothing else goes on the list.

### Pruning

`sync.add` coalesces when it queues an op. It only touches entries that haven't been sent (in 1A, never sent. In 1B,
`!stage && !tried`) and aren't held.

- A new `tick` or `untick` on a task cancels an unsent opposite one on that task. Both entries go.
- A new `due`, `progress` or `edit` replaces an unsent op of the same kind on the same task and fields. It keeps the
  oldest `was`, so Undo returns to where the user started.
- Anything else is queued as it is.

Test it in `tests/unit/` with a fake outbox. Ticking and unticking ten times while offline leaves zero or one entry.

### Older outbox entries

Entries an older Pocket saved are in IndexedDB on users' phones, some half sent. They can't be turned into keyed ops
safely, because the old code may have done part of the change already. So the old sender stays for one release, and
sends only entries in the old format. The release after that deletes it. Name the release in the commit that adds the
new format.

### Traps

- **A repeating task ticked twice skips a date.** 1A: the plugin ticks once per key. 1B: the `tick` stage reads
  Vikunja's copy after a cut-off try, as `landed` and `LINE_STEPS.arrive` do now.
- **Ops wait behind a refused op on the same task** (`heldTasks`). Move all queues one op per task, so one refusal
  holds back only that task.
- **Ids not yet sent.** An op on a waiting row has a string task id (`pending-…`). The sender already waits for the
  real id. Every op must handle that.
- **Rows leaving with the batch** (`holdRow`, `markRow`, leaving.js) work as they do now. An op returns once it is
  queued, not once it is sent, so `holdRow` lets go sooner. Check that a ticked row still never jumps.
- **Rule 10.** Every row reads `waiting`. Each op names its key (`ticks`, `pcts`, a new `dues`). Run
  `npm run perf:rows -- counts` before and after.
- **`data-sync`.** The tests wait on `sendState`. It reads `writing`, which `saveTask` counts today. Ops sent outside
  `flush` don't set `flushing`, so the sender must count itself as busy, or the tests read `idle` too early.
- **Yaegi** (1A). Only what `pkg/yaegi_symbols` exposes can be called. Each file in `pocket/` is evaluated on its own,
  in name order, so a file can't use a name another file defines unless that file comes first. Keep the plugin's own
  types out of xorm, and use plain SQL for its table.

## 2. Undo checks before it writes back

About 21 places build an Undo. Two check that the task is as Pocket left it, by calling `unchanged()`: the Undo of a
repeating task's tick (`toggleDone`) and the Undo of date moves (`undoMoves`). Every other Undo writes back blindly:
untick, progress, moving to another project, unlinking a subtask, reopening closed subtasks. An Undo tapped after a
teammate's edit overwrites that edit without saying so.

Found with `grep -n "label: 'Undo'\|const undo\|undo: async" src/js/app/*.js`.

- **Undo is an op,** made by the op's `invert` from what the first op recorded: `was`, the value each field had, and
  `set`, the value it wrote.
- **The check runs when it is sent,** not when it is tapped, so an Undo queued offline is checked against Vikunja's
  copy as it is then. In 1A the plugin reads, compares and writes in one transaction, so nothing can change in
  between. In 1B the stage reads Vikunja's copy first.
- **Per field, not per task.** `unchanged()` compares `updated`, so any edit to any field blocks the whole Undo. A
  field that still has `set` goes back to `was`. A field changed elsewhere is left alone.
- **One message** for a field left alone: "Not undone: “title” has changed since then", on the row, or in the outbox
  sheet if the row is gone.
- **A repeating task's Undo** puts back `due_date`, `start_date`, `end_date` and absolute reminders. Its `set` is
  Vikunja's copy after the tick, because Vikunja moved the dates.

The inline undo closures in `toggleDone`, `arrivedDone`, `reopenedHead`, `undoMoves`, `moveTask` and `ownTask` go, and
so does `unchanged()`.

## 3. One answer to "what kind of task is this?"

- Most of actions, cards and throw ask `hasTemplateLabel(t)`: any task labelled "template", in any project.
- The sheet asks `checklistRole`, which also requires a Checklists project.
- `isTemplate` also requires no parent, and done or dated.
- `withoutTemplates` also matches a parent whose title starts "template:".
- A checklist is `isRun` in some places (open only, any project) and `isRunTask` in others (done or open, Checklists
  project only).

So a plain task labelled "template" in an ordinary project is left out of Move all, gets no ✅, can't be held and
thrown to a date, and never stacks as a card. Its sheet treats it as an ordinary task.

Found with `grep -on "hasTemplateLabel(\|isTemplate(\|isRun(\|isRunTask(\|isRunStepTask(\|stepRun(\|checklistIds.has(" src/js/app/*.js`.

- **One function, `roleOf(t, known)`, in `checklists.js`,** returns `'template'`, `'tplstep'`, `'run'`, `'step'`,
  `'candidate'`, or `null` for an ordinary task. `known` holds what Vikunja leaves out of a related task, such as a
  parent's labels: `cache`, `templatesKept`, and the list on screen.
- **The component asks `this.role(t)`,** a `memo` keyed by task id (rule 10). `checklistRole` becomes
  `this.role(this.sheet.task)`. `stepRun(t)` stays only to find a step's checklist id.
- **The predicates become private** to `checklists.js`: `hasTemplateLabel`, `isTemplateLabel`, `isTemplate`, `isRun`,
  `isRunStepTask`, `isRunDesc`.
- **Tests.** A table in `tests/unit/checklists.test.mjs` with one row per shape: label or not, Checklists project or
  not, a parent or not, done, dated, copied from a template, with a run line. Write it first, against each current
  predicate, so the differences show as failing rows.
- **Decide before building:** a task labelled "template" outside a Checklists project. Recommended: an ordinary task,
  as its sheet treats it now. Then Move all moves it, a tick adds the ✅, and it can stack as a card.

## 4. One rule for Today's groups

The rule that sorts a date into Overdue, Today, Next 7 days or nothing is written out six times: `placeDated`
(alerts.js), `pendingPlace` (sending.js), `placeOnToday` (actions.js), `beyond()` in `toggleDone` (actions.js) and in
`arrivedDone` (sending.js), and the query range in `loadToday` (views.js). They agree today. A change to one would show
a waiting row in one group and the same task, once sent, in another.

Found with `grep -n "addDays(startOfDay(), 8)\|addDays(t0, 8)\|addDays(t0, 1)\|t1 = " src/js/app/*.js src/js/lists.js`.

- **`dayGroup(due, now)` in `lists.js`** returns `'overdue'`, `'today'`, `'week'`, or `null` for 8 or more days ahead.
  An unset date returns `'nodate'`. `TODAY_DAYS = 8` is exported for `loadToday`'s query.
- **All six places call it.** A card passes its earliest date (`todayAt`) as `due`, as now.
- **Name it `dayGroup`,** not `todayKey`. `todayKey(t)` in actions.js already means the group a task is in on screen.
- **Tests** in `tests/unit/lists.test.mjs`: a task with no time due today is not late until the day ends; a timed task
  is late one minute after its time; a day of 23 and of 25 hours; the last minute of the 7th day; the first minute of
  the 8th.

## 5. What Pocket says lives in `messages.js`

Rule 6 says the words are in `messages.js`. About 76 calls to `say` and `notify` pass inline text, and about 10
`confirm()` calls do too. So the same failure reads differently on different screens. A lost connection is "Not
moved: no connection", "no connection to Vikunja" (`why`) or `netHelp()`, depending on where it happened.

Found with `grep -c "this.say(\`\|this.say('\|this.notify(\`\|this.notify('" src/js/app/*.js` and
`grep -n "confirm(" src/js/app/*.js`.

- **Every user-facing string comes from a function in `messages.js`:** messages, Undo and Try again labels, confirms,
  and what is announced to screen readers (`this.said`).
- **One wording per situation:** a lost connection, "changed since then", a refusal with Vikunja's reason.
- **Text from Vikunja stays escaped.** `errText` escapes it before it is shown with `x-html`. Keep that.
- **This part goes last,** because parts 1 to 4 rewrite many of these calls. From phase 1 on, new code puts its strings
  in `messages.js`, so the sweep has only old strings left.
- **Tests** in `tests/unit/messages.test.mjs` for each new function, singular and plural.

## Enforcing it

`eslint.config.js` already bans `fetch` outside `api.js`. Add the rest the same way. Every selector goes in the
existing `no-restricted-syntax` array, beside the `prefers-reduced-motion` one, because a second entry for the same
rule replaces the first.

| Part | Rule | Off for |
|---|---|---|
| Writes | `no-restricted-syntax`: a call to `api` whose argument object has a `method` property, any call to `patchTask`, calls to `this.saveTask` and `this.saveEach` | `src/js/sync.js`, `src/js/app/acts.js`, and the allowlist |
| Undo | `no-restricted-syntax`: a call to `this.unchanged` | nothing, once `unchanged()` is gone |
| Roles | `no-restricted-imports` with `importNames` for the predicates in `checklists.js` | `src/js/checklists.js` |
| Today's groups | `no-restricted-syntax`: a call to `addDays` whose second argument is the literal `8` | `src/js/lists.js` |
| Messages | `no-restricted-syntax`: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said` | `src/js/messages.js` |

The writes allowlist starts as every file that writes today. Each phase removes the files it finishes. The other rules
are turned on in the phase that finishes their part.

## Phases

Each phase is its own commits on `dev`, and leaves the app working. Each passes `npm run lint`, `npm run test:unit`
and `npm run test:local`. Each phase that moves an op adds a case to `tests/offline.mjs`: make the change offline,
reload Pocket, reconnect, and check Vikunja's copy. In 1A it also sends each op twice with one key and checks that
Vikunja changed once.

0. **The gate.** Run `scripts/spike-keyed.mjs` on the `spike/keyed-create` branch, on SQLite and on Postgres. Record
   the results here, choose 1A or 1B, and delete the branch.
1. **Ground.** The op registry and `app/acts.js`. The writes lint rule with the full allowlist. Nothing the user sees
   changes.
2. **Roles.** Settle the decision in part 3 first. Write the table test, add `roleOf` and `this.role`, move every
   caller, and turn on the roles rule.
3. **Today's groups.** Add `dayGroup`, move all six places, and turn on its rule.
4. **The transport.** 1A: the `do` route, the `pocket_keys` table and key cleanup, `addTask` end to end, and the old
   sender kept for old entries only. 1B: the v2 set-style endpoints.
5. **Dates.** `due`, with Undo checked per field. Delete `undoMoves` and `saveEach`.
6. **Ticks and progress.** One tick for every row, card, sheet and checklist, with pruning. Delete `signTick`,
   `arrivedDone`'s own save, `closeSubtasks` and `reopen`.
7. **Sheet fields, project, links, people, labels.** Delete `save` and the direct calls in sheet.js.
8. **Deletes.** Delete `deleteTasks` and `deleteTree`.
9. **Checklists.** 1A: `startChecklist` and `insertStep` in the plugin. Delete `RUN_STEPS`, `INSERT_STEPS` and
   `findCopy`. Then renames, step edits, answers and template step order. Remove the last non-permanent files from the
   writes allowlist. Delete `unchanged()` and turn on the Undo rule.
10. **Messages.** Move the remaining inline strings to `messages.js` and turn on its rule.
11. **Clean up.** Update `development.md`. Rule 3 becomes "Every change is an op sent through the outbox". Add a rule
    that a task's kind comes from `role()`, and one that Today's groups come from `dayGroup`. Rule 6 now has lint
    behind it. In 1A, add the plugin's ops to the map. Update `docs/guide.md`. Delete this file.
12. **One release later.** Delete the old outbox sender and the old entry format.

## Out of scope

These change what the user sees, so they are discussed before they are built:

- Leaving an Undo gap where a moved row was, instead of an Undo on the row where it lands.
- The time Move all gives a task whose time today has passed. It is now the next whole hour, which can be late again
  when Pocket is reopened.
