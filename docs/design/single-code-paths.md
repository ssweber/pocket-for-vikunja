# Single code paths

Several questions in Pocket have more than one answer, depending on which code path asks:

- **How does a change reach Vikunja?** Checklists, adds and deletes go through the outbox. About 50 other places write
  directly. Each kind of change is defined in up to six places across four files.
- **What happens when a reply is lost?** Vikunja's creates aren't safe to send twice, so Pocket guesses after the fact
  (`findSent`, `findCopy`, `findNote`, `hasAttachment`, `claims`, `landed`).
- **Can Undo trust what it puts back?** Two Undos check for a change made elsewhere. The rest don't.
- **What kind of task is this?** Template and checklist are decided by four different tests.
- **Which Today group does a date go in?** The rule is written out six times.
- **What does Pocket say?** Rule 6 puts the words in `messages.js`. About 76 messages are written inline.

This plan gives each question one answer, in one place, and makes lint keep it that way. It is a refactor, not a
feature. Delete each old path in the same phase that replaces it. Keep no shims, and no "legacy" branch beside the new
one, except the two named below (older outbox entries, and sign-in with an API token if the relay can't serve it).
Read `AGENTS.md` and `docs/development.md` first. Delete this file when the last phase is done, and move the rules that
last into `development.md`.

Line numbers and counts drift. Run the greps given below again before each phase.

## 0. Retries without guessing: a keyed relay

Every write Pocket makes goes to Vikunja's `/api/v2` with an `Idempotency-Key` header, following the IETF httpapi
draft. Vikunja doesn't support that header yet. Until it does, Pocket's plugin relays the write:

- Pocket sends the write to `/api/v1/plugins/pocket/v2/<path>` instead of `/api/v2/<path>`, with the key.
- The plugin forwards it to Vikunja's own `/api/v2/<path>`, with the user's `Authorization` header. Vikunja checks
  permissions, applies an API token's scopes and sends events exactly as for a direct request.
- The plugin stores Vikunja's answer under (user, key). A request sent again with that key gets the stored answer, and
  Vikunja sees the write once.

When Vikunja supports the header, Pocket sends to `/api/v2` with the same header, and the relay is deleted. Pocket
asks for that upstream with `docs/design/upstream-idempotency-key.md`.

Why a relay and not a plugin that calls Vikunja's models: the relay depends only on the public v2 API, plain
`net/http`, and the plugin system. Permissions, token scopes and events stay Vikunja's. Its interface is the one
Vikunja would offer, so nothing in Pocket changes when it is removed except the base address.

### What the relay does

As the draft says:

- no key: 400;
- a key whose first request is still running: 409, with `Retry-After`;
- a key reused for a different method, path or body: 422;
- a key already answered: that answer again, with `Idempotent-Replayed: true`. A refusal (4xx) is stored and replayed
  like a success.

And beyond the draft:

- **A 5xx or a failed forward isn't stored,** so the request can be sent again. Vikunja rolls back a request that fails
  that way.
- **The forward doesn't use the request's context.** If the phone hangs up, the write still finishes and its answer
  is stored for the retry.
- **The gap.** The write commits in Vikunja's transaction, and the answer is stored in a second one. If Vikunja stops
  between the two, the key stays pending. A request with that key more than 2 minutes later gets 409 with
  `Idempotency-Unknown: true`. The outbox shows that entry as failed, for the user to send or drop. The window is a few
  milliseconds on the server, against today's window of any dropped connection.
- **Keys are kept 30 days.** An outbox entry still unsent after 30 days is marked failed instead of sent, because its
  key may be gone.
- **The table, `pocket_relay`,** is plain SQL that SQLite, Postgres and MySQL accept. A Go struct would be a type Yaegi
  makes at runtime, and xorm may not read it. It holds each stored answer, which includes task content, for 30 days.

### The spike

The relay is on the branch `spike/relay`: `pocket/relay.go`, checked by `scripts/spike-relay.mjs` against
`npm run dev`. The script checks that:

1. a relayed create makes a task;
2. the same key gets the stored answer and makes no second task;
3. five requests with one key at the same moment make one task;
4. a reused key gets 422, and a missing key 400;
5. a project the user can't write to is refused, the refusal is replayed, and nothing is created;
6. events fire: a mention in the description notifies the mentioned user;
7. a repeating task ticked twice with one key moves on one day, not two.

It also reports whether an API token can reach a plugin route. Vikunja limits a token to the routes its permissions
list. If a plugin route can't be on that list, Pocket's API-token sign-in can't use the relay. Then that sign-in keeps
today's `find…` checks until Vikunja supports the header, and the relay serves the session sign-in only.

`relay.go` type-checks against stand-ins for Vikunja's packages, but hasn't run inside Vikunja. Run the spike first,
on SQLite and on Postgres.

### Traps in the relay

- **Rate limits.** With `ratelimit.kind: ip`, every relayed request comes from 127.0.0.1 and shares one limit. Check
  how Vikunja counts a relayed request, and say in the guide what to set.
- **Where Vikunja listens.** The relay reaches Vikunja at `service.unixsocket` if set, or else `service.interface`,
  with `0.0.0.0` read as 127.0.0.1. A Vikunja that serves TLS itself needs `https` here.
- **MySQL's `TEXT`** holds 64 KB. A large answer, such as a task with many comments, needs `MEDIUMTEXT` there.
- **Body size.** The relay accepts 50 MB, so attachments can go through it. A reverse proxy in front may allow less.
- **Yaegi.** Only what `pkg/yaegi_symbols` exposes can be called, plus Go's standard library. Each file in `pocket/` is
  evaluated on its own, in name order, so a file can't use a name another file defines unless that file comes first.

## 1. Every change is an op, sent through the outbox

### The op registry

Each kind of change is one object in `src/js/ops/`, with everything about it in one place. Today one op is spread over
`ACTS` and `ACT_STEPS` (sync.js), `actText` and `dropText` (outbox.js), `actWhat` (runs.js) and `keyWaiting`
(sending.js).

```js
export const due = {
  apply(app, a){ … },             // show the change on screen at once (rule 4)
  steps: [ … ],                   // the v2 requests, in order, each sent with its own key
  invert(a){ … },                 // the op that undoes it, built from what this one recorded (part 2)
  merge(older, newer){ … },       // pruning, below
  waiting: 'dues',                // the key a row reads in `waiting` (rule 10)
  text, refused, dropped,         // the words, from messages.js
};
```

A method in `src/js/app/` calls `this.act({op, task, ...})`. Nothing else sends a write. The act sender moves out of
`runs.js` into `app/acts.js`, with `giveBack`. A unit test checks that every op defines every field, so no op is
missing its words in the outbox sheet.

### Keys and steps

- **An entry gets a key when it is made,** and each of its requests a key made from it: the entry's key, the step's
  index, and the part (one label, one person). So a retry of any request sends the key it was first sent with.
- **Steps stay,** because some changes take several requests (a task, then its link under a parent, then its
  progress). But each step is now one keyed request, sent until it is answered. There is nothing to look for after a
  lost reply. `tried`, `triedAt`, `arriving`, `findSent`, `findCopy`, `findNote`, `hasAttachment`, `claims` and the
  lost-reply half of `landed` go.
- **`api()` gets a `key` option.** With a key, it sends to the relay and adds the header. Once Vikunja supports the
  header, the option sends to `/api/v2`, and only that line changes.

### Fewer steps with v2's set-style endpoints

These say what the end state is, so they replace several requests with one:

| v2 endpoint | Replaces |
|---|---|
| `PUT /tasks/{task}/labels/bulk` sets the exact label set | adding labels one by one, and the `ALREADY` codes for them |
| `PUT /tasks/{task}/assignees/bulk` sets the exact assignees | the same for people |
| `PUT /tasks/bulk` applies the same fields to many tasks, all or nothing | Move all as one request per distinct new date |
| `POST /projects/{project}/tasks/bulk` creates up to 100 tasks, all or nothing | the top-level lines of a pasted list as one request |

### What moves

Found with `grep -n "this\.saveTask(\|this\.saveEach(\|this\.save(\|api(.*method\|patchTask(" src/js/app/*.js`.

| Area | Today | Becomes |
|---|---|---|
| Tick, untick, progress | `toggleDone`, `tickRunStep`, `tickRunTask`, `arrivedDone`, `setProgress`, `sheetDone`, `sheetProgress`, `closeSubtasks`, `reopen`, `writeFigure` | `tick`, `untick`, `progress`. A plain task gets the ✅ as a step does, wherever it was ticked, including `x` lines in quick add. |
| Dates | `reschedule`, `moveOverdueToToday`, `undoMoves`, the sheet's date and repeat edits | `due`, `repeat` |
| Sheet fields | `save` and its callers (title, priority, notes, reminders) | `edit`. Notes, reminders and step order need the copy Vikunja has now, so the op names a rebase kind (`notes`, `reminders`, `order`) that its step applies when it is sent. A function can't be stored in IndexedDB. |
| Project | `moveTask` | `project`, with the subtasks, in one op |
| Subtask links | `ownTask`, `linkSubtask` callers | `link`, `unlink` |
| People and labels | `addAssignee`, `removeAssignee`, `addLabelTo`, `removeLabelFrom`, `LINE_STEPS.label`, the template label in checklists.js | `assign`, `label`, each setting the whole set |
| Delete | `deleteTasks`, `deleteTree`, the deletes in runs.js and checklists.js | `delete`, held as now. A template is deleted after its confirm with no hold. |
| Checklists | `RUN_STEPS`, `INSERT_STEPS`, renames, `saveRun`, the step edits in checklists.js and runs.js, answers in asks.js | `startChecklist`, `insertStep` and the same ops as above |

`saveTask` and `shared.saveChain` go. Patching a task is a step like any other.

### What stays direct

These need Vikunja's answer before anything else can happen, and the user waits for it on screen: signing in
(`auth.js`), creating a project, including the Checklists project (`views.js`, `checklists.js`), renaming, archiving
and deleting a project (`checklists.js`), and seeding the example template (`checklists.js`). Each stays in the lint
allowlist with a comment saying why. Nothing else goes on the list.

### Pruning

`sync.add` coalesces when it queues an op. It only touches entries that haven't sent a request yet and aren't held.

- A new `tick` or `untick` on a task cancels an unsent opposite one on that task. Both entries go.
- A new `due`, `progress` or `edit` replaces an unsent op of the same kind on the same task and fields. It keeps the
  oldest `was`, so Undo returns to where the user started.
- Anything else is queued as it is.

Test it in `tests/unit/` with a fake outbox. Ticking and unticking ten times while offline leaves zero or one entry.

### Older outbox entries

Entries an older Pocket saved are in IndexedDB on users' phones, some half sent. They have no keys, and the old code
may have done part of the change already. So the old sender stays for one release, and sends only entries in the old
format. The release after that deletes it. Name the release in the commit that adds the new format.

### Traps

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
- **409 from the relay** means wait and send again, after `Retry-After`. With `Idempotency-Unknown`, it means the entry
  is marked failed for the user. Neither is a refusal.

## 2. Undo checks before it writes back

About 21 places build an Undo. Two check that the task is as Pocket left it, by calling `unchanged()`: the Undo of a
repeating task's tick (`toggleDone`) and the Undo of date moves (`undoMoves`). Every other Undo writes back blindly:
untick, progress, moving to another project, unlinking a subtask, reopening closed subtasks. An Undo tapped after a
teammate's edit overwrites that edit without saying so.

Found with `grep -n "label: 'Undo'\|const undo\|undo: async" src/js/app/*.js`.

- **Undo is an op,** made by the op's `invert` from what the first op recorded: `was`, the value each field had, and
  `set`, the value it wrote.
- **The check runs when it is sent,** not when it is tapped. Its first step reads Vikunja's copy, so an Undo queued
  offline is checked against the task as it is then.
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
| Writes | `no-restricted-syntax`: a call to `api` whose argument object has a `method` property, any call to `patchTask`, calls to `this.saveTask` and `this.saveEach` | `src/js/sync.js`, `src/js/app/acts.js`, `src/js/ops/`, and the allowlist |
| Keys | `no-restricted-syntax`: a call to `api` with a `method` other than `GET` and no `key` | `src/js/api.js`, and the allowlist |
| Undo | `no-restricted-syntax`: a call to `this.unchanged` | nothing, once `unchanged()` is gone |
| Roles | `no-restricted-imports` with `importNames` for the predicates in `checklists.js` | `src/js/checklists.js` |
| Today's groups | `no-restricted-syntax`: a call to `addDays` whose second argument is the literal `8` | `src/js/lists.js` |
| Messages | `no-restricted-syntax`: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said` | `src/js/messages.js` |

The writes allowlist starts as every file that writes today. Each phase removes the files it finishes. The other rules
are turned on in the phase that finishes their part.

## Phases

Each phase is its own commits on `dev`, and leaves the app working. Each passes `npm run lint`, `npm run test:unit`
and `npm run test:local`. Each phase that moves an op adds a case to `tests/offline.mjs`: make the change offline,
reload Pocket, reconnect, and check Vikunja's copy. It also sends each request of the op twice with its key, and
checks that Vikunja changed once.

0. **The spike.** Run `scripts/spike-relay.mjs` on the `spike/relay` branch, on SQLite and on Postgres. Record the
   results and the API-token answer here. If a check fails, stop and rethink part 0 before going on. Then merge
   `relay.go` into `dev` as the plugin's relay, and delete the branch.
1. **Ground.** The op registry, `app/acts.js`, and the `key` option in `api()`. The writes lint rule with the full
   allowlist. Nothing the user sees changes.
2. **Roles.** Settle the decision in part 3 first. Write the table test, add `roleOf` and `this.role`, move every
   caller, and turn on the roles rule.
3. **Today's groups.** Add `dayGroup`, move all six places, and turn on its rule.
4. **Adding tasks.** Quick add and the subtask boxes as keyed ops, with the set-style label and people endpoints and
   bulk create. Delete `LINE_STEPS`' lost-reply checks, `findSent` and `claims`. Keep the old sender for old entries.
5. **Dates.** `due`, with Undo checked per field. Delete `undoMoves` and `saveEach`.
6. **Ticks and progress.** One tick for every row, card, sheet and checklist, with pruning. Delete `signTick`,
   `arrivedDone`'s own save, `closeSubtasks` and `reopen`.
7. **Sheet fields, project, links, people, labels.** Delete `save` and the direct calls in sheet.js.
8. **Deletes and comments.** Delete `deleteTasks`, `deleteTree` and `findNote`.
9. **Checklists and files.** `startChecklist` and `insertStep` as keyed ops. Delete `findCopy`, `duplicate`'s
   bookkeeping and `hasAttachment`. Then renames, step edits, answers and template step order. Remove the last
   non-permanent files from the writes allowlist, turn on the keys rule, delete `unchanged()` and turn on the Undo rule.
10. **Messages.** Move the remaining inline strings to `messages.js` and turn on its rule.
11. **Clean up.** Update `development.md`. Rule 3 becomes "Every change is an op sent through the outbox, each request
    with a key". Add a rule that a task's kind comes from `role()`, and one that Today's groups come from `dayGroup`.
    Rule 6 now has lint behind it. Update `main.go`'s header and the Privacy and security section of `docs/guide.md`
    for the relay and its table. Delete this file.
12. **One release later.** Delete the old outbox sender and the old entry format.
13. **When Vikunja supports `Idempotency-Key`.** Point `api()`'s `key` option at `/api/v2`, delete `relay.go`, and add
    a migration that drops `pocket_relay`. Raise the minimum Vikunja version.

## Out of scope

These change what the user sees, so they are discussed before they are built:

- Leaving an Undo gap where a moved row was, instead of an Undo on the row where it lands.
- The time Move all gives a task whose time today has passed. It is now the next whole hour, which can be late again
  when Pocket is reopened.
