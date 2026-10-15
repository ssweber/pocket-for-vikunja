# Single code paths

Several questions in Pocket have more than one answer, depending on which code path asks:

- **How does a change reach Vikunja?** Checklists, adds and deletes go through the outbox. 76 lines in `src/js/app/`
  write directly. Each kind of change is defined in up to six places across four files.
- **What happens when a reply is lost?** Vikunja's creates aren't safe to send twice, so Pocket guesses after the fact
  (`findSent`, `findCopy`, `findNote`, `hasAttachment`, `claims`, `landed`).
- **Can Undo trust what it puts back?** Two Undos check for a change made elsewhere. The rest don't.
- **What kind of task is this?** Template and checklist are decided by six different tests.
- **Which Today group does a date go in?** The rule is written out seven times.
- **What does Pocket say?** Rule 6 puts the words in `messages.js`. About 76 messages are written inline.
- **Which copy of a task is right?** A task can be on screen from six copies: `tasks`, `cache`, `sheet.task`, the
  screens saved on the phone, the subtasks inside a task, and `view.run`. Each has its own way of staying current.

This plan gives each question one answer, in one place, and makes lint keep it that way. It is a refactor, not a
feature. Delete each old path in the same phase that replaces it. Nobody uses Pocket yet, so keep no shims, no "legacy"
branch beside the new one, and nothing for data an older Pocket saved. Read `AGENTS.md` and `docs/development.md` first. Delete this file when the last phase is done, and move the rules that
last into `development.md`.

Line numbers and counts drift. Run the greps given below again before each phase.

## 0. Retries without guessing: a keyed relay

Every write Pocket makes goes to Vikunja's `/api/v2` with an `Idempotency-Key` header, following the IETF httpapi
draft. Vikunja doesn't support that header yet. Until it does, Pocket's plugin relays the write:

- Pocket sends the write to `/api/v1/plugins/pocket/v2/<path>` instead of `/api/v2/<path>`, with the key.
- The plugin forwards it to Vikunja's own `/api/v2/<path>`, with the user's `Authorization` header. Vikunja checks
  permissions and sends events exactly as for a direct request.
- The plugin stores Vikunja's answer under (user, key). A request sent again with that key gets the stored answer, and
  Vikunja sees the write once.

When Vikunja supports the header, Pocket sends to `/api/v2` with the same header, and the relay is deleted. Pocket
asks for that upstream with `docs/design/upstream-idempotency-key.md`.

Why a relay and not a plugin that calls Vikunja's models: the relay depends only on the public v2 API, plain
`net/http`, and the plugin system. Permissions and events stay Vikunja's. Its interface is the one
Vikunja would offer, so nothing in Pocket changes when it is removed except the base address.

### What the relay does

As the draft says:

- no key: 400;
- a key whose first request is still running: 409, with `Retry-After`;
- a key reused for a different method, path or body: 422;
- a key already answered: that answer again, with `Idempotent-Replayed: true`. A refusal (4xx) is stored and replayed
  like a success.

And beyond the draft:

- **A 5xx, a 408, a 429 or a failed forward isn't stored,** so the request can be sent again. Vikunja rolls back a request that fails
  that way.
- **The forward doesn't use the request's context.** If the phone hangs up, the write still finishes and its answer
  is stored for the retry.
- **The gap.** The write commits in Vikunja's transaction, and the answer is stored in a second one. If Vikunja stops
  between the two, the key stays pending. A request with that key more than 2 minutes later gets 409 with
  `Idempotency-Unknown: true`. The outbox shows that entry as failed, for the user to send or drop. The window is a few
  milliseconds on the server, against today's window of any dropped connection.
- **The relay decides how long keys are kept,** 30 days for now, and refuses an expired key instead of running it.
  Every key starts with a UUIDv7, which holds the time it was made, and may have more after it
  (`<uuidv7>:<stage>:<part>`, part 1). A key that doesn't start with one gets 400. A key older than the relay keeps keys gets 409 with
  `Idempotency-Unknown: true`, as for the gap. So does a key made more than a day in the future, by a phone whose
  clock is wrong. The outbox has no rule about age of its own, and the relay can change how long it keeps keys
  without breaking old entries. A phone's clock that is a day slow can still slip a key past the check. That margin
  is why the relay keeps keys for weeks, not hours.
- **The table, `pocket_relay`,** is plain SQL that SQLite, Postgres and MySQL accept. A Go struct would be a type Yaegi
  makes at runtime, and xorm may not read it. It holds each stored answer, which includes task content, for 30 days.

### The spike: passed

Run on 2026-10-15 against Vikunja 2.7.0, on Postgres and on SQLite. Every check passed. The checks are now
`tests/relay.mjs`, which `test:local` runs:

1. a relayed create makes a task;
2. the same key gets the stored answer and makes no second task;
3. five requests with one key at the same moment make one task, and the others get 409 or the stored answer;
4. a reused key gets 422, and a missing key 400;
5. a project the user can't write to is refused, the refusal is replayed, and nothing is created;
6. events fire: a mention in the description notifies the mentioned user;
7. a repeating task ticked twice with one key moves on one day, not two;
8. a key older than 30 days, or from 2 days ahead, gets 409 with `Idempotency-Unknown`, and makes nothing. A key that
   isn't a UUIDv7 gets 400, and a key with a stage and part after its UUID is accepted.

The first run didn't load: Vikunja evaluates every `.go` file into one package, so `relay.go`'s second import of
`net/http` was "redeclared". `relay.go` now imports only what `main.go` doesn't (see Yaegi below).

### Traps in the relay

- **Rate limits.** Vikunja's are off unless `ratelimit.enabled` is set. With `ratelimit.kind: user`, the default, a
  relayed write counts twice against its user: once at the relay and once at `/api/v2`. With `ratelimit.kind: ip`,
  every relayed request reaches `/api/v2` from 127.0.0.1, so all users share one limit there. The guide says to use
  `user`, and to allow for the doubling.
- **Two shapes of refusal.** Vikunja's v2 refusals carry their reason in `detail`. The relay's own (400, 409, 422) carry
  it in `message`, as echo writes them. `api()` reads `detail`, then `message`.
- **Where Vikunja listens.** The relay reaches Vikunja at `service.unixsocket` if set, or else `service.interface`,
  with `0.0.0.0` read as 127.0.0.1. A Vikunja that serves TLS itself needs `https` here.
- **MySQL's `TEXT`** holds 64 KB. A large answer, such as a task with many comments, needs `MEDIUMTEXT` there.
- **Body size.** The relay accepts 50 MB, so attachments can go through it. A reverse proxy in front may allow less.
- **Yaegi.** Only what `pkg/yaegi_symbols` exposes can be called, plus Go's standard library. Vikunja evaluates every
  `.go` file in `pocket/` into one package, in name order (`pkg/plugins/yaegi/loader.go`). A file can use what an
  earlier file defines, but can't import a package an earlier file imports. So `relay.go` uses `main.go`'s imports,
  and if `main.go` stops importing one of them, `relay.go` stops loading. `test:local` fails then, because `dev.mjs`
  checks that the plugin loaded. Vikunja asks for `NewPlugin` once, from `main.go`, and for the routes and the table
  from `relay.go`.

## 1. Every change is an op, sent through the outbox

### The op registry

Each kind of change is one object in `src/js/ops/`, with everything about it in one place. Today one op is spread over
`ACTS` and `ACT_STEPS` (sync.js), `actText` and `dropText` (outbox.js), `actWhat` (runs.js) and `keyWaiting`
(sending.js).

```js
export const due = {
  apply(t, a){ … },               // the task as it will be: a task in, a new task out (rule 4, part 7)
  stages: [ … ],                  // the v2 requests, in order, each sent with its own key
  invert(a){ … },                 // the op that undoes it, built from what this one recorded (part 2)
  merge(older, newer){ … },       // pruning, below
  waiting: 'dues',                // the key a row reads in `waiting` (rule 10)
  text, refused, dropped,         // the words, from messages.js
};
```

A method in `src/js/app/` calls `this.act({op, task, ...})`, as a checklist's methods do today. Nothing else sends a
write. The act sender (`act`, `sendActs`, `sendAct`) moves out of `runs.js` into `app/acts.js`, with `giveBack`. A unit
test checks that every op defines every field, so no op is missing its words in the outbox sheet.

Name the requests `stages`, as `ACTS` does (`a.stage`). In the code and on screen a step is a checklist's step.
`LINE_STEPS`, `RUN_STEPS` and `INSERT_STEPS` become the stages of their ops.

`apply` is pure. It reads only the task and the op, and changes neither. The screen shows what `apply` returns
(part 7). An `apply` that changed the screen itself would have to be rewritten for every op when part 7 is built.

### Keys and stages

- **An entry gets a key when it is made,** and each of its requests a key made from it: the entry's key, the stage's
  index, and the part (one step of a checklist being started, one file). So a retry of any request sends the key it
  was first sent with.
- **Stages stay,** because some changes take several requests (a task, then its link under a parent, then its
  progress). But each stage is now one keyed request, sent until it is answered. There is nothing to look for after a
  lost reply. `tried`, `triedAt`, `triedUntil`, `arriving`, `triedSince`, `findSent`, `findCopy`, `findNote`,
  `hasAttachment`, `claims` and `landed` go. `landed` only checks whether a save with a lost reply arrived.
- **A request's body is fixed before it is first sent.** The relay answers 422 to a key sent with a different body.
  A stage whose body depends on Vikunja's copy (a rebase kind, or Undo's check in part 2) reads that copy and builds
  the body once, saves it in the entry, and then sends it. A retry sends the saved body. It never reads again, because
  after a lost reply Vikunja's copy already has the change, and a new body would be refused, or read as a change made
  elsewhere. The stages that read first today: `writeFigure` (a parent's progress), the start's `name` (its number
  among the template's checklists), `unlabel` and `tick` in `RUN_STEPS`, `order` in `INSERT_STEPS`, and `claim`'s
  check for another person.
- **`api()` gets a `key` option.** With a key, it sends to the relay and adds the header. Once Vikunja supports the
  header, the option sends to `/api/v2`, and only that line changes.

### v2's set-style endpoints

`PUT /tasks/{task}/labels/bulk` and `PUT /tasks/{task}/assignees/bulk` set a task's exact labels or people in one
request. They replace adding them one at a time, and the `ALREADY` codes for them. Each is a rebase kind (the people
and labels row below).

Two more were checked on Vikunja 2.7.0 and are left out:

- `PUT /tasks/bulk` applies the same fields to many tasks, all or nothing. Move all stays one `due` op per task. A task
  deleted or refused elsewhere would refuse the whole move, and pruning, Undo and `heldTasks` all work per task.
- `POST /projects/{project}/tasks/bulk` creates up to 100 tasks, all or nothing. It ignores `position` and `labels`,
  so each line that quick add places would need a second request. One keyed create per line is already safe to send
  again, and a second way to create a task is what this plan removes.

### What moves

Found with `grep -n "this\.saveTask(\|this\.saveEach(\|this\.save(\|api(.*method\|patchTask(" src/js/app/*.js`.

| Area | Today | Becomes |
|---|---|---|
| Done, not done, progress | `toggleDone`, `tickRunStep`, `tickRunTask`, `arrivedDone`, `setProgress`, `sheetDone`, `sheetProgress`, `closeSubtasks`, `reopen`, `writeFigure` | `done`, `undone`, `progress`, the act ops of those names. A plain task gets the ✅ as a step does, wherever it was ticked, including `x` lines in quick add. |
| Dates | `reschedule`, `moveOverdueToToday`, `undoMoves`, the sheet's date and repeat edits | `due`, `repeat` |
| Sheet fields | `save` and its callers (title, priority, notes, reminders), and `pendingSaves` (sheet.js) | `edit`. Notes, reminders and step order need the copy Vikunja has now, so the op names a rebase kind (`notes`, `reminders`, `order`) that its stage applies when it is sent. A function can't be stored in IndexedDB. |
| Project | `moveTask` | `project`, with the subtasks, in one op |
| Subtask links | `ownTask`, `linkSubtask` callers | `link`, `unlink` |
| People and labels | `addAssignee`, `removeAssignee`, `addLabelTo`, `removeLabelFrom`, `LINE_STEPS.label` and `.assignee`, `setRunFor`, the template label in checklists.js | `assign`, `label`, each setting the whole set. Both are rebase kinds (`assignees`, `labels`): the stage reads the set Vikunja has, adds or removes the one change, and sends that set. A set built from Pocket's copy would remove a label a teammate added since. `labels/bulk` attaches only labels that exist, so a new label is first created by a keyed `POST /labels` stage. |
| Delete | `deleteTasks`, `deleteTree`, `deleteRun`, `deleteAddedStep`, the deletes in runs.js and checklists.js | `delete`, held as now. A template is deleted after its confirm with no hold. |
| Checklists | `RUN_STEPS`, `INSERT_STEPS`, `saveRunName`, `saveRun`, the step edits in checklists.js and runs.js, answers in asks.js | `startRun` and `addStep`, named after the methods that queue them today, and the same ops as above |
| What `ACTS` already has | `skip`, `doneNote`, `note`, `answer`, `finish`, `reopen`, `claim`, `unclaim`, `position` | The same names, each moved into `src/js/ops/`. `claim` keeps its single `POST` and its check for another person, never the whole set, so two people claiming at once still settle on one. |

`saveTask` and `shared.saveChain` go. Patching a task is a step like any other.

### What stays direct

These need Vikunja's answer before anything else can happen, and the user waits for it on screen: signing in
(`auth.js`), creating a project, including the Checklists project (`views.js`, `checklists.js`), renaming, archiving
and deleting a project, turning checklists on or off for a project (the Checklists mark in its description), and
seeding the example template (all in `checklists.js`). Each stays in the lint
allowlist with a comment saying why. Nothing else goes on the list.

### Pruning

`sync.add` coalesces when it queues an op. It only touches entries that haven't sent a request yet and aren't held.

- A new `done` or `undone` on a task cancels an unsent opposite one on that task. Both entries go.
- A new `due`, `progress` or `edit` replaces an unsent op of the same kind on the same task and fields. It keeps the
  oldest `was`, so Undo returns to where the user started.
- Anything else is queued as it is.

Test it in `tests/unit/` with a fake outbox. Ticking and unticking ten times while offline leaves zero or one entry.

### The outbox's format

The new entry format replaces the old one outright. Raise the IndexedDB version in `sync.open`, and clear the
`outbox`, `files` and `claims` stores in the upgrade. Delete `claims` once nothing reads it, and the code that moves
entries from localStorage. There is no old sender.

### Traps

- **Ops wait behind a refused op on the same task** (`heldTasks`). Move all queues one op per task, so one refusal
  holds back only that task.
- **Ids not yet sent.** An op on a waiting row has a string task id (`pending-…`). The sender already waits for the
  real id. Every op must handle that.
- **Rows leaving with the batch** (`holdRow`, `markRow`, leaving.js) work as they do now. An op returns once it is
  queued, not once it is sent, so `holdRow` lets go sooner. Check that a ticked row still never jumps.
- **Rule 10.** Every row reads `waiting`. Each op names its key (`ticks`, `pcts`, a new `dues`). Run
  `npm run perf:rows -- counts` before and after.
- **`data-sync`.** The tests wait on `syncState` (outbox.js). `saveTask` counts a save in `writing` from the moment it
  is called. An op is counted only once `refreshPending` puts its entry in `unsent`, after `sync.add` has saved it.
  Between the tap and then, `data-sync` reads `idle`. Count the op as busy over that gap, as `cap.busy` and
  `sheet.sub.adding` do for the add boxes.
- **409 from the relay** means wait and send again, after `Retry-After`. With `Idempotency-Unknown`, it means the entry
  is marked failed for the user. Neither is a refusal.

## 2. Undo checks before it writes back

About 21 places build an Undo. Two check that the task is as Pocket left it, by calling `unchanged()`: the Undo of a
repeating task's tick (`toggleDone`) and the Undo of date moves (`undoMoves`). Every other Undo writes back blindly:
untick, progress, moving to another project, unlinking a subtask, reopening closed subtasks. An Undo tapped after a
teammate's edit overwrites that edit without saying so.

Found with `grep -n "label: 'Undo'\|const undo\|undo: async" src/js/app/*.js`.

- **Undo is an op,** made by the op's `invert` from what the first op recorded: `was`, the value each field had, and
  `got`, the value Vikunja stored (as `a.got` holds the position Vikunja kept today). `got` comes from Vikunja's
  answer, not from what Pocket sent, because Vikunja changes some values as it saves them (a description's HTML, a
  date's format). Compared with the value sent, the field would look changed elsewhere.
- **An Undo of an op not yet sent** removes the op from the outbox. Nothing is sent. Pruning already does this for a
  tick and its untick.
- **The check runs when it is sent,** not when it is tapped. Its first step reads Vikunja's copy, so an Undo queued
  offline is checked against the task as it is then.
- **Per field, not per task.** `unchanged()` compares `updated`, so any edit to any field blocks the whole Undo. A
  field that still has `got` goes back to `was`. A field changed elsewhere is left alone.
- **One message** for a field left alone: "Not undone: “title” has changed since then", on the row, or in the outbox
  sheet if the row is gone.
- **A repeating task's Undo** puts back `due_date`, `start_date`, `end_date` and absolute reminders.

The inline undo closures in `toggleDone`, `arrivedDone`, `reopenedHead`, `undoMoves`, `moveTask` and `ownTask` go, and
so does `unchanged()`. So does `untick` (runs.js), the start's Undo for the template it ticked, which checks the
template's date by hand. It becomes the `invert` of the start's `tick` stage.

## 3. One answer to "what kind of task is this?"

- Most of actions, cards and throw ask `hasTemplateLabel(t)`: any task labelled "template", in any project.
- The sheet asks `checklistRole`, which also requires a Checklists project.
- `isTemplate` also requires no parent, and done or dated.
- `withoutTemplates` also matches a parent whose title starts "template:".
- A checklist is `isRun` in some places (open only, any project) and `isRunTask` in others (done or open, Checklists
  project only).
- `hasOwnOrder` treats any task labelled "template", in any project, as ordering its subtasks by its own order line.

So a plain task labelled "template" in an ordinary project is left out of Move all, gets no ✅, can't be held and
thrown to a date, and never stacks as a card. Its sheet treats it as an ordinary task.

Found with `grep -on "hasTemplateLabel(\|isTemplate(\|isRun(\|isRunTask(\|isRunStepTask(\|stepRun(\|checklistIds.has(\|hasOwnOrder(" src/js/app/*.js`.

- **One function, `roleOf(t, known)`, in `checklists.js`,** returns `'template'`, `'tplstep'`, `'run'`, `'step'`,
  `'candidate'`, or `null` for an ordinary task. `known` holds what Vikunja leaves out of a related task, such as a
  parent's labels: `cache`, `templatesKept`, and the list on screen.
- **The component asks `this.role(t)`,** a `memo` keyed by task id (rule 10). `checklistRole` becomes
  `this.role(this.sheet.task)`. `stepRun(t)` stays only to find a step's checklist id.
- **The predicates become private** to `checklists.js`: `hasTemplateLabel`, `isTemplateLabel`, `isTemplate`, `isRun`,
  `isRunStepTask`, `isRunDesc`. `hasOwnOrder` asks `roleOf`. The component's `isRunTask`, `canTick`, `canDelete`,
  `isStepRow` and `withoutTemplates` ask `this.role(t)`.
- **Tests.** A table in `tests/unit/checklists.test.mjs` with one row per shape: label or not, Checklists project or
  not, a parent or not, done, dated, copied from a template, with a run line. Write it first, against each current
  predicate, so the differences show as failing rows.
- **Decided on 2026-10-15:** a task labelled "template" outside a Checklists project is an ordinary task, as its sheet
  treats it now. Move all moves it, a tick adds the ✅, it can be held and moved to a date, it can stack as a card, its
  subtasks follow the List view, and editing its title adds no "TEMPLATE: ".

## 4. One rule for Today's groups

Built.

The rule that sorts a date into Overdue, Today, Next 7 days or nothing is written out seven times: `placeDated`
(alerts.js), `pendingPlace` (sending.js), `placeOnToday` (actions.js), `beyond()` in `toggleDone` (actions.js) and in
`arrivedDone` (sending.js), the query range in `readToday` (views.js), and `urgentFirst` (cards.js), which ranks a
card's subtasks. A change to one would show a waiting row in one group and the same task, once sent, in another. Six
agree today. `urgentFirst` found tomorrow with `day + 864e5`, so on a day of 23 or 25 hours it ranked a task an hour
off. No order on screen changed, because its ranks for dated tasks follow date order. The others used `addDays`.

Found with `grep -n "addDays(startOfDay(), 8)\|addDays(t0, 8)\|addDays(t0, 1)\|t1 = \|864e5" src/js/app/*.js src/js/lists.js src/js/cards.js`.

- **`dayGroup(due, now)` in `lists.js`** returns `'overdue'`, `'today'`, `'week'`, or `null` for 8 or more days ahead.
  An unset date returns `'nodate'`. `TODAY_DAYS = 8` is exported for `readToday`'s query.
- **All seven places call it.** A card passes its earliest date (`todayAt`) as `due`, as now.
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

## 6. Sign in with Vikunja's session only

Built.

Pocket also signs in with an API token. Nobody depends on that, and it costs code in many places: a second sign-in
form, a second way to keep and renew the token, and handling for tokens that lack a permission. Delete it.

Found with `grep -rn "'token'\|API token" src/js src/markup`.

- **Sign-in:** the token tab and form in `markup/login.html`, `submitToken` and the `'token'` method in `auth.js`, and
  `mode` and `token` in `core.js`. A server with no password sign-in shows its single sign-on buttons.
- **Requests:** `tokenWorks` and the 401 that becomes a 403 in `api.js`. `sharedToken` stays. It is Vikunja's own
  session token, which Vikunja's web app also keeps under `token` in localStorage, so the grep finds it too.
- **Missing permissions:** the token wording in `notReordered` (messages.js) and in `sendAct` (runs.js), and
  `accessBlocked` with the "Pocket can't check" path in `canSee` and `LINE_STEPS.prepare`.
- **Docs:** the API tokens section of `docs/guide.md`, and the troubleshooting lines about token permissions.
- **Tests:** the token sign-in and the token-permission cases.
- **How the tests sign in.** Every end-to-end test signs Pocket in on the API token tab (`signIn`, helpers.mjs), and so
  do `scripts/demo.mjs` and `scripts/perf/`. Under `test:local` the token is a session token from `/login`
  (`scripts/dev.mjs`), so the tests' own requests to Vikunja keep working. `signIn` changes to the password form, with
  `VIKUNJA_USER` and `VIKUNJA_PASSWORD`, which `dev.mjs` already sets. A test that signs in as the other user
  (`checklists.mjs`) uses `OTHER_USER` and `OTHER_PASSWORD`. The unit tests' fake component (`fake.mjs`) and
  `auth.test.mjs` run in `'token'` mode, and move to `'session'`. Running the tests against your own server then
  needs a user and password, and the Tests section of `development.md` says so.

## 7. One store: Vikunja's copy, with the outbox on top

A task can be on screen from six copies, and each has its own way of staying current:

- `keep` (tasks.js) writes the fields that changed into `tasks`, and keeps a ticked task done while it leaves.
- `cache` holds Vikunja's last copy, for Undo to compare with and for putting back a failed save.
- `readTask` (actions.js) throws a fetched copy away if a save started during the fetch, counted in `saving`.
- The sheet keeps `sheet.task`, and shows a save's reply only once no other save of the sheet is running
  (`pendingSaves`).
- `keptRows` decides, row by row, whether a saved screen's copy is newer than the one in `tasks`.
- A checklist's screen keeps its checklist and steps in `view.run`.

The roadmap lists these under "Copies of a task that are not the store's yet". This part makes them one store. It
lives in `app/tasks.js`, which already holds one object per task (`keep`). `util.js` already exports a `store`, which
is localStorage, so the file isn't called store.js.

### Vikunja's copies and the waiting ops

- **Vikunja's copies** are the last copy Vikunja gave of each task Pocket has loaded, by id. They replace `cache` and
  the tasks inside the saved screens.
- **The waiting ops** are the ops in the outbox that Vikunja hasn't answered yet (`pending`).
- **A row shows Vikunja's copy with its task's waiting ops applied,** in order, through each op's `apply` (part 1).
  `show(id)` patches this into `tasks[id]` field by field, so a new op on one task reruns only the bindings that read
  the fields it changed (rule 10). Nothing else writes `tasks`.
- **A screen holds ids,** in Vikunja's order, with each waiting task's id where it will be. The saved copy of a screen
  is its ids. The sheet, a card and a checklist's screen read tasks from the store by id.
- **A task is waiting when it has a waiting op.** Nothing else records it.

### Writing Vikunja's copies

- **By field.** Vikunja leaves fields out of a related task, such as a subtask's people and labels. A copy replaces
  only the fields it has. The store records which fields of each task have been loaded, so a row can tell an empty
  field from one never loaded.
- **An op's answer goes into Vikunja's copy, and the op stops waiting, in one change.** If the op stopped waiting
  first, the row would show the old value for a moment.
- **A late read is ignored for a task changed since it started.** A read started before an op was answered may carry
  the task as it was before the op. The store records when the last answer for each task arrived. A read started
  before that leaves the task's copy as it is. `updated` can't decide this alone: ticking a subtask changes the
  parent's ring but not the parent's `updated`. This replaces `readTask` and `saving`.
- **A ticked task stays done while it leaves.** `keep` does this today, for a repeating task whose answer has it open
  at its next date. Once the `done` op stops waiting, the row would reopen. So `show(id)` leaves a task as it is
  while it is leaving done.

### Pruning Vikunja's copies

The store keeps a task's copy while something points to it:

- an id on a kept screen;
- an op in the outbox;
- the task open in the sheet, its parent and its subtasks, and the steps of the checklist on screen.

Everything else is removed. The sweep runs when a fresh load replaces a screen's ids, and once when Pocket opens. A
task Vikunja answers with 404 is removed once no op points to it. `forget`, `forgetTree` and `forgotten` go.

The kept screens are Today, Lists, Checklists and the last 5 projects opened. They bound how many copies are kept, so
nothing expires by age. A project opened rarely loads fresh, as one never opened does now.

A done task stays only while a screen shows it, such as Done today or a checklist finished recently. Pocket can
remove the others at any time, which keeps the list of ids short.

### Keeping the store current

When Pocket comes back to the screen, or the connection comes back, it updates the store with two requests to
Vikunja's own API. No plugin route is needed.

- **Changed tasks.** `GET /tasks?filter=updated > T&expand=reactions`, where T is the time of the last update.
  Vikunja returns each changed task in full, with its `related_tasks`, and the store takes the fields each one has.
  T is on Vikunja's clock (`serverTime`), and a second earlier than the last update started, because Vikunja keeps
  times in whole seconds. A task returned twice does no harm.
- **Removed tasks.** `GET /tasks?filter=id in <the store's ids>&per_page=1`. Vikunja leaves out a task that was
  deleted, or that the user can no longer see. If `total` equals the number of ids, nothing was removed. If it is
  lower, Pocket runs the same query in full and drops the tasks it doesn't return. A task with an op in the outbox
  stays.
- **Each screen's own load still decides which tasks are on that screen,** such as a task that became due today, or a
  project's order. It also writes every task it returns into the store in full, because the changed-tasks query
  misses most of what Pocket shows (below).
- **A parent's ring** comes from the subtask counts in the parent's own copy. It is corrected the next time Pocket
  reads the parent.

Checked on Vikunja 2.7.0 on 2026-10-15:

- **`updated` changes only when a task's own fields change, or a comment is added.** These leave it as it was:
  linking or unlinking a subtask (on either task), ticking a subtask (on the parent), a ✅ or any reaction, labels,
  assignees, a position, an attachment, and the step times Pocket's plugin writes (`main.go` says so). So the
  changed-tasks query catches edits elsewhere to titles, dates, done, progress, notes and priority, and new comments.
  A claim, a ✅, a label or a new subtask made elsewhere shows once a screen that has the task loads again.
  `docs/design/upstream-task-updated.md` asks Vikunja to change that.
- **A field Vikunja wasn't asked for comes back as `null`.** `reactions` is `null` unless the request asks for
  `expand=reactions`. Taking it as "the task has no reactions" would remove every ✅. So the store takes only the
  fields its request asked for, and a list read without `expand=reactions` leaves `reactions` alone.
- **`id in` with `per_page=1`** answers with the right `total`, counting only the tasks that still exist.

**URL length.** The ids go in the URL, and some reverse proxies refuse URLs longer than about 8 KB. Split a long list
of ids across several requests.

**Before building this part,** read Replicache's design doc. Replicache keeps the server's state with pending
mutations on top, and gives each mutation an id so the server applies it once, which is this plan's design. The doc
covers traps this plan hasn't hit yet. One is a reply that arrives after its change was undone. Here, an Undo of an
op already sent is a second op queued after it, so the reply goes into Vikunja's copy and the Undo still applies on
top. Check that holds for every op's `invert`.

### Traps

- **Rule 10.** `show(id)` must write only the fields that changed, and never replace `tasks[id]` with a new object.
  Run `npm run perf:rows -- counts` before and after.
- **Where the copies are kept.** The saved screens are in localStorage, which a screen reads at once. The outbox is in
  IndexedDB, which is asynchronous. Measure the time to the first row before choosing. If IndexedDB delays it, keep
  the copies in localStorage, under the kept screens' bound.
- **Ids not yet sent.** A task waiting to be created has a `pending-…` id and no copy. Its row is the create op
  applied to nothing. When the create is answered, the copy gets the real id, and every screen's ids swap it in the
  same change.
- **Rule 8.** A screen opened from its saved ids draws at once from the copies. The fresh load replaces the ids, and a
  row it adds or removes follows rule 8 as now.
- **The format.** The copies replace the saved screens' format. Clear them on upgrade, as part 1 clears the outbox.

## Enforcing it

`eslint.config.js` already bans `fetch` outside `api.js`. Add the rest the same way. Every selector goes in the
existing `no-restricted-syntax` array, beside the `prefers-reduced-motion` one, because a second entry for the same
rule replaces the first. For the same reason, a file can't turn one selector off with `'off'`: that turns off every
selector in the file, as it does for `util.js` today. Build the array with a function that leaves out the selectors a
file is allowed, and give each file in "Off for" its own array.

| Part | Rule | Off for |
|---|---|---|
| Writes | `no-restricted-syntax`: a call to `api` whose argument object has a `method` property, any call to `patchTask`, calls to `this.saveTask` and `this.saveEach` | `src/js/sync.js`, `src/js/app/acts.js`, `src/js/ops/`, and the allowlist |
| Keys | `no-restricted-syntax`: a call to `api` with a `method` other than `GET` and no `key` | `src/js/api.js`, and the allowlist |
| Undo | `no-restricted-syntax`: a call to `this.unchanged` | nothing, once `unchanged()` is gone |
| Roles | `no-restricted-imports` with `importNames` for the predicates in `checklists.js` | `src/js/checklists.js` |
| Today's groups | `no-restricted-syntax`: a call to `addDays` whose second argument is the literal `8` | `src/js/lists.js` |
| Messages | `no-restricted-syntax`: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said` | `src/js/messages.js` |
| Store | `no-restricted-syntax`: an assignment to a member of `this.tasks`, any use of `this.sheet.task` or `this.view.run`, and an import of `cache` | `src/js/app/tasks.js` |

The writes allowlist starts as every file that writes today. Each phase removes the files it finishes. The other rules
are turned on in the phase that finishes their part.

## Phases

Each phase is its own commits on `dev`, and leaves the app working. Each passes `npm run lint`, `npm run test:unit`
and `npm run test:local`. Each phase that moves an op adds a case to `tests/offline.mjs`: make the change offline,
reload Pocket, reconnect, and check Vikunja's copy. It also sends each request of the op twice with its key, and
checks that Vikunja changed once.

0. **The spike.** Done on 2026-10-15. `relay.go` and `tests/relay.mjs` came from the spike's branch, since deleted.
1. **Ground.** Done, and checked on the user's phone and server on 2026-10-15. Delete API-token sign-in (part 6). The op registry, `app/acts.js`, and the `key` option in `api()`. The
   writes lint rule with the full allowlist. The store's core (part 7) in `app/tasks.js`: Vikunja's copies and the
   waiting ops, with each op's answer written into the copies, and `withWaiting` put on the rows with `keep`. Only the
   ops built from here on use it. Without it, each op in phases 5 to 10 would first change `tasks` itself, and be
   rewritten for part 7. Phase 4 replaces the bridge with rows that read the store.
   Built so far: part 6, `api()`'s `key` option with `uuid7()`, and the writes rule. The registry, with the 13 ops
   `ACTS` had, and `app/acts.js`, which sends every request of an act through the relay with its key. Try again after
   `Idempotency-Unknown` (or any refusal) sends with a new key. IndexedDB is at version 3. The unit tests' fake
   Vikunja has the relay, and `offline.mjs` sends a checklist step's requests twice. The store's core: `opsOn`,
   `withWaiting`, `answered` (an op's answer goes into `cache` as the op leaves `opsOn`) and the bridge (`keyOps`).
   All 13 ops are in `SHOWN_OWN_WAY` (tasks.js), because `cache` and `tasks` still differ in fields no op touches,
   such as `comment_count`. Phase 4 deletes that list, with the bridge. While
   Pocket knows it is offline, `sendAct` doesn't try an act's first request, and `flush` first reads `/user`. Before
   the first op ships, install `relay.go` on the user's own Vikunja and check one relayed create there: that the
   relay reaches Vikunja, and which database it uses.
2. **Today's groups.** Done. Add `dayGroup`, move all seven places, and turn on its rule.
3. **Roles.** Done. Add the table test, `roleOf` and `this.role`, move every caller, and turn on the roles rule.
   `known` also holds the Checklists projects' ids. `isTemplateLabel` stays exported, because it asks about a label.
4. **The store's foundation.** Rows read Vikunja's copy with the waiting ops applied, which `show(id)` patches into
   `tasks[id]`, its only writer. Every read and every direct save writes into the copies by field, so today's
   `saveTask` paths feed the store instead of `tasks`. The sheet and a checklist's screen read their task by id, so
   `sheet.task` and `view.run` go. A late read is ignored as part 7 says, so `readTask` and `saving` go. The bridge's
   `SHOWN_OWN_WAY` and `keep`'s callers go, and so does each of the 13 ops' own way of showing itself where the store
   now shows it (`applyAct`, the acts `workOutRun` lays over a checklist's steps). Measure rule 10 before and after
   (`npm run perf:rows -- counts`). Turn on the store rule, except for `cache`, which phase 11 removes. This is the
   phase most likely to show a problem on the phone, so the user checks it there before phase 5.
5. **Adding tasks.** Quick add and the subtask boxes as keyed ops, with the set-style label and people endpoints.
   Delete `LINE_STEPS`' lost-reply checks, `findSent` and `claims`. Change the outbox's format and clear the old one.
6. **Dates.** `due`, with Undo checked per field. Delete `undoMoves` and `saveEach`.
7. **Ticks and progress.** One tick for every row, card, sheet and checklist, with pruning. Delete `signTick`,
   `arrivedDone`'s own save, `closeSubtasks` and `reopen`.
8. **Sheet fields, project, links, people, labels.** Delete `save` and the direct calls in sheet.js.
9. **Deletes and comments.** Delete `deleteTasks` and `deleteTree`.
10. **Checklists and files.** `startRun` and `addStep` as keyed ops. Delete `findCopy`, `duplicate`'s bookkeeping and
    `hasAttachment`. Then renames, step edits, answers and template step order. Remove the last non-permanent files
    from the writes allowlist, turn on the keys rule, delete `unchanged()` and turn on the Undo rule.
11. **Screens hold ids.** The rest of part 7: the saved screens hold ids, and Vikunja's copies replace their tasks
    (a new format, cleared on upgrade). The sweep prunes the copies, and the two requests in "Keeping the store
    current" update them. Delete `keptRows`, `cache` and `forgotten`, and turn on the store rule in full.
12. **Messages.** Move the remaining inline strings to `messages.js` and turn on its rule.
13. **Clean up.** Update `development.md`. Rule 1 becomes "A task is Vikunja's copy with the outbox's ops applied,
    read from the store by id". Rule 3 becomes "Every change is an op sent through the outbox, each request with a
    key". Add a rule that a task's kind comes from `role()`, and one that Today's groups come from `dayGroup`. Rule 6
    now has lint behind it. Delete "Copies of a task that are not the store's yet" from `roadmap.md`. Update
    `main.go`'s header and the Privacy and security section of `docs/guide.md` for the relay and its table. Delete
    this file.
14. **When Vikunja supports `Idempotency-Key`.** Point `api()`'s `key` option at `/api/v2`, delete `relay.go`, and add
    a migration that drops `pocket_relay`. Raise the minimum Vikunja version.

## Phase 1 in detail

Agreed with the user on 2026-10-15: the store's core goes through `keep` until phase 4, and Try again after
`Idempotency-Unknown` sends with a new key. `api()`'s `key` option and `uuid7()` are built.

### An entry and its keys

- **An entry's `id` is a UUIDv7** (`uuid7()` in sync.js, beside `randomId`). It is the key the relay reads the time
  from. A request's key is `<id>:<stage>:<part>`. No second field holds a key. Waiting rows keep their ids
  (`pending-<id>-<index>`), only longer.
- **The acts' entries keep `kind: 'act'` and `op`** in phase 1. Captures, starts and inserted steps keep their kinds
  and senders until phases 5 and 10 make them ops. Once every kind is an op, `kind` goes.
- **IndexedDB goes to version 3,** and the upgrade clears `outbox`, `files` and `claims`. `start()` loses the code that
  moves entries from localStorage.

### A stage, and the one sender

An op's `stages` is a list of functions `(a, c) => Promise`. `sendOp` (app/acts.js) runs them from `a.stage`, saving
the entry after each:

- `c.send(path, opts)` is `api()` with the next key: the stage's part counter starts at 0 each time the stage runs. A
  stage that sent two of its three requests before a lost reply runs again from the top. Its first two requests get
  their stored answers back from the relay, and the third is sent. So a stage needs no record of its own parts.
- `c.read(path)` is a plain `GET`, never keyed.
- `c.once(name, build)` returns `a.fixed[name]`, or builds it, saves the entry, and returns it. A stage whose body
  depends on a read builds the body in `once`. This is how "a request's body is fixed before it is first sent" is
  kept.
- A part number must always carry the same request. So a stage's requests, and their bodies, depend only on the
  entry and `a.fixed`. A request that a later read decides on goes last in its stage, as `claim`'s undo of its own
  assignment does. Otherwise the part counter could give one key two bodies, and the relay answers 422.

`patiently` stays around each stage: a busy Vikunja is retried, and with keys a retry is safe.

### What `api()` does with a key

- With `key`, it sends to `/api/v1/plugins/pocket/v2<path>` with `Idempotency-Key: "<key>"`. Without, as now. A write
  without a key is a lint error outside the allowlist (the keys rule, turned on in phase 10).
- A refusal's reason is `detail`, then `message` (the relay's own refusals).
- **409 without `Idempotency-Unknown`** (the first request is still running): wait `Retry-After` seconds, at most 3
  times, then treat it as no connection (`passing`), so the entry waits.
- **409 with `Idempotency-Unknown`**: the entry is marked failed, with a message saying Pocket can't tell whether
  the change was made, and the outbox sheet offers Try again and Don't send it. Try again sends the stage with a new
  key: it is the user's call that the change wasn't made.

### The registry

`src/js/ops/` holds one file per area, and `ops/index.js` exports `OPS`, the map from name to op. Phase 1 moves the
ops `ACTS` has (`done`, `undone`, `skip`, `doneNote`, `note`, `answer`, `finish`, `reopen`, `progress`, `claim`,
`unclaim`, `delete`, `position`), with their stages from `ACT_STEPS`, their words from `actText`, `dropText` and
`actWhat`, and their `waiting` key from `keyWaiting`. `ACTS`, `ACT_STEPS`, `actText`, `dropText` and `actWhat` go.
Each op's words come from `messages.js`.

These helpers know nothing of the screen. A stage that needs the component (`figure` calls `writeFigure`) gets it as
`c.app`, as `sync.js` reaches `app` today.

The unit test in `tests/unit/ops.test.mjs` checks every op has every field, and that `apply` returns a new task and
leaves its input alone.

### The store's core, without changing what rows read

`cache` already holds Vikunja's last copy of each task. Phase 1 makes it the store's copies and adds the waiting ops
on top, but rows still read `tasks`, so nothing on screen changes yet:

- `opsOn` (tasks.js): task id → the waiting entries for it, in order, rebuilt in `refreshPending` with `intoKeys`, as
  `waiting` is.
- `withWaiting(id)`: `cache.get(id)` with `opsOn[id]` applied through each op's `apply`.
- When the waiting ops of a task change, `refreshPending` puts `withWaiting(id)` on its rows with `keep`. When an op is
  answered, its answer goes into `cache` and the op leaves `opsOn` in the same call, followed by one `keep`.

Phase 4 finishes the bridge: `show(id)` becomes the only writer of `tasks`, before any op needs the bridge. That
order was chosen on 2026-10-15, after building the bridge showed it was half a store.

**Found while building it:** `keep` replaces the row's task with the whole copy it is given, and deletes the fields
that copy lacks. `cache` and `tasks` come from different reads (a sheet's read has no `comment_count`, a checklist's
has `comments`), so even an op whose `apply` changes nothing would rewrite a row. So every op is in `SHOWN_OWN_WAY`
for now. Phase 4's store writes every copy by field (part 7), so the problem goes with the bridge.

### Sending only when online

A request that fails without an answer may have reached Vikunja, so an op is marked `sent` before its first request,
and from then on can't be dropped or pruned. So that an op made offline stays unsent, Pocket doesn't try an op's
first request while it knows it is offline (`app.offline`, or `navigator.onLine` false). It queues the op, and
`flush` first sends a plain read. Once a read gets through, Pocket is online and sends what waits. Decided with the
user on 2026-10-15.

### What phase 1 leaves alone

Pruning (phase 7), Undo as an op (phase 6), the late-read rule (phase 4) and every direct write outside the acts.

## Phase 4 in detail

Agreed with the user on 2026-10-15, from a map of the code on `dev` after phase 2. `tasks` stays as a patched object,
an edit in the sheet shows on its rows at once, the upgrade clears the saved screens, and the phone check comes once,
after 4d.

### What the code does today

- `tasks[id]` is one object per task. Rows, `view.groups`, Undo's closures and the gestures hold that object itself.
  About 40 places write its fields before a save answers, such as `t.done = true` in `toggleDone`. `keep` patches it
  field by field, so a change reruns only the bindings that read that field.
- `cache` is a plain `Map`. Most reads put their answer in it whole. So the sheet's read drops `comment_count`, and a
  list read without `expand=reactions` sets `reactions` to `null`. The checklists' read doesn't write `cache` at all.
- `sheet.task` is a shallow copy from `cache`, and `view.run` holds plain copies of a checklist and its steps. Neither
  is the object a row holds.
- `answered` writes an op's answer into `cache` only for the stages that patch a task. A claim, a comment, a ✅ and a
  delete never update it.

### `tasks` stays, with one writer

Part 7 says rows read a `memo` per id and `tasks` goes. Instead, `tasks[id]` stays the object rows hold, and one
function, `show(id)`, is the only code that writes it. `show(id)` works out how the task should look and patches
`tasks[id]` field by field, as `keep` does now. The task is Vikunja's copy, then the waiting ops applied through each
op's `apply`, then the direct saves still running (below).

A memo returns a new object on each change. That reruns every binding on the row, about 30, instead of the changed
field's. It also breaks `g.tasks.includes(t)` and `sameList`, and leaves every closure that holds a task with an old
one until phase 11 makes screens hold ids. A patched object keeps all of those working, and the unit tests need no
Alpine to check it. It is the bridge (`keyOps`), finished.

`show(id)` runs whenever one of its inputs for that id changes. A copy is written, an op is added, answered or
dropped, a direct save starts or ends, or a batch clears.

### Writing Vikunja's copies

- **One writer, `put(list, asked)`.** Every read and every reply goes through it, the checklists' read included.
  `asked` names the fields the request can be trusted for. A field outside it is left as it is in the copy. A task's
  own fields are trusted by default. `reactions`, `comment_count` and `comments` are trusted only when the request
  expanded them. A PATCH reply is not trusted for `labels`, `assignees` or `reactions`. The build checks each
  request against Vikunja 2.7 and writes its list beside the read.
- A trusted `null` is taken as it is. A full read gives `labels: null` for a task with no labels, so "keep the old
  value for a `null`" would never remove the last label.
- **A copy holds only Vikunja's fields.** Pocket's own fields on a row (`pending`, `parent`, `was`, `place`) move to
  maps by id beside the store.
- `show` copies nested values into `tasks`, so writing a row never changes Vikunja's copy.
- `cache` becomes `copies`, read through `copyOf(id)` outside tasks.js.

### Direct saves, until their phase makes them ops

Each remaining direct save goes through `edit(id, fields)`. It lays `fields` on top of the task, in memory only, and
returns `ok(answer)` and `undo()`. `ok` writes the answer with `put` and removes the fields in one call to `show`.
`undo` removes them, for a failed save. A failed save then puts back only its own fields. Today the sheet's `save`
puts back all of `cache`, and loses the user's other unsaved edits.

Every direct field write in the map becomes an `edit`, including those in actions.js, sending.js and on the sheet's
subtask stubs. The store rule catches an assignment to a member of `this.tasks`. A write through a variable such as
`t.done = …` it can't see, so the build finds those by grep and lists them in its report.

### An op's answer

When an op is answered, its task's copy becomes `apply(copy)`, takes the fields its reply is trusted for, and the op
leaves `opsOn`, all in one call to `show`. Vikunja did what the op asked, so its copy now has it. This covers the ops
whose reply is not a task, such as a claim, a comment or a ✅.

### Each op shows itself through `apply`

`apply` grows to show what each op's own way shows today, so `workOutRun`'s overlay, `applyAct` and `SHOWN_OWN_WAY`
go.

- `done`, `doneNote` and `skip` set done, `done_at` to the op's time, and add the user's ✅ or ⏭️ to `reactions`.
- `undone` reopens the task and removes the user's ✅ and ⏭️.
- `note`, `answer` and `doneNote` add their comment to `comments`, marked as waiting.
- `claim` adds the user as `/user` gave them, name included.
- `progress`, `finish` and `reopen` stay as they are.
- `delete` removes its tasks from the rows and from their parent's subtasks, so `deleting` goes. A delete's list of
  tasks (`taskTree`) reads the store, so a subtask already being deleted is neither counted nor asked about. The
  `figure` stage skips a parent with a waiting delete. Found on the phone on 2026-10-15. The user swiped a subtask on
  Today, then its parent. Pocket asked to delete both, and the subtask's delete failed when it read the parent's
  progress after the parent had gone.
- `position` keeps its own way, because a position belongs to a project's view, not to a task.

`waiting.ticks`, `waiting.pcts` and `waiting.claims` go where a row can read the task instead. The waiting and slow
marks stay, because they describe the outbox entry, not the task.

### A late read

The store records when the last answer for each task arrived, from an op or a direct save. A read started before that
leaves the task's copy as it is. A read that lands while an op is still waiting needs nothing more. The op stays
applied on top until it is answered, and its answer is written after the read. `readTask`, `saving` and
`pendingSaves` go.

### Leaving done

While a task is leaving done, `show(id)` leaves `tasks[id]` as it is, as `keep` does today. All its fields stay, not
only `done`. A repeating task's answer moves its due date, and the row would jump to another group as it leaves.
Clearing the batch calls `show(id)`.

### Saved screens

A screen is saved from Vikunja's copies, not from its rows, so a saved task never carries a waiting op's effect. When
Pocket opens, a saved copy goes into the store where it is newer by `updated` than the copy there, or there is none,
as `keptRows` decides today. The old saved screens hold rows with waiting ops' effects in them, so the upgrade clears
them, as phase 1 cleared the outbox.

### The sheet and a checklist's screen, by id

`sheet.task` becomes `sheet.id`, and the sheet reads `tasks[sheet.id]`. A task opened from search or a link is put in
the store first. `view.run` keeps `at`, `last` and the steps' order, and holds the checklist's id and its steps' ids.
A subtask stays nested in its parent's copy (`related_tasks`), as now. Phase 11 decides whether it gets its own copy.

What the user sees change: an edit in the sheet shows on the row behind it at once, not when Vikunja answers.

### Waiting creates

`pendingTasks` keeps one object per waiting row, by entry, so a group with a waiting row compares as unchanged.
Phase 5 makes creates ops.

### Order of work

Four commits, each leaving the app working and passing the full `test:local`, so a problem found on the phone can be
bisected. The user checks the phone once, after 4d.

- **4a. The copies.** `put` and each read's trusted fields, Pocket's own fields off the copies, `copies` for `cache`,
  and screens saved from the copies. Nothing on screen changes.
- **4b. One writer.** `show`, `edit`, every direct field write moved, and the late-read rule. `readTask`, `saving`,
  `pendingSaves` and `keep`'s callers go. The store rule is on, except for `this.sheet.task`, `this.view.run` and
  `cache`. Measure rule 10.
- **4c. Ops through `apply`.** An op's answer, the grown `apply`s, and `workOutRun`'s overlay, `applyAct` and
  `SHOWN_OWN_WAY` gone, and deletes shown by the store. This fixes the dropped tick that stays ticked. Measure rule 10.
- **4d. By id.** The sheet and a checklist's screen. The store rule is on in full, except for `cache`, which phase 11
  removes.

### Tests

- Unit: `put` leaves an untrusted field alone and takes a trusted `null`. `show` stacks the copy, the ops and the
  edits in order. `tasks[id]` stays the same object across changes. `edit`'s `ok` and `undo`. A late read is
  ignored. An op whose reply is not a task updates the copy. Each op's `apply`.
- `tests/offline.mjs`: a tick dropped from Waiting to send shows unticked without a reload.
- E2e: an edit in the sheet shows on its row before the answer. A failed sheet save puts back only its own field.
  Deleting a subtask on Today, then its parent, asks no question and leaves nothing in Waiting to send.

## State on 2026-10-15

For whoever carries on. Read this, then phase 4.

- **Where the work is.** Phases 0, 1 and 2 are on `dev` and pushed. They were built on a branch and
  fast-forwarded onto `dev`. The `pocket` folder at that point is installed on the user's server
  (Cloudron, Postgres), and passed `scripts/relay-check.js` and a phone check online and offline.
- **How it has been built.** One build agent at a time, each with a written brief: the parts of this plan it needs,
  `AGENTS.md`, `docs/development.md`, the exact scope, "nothing on screen changes" where that holds, the checks, and
  "list every choice the brief didn't settle". The briefs used so far are in `scratchpad/ground/brief-*.md`. Every
  commit passed `npm run lint`, `npm run test:unit`, `test:parse` and the full `test:local` first. Check lint's exit
  code itself, not through a pipe. A change to `pocket/*.go` also runs `DB=sqlite` and `DB=mysql npm run test:local`.
  New words the user reads are proposed to the user before they ship. Discuss a phase's design with the user before
  building it, as was done for phase 1.
- **Next: phase 3 (roles),** then **phase 4 (the store's foundation),** built as "Phase 4 in detail" says, in four
  commits. Phase 4 is the riskiest.
- **Known, and fixed by a later phase.**
  - A checklist tick dropped from Waiting to send still shows as ticked until a reload (phase 4).
  - Every op is in `SHOWN_OWN_WAY` and the bridge carries none (phase 4 deletes both).
  - `docs/roadmap.md` line 83 still says a checklist's progress calls `api()` itself (phase 13).
  - A phone that once used token sign-in keeps `pocket.token` in localStorage, unused.
  - Part 2 of `today-moves.md`, the gap where a moved row was, is built after phase 6.
- **For the user.** Two issue drafts to file upstream: `upstream-idempotency-key.md` and `upstream-task-updated.md`.

## Out of scope

A change to what the user sees came up alongside this plan: the Undo gap where a moved row was. It is decided and
written up in `docs/design/today-moves.md`, and is built after phase 6.
