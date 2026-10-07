# Developing Pocket

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the sign-in screen, the app and its screens, the sheet and each kind of sheet, a task's row
               (task-row.html), who's doing a task or a step (claim-slot.html), and a message in a row's place
               (row-line.html)
  styles.css   all of the CSS
  js/          main.js, where the code starts; component.js, which puts the Alpine component together; the helpers;
               and app/, the parts of the component
pocket/        the plugin, as it's installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  app/         the built app, the libraries it uses, and sw.js, which lets it open offline
tests/         the test files described below, and unit/, the tests that need no browser
scripts/       build.mjs: the build; dev.mjs: a local Vikunja with the plugin loaded; demo.mjs: the README's GIFs and
               screenshots; check.mjs: what npm run lint checks besides ESLint; specimen.mjs and specimen/: a page
               showing the task row in every state
.github/       CI on pull requests and main, and the zip attached to each release
docs/          this file, guide.md (everything the README leaves out), the screenshots, design/ (feature plans) and
               roadmap.md: how the code and the way we work on it will change
  design/      plans for features, written before building them
```

The app is plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. It's written in `src/`, and `npm run build` puts it all into one file, `pocket/app/index.html` (with `pocket.js.map` next to it, so the browser's developer tools show the code as it's written in `src/`). Both are committed, so the `pocket` folder works as it is. Edit `src/`, never `pocket/app/`'s copy: CI checks that it's the build of `src/`. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

The JavaScript is ES modules, each importing what it uses. The helpers in `src/js/` know nothing of the screen. The Alpine component, `pocket`, is one object: `app/core.js` has its data and what happens when Pocket opens, and each other file in `app/` adds its methods, put together in `component.js`. In those methods, `this` is the component, so any of them can call any other. A few things to know:

- A module can't assign to another module's variable. A variable lives in the module that changes it; the few that several parts change are properties of `shared`, in `app/core.js`.
- The markup's Alpine expressions see the component's data and methods, and the few helpers `component.js` lists as globals. A helper used in the markup has to be added there.
- What's done to a task is in `app/actions.js`, a method for each thing: ticking it (and its subtasks with it), its progress, deleting it, moving it, adding subtasks, its people and labels, and saving a change. Each one makes the request, changes what's on screen and offers the Undo, so the lists and the sheet call these rather than `api()`. A run and its steps go through the outbox instead (`act`, in `app/runs.js`), and a template's steps are moved by `moveStep` (`app/checklists.js`).
- Each task on screen is one object, in `tasks`, by id (`app/tasks.js`): every list's rows are those objects, so a change shows on all of a task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` (`util.js`) is apart from it: Vikunja's last copy of each task, as it said it, for an Undo to compare with and a failed save to put back. A task's sheet still has a copy of its own, and a run's screen its own steps (see `roadmap.md`).
- A task's row is `markup/task-row.html`, in every list of tasks and for the subtasks in a task's sheet (`g.sheet`, where it differs in the few ways its comment lists). A template's steps and a run's steps have rows of their own, with the same slot for who's doing them, `markup/claim-slot.html`.
- What a finger does on a row is `app/progress.js`: held, then slid sideways, progress, in snaps of 25% (the sums are in `progress.js`, beside `app/`, so the unit tests can check them); moved up or down after the hold, the place left for reordering (`reorder`, in `holdToSlide`'s comment); swiped left, the row's Delete, or past half the row, deleted. `haptics.js` is the tick felt at each snap.
- A message about one row goes in the row's place, not at the bottom: `rowLine(id, {text, title, action, ms, gone})` (`app/lines.js`, shown by `markup/row-line.html`). A tick that takes a task off its list, and a deletion, put their Undo there. A deletion is apart from how it's shown: `holdDelete` puts it in the outbox, held back (`sync.held`), and `sendHeld` sends it when its line folds, the screen is left, or Pocket is put away; `undoDelete` takes it out.
- Colours are custom properties, in `styles.css`'s `:root`, with dark mode's in the block after it.
- `npm run lint` (ESLint) catches a name that isn't defined or imported, and a variable that's never used. It also fails on `fetch()` anywhere but `api.js`, which signs the request and renews the session (the two other requests, signing out and looking for a new version of Pocket, say why where they are), and, with `scripts/check.mjs`, on a colour written out (`#hex`, `rgb()`, `hsl()`) in `styles.css` outside `:root`, or anywhere in `markup/`. CI runs it.

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, with the plugin loaded straight from `pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. Sign in as `dev` / `dev-password`, or with **Mock SSO**. It keeps building the page as `src/` changes, so edits show up when you reload, until you stop it with Ctrl+C (Vikunja keeps running). After changing `main.go`, run `npm run dev` again.

## Tests

- `tests/unit/`: the parts of the app that need no browser, under Node's own test runner (`node --test`), in a second
  and with no server: the order of a list and subtasks under their parents (`lists.test.mjs`), due dates in words
  (`dates.test.mjs`), progress, what a tick says, sliding to the snaps and swiping to Delete (`progress.test.mjs`), a
  checklist's steps, their order and times (`checklists.test.mjs`), the address, util.js and what's waiting to send (`helpers.test.mjs`), the one copy of each
  task (`tasks.test.mjs`), and what's done to a task (`actions.test.mjs`): ticking a parent closes its open subtasks and
  Undo opens exactly those, a repeating task whose reply is lost is ticked once, progress at 100%, saves one after
  another, deleting, a subtask's tick with no message, a deletion held until its Undo has gone (and sent without a
  connection later, or brought back if Vikunja turns it down), and Move all to today. The app's methods run as they
  are, on a pretend component, with a pretend Vikunja behind `fetch()` (`fake.mjs`). `browser.mjs` gives the modules what they look for in a browser as they load,
  and nothing more: there's no DOM, so reading a task's notes (Pocket's lines in them) stays in `parse.mjs`. A test file
  per area: a new one is picked up by its name, `*.test.mjs`.
- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, how pasted lists lose their bullets and checkboxes, how checklist steps are read, a template's order line, and a run's, with steps inserted in it, and what's a template, its name, and where Vikunja moves one that comes round. It loads `src/js/quickadd.js` and `src/js/checklists.js` as they are, so it needs no build and no server, and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, adds subtasks in the sheet with quick add's chips, claims one and lets it go, and a task from its row, ticks a subtask in a list (it stays, with no message), swipes a row and a subtask in a sheet to Delete with the Undo in the row's place, sets progress in snaps (and lets go when moved up or down after the hold), gives two ticks an Undo each, moves a task to Overdue as its time passes (waiting for an Undo still showing to say so), adds and removes reminders in the sheet (keeping those changed elsewhere meanwhile), offers the 🔔 chip only for a time and only when reminder emails reach you, ticks off a parent and its subtasks with it, adds quick ticks up into one Undo, takes the top suggestion on Enter, reads a bare hour as daytime and warns of a repeat Vikunja can't do, closes a sheet with the phone's Back and keeps the draft through a reload, moves a ticked search result to Done, keeps notes and a comment being written when the sheet closes, doesn't write over notes changed elsewhere meanwhile, adds a label with Enter and a suggested person, undoes a repeating tick (its reminder at a set time too), ticks one whose reply is lost, leaves a repeating subtask alone when its parent is ticked, moves and deletes a task with its subtasks, renames and deletes a project from its ⋯, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side (keeping what was being written when Vikunja signs you out), single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), adds a subtask and a comment in a sheet offline, puts a cancelled task's words back in the box, shows what's waiting in the header and lists it in Waiting to send (dropping one from there), moves over what an older Pocket left waiting, and has two tabs send the same waiting task. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (rows typed with Enter, times in words, a step to count from, a row moved, and Make again after a step's reply is lost), moves a step (only its order line is written, the order stays after a reload, a move cut off goes back, one whose reply is lost stays, and notes and moves saved elsewhere meanwhile are kept), starts runs (a template changed after a start leaves the run as it was; for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too, with a step of yours they've claimed), ticks, skips, unticks and adds notes, ticks a step whose ✅ is refused (kept to try again, with an untick waiting behind it), does again a step someone else skipped, claims a step and lets it go (online, offline, and someone else's, which Done still works on), checks that a timed step gets a reminder and that a countdown alerts once at zero, checks that a run has no tick on Today and that a step ticked there gets a ✅, opens a run and a step from Today and from the run's sheet, keeps a note with its step, sends a note typed before Done, finishes a run and checks the next one's Last time, finishes one by ticking it in its project, after it asks, undoes a start, and names a run when starting it, renames it and makes it for someone else as well, then instead, from its ⋯, inserts a step and repeats one from a step's › (marked, in their place after a reload, deleted, with a reply lost, and offline, ticked before it's sent), holds a step to set its progress (its line, Undo, 100% is done, not from its ›, with a box open, and held past 100% while the screen redraws), checks a run's row under Checklists has its progress line, opens the finished run from Last time, then deletes it, cancels a start that waits, and one whose run was copied without a connection after, reads a step's time counted from a step named in words, goes Back from a project to Checklists, and changes, removes and deletes a template's steps, with ↑ ↓ × only on the step tapped, and writes a step's notes in its own sheet. It writes a template's name and steps with quick add (a person or priority read, shown as chips, sent, and a step changed in place read the same way). A template that comes round: its date and repeat set in its sheet leave it not done, it's on Today with no tick and opens Start, for its assignees; a start ticks it (the run due then, with no repeat or reminders), but not one days before it's due; a lost reply to the tick doesn't skip twice; one left for months moves past now; without a repeat a start ends it; taking its date off leaves it done; and a task with a due date made a template comes round. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step and a reply lost, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
- `tests/steptimes.mjs`: the plugin's step times, through the API only, so it needs a Vikunja with them on (`npm run test:local` turns them on). It sets up a template and two runs as Pocket does, then checks that a tick sets the due dates of the steps timed from it, chained and from a name, and moves their reminders with them; that the other run, a template marked done, a done step saved again or labelled change nothing; that a step marked not done takes the due date off the steps waiting on it; that a step done early counts from when it was done; that a run's steps go in the order they were copied, whatever order they're linked in, or in its own order line; that an inserted step isn't the step before, and a step timed from a repeated one counts from the copy, and from the first again once the copy isn't done; that a tick from the web app works too; and that a run keeps its steps' times when its template is changed or deleted, while one started before runs kept them reads its template.

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run lint                       # mistakes ESLint can see, and colours written out
npm run test:unit                  # the unit tests, in a second
node --test tests/unit/actions.test.mjs                      # one file of them
node --test --test-name-pattern="Undo" "tests/unit/*.test.mjs"  # those whose name says Undo
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja and runs them all

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

`npm run test:local` prints how long each file took at the end, and each step of the end-to-end tests its own time,
so a slow one is seen. CI runs `lint`, `test:unit` and `test:parse` in one job, and `test:local` in another.

**The page's clock.** `smoke.mjs` and `checklists.mjs` install [Playwright's clock](https://playwright.dev/docs/clock) on
the page, which keeps the real time until a test moves it: `later(ms)` runs what the page would do in that time (a toast
going, Today's minute, a countdown's second) at once, then puts the page's clock back on the real time. A test moves
the page's clock, never waits, for what the page decides: a task becoming overdue, a countdown reaching zero, a tick
made a while before it's sent. A toast is made to go at once (`toastGone`), as its own timer would. Vikunja's clock is
real, so the page's goes back to the real time after, and what Vikunja dates itself still takes real time: a change a
second after another (its times have whole seconds), a task made on the web before one from Pocket. Those few waits say
why. Moving the clock on runs everything due meanwhile at once, and what that starts (a request, a redraw) lands after,
so it's for a wait that's about time, not one that lets the page settle.

Vikunja on SQLite (the local one) now and then answers 500, "database is locked", when a request comes while it's
still writing the one before: the tests' own requests to Vikunja try again, a few times, as Pocket's do.

The tests delete what they create, except a `pocket-smoke` label that the end-to-end test reuses on later runs, and the `template` label of the checklists test, since Task Management tokens can't delete labels. The checklists test needs a token that can create and update projects and add reactions. With a token that can't create projects, the project step is skipped.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with a small café's made-up tasks and checklists for two users of its own, `alex`, who owns it, and `priya`, the shift lead, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. New examples in the README and the guide follow the same café. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## The task row's specimen

`npm run specimen` makes `specimen/index.html`, a page for working on how a task's row looks: `markup/task-row.html` in every state (open, done, waiting to send, with progress, subtasks at each depth, due dates, priority, labels, people and comments, a run's row, read only, and a task's subtasks in its sheet with who's doing each, and a row held, swiped to its Delete, and in a line's place), in light and dark side by side. It uses the real stylesheet and Pocket's own component, given made-up tasks instead of signing in (`scripts/specimen/`), so it needs no server: open the file in a browser, and run it again after a change. It's for development only: git ignores `specimen/`, and nothing in `pocket/app/` refers to it, so it's never served or saved for offline.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag in `src/index.html`.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag in `src/index.html`.
