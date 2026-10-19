# Roadmap

This file is about the structure of Pocket's code and how we work on it, not about features. A plan for a feature
lives in `docs/design/` while the feature is being built, and is deleted once it is built.

## What should stay

- Installing is unzipping one folder into Vikunja's plugins folder. Nothing is compiled on the server.
- The tests drive the real app in a browser against a real Vikunja, and only look at the page. They do not care how
  the code is arranged, so they protect any change to it.

## When to refactor

- Between features, never in the middle of one. A refactor is its own commits, changes no behaviour, and has the
  tests passing before and after.
- It is time when a file no longer fits in your head, when the next feature touches many sections, when the same
  fix is needed in two places, or when a change feels risky because it is not clear what depends on the thing being changed.

## Decisions

**One built file, with Alpine kept.** `scripts/build.mjs` uses [esbuild](https://esbuild.github.io) to bundle the
JavaScript, minify it and the CSS, and paste them and the markup's pieces into the page.

- One file rather than many. The service worker answers every request but `index.html` from its saved copy first,
  under a fixed cache name, and the plugin tells the browser to check for a new version of `index.html` only. That is
  right for the libraries, whose version is in their file name, but a separate `app.js` would let an installed
  Pocket run a new page with old code.
- The built page is committed, so the repo's `pocket` folder works as it is, and CI fails if it is not the build of
  `src/`. A source map beside it lets the browser's developer tools show `src/`.
- The two libraries stay separate files in `pocket/app/`. The bundle does not include them.
- Not React, Vue or Svelte. That would be a rewrite, for no gain Pocket needs. Alpine fits a page like this.

**One owner for each thing.**

- Everything done to a task is a method in `app/actions.js`. The lists and the sheet call those methods.
- Each task on screen is one object in `tasks`, by id, made from Vikunja's copy and the ops waiting in the outbox.
- A task's row is one piece of markup, `markup/task-row.html`, wherever it is shown.
- Markup written twice or more is a piece under `src/markup/`, included where it is used. What every add box does
  is one directive, `x-box`.
- A decision written out in the markup is a method with a unit test.

Kept on purpose: one gesture engine with no handlers bound per row, plain tap handlers on each row, and one row
template for every list, with the parts a given list does not show left in it.

**The way we work.**

- Work happens on `dev`, or on a branch from it for something big. `main` is what is released. `dev` is merged into
  it by pull request.
- [Conventional commits](https://www.conventionalcommits.org): a type, an optional area, then a plain sentence, as
  in `feat(checklists): let a step pick which step it counts from`. Types: `feat`, `fix`, `refactor`, `test`, `docs`,
  `chore`, `build`.
- Versions follow [semantic versioning](https://semver.org), starting at 0.1.0. Until 1.0, anything may change. A
  new feature, or a change to what Pocket writes into Vikunja (the step times syntax, the marker of a project for
  checklists, the `template` label), goes to the next 0.x.0. Fixes only go to the next 0.x.y. 1.0 is a promise that
  what Pocket writes into Vikunja will not change without a major version.
- A release is made on GitHub: **Releases → Draft a new release**, a new tag on `main` like `v0.1.0`, and
  **Publish**. The tag is the version. `.github/workflows/release.yml` writes it into `Version()` in `main.go` and
  attaches `pocket-v0.1.0.zip`, the folder to install. In the repo the version stays `0.0.0-dev`.
- `CHANGELOG.md` gets a line under Unreleased for each change a user would notice, in the commit that makes it. A
  change to what Pocket writes into Vikunja is listed on its own. At a release, Unreleased becomes the version and
  the date, and the release notes start from it.
- `.github/workflows/ci.yml` checks the build, runs ESLint and every test on each pull request to `main` and each
  push to it, not on every push to `dev`.

## Before anyone else uses Pocket

- **Upgrading stored data.** Replace the upgrade that empties every IndexedDB store with one step per version that
  never drops the outbox, and give each entry and saved screen a format version. Show an entry Pocket can't read in
  the Outbox with Cancel. Today such an entry breaks the Outbox's list (`op.text`) and the sender (`stagesOf`), and a
  start or a step that an older Pocket saved before they were ops is dropped unsent.
- **Limit what's saved on the phone.** Drop avatars not refreshed in 30 days. When localStorage is full, delete the
  oldest saved screen and try again.
- **Deleted tasks.** In `docs/design/upstream-task-updated.md`, ask Vikunja for a way to learn which tasks were
  deleted, such as the ids deleted since a time, a soft-delete flag a filter can see, or a table of deleted ids kept
  for a set time. If Vikunja declines, build a change log in the plugin from Vikunja's task events. It can't replace
  a checklist's reload, because Vikunja sends no events for labels or reactions.
- **`Retry-After` and `default_due_time`.** Honour a 429's `Retry-After`, which the relay must pass on too. Accept
  `default_due_time` only as `HH:MM`.
- **Test tools.** A `STEP=<regex>` filter for `smoke.mjs`, and a leak check (DOM nodes, Alpine effects, timers) after
  opening the sheet and switching screens many times.
- **To discuss with the user first.** Screen readers (`aria-live` off `#view`, group titles as headings, rows as
  lists). Back restoring the scroll position. A step added under a template waits as a row at the end of its sheet,
  not after the step the box was under, until Vikunja has made it.

## Known gaps

Rare cases, or fixes that would change what the user sees and need deciding first.

- An op refused with 404, because its task was deleted in Vikunja, stays failed for good. A tick, an untick, a
  progress, a finish, a reopen, an edit, a move, a link or unlink, an `assign` and a `label` leave the outbox instead
  (`refusal`).
- Dropping a failed add with no waiting neighbour leaves its parent's progress unwritten.
- A move takes the subtasks Pocket knows of when it is queued (`subtaskTree`). Offline, a subtask Pocket never read
  moves without its own subtasks.
- The Undo of a repeating task's tick whose answer this tab never saw has no dates to check against. It counts any
  date other than the one before as changed since.
- No screen offers an Undo for a person or a label, though their ops have an `invert`.
- An Undo of a cancelled refused change can land behind later changes.
- A person or a label op reads the set Vikunja has once, before its first request (`c.once('set')`, `stages.js`). When
  Vikunja answers that request with a 5xx, the retry sends the same set, so it removes a label a teammate added since.
- `PUT /tasks/{id}/labels/bulk`, and a file's upload through the relay (`fileBody`), have only been sent to the fake
  Vikunja. `test:local` should cover them.
- When the relay can't say whether Vikunja made a start's copy of the template or of a step, the start's Cancel and
  Undo can't find that copy, and leave it (`KNOWN` in `lifecycle.test.mjs`). For a done template, Checklists then
  lists a second template with no steps. The same holds for a step added to a checklist or a template. The template's
  `related_tasks.copiedto` lists the copy, but telling it from a teammate's start would be a guess.
- The Outbox offers no Cancel for a start, an added step, Make template or a template's step once it has sent a
  request and waits. The row's × still cancels a step.
- `hiddenRows` reads every task's waiting ops, so a sheet's subtask list and a screen's groups are worked out again
  whenever an op is queued or answered. The rows don't redraw. Measure before changing it.

## Only if needed

- **Separate Alpine components** for the parts that stand alone (the sheet, the toast, the add box), with what they
  share in an `Alpine.store`. Worth it if one part's data or methods start getting in another's way. Until then,
  one component whose methods are in separate files is simpler.

## Not yet, and when

- **TypeScript.** First, types in JSDoc comments, checked by `tsc --checkJs --noEmit` in CI, with no change to the
  build. Switch to TypeScript files only if that stops being enough.
- **Vite.** When Pocket needs packages from npm beyond the two libraries it keeps in `pocket/app/`.
- **Sending to `/api/v2` directly.** When Vikunja supports the `Idempotency-Key` header
  (`docs/design/upstream-idempotency-key.md` asks for it), point `api()`'s `key` option at `/api/v2`, delete
  `relay.go`, add a migration that drops `pocket_relay`, and raise the minimum Vikunja version.
- **A formatter (Prettier).** No. It would rewrite every line of the current compact style. ESLint checks for
  mistakes only, none about style.
