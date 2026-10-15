# Developing Pocket

This file is the map: where things are, the rules that hold across files, and what has tripped people up. What a
function or a file does is in a comment where it is, and this file does not repeat it. A plan for a feature lives in
`docs/design/` only while the feature is being built, and is deleted once it is built. From then on the code and its
comments carry the reasons.

## Where things are

```
src/           the app's code. npm run build turns it into pocket/app/index.html
  index.html   the page. The build pastes the pieces from markup/ into it
  markup/      the pieces: one file for each thing drawn in more than one place (a task's row, a stacked card, a
               ring, a gap, a message, an add box's chips). screens/ has the screens and sheet/ has the sheets
  styles.css   all of the CSS
  js/          main.js starts the app. component.js assembles the Alpine component from app/. The other files are
               helpers that know nothing of the screen
  vendor/      Alpine as published, patched for long lists (see Upgrading the libraries)
pocket/        the plugin, as it is installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  relay.go     passes Pocket's writes on to Vikunja's API, so a write sent twice is made once
  app/         the built app, Alpine and chrono, and sw.js, the service worker that lets Pocket open offline
tests/         the end-to-end tests, helpers.mjs (what they share), and unit/ (the tests that need no browser)
scripts/       build.mjs, dev.mjs (a local Vikunja), check.mjs (what lint checks besides ESLint), demo.mjs (the
               README's pictures), specimen/ (every state of a row on one page), perf/ (timing long lists)
docs/          this file, guide.md (for people using Pocket), design-rules.md and roadmap.md
```

Each file in `src/js/` starts with a comment saying what it is for. By what you are changing:

| Changing | Look in |
|---|---|
| What is done to a task (tick, progress, delete, move, reorder, save), each with its Undo | `app/actions.js` |
| The tasks on screen, one object each | `app/tasks.js` |
| A screen's lists, what a row may do on each, and the copies kept on the phone | `lists.js`, `app/views.js`, `app/sending.js` |
| A task's row | `markup/task-row.html`, `app/views.js`, `app/claims.js` |
| Stacked cards and a parent's ring | `cards.js`, `app/cards.js`, `markup/list-item.html`, `markup/ring.html` |
| A swipe, a hold, a nudge | `progress.js`, `app/progress.js`, `haptics.js` |
| Holding a task on Today to change its date | `throw.js`, `app/throw.js` |
| Ticked or deleted rows leaving together | `batch.js`, `app/leaving.js` |
| What Pocket says, and where | `messages.js`, `app/lines.js`, `app/toast.js` |
| Quick add: parsing a line or a pasted list, the add boxes, the box under a row | `quickadd.js`, `app/quickadd.js`, `app/seat.js` |
| What is waiting to be sent, and sending it | `sync.js`, `app/sending.js`, `app/outbox.js`, `app/acts.js` |
| A kind of change sent through the outbox: its requests, what it does to the task, its words | `ops/` |
| Checklists: templates, checklists in progress, timed steps | `checklists.js`, `app/checklists.js`, `app/runs.js`, `app/alerts.js` |
| What a step asks to record: the fields on its card, the answers, and the editor on a template step | `asks.js`, `app/asks.js` |
| A task's sheet | `app/sheet.js`, `markup/sheet/` |
| A project's task order | `order.js` |
| Due dates, as stored and as shown | `dates.js` |
| Which screen a URL opens | `routing.js` |
| Sharing and copying | `share.js`, `app/sharing.js` |
| Signing in, and opening offline | `api.js`, `app/auth.js`, `pocket/app/sw.js` |
| Notes and comments from Vikunja, made safe | `html.js` |

The code calls a checklist in progress a run (`app/runs.js`, `view.run`). The screen calls it a checklist.

## How it is built

The app is plain CSS and JavaScript, with [Alpine.js](https://alpinejs.dev) keeping the screen in sync with the data.
`npm run build` bundles `src/` into one file, `pocket/app/index.html`, with a source map (`pocket.js.map`) and
compressed copies (`index.html.br`, `index.html.gz`) beside it. `main.go` sends a compressed copy to a browser that
accepts one. All of them are committed, so the `pocket` folder works as it is. Edit `src/`, never `pocket/app/`. CI
checks that `pocket/app/` is the build of `src/`, and the build gives the same bytes on every computer. Dates are
parsed by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (`parseCapture`).

## How the code is put together

- The JavaScript is ES modules. The helpers in `src/js/` know nothing of the screen, and the unit tests check them.
  When a part of the component needs arithmetic or parsing, that goes in the helper of the same name (`progress.js`
  beside `app/progress.js`).
- The Alpine component, `pocket`, is one object. `app/core.js` holds its data and what happens when Pocket opens.
  Each other file in `app/` adds methods, and `component.js` assembles them. In those methods `this` is the
  component, so any method can call any other.
- A module cannot assign to another module's variable. A variable lives in the module that changes it. The few that
  several parts change are properties of `shared` in `app/core.js`.
- The markup sees the component's data and methods, and the few helpers `component.js` lists as globals. A helper
  used in the markup must be added to that list.
- `component.js` defines the markup's own directives: `x-style` (what `:style` does with an object, without the
  timer Alpine starts), `x-grow` (a text box as tall as its text) and `x-box` (every add box is one).
- A decision longer than a line is a method, not an expression in the markup. See `tickRow`.

## Rules that hold across files

How Pocket looks and responds to touch follows the nine rules in [`design-rules.md`](design-rules.md). Check a
change against them, and say where it bends one. The code's own rules:

1. **One object for each task.** Every list's rows are the objects in `tasks`, by id, so a change shows on all of a
   task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` is separate: it holds
   Vikunja's last copy of each task, for an Undo to compare with.
2. **One row, everywhere.** `markup/task-row.html` is the row in every list, on a card, in a sheet and on a
   checklist's screen. The list's options object `g` (`screenRows`, `lists.js`) says what the row shows there. The
   gesture code cannot reach `g`, so the row writes the gestures it allows on itself (`data-gestures`). Each place
   that includes the row names its kind of list (`<!-- include markup/task-row.html run -->`). Markup that only some
   kinds need sits between `<!-- only run sheet -->` and `<!-- /only -->`, and the build leaves it out of every
   other copy (`scripts/build.mjs`).
3. **The markup calls actions, never `api()`.** Each action makes the request, changes what is on screen and returns
   the way to undo it. A run and its steps go through the outbox instead, as ops (`act`, `app/acts.js`, `ops/`),
   each request with a key, so it is made once however often it is sent. `fetch()` is only in `api.js`, and lint
   enforces that.
4. **A change shows at once, as it will be.** It looks "waiting" only after `WAIT_MS`, or with no connection. A task
   not yet sent is already where it will be on its list, so it does not move once it is sent.
5. **A ticked or deleted row stays where it is,** marked (`leaving`), until the batch clears: 3 seconds after the
   last mark, and never while a finger is down. What is on screen is computed from what is done and what is marked.
6. **Pocket says what happened where it happened** (`say`, `app/lines.js`): on the row, or in a fixed place on the
   screen. The toast is for what has neither. The words are in `messages.js`.
7. **Only the row moves on a swipe,** by its transform alone. What it uncovers is a layer lying still under it.
   Nothing bounces, and no two animations have to keep step.
8. **Nothing on screen may move when late data arrives.** Data that loads late is drawn below anything the user
   could be touching, or is held back and drawn together with the rows it belongs to.
9. **A long screen is drawn in batches** (`drawFrom`, `app/views.js`), and `#view` is `aria-busy` until every row is
   drawn. A list's `x-for` iterates `drawn(g)`, gets the list unwatched (`raw`) and is keyed by a path into the item
   (`:key="t.id"`).
10. **A change to one row costs one row.** Each row has about 30 bindings, and Alpine recomputes a binding whenever
    anything it read is a different object, changed or not. So:
    - what every row reads stays the same object and changes inside (`shownGroups`, the screen's `route`);
    - what is said of one task is read by that task's id (`leaving`, `lit`, `flashed`, `waiting`), never by
      searching a list;
    - an expensive getter many bindings read is a `memo` (`util.js`), as `runView` is;
    - the clock re-renders a screen only when the time changes what the screen shows (`runNow`);
    - a touch-start handler walks the list at most once, and draws nothing.

    `listGroups` returns plain groups, and a new one whenever anything in it changed. Never change one in place.
    Count the bindings before and after adding something every row reads (`npm run perf:rows -- counts`).
11. **Content from Vikunja goes through `sanitize`** (`html.js`) before it is shown. Pocket shares Vikunja's origin
    and sign-in, so a script in a description would run as the user.
12. **Colours are custom properties** in `styles.css`'s `:root`, with dark mode's values in the block after it. Lint
    fails on a colour written anywhere else. The sizes a row is laid out by are custom properties too: `--tick` and
    `--title-x`, and a subtask's smaller tick and indent, `--sub-tick` and `--sub-in`. Type is one scale: 17, 15, 14
    and 13px, and 22px for a sheet's title. An input never goes under 16px, or an iPhone zooms in.
13. **`motion()` in `util.js` is the one place that asks whether the user wants less motion.** Every vibration goes
    through `haptic()`, because an iPhone has no `navigator.vibrate`.
14. **`sw.js` caches the libraries by file name,** so a changed file under an old name never reaches an installed
    Pocket. A new file in `pocket/app/` needs a caching decision there.

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456` on Postgres, with the plugin loaded from `pocket/`,
step times on and a mock single sign-on provider, and prints Pocket's address. `DB=sqlite npm run dev` (or `test:local`)
runs Vikunja on SQLite instead, and `DB=mysql` on MySQL. The containers are `pocket-dev`, `pocket-dev-sso` and
`pocket-dev-db`. The next run replaces them. Sign in as `dev` / `dev-password`, or with **Mock SSO**. `dev` shares a
project called Team with `bob`, and its default project with `carol`, so a task there shows **+ me**. The tests rely on
that, so against your own Vikunja, share the test account's default project with someone. `npm run dev` rebuilds the
page as `src/` changes, so an edit shows when you reload. Ctrl+C stops the rebuilding. Vikunja keeps running. After
changing `main.go`, run `npm run dev` again.

## Tests

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run lint                       # ESLint, and what scripts/check.mjs checks
npm run test:unit                  # the unit tests, in a second
node --test tests/unit/actions.test.mjs                         # one file of them
node --test --test-name-pattern="Undo" "tests/unit/*.test.mjs"  # the tests whose name says Undo
npm run test:parse                 # quick add's phrases only
npm run test:local                 # starts the local Vikunja and runs every test

# against a real server with the plugin installed (use a test account). Pocket signs in with the user and password.
# The tests' own requests use the token, an API token of the same user with every permission.
VIKUNJA_URL=https://tasks.example.com VIKUNJA_USER=... VIKUNJA_PASSWORD=... VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=<username> ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user
```

`npm run test:local` prints how long each file and each end-to-end step took. CI runs `lint`, `test:unit` and
`test:parse` in one job, and `test:local` in another.

Every test's name is a sentence saying what it checks, so the files are their own list. A change in behaviour comes
with a test in the file for its area:

- `tests/unit/*.test.mjs`: the helpers and the component's methods, in Node, with no server, one file per area.
  `fake.mjs` is a pretend Vikunja behind `fetch()` and a pretend component. `browser.mjs` is what the modules expect
  of a browser. `reactive.mjs` runs the reactive part of Pocket's Alpine, to test what is recomputed as data
  changes. There is no DOM, so tests that read a task's notes stay in `parse.mjs`.
- `tests/parse.mjs`: how quick add reads about 770 phrases and pasted lists, most adapted from Vikunja's own tests.
- `tests/smoke.mjs`: Pocket end to end in a headless browser against a Vikunja with the plugin: tasks, lists, the
  sheet, gestures, Today, quick add, sharing.
- `tests/checklists.mjs`: checklists end to end, in a project of their own.
- `tests/offline.mjs`: with the connection cut, Pocket opens, queues, and sends once the connection is back.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side, signing in and out on either.
- `tests/steptimes.mjs`: the plugin's step times, through the API only.
- `tests/relay.mjs`: the plugin's relay, through the API only. A write sent twice with one key is made once.

The tests delete what they create, except the labels `pocket-smoke` and `template`.

### Writing an end-to-end test

`tests/helpers.mjs` has what the tests share. Its comments say how each helper works.

- **Find things by role and name** with Playwright's `expect`, which retries until it passes:
  `page.getByRole('button', {name: 'Mark done: ' + title})`. Not `waitForSelector` and a check.
- **Move the page's clock instead of waiting** for anything the page decides (`later(ms)`, at the top of `smoke.mjs`
  and `checklists.mjs`): a task becoming overdue, a countdown reaching zero, ticked rows leaving together
  (`later(3000)`). Vikunja's clock is real, so the few real waits are for dates Vikunja sets itself, and say so.
- **Wait for Pocket to load with `loaded(page)`** before a test reads the screen. A screen opened again shows its
  saved copy first, and a long one draws its rows in batches. Wait for something on the new screen first.
- **Wait for Pocket to send with `synced(page)`** before checking Vikunja or deleting what the test made.
- **Swipe with `swipeRow(page, sel, to)`,** which computes where to let go with the app's own arithmetic. What a
  swiped row uncovers is not inside the row: find it with `uncovered(page)`.
- **A mouse is not a finger.** For what only a touch triggers (`touch-action`, a cancelled touch, the page scrolling
  under it), `finger(page)` gives Chrome's own touch input.

## Gotchas

- **The page's own timers.** Today checks the time once a minute, a checklist's screen reloads every 20 seconds,
  lines and toasts fold after 5 seconds, and ticked or deleted rows leave 3 seconds after the last mark. A test that
  waits in real time collides with them. Right after `later()`, `waitForSelector` can stall: use `expect`, or
  `waitForFunction` with `polling: 100`.
- **Many timers at once are slow under Playwright's clock.** 1,000 `setTimeout(0)` calls take 15 seconds. Alpine's
  `:style` with an object starts one each time it is evaluated, which is why `x-style` exists and lint keeps `:style`
  to strings. Anything else that starts a timer per row brings this back (`window.__pwClock.controller._timers`
  lists them).
- **The batch runs on the page's clock, which keeps real time.** A test that ticks a row, then reads Vikunja before
  ticking it again, has 3 real seconds before the row leaves. Move the clock past the batch after `synced(page)` for
  a tick, or after `#said` says "Deleted: …" for a deletion. `page.mouse.down()` holds the batch, as a finger does.
- **Alpine applies `x-if` and `x-show` a frame apart,** so one part of a change can be on screen before the other.
  `$nextTick` runs on a timer, which Playwright's clock owns.
- **What you put in the component's data comes back as Alpine's proxy of it.** After `this.places.cap = line`,
  `this.places.cap === line` is false. Compare what the store gives back. The unit tests have no Alpine, so a test
  of this uses a stand-in store that also returns a copy.
- **Alpine's `x-for` reorders whatever follows its `<template>`.** An element of ours placed among the rows is
  swapped with the next row each time the list is drawn. Put it before the template.
- **The build removes the markup's comments and indentation** (`lean`, `scripts/build.mjs`). Two inline elements on
  separate lines get no space between them. Write them on one line, with the space, to keep it.
- **An `x-if` or `x-for` template inside another template is empty in the built page.** The build moves its content
  to a `<template id="part-N">` and names that template on it (`data-from`; `shared`, `scripts/build.mjs`), so a row
  is not cloned with the content of every template inside it. Only `x-if` and `x-for` read `data-from`.
- **`:text-is()` matches the innermost element** with that text. Prefer `getByRole` with a name, or `:has-text`.
- **`toContainText` is case-sensitive;** `:has-text` is not. Given a regular expression, `toHaveText` does not fold
  the markup's line breaks into spaces.
- **`.sec + .list` misses a group's list** when its heading has a message under it. Use `.sec ~ .list`.
- **Vikunja leaves a task's reactions out** unless the request asks with `?expand=reactions`. A test that checks a
  ✅ or a ⏭️ reads the task that way.
- **Vikunja keeps times in whole seconds.** Two changes less than a second apart can carry the same `updated`, and a
  due time set by a test comes back rounded down.
- **Vikunja on Postgres returns a task's subtasks in no set order.** A test sorts them by id and finds one by its
  id, not by its place in the sheet. On SQLite Vikunja now and then answers 500 "database is locked". The tests'
  requests retry, as Pocket's do.
- **A row to hold must be on screen,** clear of the top and bottom edges, where moving it scrolls the list. Scroll
  it to the middle first.
- **A hold on Today is detected on the page's clock, but its date chips appear on real frames.** `datesSeen()` in
  `smoke.mjs` waits for them. A dimmed date is `aria-disabled`, which `click()` waits on, so tap it by its
  coordinates.
- **A click focuses a button in Chrome. A tap on an iPhone does not.** A test of what happens to a field's focus
  opens the sheet with nothing focused.
- **A pending row is `.row.pending` from the start, and `.waits` only after `WAIT_MS`.** Move the clock to see it.
- **The one-time hint adds a line to a screen's first row** on a phone that has never swiped one. The tests dismiss
  it from the start (`hintSeen(context)`). A new browser context in a test needs it too.
- **Low Power Mode on an iPhone** animates a width at half the frame rate of a transform. Desktop Chrome cannot show
  this. Rule 7 exists because of it.
- **Vikunja evaluates every `.go` file in `pocket/` into one package,** in name order. A file can use what an earlier
  file defines, but can't import a package an earlier file imports ("redeclared in this block"). `relay.go` relies on
  `main.go`'s imports.
- **Never run `npm run build` while tests run.** A changed page makes the open copies reload in the middle of a test.
- **Never stop processes by name** (`taskkill /IM`, `pkill`). That closes the user's own Chrome and Node. Stop only
  what you started, by PID, or the `pocket-dev` containers.
- **On Windows,** Git Bash eats backslashes in a heredoc. Write code with backslashes with the Edit tool, or from a
  file. `.gitattributes` keeps line endings LF. Without Playwright's own Chromium, `BROWSER_CHANNEL=chrome` uses the
  installed Chrome, for `test:parse` too.

## Measuring

`scripts/perf/` times Pocket with long lists, in Chrome, against a Vikunja of its own (`pocket-perf`, on port 3470)
seeded with a busy project. `npm run perf` times opening each screen. `npm run perf:rows` times a tick, a swipe, an
add, the start of a scroll and a checklist left alone. Its README says how, and keeps the numbers. Measure before
and after any change that could slow a long list: something called for every row, a new `x-for`, something per row
on every change.

## The README's pictures

With `npm run dev` running, `npm run demo` remakes the GIFs and screenshots in `docs/screenshots/`. It drives the
real app in a phone-sized browser with a small café's made-up tasks for two users of its own, `alex` and `jamie`,
and the page's clock fixed, so the dates in the pictures always match the README. Examples in the README and the
guide use the same café. Run it after changing how Pocket looks.

## The specimen

`npm run specimen` makes `specimen/index.html`: the task row, the stacked card, a parent's ring, the sheet, a
checklist's screen and the add boxes in every state, light and dark side by side. It uses the real stylesheet and
Pocket's own component with made-up tasks (`scripts/specimen/`), and needs no server. A new state of a row or a box
gets a place there. Git ignores it, and nothing in `pocket/app/` refers to it.

## Upgrading the libraries

Both libraries are kept in the repo, not loaded from a CDN.

- **Alpine** is kept readable, as published, in `src/vendor/alpine-<version>.js`, with three patches for long lists,
  each change marked with a comment starting `Pocket:`: the scheduler (commit 70f4fdd), whose queue was quadratic,
  `x-for` (commit aea10ac), which keeps the rows at the start of a list that have not moved, and `x-for` and `x-if`
  (commit 6f31fc3), which clone the content of the template theirs names (`data-from`).
  `tests/unit/alpine.test.mjs` checks all three, and that `memo` can still set an effect's own scheduler. The build
  minifies it into `pocket/app/alpine-<version>-pocket.<N>.min.js`, which the `<script>` tag in `src/index.html`
  names. To upgrade, or to change a patch: replace the file with the new version's `dist/cdn.js`, commit it as
  published, redo each `Pocket:` change (`git show 70f4fdd aea10ac 6f31fc3`), run `npm run test:unit`, give the
  `<script>` tag the new version and the next `N`, delete the old file from `pocket/app/`, and measure a long list
  before and after.
- **chrono** is `pocket/app/chrono-<version>.en.min.js`, the English-only build, from
  `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the
  Alpine `<script>` tag in `src/index.html`.
