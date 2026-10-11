# Developing Pocket

This file is the map: where things are, the rules that hold across files, and what has tripped people up. What one
function or one file does is said in a comment where it is, and this file doesn't repeat it. Why a feature is the way
it is, is in its plan in `docs/design/`.

## Where things are

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the pieces: one file for each thing drawn in more than one place (a task's row, a stacked card, a
               ring, a gap, a message in its place, an add box's chips), the screens in screens/, the sheets in sheet/
  styles.css   all of the CSS
  js/          main.js, where the code starts; component.js, which puts the Alpine component together; the helpers,
               which know nothing of the screen; and app/, the parts of the component
  vendor/      Alpine as published, patched for long lists (Upgrading the libraries, below)
pocket/        the plugin, as it's installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  app/         the built app, the libraries it uses, and sw.js, which lets it open offline
tests/         the end-to-end tests, helpers.mjs (what they share), and unit/, the tests that need no browser
scripts/       build.mjs, dev.mjs (a local Vikunja), check.mjs (what lint checks besides ESLint), demo.mjs (the
               README's pictures), specimen/ (every state of a row on one page), perf/ (measuring long lists)
docs/          this file, guide.md (for people using Pocket), design-rules.md, roadmap.md, and design/ (plans)
```

Each file in `src/js/` starts with a comment saying what it's for. By what you're changing:

| Changing | Look in |
|---|---|
| What's done to a task: a tick, progress, a delete, a move, its order, a save, each with its way back | `app/actions.js` |
| The tasks on screen, one object each | `app/tasks.js` |
| A screen's lists, what each lets a row do, and the copies kept on the phone | `lists.js`, `app/views.js`, `app/sending.js` |
| A task's row, and what it asks of the component | `markup/task-row.html`, `app/views.js`, `app/claims.js` |
| Stacked cards and a parent's ring | `cards.js`, `app/cards.js`, `markup/list-item.html`, `markup/ring.html` |
| A swipe, a hold, a nudge | `progress.js`, `app/progress.js`, `haptics.js` |
| A task held on Today, its four dates | `throw.js`, `app/throw.js` |
| Rows ticked or deleted, leaving together | `batch.js`, `app/leaving.js` |
| What Pocket says, and where | `messages.js`, `app/lines.js`, `app/toast.js` |
| Quick add: reading a line, a pasted list, the add boxes | `quickadd.js`, `app/quickadd.js` |
| What's waiting to be sent, and sending it | `sync.js`, `app/sending.js`, `app/outbox.js` |
| Checklists: templates, runs, timed steps | `checklists.js`, `app/checklists.js`, `app/runs.js`, `app/alerts.js` |
| A task's sheet | `app/sheet.js`, `markup/sheet/` |
| A project's order | `order.js` |
| Due dates, as kept and as shown | `dates.js` |
| Sharing and copying | `share.js`, `app/sharing.js` |
| Signing in, and opening without the network | `api.js`, `app/auth.js`, `pocket/app/sw.js` |
| Notes and comments from Vikunja, made safe | `html.js` |

## How it's built

The app is plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the
data. `npm run build` puts `src/` into one file, `pocket/app/index.html`, with `pocket.js.map` next to it and the page
compressed (`index.html.br`, `index.html.gz`), which `main.go` sends to a browser that takes it. All of them are
committed, so the `pocket` folder works as it is. Edit `src/`, never `pocket/app/`'s copy: CI checks that it's the
build of `src/`, and the output is the same bytes on every computer. Dates are read by
[chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (`parseCapture`).

## How the code is put together

- The JavaScript is ES modules. The helpers in `src/js/` know nothing of the screen: sums and words, which the unit
  tests check. Where a part of the component has sums, they're in the helper of the same name (`progress.js` beside
  `app/progress.js`).
- The Alpine component, `pocket`, is one object: `app/core.js` has its data and what happens when Pocket opens, each
  other file in `app/` adds its methods, and `component.js` puts them together. In those methods `this` is the
  component, so any of them can call any other.
- A module can't assign to another module's variable. A variable lives in the module that changes it; the few that
  several parts change are properties of `shared`, in `app/core.js`.
- The markup sees the component's data and methods, and the few helpers `component.js` lists as globals. A helper
  used in the markup has to be added there.
- `component.js` has the markup's own directives: `x-style` (what `:style` does with an object, without its timer),
  `x-grow` (a text box as tall as its text) and `x-box` (an add box: every one is this).
- A decision longer than a line doesn't go in the markup: it's a method, beside `tickRow`.

## Rules that hold across files

How Pocket looks and what a finger does on it follow nine rules, in [`design-rules.md`](design-rules.md). Check a
change against them, and say in its plan where it bends one. These are the code's own:

1. **One object for each task.** Every list's rows are the objects in `tasks`, by id, so a change shows on all of a
   task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` is apart: Vikunja's last
   copy, for an Undo to compare with.
2. **One row, everywhere.** `markup/task-row.html` is the row in every list, on a card, in a sheet and on a run. Where
   it is changes only what it shows, and that's said by its list's options, `g` (`screenRows`, `lists.js`). The
   gesture code can't reach `g`, so the row writes what it allows on itself (`data-gestures`).
3. **The screen calls actions, never `api()`.** Each action makes the request, changes what's on screen and gives the
   way to take it back. A run and its steps go through the outbox instead (`act`, `app/runs.js`). `fetch()` is only
   in `api.js`; lint says so.
4. **A change shows at once, as it will be.** It looks waiting only after `WAIT_MS`, or with no connection. A task
   not sent yet is already where it'll be on its list, so it doesn't move once it's sent.
5. **A row ticked or deleted stays where it is,** marked (`leaving`), until the batch clears: 3 seconds after the
   last mark, never while a finger is down. What's on screen is worked out from what's done and what's marked.
6. **Pocket says what happened where it happened** (`say`, `app/lines.js`): on the row, or in a place on the screen.
   The toast is for what has neither. The words are in `messages.js`.
7. **Only the row moves on a swipe,** by its transform alone. What it uncovers is a layer laid still under it. Nothing
   bounces, and no two animations have to keep step.
8. **Nothing on screen may move as late data comes.** What loads late goes under what can be touched, or comes with
   what it's shown beside.
9. **A long screen is drawn in batches** (`drawFrom`, `app/views.js`), and `#view` is `aria-busy` until every row is
   drawn. A new list draws `drawn(g)`, its `x-for` handed the list unwatched (`raw`) and keyed by a path into the item
   (`:key="t.id"`).
10. **A change to one row costs one row.** Each row has about 30 bindings, and each is worked out again whenever
    anything it read is another object, changed or not. So:
    - what every row reads stays the same object, and changes inside (`shownGroups`, the screen's `route`);
    - what's said of one task is read by that task's id (`leaving`, `lit`, `flashed`, `waiting`), never a list to
      look through;
    - a getter many bindings read, that costs something, is a `memo` (`util.js`): `runView`;
    - the time moves a screen only when it changes what the screen shows (`runNow`);
    - what a finger going down asks of a row goes over the list at most once, and draws nothing.

    `listGroups` still gives plain groups, a new one when anything in it changed: never change one in place.
    Something new that every row reads is counted before and after (`npm run perf:rows -- counts`).
11. **Content from Vikunja goes through `sanitize`** (`html.js`) before it's shown: Pocket shares Vikunja's origin
    and sign-in.
12. **Colours are custom properties,** in `styles.css`'s `:root`, with dark mode's in the block after it; lint fails
    on one written anywhere else. So are the two sizes a row is laid out by, `--tick` and `--title-x`. Type is one
    scale (17, 15, 14, 13, and 22 for a sheet's title); an input never goes under 16px, or an iPhone zooms in.
13. **Whether less motion is wanted is asked in one place,** `motion()` in `util.js`. Everything felt goes through
    `haptic()`: an iPhone has no `navigator.vibrate`.
14. **`sw.js` keeps the libraries by name,** so a changed file under an old name never reaches an installed Pocket. A
    new file in `pocket/app/` needs thinking about how it's cached there.

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, on Postgres, with the plugin loaded straight from
`pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. `DB=sqlite npm run dev`
(or `test:local`) puts Vikunja on SQLite instead. Its containers are `pocket-dev`, `pocket-dev-sso` and
`pocket-dev-db`; the next run replaces them. Sign in as `dev` / `dev-password`, or with **Mock SSO**. `dev` shares a
project, Team, with `bob`, and its default project with `carol`, so a task there has **+ me**, which the tests rely
on: against your own Vikunja, give the test account's default project to someone too. It keeps building the page as
`src/` changes, so edits show when you reload, until you stop it with Ctrl+C (Vikunja keeps running). After changing
`main.go`, run `npm run dev` again.

## Tests

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run lint                       # mistakes ESLint can see, and what scripts/check.mjs checks
npm run test:unit                  # the unit tests, in a second
node --test tests/unit/actions.test.mjs                         # one file of them
node --test --test-name-pattern="Undo" "tests/unit/*.test.mjs"  # those whose name says Undo
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja and runs them all

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

`npm run test:local` prints how long each file and each end-to-end step took. CI runs `lint`, `test:unit` and
`test:parse` in one job, and `test:local` in another.

Every test's name says what it checks, as a sentence, so the files are their own list. A change to what Pocket does
comes with a test in the file for its area:

- `tests/unit/*.test.mjs`: the helpers and the component's methods, in Node, with no server, a file per area named
  for what it covers. `fake.mjs` is a pretend Vikunja behind `fetch()` and a pretend component; `browser.mjs` is what
  the modules expect of a browser; `reactive.mjs` runs the part of Pocket's own Alpine that watches data, for a test
  of what's asked again as data changes. There's no DOM, so reading a task's notes stays in `parse.mjs`.
- `tests/parse.mjs`: how quick add reads about 770 phrases and pasted lists, most adapted from Vikunja's own tests.
- `tests/smoke.mjs`: Pocket end to end in a headless browser against a Vikunja with the plugin: tasks, lists, the
  sheet, gestures, Today, quick add, sharing.
- `tests/checklists.mjs`: checklists end to end, in a project of its own.
- `tests/offline.mjs`: with the connection cut, Pocket opens, queues, and sends once it's back.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side, signing in and out on either.
- `tests/steptimes.mjs`: the plugin's step times, through the API only.

The tests delete what they create, except the labels `pocket-smoke` and `template`, which a Task Management token
can't delete. The checklists test needs a token that can create and update projects and add reactions.

### Writing an end-to-end test

`tests/helpers.mjs` has what the tests share; its comments say how each works.

- **Find things by role and name,** with Playwright's `expect`, which tries again until it passes:
  `page.getByRole('button', {name: 'Mark done: ' + title})`. Not `waitForSelector` and a check.
- **Move the page's clock, never wait, for what the page decides** (`later(ms)`, at the top of `smoke.mjs` and
  `checklists.mjs`): a task becoming overdue, a countdown reaching zero, rows ticked leaving together
  (`later(3000)`). Vikunja's clock is real, so the few real waits are for what Vikunja dates itself, and say why.
- **Wait for Pocket to load with `loaded(page)`** when a test reads the screen once: a screen opened again shows its
  kept copy first, and a long one draws its rows in batches. Wait for something on the new screen first.
- **Wait for Pocket to send with `synced(page)`** before checking Vikunja or deleting what the test made.
- **Swipe with `swipeRow(page, sel, to)`,** which works out where to let go with the app's own sums. What a swiped row
  uncovers isn't in the row: `uncovered(page)`.
- **A mouse isn't a finger.** For what only a touch meets (`touch-action`, a touch taken away, the page scrolling
  under it), `finger(page)` gives Chrome's own touch input.

## Gotchas

What tripped up earlier work, for whoever starts next.

- **The page's own timers.** Today checks the time once a minute, a run's screen reloads every 20 seconds, lines and
  toasts fold after 5, and rows ticked or deleted leave 3 seconds after the last. A test that waits in real time
  collides with them. Right after `later()`, `waitForSelector` can stall: use `expect`, or `waitForFunction` with
  `polling: 100`.
- **Many timers at once are slow under Playwright's clock:** 1,000 `setTimeout(0)`s take 15 seconds. Alpine's
  `:style` with an object starts one each time it's worked out, which is why `x-style` exists and lint keeps `:style`
  to strings. Something else that starts a timer per row would bring it back
  (`window.__pwClock.controller._timers` lists them).
- **The batch runs on the page's clock, which keeps the real time.** A test that ticks a row, then reads Vikunja
  before ticking it again, has 3 real seconds before the row goes. Move the clock past the batch after
  `synced(page)` for a tick, or after `#said` says "Deleted: …" for a deletion. `page.mouse.down()` holds the batch,
  as a finger does.
- **Alpine applies `x-if` and `x-show` a frame apart,** so one part of a change can be on screen before the other.
  `$nextTick` runs on a timer, which Playwright's clock owns.
- **What's put in the component's data comes back as Alpine's own copy of it:** `this.places.cap = line`, and
  `this.places.cap === line` is false. Compare what the store gives back. The unit tests have no Alpine, so a test
  of this stands a store in that gives back a copy too.
- **Alpine's `x-for` puts back in order whatever follows its `<template>`.** An element of ours put among the rows is
  swapped with the next row each time the list is drawn: put it ahead of the template.
- **`:text-is()` matches the innermost element** with that text. Prefer `getByRole` with a name, or `:has-text`.
- **`toContainText` is case-sensitive;** `:has-text` isn't. Given a regular expression, `toHaveText` doesn't fold the
  markup's line breaks into spaces.
- **`.sec + .list` doesn't find a group's list** when its heading has a message under it: use `.sec ~ .list`.
- **Vikunja keeps times in whole seconds.** Two changes less than a second apart can carry the same `updated`, and a
  due time set by a test comes back rounded down.
- **Vikunja on Postgres gives a task's subtasks in no set order.** A test sorts them by id, and finds one by its id,
  not its place in the sheet. On SQLite it now and then answers 500, "database is locked": the tests' requests try
  again, as Pocket's do.
- **A row to hold has to be on the screen,** clear of its top and bottom edges, where moving it scrolls the list:
  scroll it to the middle first.
- **A hold on Today is felt on the page's clock, but its dates draw in on real frames:** `datesSeen()` waits for
  them. A dimmed date is `aria-disabled`, which `click()` waits on: tap it by its place.
- **A click gives a button the focus in Chrome, which a tap on an iPhone doesn't.** A test of what happens to a
  field's focus opens the sheet with nothing focused.
- **A pending row is `.row.pending` from the start, and `.waits` only after `WAIT_MS`:** move the clock to see it.
- **The one-time hint adds a line to a screen's first row** on a phone that's never swiped one. The tests put it away
  from the start (`hintSeen(context)`); a new browser context in a test needs it too.
- **Low Power Mode on an iPhone** runs an animation of a width at half the frames of one of a transform. Desktop
  Chrome can't show it: rule 7 is there for it.
- **Never run `npm run build` while tests run.** A changed page makes the open copies reload in the middle of a test.
- **Never stop processes by name** (`taskkill /IM`, `pkill`): that closes the person's own Chrome and Node. Stop only
  what you started, by its PID, or the `pocket-dev` containers.
- **On Windows,** Git Bash eats backslashes in a heredoc: write code with backslashes with the Edit tool, or from a
  file. `.gitattributes` keeps line endings LF. Without Playwright's own Chromium, `BROWSER_CHANNEL=chrome` uses the
  installed Chrome, for `test:parse` too.

## Measuring

`scripts/perf/` times Pocket with long lists, in Chrome against a Vikunja of its own (`pocket-perf`, on :3470), seeded
with a busy project. `npm run perf` times opening each screen, and `npm run perf:rows` what a screen costs once it's
open: a tick, a swipe, an add, a scroll's start, a run left alone. Its README says how, and has the numbers from
before and after each round. A change that could slow a long list (something called for every row, a new `x-for`,
something per row on every change) is measured before and after.

## The README's pictures

With `npm run dev` running, `npm run demo` remakes the GIFs and screenshots in `docs/screenshots/`. It drives the
real app in a phone-sized browser, with a small café's made-up tasks for two users of its own, `alex` and `priya`,
and the page's clock fixed, so the dates in the pictures always match the README. New examples in the README and the
guide follow the same café. Run it after changing how Pocket looks.

## The specimen

`npm run specimen` makes `specimen/index.html`: the task row, the stacked card, a parent's ring, the sheet and a
run's screen in every state, in light and dark side by side. It uses the real stylesheet and Pocket's own component,
given made-up tasks (`scripts/specimen/`), and needs no server. A new state of a row gets its place there. It's for
development only: git ignores it, and nothing in `pocket/app/` refers to it.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN.

- **Alpine** is kept readable, as published, in `src/vendor/alpine-<version>.js`, and patched there for long lists,
  each change marked with a comment starting `Pocket:`. There are two patches: its scheduler (70f4fdd), whose queue
  was quadratic, and `x-for` (aea10ac), which keeps the rows at the start of a list that are where they were.
  `tests/unit/alpine.test.mjs` checks both, and that `memo` can still set an effect's own scheduler. The build
  minifies it into `pocket/app/alpine-<version>-pocket.<N>.min.js`, the name the `<script>` tag in `src/index.html`
  gives. To upgrade, or change a patch: replace the file with the new version's `dist/cdn.js` and commit it as
  published, redo each `Pocket:` change (compare with `git show 70f4fdd aea10ac`), run `npm run test:unit`, give the
  `<script>` tag the new version and the next `N`, delete the old file from `pocket/app/`, and measure a long list
  before and after.
- **chrono** is `pocket/app/chrono-<version>.en.min.js`, the English-only build, from
  `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the
  Alpine `<script>` tag in `src/index.html`.
