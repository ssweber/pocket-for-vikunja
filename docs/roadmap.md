# Roadmap: how Pocket's code will change

Pocket started as a quick proof of concept, all in one file. It's now meant to last, so this is the plan for how the
code and the way we work on it change. It's about structure, not features: features are planned in `design/`.

## Where things stand (October 2026, 0.1.0)

Until 0.1.0, all of Pocket was one 4,700-line `pocket/app/index.html`, with one Alpine component of 2,550 lines. Now
it's written in `src/` and built into that one file:

```
src/
  index.html             the page, with its pieces included from markup/
  markup/                the sign-in screen, the app and its screens, the sheet and each kind of sheet
  styles.css
  js/main.js             where the code starts: puts the Alpine component together
  js/*.js                the helpers: the API, dates, quick add, checklist steps, sync, lists, HTML
  js/app/*.js            the Alpine component: its data (core.js), and its methods, a file for each part of the app
scripts/build.mjs   →   pocket/app/index.html (and pocket.js.map)
```

`docs/development.md` says how it fits together.

What works well, and should stay:

- Installing is unzipping one folder into Vikunja's plugins folder. Nothing to compile on the server.
- The tests drive the real app in a browser against a real Vikunja, and only look at the page. They don't care how the
  code is arranged, so they protect any change to it.

## When to refactor

- Between features, never in the middle of one: in its own commits, which change no behaviour, with the tests passing
  before and after.
- It's time when a file no longer fits in your head, when the next feature touches many sections, when the same fix is
  needed in two places, or when changing something feels risky because it isn't clear what reads it.

## Decisions

**A build step that makes one file, with Alpine kept.** `scripts/build.mjs` uses [esbuild](https://esbuild.github.io)
to bundle the JavaScript and minify it and the CSS, and puts them and the markup's pieces into the page.

- One file, rather than serving many: the service worker answers every file but `index.html` from its saved copy
  first, under a fixed cache name, and the plugin tells the browser to check for a new version only of `index.html`.
  That's right for the libraries, which have their version in their name, but a separate `app.js` would let an
  installed Pocket run a new page with old code. So `sw.js` and `main.go` needed no change.
- The built page is committed, so the repo's `pocket` folder works as it is, and CI fails if it isn't the build of
  `src/`. A source map next to it lets the browser's developer tools show `src/`.
- The two libraries stay separate files in `pocket/app/`, as before: the bundle doesn't include them.
- Not React, Vue or Svelte: it would be a rewrite, for no gain Pocket needs. Alpine fits a page like this.

**The way we work.**

- Work happens on `dev`, or on a branch from it for something big. `main` is what's released: `dev` is merged into it
  by pull request.
- [Conventional commits](https://www.conventionalcommits.org): a type, an optional area, then the same plain sentence
  as before, e.g. `feat(checklists): let a step whose step to count from is gone pick the start`. Types: `feat`, `fix`,
  `refactor`, `test`, `docs`, `chore`, `build`.
- Versions follow [semantic versioning](https://semver.org), starting at 0.1.0. Until 1.0, anything may change: a new
  feature, or a change to what Pocket writes into Vikunja (the step times syntax, the marker of a project for
  checklists, the `template` label), goes up to the next 0.x.0; fixes only, to the next 0.x.y. 1.0 is a promise that
  those won't change without a major version.
- A release is made on GitHub: **Releases → Draft a new release**, a new tag on `main` like `v0.1.0`, and **Publish**.
  The tag is the version: `.github/workflows/release.yml` writes it into `Version()` in `main.go` and attaches
  `pocket-v0.1.0.zip`, the folder to install. In the repo, the version stays `0.0.0-dev`.
- `.github/workflows/ci.yml` checks the build, runs ESLint and every test on each pull request to `main` and each push
  to it, not on every push to `dev`.

## Done for 0.1.0

1. Merged `workflows` into `main`.
2. The way we work, above, with CI and the release zip.
3. The build, at first giving back the same file.
4. The CSS into `styles.css`, and the helpers into modules. Each `let` lives in the module that changes it; the few
   that several parts change are properties of `shared`. `tests/parse.mjs` loads the modules from `src/` as they are,
   still in a browser: the HTML helpers need one.
5. The component into a file for each part, put together with `Object.defineProperties` so its 39 getters stay
   getters (a spread, `{...part}`, would read each once and keep the value).
6. The markup into pieces under `src/markup/`.

ESLint came with step 4, to catch names the split left undefined. It also found a test check that could never fail.

## One owner for each thing (October 2026)

Part 2 of `design/fast-tasks-plan.md`, so that the features after it each change one place: a refactor, in its own
commits, with the tests passing before and after.

1. `app/actions.js`: what's done to a task, a method for each thing (ticking, progress, deleting, moving, adding
   subtasks, people and labels, saving a change). Each makes the request, takes the subtasks along, changes the screen
   and offers the Undo; the lists and the sheet call them. Ticking a run or a step in a list or a sheet goes through
   the same tick, which hands it to the outbox and keeps a run's rule: finished with steps not done, it asks first
   and leaves them.
2. One copy of each task on screen: `tasks`, by id (`app/tasks.js`), which every list's rows are, so a change is on all
   of a task's rows at once.
3. One row: `markup/task-row.html` is also the subtasks in a task's sheet. A template's step keeps a row of its own:
   its number where a task has its tick, its time and first line of notes, and quick add's box in its place when it's
   tapped, with ↑ ↓ ×; none of that is a task's, and in the task row it would be in every list's markup. A run's step
   keeps its own too, on the run's screen (its ›, Skip, and who did it). Both share the slot for who's doing it,
   `markup/claim-slot.html`, with the sheet's subtasks.
4. The colours written out in `styles.css` (its shadows and the scrim) are custom properties.
5. Checks in `npm run lint`: `fetch()` only in `api.js`, and no colour written out of `:root` or in `markup/`. And a
   specimen page, `npm run specimen`, with the row in every state, in light and dark.

What's left of one copy of each task, for when a feature needs it:

- A task's sheet has its own copy (`sheet.task`). It shows a change at once and puts it back if it isn't saved
  (`save`), and while saves are under way it doesn't show the replies in between. As the store's copy, the rows would
  show those too: the changes waiting need keeping apart from Vikunja's copy first. The plan's Instant feel (part 9)
  didn't need that: what's waiting is shown from the outbox, and looks waiting only after a few seconds (`slow`).
- The copies of each screen kept on the phone (`saved`), which a screen now opens with before it's loaded, are their
  own copies too: shown, each task gives way to the store's where that's as new (`keptRows`).
- The subtasks in a task's sheet are Vikunja's copies inside the task's own (`related_tasks.subtask`), without their
  people or labels, so they can't be the store's either. Their row differs from a list's in a few ways (its tick,
  title and meta, no progress line), marked `g.sheet` in `task-row.html`, until the plan's Rows make every row the same.
- A run's screen has its own run and steps (`view.run`), and Checklists its templates and the runs finished lately,
  as summaries. The runs in progress under Checklists are the store's.
- `cache` stays Vikunja's last copy of each task.
- Projects (new, rename, archive, delete, use for checklists), templates (`app/checklists.js`) and runs (`app/runs.js`,
  through the outbox) still call `api()` themselves.

## Next, only if needed

- **Separate Alpine components** for the parts that stand alone (the sheet, the toast, the add box), with what they
  share in an `Alpine.store`. Worth it if one part's data or methods start getting in another's way; until then, one
  component whose methods are in separate files is simpler.

## Not yet, and when

- **TypeScript.** First, types in JSDoc comments, checked by `tsc --checkJs --noEmit` in CI: no change to the build.
  Switch to TypeScript files only if that stops being enough.
- **Vite.** When Pocket needs packages from npm beyond the two libraries it keeps in `pocket/app/`.
- **A formatter (Prettier).** No: it would rewrite every line of the current compact style. ESLint checks for mistakes
  only, none about style.
