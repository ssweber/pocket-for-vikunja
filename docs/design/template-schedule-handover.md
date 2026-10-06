# Handover: checklists that come round again (part 4)

Built 2026-10-06: the plan's part 2 now says how. This note is kept as it was.

For the agent building part 2 of `docs/design/checklist-round-out-plan.md`, "Checklists that come round again" (the
last part of the user's round-out PRD to build). Read that section first: it's the agreed spec, and this note doesn't
repeat it. Then `AGENTS.md`, `docs/development.md`, and the code below.

## Where things stand (2026-10-06)

- On `dev`, all six test files green, and pushed to `origin/dev` up to `a8b10cc` (by the user or another session, not
  by the agent that wrote this). Parts 1 and 3 of the plan are built:
  - `9996904` what's waiting to send: the refresh button's icon and the Waiting to send sheet (`src/js/app/outbox.js`);
    an act Vikunja turns down is kept (`failed`), with Try again / Don't send it.
  - `bebf115` a run's own `pocket:order` line, written at every start (the `order` part of `RUN_STEPS`), and steps
    inserted or repeated during a run (`INSERT_STEPS` in `sync.js`, `pocket:added`), with the plugin's timing for them.
  - `0cef46f`, `41b7051`, `a8b10cc` where that lives: quick add's third box, `'ins'`, always there above the step on
    screen in Steps, with 🔁 to put the step before in it; after the last step once all are done.
- Part 4 has not been started: no code, no checks run.

## What the user decided (don't re-ask)

- No scheduler on the server, no API token: **the template itself is Vikunja's repeating task.** A template with a due
  date is left not done, so Vikunja shows it, emails its reminders and moves it on; starting a run ticks it. ("api keys
  isn't very friendly"; "I think that's the cleanest we can do".)
- Any template with a due date comes round: the due date is the cursor. No per-template switch. Pocket isn't released,
  so there's no older data to allow for.
- A run of a template that's due is for the template's assignees, and is due at the time the template was.
- Runs of the same template can be open at once. The PRD's "only one run outstanding" is dropped.
- A template's title starts with `TEMPLATE: `, so it isn't deleted by mistake on the web; Pocket shows the name
  without it everywhere. The `template` label stays what marks a template.
- "From the day it's done" counts from when the run is started (the template is ticked then), not finished.

## Still to discuss with the user before building (UI)

The plan marks these "to discuss before building". Bring the user a short proposal, with a mockup, before writing them:

1. **Today:** a template that's due, shown where any task due then would, with no tick; tapping opens Start; grey
   "Checklist: tap to start". Open question: shown to everyone who can see the project, or only to the template's
   assignees (as a run shows only to its starter and who it's for)? Recommend: its assignees, or everyone if it has
   none.
2. **Checklists:** the template's grey line, "Next: Wed Oct 7, 8:00, then every day", or "Due now".
3. **The template's sheet:** its due date (the Due card is hidden for templates now) and Repeats.
4. **Start sheet "For":** it picks one person; a template may have several assignees. Recommend: all of them,
   preselected, with the chips as now.

## Check first, on the local Vikunja 2.7 (through the API, before any code)

Read so far from Vikunja's source (`pkg/models/tasks.go`, `task_duplicate.go`, main branch), not yet tried on 2.7:

- `updateDone` moves dates only when a task goes from not done to done (`!oldTask.Done && newTask.Done`), by
  `oldTask`'s repeat. So saving a done template's repeat is safe, and taking a repeat off must be its own save before
  the template is marked done.
- Mode 0 (every so often) advances "by at least one interval, even when already at or after now", computed by
  division, so it seems to skip missed times; month mode (1) and from-current-date (2) add one interval.
- Duplicate copies title, description, due date, `repeat_after`, `repeat_mode`, reminders, assignees, labels,
  attachments; not done; adds `copiedfrom`.

To check: how far each mode moves a template left for weeks; that saving a done template's repeat leaves it done; that
Vikunja emails reminders for a not-done template (and sends nothing for a done one); what deleting a template does to
its steps (subtasks stay as tasks, probably). Put what you find in the plan's "Check first" section.

## The code to change

Places that assume **a template is done** (an undone one with a due date breaks each):

- `src/js/app/checklists.js`
  - `loadChecklists`: templates are fetched with `done = true && labels in …`. Fetch them done or not.
  - `checklistRole`: `hasTemplateLabel(t) && t.done` is `'template'`; an undone one would be a `'candidate'`.
  - `keepTemplate` (offline copy for starting a run): skips one that isn't done.
  - `inToday`: returns false for anything labelled template: that's how Today hides templates and runs still being set
    up (a copy has the label until `unlabel`). Telling them apart: a template has no `copiedfrom`... but a run being set
    up does. Check `copiedfrom`, or `isRunDesc`, before showing one.
- `src/js/app/runs.js`: `canTick` (no tick for a template), `openRow` (should open Start for a template), `isRunTask`,
  `stepRun`.
- `src/markup/sheet/task.html`: the Due card is `x-show="!ofTemplate"`; Details has Repeats (`setRepeat` in
  `sheet.js`). Setting or clearing a template's date has to follow the two-save rule above, not the plain `save()`.

Starting a run:

- `openStart` / `startRun` in `runs.js` build the outbox entry; `RUN_STEPS` in `sync.js` does it: `run`, `name`,
  `step`, `order`, `assign`, `unlabel`. `runProgress` counts 5 + 3 per step (and `startRun`'s `total`): add the new part
  to both.
- The `name` part patches the run with `due_date: ZERO`: make it the template's due date when the start ticks the
  template. It doesn't clear `reminders`; duplicate copies the template's, so it must now (`reminders: []`).
- The new `tick` part goes last (so a start called off ticks nothing) and must be safe to send twice: keep the due date
  the start saw, re-read the template, tick only if it's still not done and still at that date. Then, if Vikunja's next
  date is still past, move it to the first time after now on the same beat. `saveTask`'s `landed` check already treats
  a lost reply carefully; read it.
- `assign` replaces assignees with `j.for`; with the template's assignees copied by duplicate, decide with the user
  (point 4 above).

Names: `runTitle(template.title, …)` in `sync.js` builds a run's title; Checklists, the Start sheet, Today and the
template's sheet show `title`. Add one helper that drops `TEMPLATE: ` and use it in each. Make template (`makeTemplate`,
`markTemplate`) and New template (`createTemplate`) write the prefix; renaming in the template's sheet keeps it.

The plugin (`pocket/main.go`) needs nothing: it ignores a template (`isTemplate`), and ticking one isn't a step.

## Working in this repo

- Tests: `BROWSER_CHANNEL=msedge npm run test:local` (Playwright's own Chromium isn't installed; Docker Desktop must be
  running). Never `npm run build` while a test run is going: a new page reloads open Pockets mid-test. To run one file
  against the running Vikunja, log in as `dev` / `dev-password` (`POST /api/v1/login`) and pass the env vars
  `scripts/dev.mjs` sets (`VIKUNJA_URL`, `VIKUNJA_TOKEN`, `OTHER_USER=bob`, …).
- Commit each group as its own conventional commit once its run is green (the user's standing OK); don't push unless
  asked.
- Another session may be editing the repo at the same time: never revert changes you didn't make.
- Scripted edits: backslashes in a JS template literal get eaten (`\\/` → `/`). Use the Edit tool, or a script written
  with the Write tool, and check the result.
- Yaegi (Vikunja's Go interpreter for the plugin) panics on a multi-assignment that mixes an index and an `append`
  (`a[i], s = x, append(s, y)`): one assignment a line.
- Known flake: New template focuses its name field on the next tick; tests wait for that focus before typing. A
  template step-edit test once failed with "reading 'description' of null", then passed twice: watch for it.
- Talk through any UI before building it, and state the rule in labels (see the user's notes in memory and
  `AGENTS.md`). Examples are the café: Alex owns it, Priya is shift lead, "Opening up", "Closing down".
