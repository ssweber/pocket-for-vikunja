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
