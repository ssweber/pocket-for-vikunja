# Workflows for Pocket — plan

Branch `workflows`. Add **Workflows** to Pocket: reusable step-by-step checklists (a line startup, a café's closing, a
packing list) built entirely on Vikunja data, with no new server. It's an optional feature for anyone using Pocket: it
stays out of sight until a project is made a workflow.

## Constraints from the existing app

- `pocket/main.go` serves `pocket/app/` and needs no change. The README promises the plugin "doesn't touch Vikunja's data".
- All of the app stays in `pocket/app/index.html` (Alpine.js + chrono-node, no build step), with workflows in their own
  clearly marked sections. `sw.js` needs no change.
- Pocket shares Vikunja's origin and sign-in: sanitize all user content (descriptions, comments) before rendering.
- Reuse the outbox (`sync`, IndexedDB) and the attachment upload path; don't build parallel ones.

## Data model (all native Vikunja)

**Workflow projects**
- A workflow is any project whose description has a line `pocket:workflow`. A plain "workflow" in prose doesn't count.
- **Use as workflow** in Pocket (a project's menu) adds the marker, so nobody has to know it.
- Teams get a workflow project shared at **Write**. Keeping them under a parent project nobody else can see is optional
  and tidy, and Pocket doesn't rely on it: a child shared without its parent is listed with its description (verified).

**Templates**
- A template is a task in a workflow project with the label `template`, **marked done**. Its steps are its subtasks,
  **also marked done**. Duplicates come back not done regardless.
- **Make template** (Pocket, on a task in a workflow project): steps come from the existing paste-a-list subtasks;
  Pocket adds the label and marks the template and its steps done.
- **Step order = the order the subtask links were created.** The API, the web task detail and the web List view all
  show link order; ID, title and position don't change it (verified). The web app can't reorder, and a step added
  there goes to the end. Pocket's template editing gets **move up/down** (unlink and relink the steps after it).
  No number prefixes.
- Optional timing on a step title: `^30m`, `^2h`, `^14d` = due that long after the run starts. `^` isn't used by
  Quick Add Magic; `~` is avoided because the editor makes `~~x~~` strikethrough.
- A template step can carry its own assignee (say QA); duplicating copies it.
- Operators with Write *can* edit templates on the web. Accepted.

**Runs**
- **Start ‹template›** asks who the run is for (default: me; others from the project's users, as `loadPeople` does), then:
  1. `POST /tasks/{template}/duplicate` → the run: same project, not done, description/labels/assignees/attachments/
     reminders copied, `copiedfrom` added by Vikunja.
  2. Remove the `template` label from the run; `PATCH` the title to `‹Template› #N — ‹date›` and the due date to its last step's.
  3. Assign the **run** (only the run) to the chosen person. Assigning steps would send a notification per step (verified).
  4. Per step, in template order: `POST /tasks/{step}/duplicate`, `POST /tasks/{run}/relations` `subtask`, `PATCH` the title
     (`^…` stripped) and due = start + offset.
- About 1 + 3N requests: confirm before starting, show progress, resume where it stopped if cut off (like LINE_STEPS),
  and Undo by deleting the run. Retry 500s as well as the usual transient errors: Vikunja on SQLite answered
  "database is locked" 500s while building a run (verified). A relation that already exists (4008) counts as done.
- `#N` = `template.related_tasks.copiedto.length`. Can repeat on simultaneous starts or a deleted run; acceptable.
- **Who did a step:** a ✅ reaction from whoever ticks it, removed on untick. Assignees keep meaning "who it's for".
  Reactions record the user and the time, adding the same one twice is fine (safe to retry from the outbox), and the web
  shows them on the task. Read with `GET /tasks/{id}?expand=reactions`. Embedded subtasks don't carry reactions, so a
  run screen loads its steps' reactions itself (try `expand=reactions` on a task list first).
- **Skip** = done + ✅ + an automatic "Skipped" comment, so the run can finish and the reason is kept.

## UI

- **Workflows tab:** shown only when the user can see a workflow project. With three tabs, Today / Projects / Workflows
  become icon-only (labels kept for screen readers); with two they keep their labels. Fix `aria-current` on Projects,
  which is currently "anything not Today".
  - Per workflow: **Start ‹template›** buttons, and **In progress**: open runs (teammates' too), who each is for, and the
    current step, so a run can be resumed or handed over.
- **Run screen:** one step at a time, large tick targets, Skip, due times from offsets (late ones in red), an optional
  photo per step, notes as comments. `addFiles` and `postComment` take a task id instead of reading `sheet.task`.
  - **Last time:** a read-only card with the comments from the most recent finished run of the same template, including
    those on its steps. Nothing is copied into the new run.
  - **Finish:** after the last step, "Finish run?" with a summary (skipped, late) marks the run done.
- **Today:** a workflow run and its steps show only for runs you started or that are assigned to you, plus any step
  assigned to you directly. The step's embedded parenttask has no `created_by` and no assignees (verified), so Pocket
  matches steps against the open runs it loads for In progress.
- **Patchy network:** ticks, unticks, skips, reactions, notes and photos go through the outbox and work offline. The
  run screen opens from its saved copy. Starting a run still needs a connection, since duplicating happens on the server.

## Build order

1. Workflow discovery (`pocket:workflow`), **Use as workflow**, the Workflows tab and the icon-only tab bar.
2. **Make template** and step reordering.
3. Starting a run (assign to, progress, resume, Undo).
4. The run screen: ticks with ✅, Skip, photos, notes, Last time, Finish. The Today rule.
5. Offline ticks, skips and notes through the outbox.
6. Tests (smoke + offline), README "Workflows (optional)" section, demo screenshots.

## Out of scope for v1

- Starting runs offline.
- Branching steps. A later convention could be a `?flag` marker on optional steps.
- Custom fields and reporting (see "Later").

## Later: custom fields plugin

A **separate, optional** yaegi plugin, not part of `main.go`, since it creates a table in Vikunja's database and Pocket
promises not to touch Vikunja's data. Vikunja has no custom fields and plugins are backend-only, so fields would show only in Pocket.

- **`MigrationPlugin`:** a `task_fields` table (task_id, key, value, updated_by, updated_at).
- **`RegisterAuthenticatedRoutes`:** GET/PUT a task's fields. Bearer token; user from `user.GetCurrentUserFromDB(s, c)`;
  check task access through `models` before reading or writing.
- **Receipt comment** on save ("Fill weight: 512 g · Temp: 68 °F"), so the web app shows the values.
- **CSV export route** for reporting.
- Yaegi: one `.go` file per plugin; typed factories (`NewAuthenticatedRouterPlugin`, `NewMigrationPlugin`); available
  packages are `db`, `events`, `log`, `models`, `plugins`, `user`, `config`, xorm/xormigrate (2.6+), Echo v5, and the standard library.

## Small follow-ups

- ~~Priority meter~~: done in 5737c54. ~~Storage persist~~: `sync.keep()` already does it.
- **CI smoke test:** boot the latest Vikunja image, load the plugin, check `/api/v1/plugins/pocket/` returns 200.

## Verified on Vikunja 2.7.0 (2026-10-03)

1. A child shared with a team at Write, without its parent: listed in `GET /projects` with `parent_project_id` and
   description; `GET /projects/{parent}` is 403.
2. `copiedfrom`/`copiedto` exist; `POST /tasks/{id}/duplicate` adds `copiedfrom`, copies labels (including `template`),
   not subtasks, not reactions; the copy is not done and created by the caller.
3. API v2 `POST /tasks/{id}/relations`. An operator with Write can duplicate, relabel, link, patch, comment, attach and react.
   An outsider gets 403.
4. Subtask order is link order everywhere (API, web detail, web List view).
5. Assigning a task to someone else sends them a `task.assigned` notification, one per task.
6. Reactions: `POST /tasks/{id}/reactions` is idempotent, `…/reactions/delete` too; other team members see who reacted.
7. A step's embedded `parenttask` has no `created_by` and no assignees.
8. API token: `tasks.duplicate`, `tasks_relations.create` and reactions are separate permissions. **Still to check:** what
   the "Task Management" preset includes; list anything missing in the sign-in note and README.
