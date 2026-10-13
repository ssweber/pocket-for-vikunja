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
- Each task on screen is one object in `tasks`, by id. Some copies are not that object yet, listed below.
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
- `.github/workflows/ci.yml` checks the build, runs ESLint and every test on each pull request to `main` and each
  push to it, not on every push to `dev`.

## Copies of a task that are not the store's yet

Rule 1 of `development.md` says every row is the one object in `tasks`. These are not, and may become it when a
feature needs that:

- A task's sheet has its own copy (`sheet.task`). It shows a change at once, puts the change back if the save fails
  (`save`), and hides the replies that arrive while saves are under way. The store's copy would show those replies
  on the rows, so the changes waiting would first need keeping apart from Vikunja's copy.
- The copies of each screen kept on the phone (`saved`), which a screen opens with before it has loaded. Once shown,
  each task gives way to the store's copy where that is as new (`keptRows`).
- The subtasks in a task's sheet are Vikunja's copies inside the task (`related_tasks.subtask`), without their people
  or labels. Their row differs from a list's in its tick, title and meta, and has no progress line (`g.sheet` in
  `task-row.html`).
- A checklist's screen has its own checklist and steps (`view.run`), drawn by the task row (`g.run`). Checklists has
  its templates and the checklists finished lately as summaries. The checklists in progress under Checklists are the
  store's.
- `cache` stays Vikunja's last copy of each task.
- Projects (new, rename, archive, delete, use for checklists), templates (`app/checklists.js`) and checklists in
  progress (`app/runs.js`, through the outbox) still call `api()` themselves.

## Only if needed

- **Separate Alpine components** for the parts that stand alone (the sheet, the toast, the add box), with what they
  share in an `Alpine.store`. Worth it if one part's data or methods start getting in another's way. Until then,
  one component whose methods are in separate files is simpler.

## Not yet, and when

- **TypeScript.** First, types in JSDoc comments, checked by `tsc --checkJs --noEmit` in CI, with no change to the
  build. Switch to TypeScript files only if that stops being enough.
- **Vite.** When Pocket needs packages from npm beyond the two libraries it keeps in `pocket/app/`.
- **A formatter (Prettier).** No. It would rewrite every line of the current compact style. ESLint checks for
  mistakes only, none about style.
