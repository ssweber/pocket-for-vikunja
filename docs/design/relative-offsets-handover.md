# Handover: relative offsets in workflow steps

For the agent picking up the "relative offsets" spec (at the end of this note). Workflows v1 is committed on the
`workflows` branch as `61a3b95`. Read `docs/design/workflows-plan.md` for the v1 design and why it is that way, then
this note, then the code. All five test files pass on Vikunja 2.7.0.

## What exists now (v1)

All in `pocket/app/index.html`, in sections marked `workflows`:

- **Data model:** a workflow is a project with a line `pocket:workflow` in its description (`isWorkflowDesc`). A
  template is a task labelled `template` and marked done; its steps are its subtasks, also done. A run is
  `POST /tasks/{template}/duplicate`, plus a duplicate of each step linked under the run. Every copy keeps a
  `copiedfrom` link to its source.
- **Step timing today:** `^30m`, `^2h`, `^3d`, `^1w` at the end of a step title (`STEP_OFFSET`, `parseStep`,
  `offsetText`). It counts from the **run's start**. The due date is fixed when the run is set up: `startRun` computes
  `due` per step, and the `step` stage of `RUN_STEPS` writes it. The run is due when its last step is. The `^` is
  stripped from run step titles. Quick add skips a chrono match right after `^` (in `parseCapture`).
- **Setting up a run:** an outbox entry `kind: 'run'` worked through by `RUN_STEPS`, resumable like `LINE_STEPS`.
  `findCopy` recovers a duplicate whose reply was lost, through the source's `copiedto`.
- **Run screen** (`#/run/{id}`, `loadRun`, `runView`): one step at a time, a list of steps, notes, and "Last time"
  (`loadLast`).
  - Ticks, skips, unticks, notes and finish are outbox entries `kind: 'act'`, handled by `ACTS`, `ACT_STEPS` and
    `sendAct`. They're sent in order (`sync.all` sorts by `at`, then `n`) and work offline.
  - Who did a step: reactions ✅ / ⏭️ (`DONE_MARK`, `SKIP_MARK`).
- **Today:** `inToday` and `loadRunIndex`. A run and its steps show only to whoever started the run or is
  assigned it.
- **Only the run is assigned**, never the steps: Vikunja sends a notification per assigned task (verified).
- **Tests:**
  - `tests/workflows.mjs`, end to end. With `OTHER_USER` and `OTHER_PASSWORD` it also checks a second person's
    Today and Workflows tab.
  - `tests/parse.mjs`, the "workflow steps" section: `^` timings and the marker.

## Decisions the user and I recommend before you start

1. **Start with a spike: can a Yaegi plugin subscribe to Vikunja's event bus in 2.7?**
   - Every server-side part of the spec depends on this, and it hasn't been verified. `events` is in the list of
     packages available to plugins, but nobody has yet listened for task updates.
   - Find out which event fires for a task update, whether it carries the before and after `done`, and whether
     changes made inside the handler fire it again.
   - Do this first and report back before building on it.
2. **Make serve-only the default.**
   - Today the plugin only serves `app/`, and the README promises it doesn't touch Vikunja's data. Writing due dates
     is a different promise to the people installing Pocket.
   - Make recalculation opt-in with a config flag, and state exactly what the plugin writes, and when, in the README
     and in `main.go`'s header comment.
3. **Where the offset lives: read it from the template step, through `copiedfrom`.**
   - The spec's open decision lists a plugin table or a line in the description. This third option needs neither.
   - Every run step already links to its template step, whose title holds `T#20m`, `{#dryer}` and `:dryer`. The
     plugin follows that link when a step is ticked.
   - Run step titles stay clean (strip the tokens as `^` is stripped now). No migration, nothing added to
     descriptions.
4. **`T#` replaces `^`.** No templates exist outside the tests, so drop `^` completely: `STEP_OFFSET`, `parseStep`,
   `offsetText`, the `^` guard in `parseCapture`, the parser tests, the README's Workflows section, and the hint in
   the task sheet's workflow card.
5. **Reopening a step (Pocket's Undo): leave the dependents' due dates as they are.** Ticking it done again
   recalculates them anyway, since the spec only acts on the change to done.
6. **Reminders: check who Vikunja notifies before relying on them.**
   - Steps are unassigned, and only the run is assigned. Verify who gets a reminder on an unassigned step: the
     creator, or nobody.
   - Use Vikunja's relative reminders (`relative_to: due_date`, `relative_period: 0`). Those move with the due date,
     so recalculation only has to write `due_date`.

## Facts verified on Vikunja 2.7.0 (save yourself the time)

- **Duplicating:** `POST /tasks/{id}/duplicate` copies labels (`template` too), assignees, attachments and
  reminders. It doesn't copy subtasks or reactions. The copy isn't done and is created by the caller, and Vikunja
  adds `copiedfrom` / `copiedto`.
- **Subtask order:** the order the relations were created, everywhere (API, web task detail, web List view).
  Position doesn't affect it.
  - Relation kinds: `subtask parenttask related duplicateof duplicates blocking blocked precedes follows copiedfrom
    copiedto`.
  - Creating one that exists returns code 4008. Deleting one that doesn't returns 404 with code 4009.
- **Embedded tasks are thin:** an embedded `parenttask` / `subtask` has no `created_by`, no assignees and no
  reactions. Use `GET /tasks/{id}?expand=reactions&expand=comments`. `expand=comments` works on a single task.
- **Reactions:** `POST /tasks/{id}/reactions` `{value}` is idempotent, and so is `POST …/reactions/delete`.
  `GET /tasks/{id}/reactions` groups users by value and gives no time a reaction was added. That's why "when" must
  come from `done_at`, as the spec says.
- **PATCH quirks:**
  - A task PATCH that changes nothing answers 304 (`api()` returns null; `patchTask` reads the task instead).
  - A **project** PATCH ignores `description: ""`: send `<p></p>` to clear it. Task descriptions clear fine.
  - Removing a label a task doesn't have answers **403**, not 404, so check the task's labels first.
- **SQLite:** Vikunja on SQLite, as in the local dev setup, answers 500 "database is locked" while busy with
  notifications. `patiently()` retries 500s, and the run and act senders keep the entry after a 500, up to 5 times.
  A server-side writer will hit this too.
- **Token permissions:**
  - The Task Management preset covers `tasks` (including duplicate), relations, comments, attachments and assignees.
  - Workflows also need **Reactions** and **Projects → Update** (Use as workflow), and Users search to pick who a
    run is for.
- **Write access is enough:** someone with Write on a project can PATCH its description, duplicate, link, react
  and comment.

## Testing gotchas found on the way

- **Playwright's own Chromium isn't installed on this machine.** Run the tests with `BROWSER_CHANNEL=msedge`.
- **`npm run dev` and `npm run test:local` recreate the user's own `pocket-dev` container.** For a separate one:
  1. Copy `scripts/dev.mjs` and change `NAME` and `SSO`.
  2. Set `PORT` and `SSO_PORT`.
  3. For the mock SSO, map `${SSO_PORT}:${SSO_PORT}` and pass `-e SERVER_PORT=${SSO_PORT}`.
- **A smoke run stopped midway leaves tasks due tomorrow on Today.** Those push rows below the fold and break the
  hold-and-slide steps. Delete leftovers whose titles end in a 13-digit stamp.
- **In tests, a hidden toast keeps its text and is only see-through, and Playwright counts it as visible.** Match
  `#toast.show #toast-msg`, and wait for `#toast.show` to be detached before expecting a new toast with the same
  words.
- **`:text-is()` matches the innermost element with the text.** List rows put the title in an inner span, so use
  `:has-text()` for `.row .title`.
- **`workflows.mjs` restores the connection and removes routes after a failed step**, so one failure doesn't take
  the rest down with it.

## Where the new work plugs in

- **Parser:** replace `STEP_OFFSET` / `parseStep` with a `T#` / `{#name}` / `:name` parser. Strip those tokens
  before `parseCapture` runs (the spec's requirement). Keep the "workflow steps" section of `tests/parse.mjs` as the
  place for the spec's parser cases.
- **Validation:** at "Make template" (`makeTemplate`), on reorder (`moveStep`), on adding steps to a template
  (`addSubtasks`), and when starting a run (`startRun`).
- **Run setup:** the `step` stage of `RUN_STEPS` stops writing absolute due dates, except for steps anchored to the
  start. It also adds `follows` relations for anchors, scoped per run by task id.
- **Run screen:** `runView` builds `dueText` and `late`.
  - Countdowns need a ticking clock: today the getter only re-runs on data changes.
  - The spec's "Workspace tab" is the run screen plus the Workflows tab here; ask the user if it means something
    new.
- **Server:** `pocket/main.go` currently has only `NewPlugin` and `NewUnauthenticatedRouterPlugin`. Keep the plugin
  one file (a Yaegi requirement), and put the write path in one clearly labelled function, as the spec asks.

---

## The spec, as the user gave it

# Spec change: relative offsets in workflow steps

Adds timed steps to existing workflows (project → template task with
subtasks → instances). Each step's due time is set when the step it
depends on is ticked done.

## Syntax (in step titles)

    T#20m             due 20 min after the previous step is done
    Dryer in {#dryer} declares an anchor named "dryer"
    T#40m:dryer       due 40 min after the "dryer" step is done
    T#-10m:dryer      due 10 min before the "dryer" step is due

- Time literals follow IEC 61131-3: T#<n><unit>..., units d h m s ms,
  combinable (T#1h30m), optional leading minus.
- A step with no T# is due as soon as the previous step is done.
- Anchors are explicit only, declared with {#name} (markdown attribute
  syntax). No auto-slugs. Names must start with a letter.
- Strip T# tokens and {#…} before quick-add / chrono-node parsing, so
  they never get read as dates, times, or projects.

## Semantics

- Anchorless offsets chain off "previous step" as Pocket links it, so
  reordering and inserting rows just works.
- Anchored offsets fan out: steps hung off the same anchor don't shift
  each other.
- First step with an anchorless T#: anchors to workflow start.
- Offset math uses the anchor task's done timestamp, not the completion
  reaction (reaction records who; timestamp records when).
- Any step with a T# is "hard": it gets a reminder at its due time.
  Steps without T# don't ping.

## Validation

- At instance creation AND on every reorder/insert in Pocket:
  every :name must match a {#name} on an earlier step (no forward refs,
  no cycles). Duplicate {#name} in one template → error.
- Resolve anchors to Vikunja `follows` relations by task ID. Names are
  scoped per instance, so concurrent runs of one template don't collide.

## Recalculation (server-side, inside Pocket's Yaegi plugin)

- Lives in Pocket's existing plugin so ticks from any client (Pocket,
  Vikunja web, API) trigger it.
- Listen on the event bus for task updates; act only on the
  not-done → done transition, so our own due-date writes don't loop.
- Skip templates: ignore done transitions on template tasks/subtasks,
  and never write to dependents already done.
- For each dependent: due = anchor done-time + offset
  (negative: anchor due-time + offset). Relative reminders follow.
- Write path in one clearly labeled function in main.go.
- Config flag to disable recalculation (serve-only mode).
- README: replace "only serves app/" with exactly what the plugin now
  writes and when.

## Workspace tab

- Next step prominent (step-at-a-time), then the next n steps.
- Hard steps: countdown once the anchor is done ("Pull B in 12m");
  before that, a relative label ("40m after Dryer in"), never a
  provisional time.
- Running countdowns pinned to the top regardless of n.

## Open decisions

- Where the offset lives per task: plugin's own table (via migration)
  vs a line in the description.
- Task reopened (Pocket's Undo): leave dependents' due dates, or clear them?

## Tests

- Parser: T# variants, negatives, {#…}, :name; no collision with
  17:30, 10/12, 01.02, 2026-10-12, Todoist-mode #project.
- Undeclared anchor, forward ref (incl. via reorder), duplicate {#name}.
- Chain vs fan-out timing, including a late step.
- Two concurrent instances of one template resolve independently.
- Marking a template done triggers no recalculation.
- Re-saving a done task doesn't recalc; ticks from Vikunja web do.
