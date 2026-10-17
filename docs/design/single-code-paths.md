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
- one store (`src/js/app/tasks.js`): a row is Vikunja's copy, then the waiting ops, then the edits still running;
- adding tasks and dates as ops;
- one answer each for a task's role (`roleOf`) and Today's groups (`dayGroup`);
- sign-in with Vikunja's session only;
- the lifecycle test and the randomized store test.

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

- **A row is Vikunja's copy, then the waiting ops, then the edits still running.** Nothing else is added without the
  user's agreement. The edits are scaffolding: each phase turns direct saves into ops.
- **Vikunja's copies have one door,** `read`, `answer` and `made`, and every write happens inside `change`. A read
  carries the time it started. A reply or a change carries the write it answers.
- **Vikunja's copy of a task only moves forward.** Agreed with the user on 2026-10-17. Vikunja gives no version
  number, so Pocket orders what it learns by when it started each request. A field is taken only if its request
  started after the request behind that field of the copy. A read that overlaps a write to the same task is thrown
  away, and the next read decides. A replayed answer confirms its change but doesn't overwrite the copy. Each field
  of an op sent in several stages counts from the request that changed it. Ops on one task go out one at a time. When
  a direct save and an op on one task are in flight at once, Pocket takes neither's reply, and neither's change to a
  field the other sets to another value. The rule lives in `tasks.js`, where each write the copy learns from is a
  `writes()` with its start time.
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
  (`tests/unit/store.model.test.mjs`) checks the store's rules on random orders of ops, reads, answers and edits, and
  checks from the fake Vikunja's log that each copy only moves forward.
- **A first request waits while Pocket knows it is offline.** Once a request is sent the op can't be cancelled, so an
  op made offline must stay unsent until a read gets through.

## Open bugs

The lifecycle test found these. Each is in its test's `KNOWN` list until it is fixed. Both are words: an op stopped
partway says in its Cancel words what Vikunja already has. They need new words, which the user agrees first.

5. **Cancel of a delete refused at its parent's progress** says the task stays in Vikunja, which has deleted it.
6. **Cancel of a progress refused at its parent's progress** doesn't say that Vikunja has the new progress.

## Phases to come

### 7 and 8. Ticks, progress, sheet fields, project, links, people and labels

One phase, with one review.

| Today | Becomes |
|---|---|
| `toggleDone`, `tickRunStep`, `tickRunTask`, `arrivedDone`, `setProgress`, `sheetDone`, `sheetProgress`, `closeSubtasks`, `reopen`, `writeFigure` | The `done`, `undone` and `progress` ops. A plain task gets the ✅ as a step does, wherever it was ticked, including `x` lines in quick add. Delete `signTick` and `arrivedDone`'s own save. |
| `save` and its callers (title, priority, notes, reminders) | `edit`. Notes, reminders and step order need the copy Vikunja has now, so the op names a rebase kind (`notes`, `reminders`, `order`) that its stage applies when it is sent. A function can't be stored in IndexedDB. |
| `moveTask` | `project`, with the subtasks, in one op |
| `ownTask`, `linkSubtask` callers | `link`, `unlink` |
| `addAssignee`, `removeAssignee`, `addLabelTo`, `removeLabelFrom`, `setRunFor`, the template label in checklists.js | `assign`, `label`. Each sends the whole set with `PUT /tasks/{id}/labels/bulk` or `assignees/bulk`, built from the set Vikunja has when the stage runs, plus or minus the one change. A set built from Pocket's copy would remove a label a teammate added since. A new label is first created by a keyed `POST /labels`. `claim` keeps its single `POST`, so two people claiming at once still settle on one. |

- **Pruning** in `sync.add`, on entries that haven't sent a request and aren't held. A new `done` or `undone` cancels
  an unsent opposite one on its task, and both entries go. A new `progress` or `edit` replaces an unsent op of the same
  kind on the same task and fields, keeping the oldest `was`. Ticking and unticking ten times offline leaves zero or
  one entry.
- **Undo is an op**, made by `invert` from what the first op recorded: `was`, each field's value before, and `got`,
  the value Vikunja stored, from its answer. Its stage reads Vikunja's copy once. A field that still has `got` goes
  back to `was`. A field changed elsewhere is left alone, with one message: "Not undone: “title” has changed since
  then", on the row, or in the Outbox if the row is gone. An Undo of an op not yet sent removes the op. A repeating
  task's Undo puts back `due_date`, `start_date`, `end_date` and absolute reminders.
- The inline Undo closures in `toggleDone`, `arrivedDone`, `reopenedHead`, `moveTask` and `ownTask` go.
- Delete `save`, the direct calls in sheet.js, `saveTask` and `shared.saveChain`.
- From the Veyrn comparison: an op refused with 404, because its task was deleted in Vikunja, stays failed for good.
  Its `refusal` should drop it. A `flush` asked for while one runs is lost until the 30-second timer, so run one more
  pass. The labels and people an add sets never reach Vikunja's copy, because `CREATED` leaves them out.
- Carried forward: dropping a failed add with no waiting neighbour leaves its parent's progress unwritten. The
  repeating tick's Undo still uses `unchanged()` and `saveFor`.

### 9. Deletes and comments

Delete `deleteTasks`, `deleteTree`, `deleteRun` and `deleteAddedStep`, and the deletes in runs.js and checklists.js.
A template is deleted after its confirm, with no hold. Once every change goes through the Outbox, the offline line in
`app.html` becomes "Offline. Changes wait in the Outbox." (the user's words, agreed on 2026-10-16), with the time of
the saved screen as now, and `docs/guide.md` says the same.

### 10. Checklists and files

- `startRun` and `addStep` become keyed ops (named after the methods that queue them today). `RUN_STEPS` and
  `INSERT_STEPS` become their stages. Then renames, step edits, answers (asks.js) and a template's step order.
- Delete `findCopy`, `duplicate`'s bookkeeping and `hasAttachment`. `claims` becomes a plain record of which task each
  entry made.
- The three callers of `createTask` outside the outbox (the template editor, a step's new title, a step inserted in a
  checklist) queue ops.
- `untick` (runs.js), the start's Undo for the template it ticked, becomes the `invert` of the start's `tick` stage.
- Remove the last files from the writes allowlist, except what stays direct (below). Turn on the keys rule. Delete
  `unchanged()` and turn on the Undo rule.
- From the Veyrn comparison: an op on a checklist step that was never added stays failed. It should leave with the
  step's add.

**What stays direct.** These need Vikunja's answer before anything else can happen, and the user waits for it on
screen: signing in, creating a project (the Checklists project included), renaming, archiving and deleting a
project, turning checklists on or off for a project, and seeding the example template. Each stays in the lint
allowlist with a comment saying why.

### 11. Screens hold ids

- **A screen holds ids,** in Vikunja's order, with each waiting task's id where it will be. The saved copy of a screen
  is its ids, and Vikunja's copies replace the tasks inside it. Old saved screens are read as they are, or ignored.
  Delete `keptRows`, `cache` and `forgotten`.
- **Pruning the copies.** The store keeps a task's copy while a kept screen shows its id, an op in the outbox points to
  it, or it is open in the sheet (with its parent and subtasks) or is a step of the checklist on screen. The kept
  screens are Today, Lists, Checklists and the last 5 projects opened. The sweep runs when a fresh load replaces a
  screen's ids, and once when Pocket opens. A task Vikunja answers with 404 goes once no op points to it.
- **Keeping the store current,** when Pocket comes back to the screen or the connection comes back. Changed tasks:
  `GET /tasks?filter=updated > T&expand=reactions`, with T on Vikunja's clock a second before the last update started.
  Removed tasks: `GET /tasks?filter=id in <ids>&per_page=1`, and if `total` is lower than the number of ids, the same
  query in full, dropping the tasks it doesn't return unless an op points to them. Split long id lists, because some
  proxies refuse URLs over about 8 KB. Each screen's own load still decides which tasks are on it.
- **Where the copies are kept.** Measure the time to the first row before moving them to IndexedDB. If it delays the
  first row, keep them in localStorage under the kept screens' bound.
- Read Replicache's design doc first. Its design is this one, and it covers a reply that arrives after its change was
  undone. Check that holds for every op's `invert`.
- From the Veyrn comparison: `dropCopies` leaves `clock` as it is, so a read still running at sign-out writes the old
  user's tasks. Check whether v2's `/tasks` returns tasks from archived projects.

### 12. Messages

Every user-facing string comes from a function in `messages.js`: messages, Undo and Try again labels, confirms, and
what is announced to screen readers (`this.said`). One wording per situation: a lost connection, "changed since then",
a refusal with Vikunja's reason. Text from Vikunja stays escaped (`errText`). Tests in `messages.test.mjs` for each
new function, singular and plural. Turn on the messages rule. From the Veyrn comparison: the sign-out confirm calls
every waiting op that isn't a line "a change to a checklist".

### 13. Clean up

Update `development.md`. Rule 1 becomes "A task is Vikunja's copy with the outbox's ops applied, read from the store by
id". Rule 3 becomes "Every change is an op sent through the outbox, each request with a key". Add that a task's kind
comes from `role()`, and Today's groups from `dayGroup`. Rule 6 now has lint behind it. Delete "Copies of a task that
are not the store's yet" from `roadmap.md`. Update `main.go`'s header and the Privacy and security section of
`docs/guide.md` for the relay and its table. Delete this file.

### End of the major work

`BROWSER_CHANNEL=chrome npm run test:local` on Postgres, `DB=sqlite` and `DB=mysql`, then the user's phone check.

### 14. When Vikunja supports `Idempotency-Key`

Point `api()`'s `key` option at `/api/v2`, delete `relay.go`, and add a migration that drops `pocket_relay`. Raise
the minimum Vikunja version. `docs/design/upstream-idempotency-key.md` asks for it.

## Lint rules still to turn on

They join the one `no-restricted-syntax` array in `eslint.config.js`, because a second entry for the rule replaces the
first.

| Phase | Rule | Allowed in |
|---|---|---|
| each | The writes allowlist shrinks as each phase finishes its files. | what stays direct |
| 10 | Keys: a call to `api` with a `method` other than `GET` and no `key`. | `src/js/api.js`, what stays direct |
| 10 | Undo: a call to `this.unchanged`. | nothing |
| 12 | Messages: a string or template literal as the first argument of `say`, `notify` or `confirm`, or assigned to `said`. | `src/js/messages.js` |

## After the major work

Before anyone else uses Pocket:

- **Upgrading stored data.** Replace the upgrade that empties every IndexedDB store with one step per version that
  never drops the outbox, and give each entry and saved screen a format version. An entry Pocket can't read shows in
  the Outbox with Cancel instead of disappearing. Today an entry whose op Pocket doesn't know breaks the Outbox's list
  (`op.text`) and the sender (`stagesOf`).
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
  rows as lists), and Back restoring the scroll position.
- An Undo of a cancelled refused change can land behind later changes. It is rare.

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
