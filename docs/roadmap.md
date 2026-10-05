# Roadmap: how Pocket's code will change

Pocket started as a quick proof of concept, all in one file. It's now meant to last, so this is the plan for how the
code and the way we work on it will change. It's about structure, not features: features are planned in `design/`.

## Where things stand (October 2026)

`pocket/app/index.html` is about 4,700 lines (334 KB, 94 KB gzipped):

- about 340 lines of CSS
- about 700 lines of markup
- about 1,050 lines of helpers with no Alpine in them: the API, dates, quick add (`parseCapture`), checklist steps,
  and sync
- one Alpine component, `Alpine.data('pocket')`, of about 2,550 lines in about 20 marked sections, with 39 getters

What works well, and should stay:

- Installing is copying `pocket/` into Vikunja's plugins folder. Nothing to compile.
- The code is in clearly marked sections.
- The tests drive the real app in a browser against a real Vikunja, and only look at the page. They don't care how the
  code is arranged, so they protect any change to it.

What's starting to hurt: one feature branch changed over 1,200 lines of that one file, which is hard to review, and two
branches at once would keep conflicting in it.

## When to refactor

- Between features, never in the middle of one: in its own pull request, which changes no behaviour, with the tests
  passing before and after.
- It's time when a file no longer fits in your head, when the next feature touches many sections, when the same fix is
  needed in two places, or when changing something feels risky because it isn't clear what reads it.
- The next one is now: before starting reminders (`design/reminders-design.md`).

## The decision: a build step, Alpine kept, one file served

The code is written in many small files under `src/`, and a build script joins them into the one
`pocket/app/index.html` that's served today:

```
src/
  index.html             the page, with markers where the markup's pieces go
  markup/sheet.html …    pieces of the markup
  styles.css
  js/api.js, dates.js, quickadd.js, steps.js, sync.js …
  js/app/auth.js, views.js, checklists.js, sheet.js …    the sections of the Alpine component
scripts/build.mjs   →   pocket/app/index.html
```

`scripts/build.mjs` uses [esbuild](https://esbuild.github.io) to bundle the JavaScript, puts the CSS, JavaScript and
markup pieces into the page, and minifies it.

Why a build step that makes one file, rather than serving many files:

- `sw.js` and `main.go` stay as they are. The service worker answers every file but `index.html` from its saved copy
  first, under a fixed cache name, and the plugin tells the browser to check for a new version only of `index.html`.
  That's right for the libraries, which have their version in their name. A separate `app.js` would let an installed
  Pocket run a new page with old code.
- The service worker finds the files to save by reading `index.html`, so it wouldn't see files that other modules
  import.

Why not React, Vue or Svelte: it would be a rewrite, for no gain Pocket needs. Alpine fits a page like this.

The cost: `pocket/app/index.html` becomes the build's output. It's still committed, so installing is still copying the
folder, and CI fails if it doesn't match `src/`. It's edited only through `src/`.

## Steps, in order

Each step is its own commit, with the tests passing before and after.

1. **Finish `workflows`.** Commit it and merge it into `main`.
2. **The way we work.**
   - Work happens on `dev`, or on a branch from it for something big. `main` is what's released: `dev` is merged into
     it by pull request.
   - [Conventional commits](https://www.conventionalcommits.org): a type, an optional area, then the same plain
     sentence as now, e.g. `feat(checklists): let a step whose step to count from is gone pick the start`. Types:
     `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.
   - Versions follow [semantic versioning](https://semver.org), starting at 0.1.0. Until 1.0, anything may change: a
     new feature, or a change to what Pocket writes into Vikunja (the step times syntax, the marker of a project for
     checklists, the `template` label), goes up to the next 0.x.0; fixes only, to the next 0.x.y. 1.0 is a promise that
     those won't change without a major version.
   - A release is made on GitHub: **Releases → Draft a new release**, a new tag on `main` like `v0.1.0`, and
     **Publish**. The tag is the version: `.github/workflows/release.yml` writes it into `Version()` in `main.go` and
     attaches `pocket-v0.1.0.zip`, the folder to install. In the repo, the version stays `0.0.0-dev`.
   - `.github/workflows/ci.yml` runs the tests on each pull request to `main` and each push to it, not on every push
     to `dev`.
3. **The build, splitting nothing.** `src/index.html` starts as a copy of today's file, and the build only copies and
   minifies it. `npm run dev` rebuilds on every change; the tests and `npm run demo` use the output. Add the CI check
   that the output matches `src/`. This proves the build with nothing else changing.
4. **Split out the easy parts:** the CSS, then the helpers, each in a module of its own. Then `tests/parse.mjs` can
   import `quickadd.js` and run under `node --test`, with no browser.
   - Watch out: the helpers share variables declared with `let` (`app`, `refreshing`, `serverOffset` and others). A
     module can't assign to another module's `let`, so each lives in the module that changes it, which offers a
     function to change it if others need to.
5. **Split the component into its sections**, without changing what it is: each section is a file that exports its
   methods and getters, all merged into the one `Alpine.data('pocket')`.
   - Watch out: merging with `{...auth, ...views}` reads each getter once and keeps the value, so the 39 getters would
     silently stop updating. Merge with
     `Object.defineProperties(target, Object.getOwnPropertyDescriptors(part))`.
6. **Split the markup** into the pieces under `src/markup/`.
7. **Only if needed later:** separate Alpine components for the parts that stand alone (the sheet, the toast, the add
   box), with what they share in an `Alpine.store`.

## Not yet, and when

- **TypeScript.** First, types in JSDoc comments, checked by `tsc --checkJs --noEmit` in CI: no change to the build.
  Switch to TypeScript files only if that stops being enough.
- **Vite.** When Pocket needs packages from npm beyond the two libraries it keeps in `pocket/app/`.
- **A formatter (Prettier).** No: it would rewrite every line of the current compact style. If a linter is wanted,
  ESLint with rules that catch mistakes only, none about style.
