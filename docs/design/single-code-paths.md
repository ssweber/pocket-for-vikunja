# Single code paths

Pocket answered several questions in more than one way, depending on which code path asked:

- **How does a change reach Vikunja?** Some changes went through the outbox and others were written directly, and
  each kind of change was defined in several files.
- **What happens when a reply is lost?** Vikunja's creates aren't safe to send twice, so Pocket guessed after the fact.
- **Can Undo trust what it puts back?** Most Undos wrote back blindly, over a teammate's edit.
- **Which copy of a task is right?** A task could be on screen from six copies, each kept current its own way.
- **What does Pocket say?** About 76 messages were written inline, so one failure read differently on each screen.

This plan gives each question one answer, in one place, and makes lint keep it that way. It is a refactor, not a
feature. Delete each old path in the same phase that replaces it. Keep no shims and no "legacy" branch. Delete this
file when the last phase is done, after moving the rules that last into `development.md`.

## Where it stands

Built on `dev`, and described by the code and its comments:

- every write is keyed, and the plugin's relay (`pocket/relay.go`) makes a retry safe;
- the op registry (`src/js/ops/`) and the one sender (`src/js/app/acts.js`);
- one store (`src/js/app/tasks.js`): a row is Vikunja's copy, then the waiting ops;
- adding tasks and dates as ops;
- ticks and progress as ops, each with an Undo that is an op (`invert`), and the pruning of unsent pairs (`fold`);
- the sheet's title, priority, notes and reminders, and a template's step order, as `edit` ops. Notes, reminders
  and step order are made on Vikunja's copy as they are sent (`rebase`);
- a move to another project, with the subtasks, as one `project` op, and a subtask taken out of its parent or put
  back, as `unlink` and `link` ops;
- people and labels from the sheet, a checklist's people and a template's label, as `assign` and `label` ops, each
  sending the set Vikunja has with one change;
- every delete of a task as a `delete` op: held for Restore from a row or a task's sheet, and sent at once from
  everywhere else (`deleteNow`), which first takes the changes still waiting on those tasks out of the outbox, and
  cancels one that made tasks;
- starting a checklist and adding a step to one as `startRun` and `addStep` ops, which keep what they made in their
  entry. Cancel, and a start's Undo, delete it with the same op marked `cancelled`;
- Make template, New template, the example template and the steps added under a template as `makeTemplate` and
  `templateStep` ops, whose Cancel takes back what they made. A checklist's name and a template step's title, asks,
  people and labels as `edit`, `assign` and `label` ops;
- each file's upload sent with a key, its body built the same way on every try (`fileBody`, `api.js`);
- every write through the outbox, except what stays direct (below), with lint holding it: the writes allowlist and
  the keys rule;
- one answer each for a task's role (`roleOf`) and Today's groups (`dayGroup`);
- sign-in with Vikunja's session only;
- screens saved on the phone as the ids of their tasks, with the store's copies kept beside them, swept to what the
  kept screens and the outbox need, and kept on the phone as Pocket is hidden too;
- the store catching up when Pocket comes back to the screen or the connection comes back (`catchUp`, `tasks.js`). It
  reads what changed since the oldest kept screen was loaded. It can't see what Vikunja's `updated` misses (see
  Lessons). It can miss a change to a task whose copy is older than that, as an op's task on no kept screen. When the
  phone's clock was set back between two pages, it can also miss a change made soon after that screen was loaded.
  Each screen's own load reads those. It doesn't ask about the tasks of a project Pocket doesn't list, as an archived
  one;
- each request's time kept in its op's entry (`sentAt`), so an op sent before a reload counts from its own requests.
  The store's clock moves past those times as the outbox is read, so the new page's reads count as newer even when
  the phone's clock was set back between the two pages;
- the lifecycle test and the randomized store test, which reloads between any two requests and catches up.

The user's phone check covers everything up to phase 5. Phase 6 (dates) and what came after it haven't been checked
on a phone. The last full `test:local` passed at `7f254fa`. The relay has changed since, so upload `pocket/` again,
and empty the Outbox on each phone, before the next phone check.

## How the work runs

- A part is checked with `npm run lint`, `npm run test:unit` and `npm run test:parse`. `test:local` (all three
  databases for a plugin change) and the phone check run once, at the end of the major work. Commits stay small so a
  failure found then can be traced to one of them.
- One build agent at a time, from a written brief, then a read-only review whose findings are fixed at once. Briefs
  are in `scratchpad/store/`, and `brief-6c1.md` and `brief-review-6c.md` are the templates.
- A change to what the user sees, or new words, is discussed with the user first.
- A move of code or tests is done by a script, with a proof that nothing else changed.

## Rules that hold

- **A row is Vikunja's copy, then the waiting ops.** Nothing else is added without the user's agreement.
- **What stays direct.** Signing in, creating a project (the Checklists project included), renaming, archiving and
  deleting a project, and turning checklists on or off need Vikunja's answer before anything else can happen, and the
  user waits for it on screen. They are the lint's `DIRECT` files, each with a comment saying why. Every other write is
  an op, sent with a key.
- **Vikunja's copies have one door,** `read`, `answer` and `made`, and every write happens inside `change`. A read
  carries the time it started. A reply or a change carries the write it answers.
- **Vikunja's copy of a task only moves forward.** Agreed with the user on 2026-10-17. Vikunja gives no version
  number, so Pocket orders what it learns by when it started each request. A field is taken only if its request
  started after the request behind that field of the copy. A read that overlaps a write to the same task is thrown
  away, and the next read decides. A replayed answer confirms its change but doesn't overwrite the copy. An op is in
  flight from its first request until it leaves the outbox, across retries, and its change counts from that request.
  Ops on one task go out one at a time. When two writes on one task are in flight at once, as when an op on a step
  writes its checklist's progress, Pocket takes neither's reply, and neither's change to a field the other sets to
  another value. A task is read once its writes end if they leave it unsure that way, if a read of it was thrown away,
  or if its op's answer was replayed or never reached this tab. An op's entry keeps when each of its requests was first
  sent, so a page that sends it after a reload knows how old each part is. The rule lives in `tasks.js`, where each
  write the copy learns from is a `writes()` with its start time.
- **Between Pocket and a teammate, the last write to reach Vikunja wins, field by field,** as in Vikunja's web app.
  Undo puts back only a field nobody has changed since.
- **Only `src/js/ops/` knows which op is which.** Lint holds it. The shared code asks the op (the fields listed in the
  comment on `OPS`).
- **An op records what the user chose** (`asks`). What the screen showed (`saw`) is only for its words and its Undo.
  A body that depends on the task is built from Vikunja's copy with `c.once` when the op is sent. `act()` and the
  stage proxy hold it.
- **A request's body is fixed before it is first sent.** The relay answers 422 to a key sent again with another body.
  So a stage's requests depend only on the entry and `a.fixed`, and a request a read decides on goes last in its
  stage.
- **Every op passes the lifecycle checks.** A new op needs a sample in `tests/unit/samples.mjs`. The randomized test
  (`tests/unit/store.model.test.mjs`) checks the store's rules on random orders of ops, reads and answers, and
  checks from the fake Vikunja's log that each copy only moves forward.
- **A first request waits while Pocket knows it is offline.** Once a request is sent the op can't be cancelled, so an
  op made offline must stay unsent until a read gets through.

## Phases to come

### 7 and 8. What parts (a) to (d) left

One phase, with one review. Its four parts are built: ticks and progress, the sheet's fields, a move to another
project with links, and people and labels. These are left:

- From the Veyrn comparison: an op refused with 404, because its task was deleted in Vikunja, stays failed for good,
  except a tick, an untick, a progress, a finish, a reopen, an edit, a move, a link or unlink, an `assign` and a
  `label`, whose `refusal` drops it ('dropped').
- Carried forward: dropping a failed add with no waiting neighbour leaves its parent's progress unwritten.
- A move takes the subtasks Pocket knows of when it is queued (`subtaskTree`). Offline, a subtask Pocket never read
  moves without its own subtasks.
- The Undo of a repeating task's tick whose answer this tab never saw, as when the relay can't say whether Vikunja made
  it, has no dates to check against. It counts any date other than the one before as changed since.
- No screen offers an Undo for a person or a label, though their ops have an `invert`.

### 12. Messages

Every user-facing string comes from a function in `messages.js`: messages, Undo and Try again labels, confirms, and
what is announced to screen readers (`this.said`). One wording per situation: a lost connection, "changed since then",
a refusal with Vikunja's reason. Text from Vikunja stays escaped (`errText`). Tests in `messages.test.mjs` for each
new function, singular and plural. Turn on the messages rule. From the Veyrn comparison: the sign-out confirm calls
every waiting op that isn't a line "a change to a checklist". Make template's Cancel after an unknown answer says
"Vikunja may or may not have this change", though it now takes the change back.

### 13. Clean up

Update `development.md`. Rule 1 becomes "A task is Vikunja's copy with the outbox's ops applied, read from the store by
id". Rule 3 becomes "Every change is an op sent through the outbox, each request with a key". Add that a task's kind
comes from `role()`, and Today's groups from `dayGroup`. The map's row for the copies kept on the phone names
`app/tasks.js`. Rule 6 now has lint behind it. Delete "Copies of a task that are not the store's yet" from
`roadmap.md`. Update `main.go`'s header and the Privacy and security section of `docs/guide.md` for the relay and its
table. Delete this file.

### End of the major work

`BROWSER_CHANNEL=chrome npm run test:local` on Postgres, `DB=sqlite` and `DB=mysql`, then the user's phone check.

### 14. When Vikunja supports `Idempotency-Key`

Point `api()`'s `key` option at `/api/v2`, delete `relay.go`, and add a migration that drops `pocket_relay`. Raise
the minimum Vikunja version. `docs/design/upstream-idempotency-key.md` asks for it.

## Lint rules still to turn on

They join the one `no-restricted-syntax` array in `eslint.config.js`, because a second entry for the rule replaces the
first.

| Phase | Rule                                                                                                                 | Allowed in           |
| ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 12    | Messages: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said`. | `src/js/messages.js` |

## After the major work

Before anyone else uses Pocket:

- **Upgrading stored data.** Replace the upgrade that empties every IndexedDB store with one step per version that
  never drops the outbox, and give each entry and saved screen a format version. An entry Pocket can't read shows in
  the Outbox with Cancel instead of disappearing. Today an entry whose op Pocket doesn't know breaks the Outbox's list
  (`op.text`) and the sender (`stagesOf`). A start or a step an older Pocket saved before they were ops is dropped
  unsent, leaving any copy it made.
- **Limit what's saved on the phone.** Drop avatars not refreshed in 30 days. When localStorage is full, delete the
  oldest saved screen and try again.
- **The upstream drafts.** In `upstream-task-updated.md`, ask how Pocket learns of deleted tasks: an endpoint for ids
  deleted since a time, a soft-delete flag a filter can see, or a table of deleted ids kept for a set time. If Vikunja
  declines, the fallback is a change log in the plugin built from Vikunja's task events. Vikunja sends no events for
  labels or reactions, so the log can't replace a checklist's reload.
- **From the Veyrn comparison:** honour a 429's `Retry-After`, which the relay also has to pass on. Accept
  `default_due_time` only as `HH:MM`.
- **Test tools.** A `STEP=<regex>` filter for `smoke.mjs`, and a leak check (DOM nodes, Alpine effects, timers) after
  opening the sheet and switching screens many times.
- **To discuss first, since the user sees them:** screen readers (`aria-live` off `#view`, group titles as headings,
  rows as lists), and Back restoring the scroll position. A step added under a template waits as a row at the end of
  its sheet, not after the step the box was under, until Vikunja has made it.
- An Undo of a cancelled refused change can land behind later changes. It is rare.
- A person or a label op reads the set Vikunja has once, before its first request (`c.once('set')`, `stages.js`).
  When Vikunja answers that request with a 5xx, the retry sends the same set, so a label a teammate added in between
  is removed.
- `PUT /tasks/{id}/labels/bulk` has only been sent to the fake Vikunja. `test:local` must cover it, and so must a
  file's upload through the relay, whose body Pocket builds itself (`fileBody`).
- When the relay can't say whether Vikunja made one of a start's copies, of the template or of a step, the start's
  Cancel and Undo can't find that copy, and leave it (the lifecycle test's KNOWN). The relay answers that key as
  unknown for good. The template's `related_tasks.copiedto` lists the copy, but telling it from a teammate's start is a
  guess, so Pocket doesn't use it. For a done template, Checklists then lists a second template with no steps. A step's
  copy is a done task in the template's project, outside any checklist. The same holds for a step added to a checklist
  or a template whose task Vikunja may or may not have made.
- The Outbox offers no Cancel for a start, an added step, Make template or a template's step that has sent a request
  and waits, as for any op, though the row's × still cancels a step.
- `hiddenRows` reads every task's waiting ops, so a sheet's subtask list and a screen's groups are worked out again
  whenever an op is queued or answered. The rows don't redraw. Measure before changing it.

## Lessons

What Vikunja 2.7 does, checked while building:

- `updated` changes only when a task's own fields change, or a comment is added. Linking a subtask, ticking a subtask
  (on the parent), a reaction, labels, assignees, a position and an attachment leave it alone, and so do the step
  times Pocket's plugin writes. `upstream-task-updated.md` asks Vikunja to change that.
- A field the request didn't ask for comes back as `null`. `reactions` is `null` without `expand=reactions`, so the
  store takes only the fields each request is trusted for (`TASK` and its neighbours in tasks.js).
- `PATCH /api/v2/tasks/{id}` reads the task, applies the patch and answers with the task as that read gave it, labels
  and assignees included, but not reactions.
- `id in` with `per_page=1` gives the right `total`, counting only tasks that still exist.
- `/api/v2/tasks` leaves out the tasks of archived projects. With no project in the request, Vikunja lists the user's
  projects without `getArchived` (`getRelevantProjectsFromCollection` in `pkg/models/task_collection.go`, then
  `getAllProjectsForUser` in `pkg/models/project.go`, which adds `is_archived = false`). `GET /tasks/{id}` still reads
  such a task, since `Project.CanRead` (`pkg/models/project_permissions.go`) doesn't check whether it is archived.
- `PUT /tasks/bulk` and `POST /projects/{project}/tasks/bulk` are all or nothing, and the second ignores `position`
  and `labels`. Pocket uses neither.

The relay:

- Vikunja evaluates every `.go` file in `pocket/` into one package, in name order, so `relay.go` can't import a package
  `main.go` already imports.
- Only a failure to connect proves a request never reached Vikunja, so only that releases its key. Each forward makes
  its own transport, so Go never retries it on a second connection.
- With `ratelimit.kind: user`, a relayed write counts twice against its user. With `ip`, every relayed request reaches
  `/api/v2` from 127.0.0.1.
- MySQL's `TEXT` holds 64 KB, so a large answer needs `MEDIUMTEXT` there.

The app:

- **Rule 10.** Many ops queued at once (Move all on a long group) are shown in one `change`, not one per op. Measure
  with `npm run perf:rows -- counts` before and after a change to the store or the rows.
- **`data-sync`.** An op counts as busy from the tap until `refreshPending` sees its entry, or the tests read `idle`
  in between.
- **Ids not yet sent.** An op on a waiting row has a `pending-…` id, and the sender waits for the real one.
- **A task leaving done keeps every field** until its batch clears, or a repeating task's row would jump to its next
  date as it leaves.
- **A held delete must never lose the mark that sends it.**

## Out of scope

The Undo gap where a moved row was is decided and written up in `docs/design/today-moves.md`. It was to be built after
phase 6, and its part 2 isn't built yet.
