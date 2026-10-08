# Developing Pocket

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the sign-in screen, the app and its screens, the sheet and each kind of sheet, a task's row
               (task-row.html), who's doing a task or a step (claim-slot.html), a message in a row's place
               (row-line.html), one in its place: under a heading, by the add box, in a sheet (place-line.html),
               and what the add box adds subtasks to (cap-target.html)
  styles.css   all of the CSS
  js/          main.js, where the code starts; component.js, which puts the Alpine component together; the helpers
               (messages.js: what Pocket says; order.js: a project's order; share.js: progress as a text or a Markdown
               list); and app/, the parts of the component
pocket/        the plugin, as it's installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  app/         the built app, the libraries it uses, and sw.js, which lets it open offline
tests/         the test files described below, helpers.mjs (what the end-to-end ones share), and unit/, the tests
               that need no browser
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
- What's done to a task is in `app/actions.js`, a method for each thing: ticking it (and its subtasks with it: `toggleDone`,
  the one way, from a list or its sheet, which hands a run to `tickRunTask`), its progress, deleting it, moving it to another project, its place in its project's list (`reorder`), adding subtasks, its people and labels, and saving a change. Each one makes the request, changes what's on screen and offers the Undo, so the lists and the sheet call these rather than `api()`. A run and its steps go through the outbox instead (`act`, in `app/runs.js`), and a template's steps are moved by `moveStep` (`app/checklists.js`).
- Each task on screen is one object, in `tasks`, by id (`app/tasks.js`): every list's rows are those objects, so a change shows on all of a task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` (`util.js`) is apart from it: Vikunja's last copy of each task, as it said it, for an Undo to compare with and a failed save to put back. A task's sheet still has a copy of its own, and a run's screen its own steps (see `roadmap.md`).
- A task's row is `markup/task-row.html`: in every list of tasks, for the subtasks in a task's sheet, and for a run's
  steps on its screen. What differs is said by the list it's in, `g`: `g.depth` (each row's depth under the task above
  it), `g.heads` (done tasks over their open subtasks), `g.sheet` (a subtask in its parent's sheet: its own tick, its
  words alone for a title, its due date only under them) and `g.run` (a run's steps, each `t` a step as `runView`
  works it out, in `app/runs.js`). On a run, `g.at` is the step on its card, lit (`.row.current`); `g.insertAt` the
  step the insert box is open under, which its › opens; and `g.locked` a run finished or shared with you to read: no
  tick, › or ×. The row asks the component by those options: its tick (`tickRow`: `tickStep` through the outbox for a
  step), what's under its title (`rowMeta`: a step's Inserted or Repeated, notes, and countdown), and who's doing it
  (`rowSlot`, shown by `markup/claim-slot.html`; a done step shows who did or skipped it, ✅ or ⏭️ on their picture,
  instead). A step held is `stepSlide` (`app/progress.js`). A template's steps keep a row of their own, an editor, with
  the same slot.
- What a finger does on a row is `app/progress.js`: held, then slid sideways, progress, in snaps of 25% (the sums are in `progress.js`, beside `app/`, so the unit tests can check them); moved up or down after the hold, its place among its siblings (`dragOf`: the row follows the finger, the rows it passes make room, and the page scrolls near the edges); swiped left, the row's Delete, or past half the row, deleted. `haptics.js` is the tick felt at each snap.
- A project's order is its List view's in Vikunja (`order.js`, beside `app/`, with the sums: where a move goes, between
  its neighbours as Vikunja's web app puts it, and which rows are a task's siblings). `positions`, by task id, is read
  with the project's list (`loadProject`) and with a task's subtasks in its sheet (`loadSubOrder`), and sorts both
  (`positionOrder`, in `listGroups` and the sheet's `subtasks`). A move (`reorder`) changes it at once and writes the
  new position through the outbox (a `position` act), so it waits without a connection; if Vikunja keeps another
  value, it renumbered the view, and the list is read again. A template's and a run's steps keep their order line
  instead (`hasOwnOrder`, `moveStep`): Vikunja's List view leaves out done tasks, as a template and its steps are. A
  project's done tasks are its Done section, the list's second group (`fold`), counted when the list loads and loaded
  when it's opened. A done task with subtasks still open is shown on the open list anyway, struck through over them, a
  head (`doneParentIds`, in `lists.js`; the open group's `heads`; `isHead`): one the view didn't give is read, all in one
  request, and goes where its first open subtask is. A task ticked done with subtasks left open under it (one that
  repeats, a run's steps) stays as one (`makeHead`), and one opened again stays where it is (`reopenedHead`).
- On a project's list, quick add's box adds subtasks to the task touched last, the cursor (`cursor`, in
  `app/quickadd.js`): its sheet opened, ticked, or its progress slid. It's then the box `'under'` (`capW`), which reads
  lines as the sheet's subtask box (`'sub'`) does, and both send through `addSubtasks` (`app/actions.js`), each with its
  position (`placeAfter`, in `order.js`): after the cursor's subtask, or the last one added from the box, or the
  parent's last. Its row is watched with an `IntersectionObserver`, and the box goes back to adding a task once the row
  is out of sight; leaving the screen (`navigated`) clears it too.
- A screen opens at once (`render`, `app/views.js`): Today, a project and Checklists with the copy kept of them on the
  phone (`savedView`, `showSaved`: `saved`, by `viewKey`, this account's only), Projects with the projects in memory;
  only a screen with no copy says Loading. It's then loaded afresh behind (`view.updating`, `<main id="view"
  aria-busy>`), and taking over a second, `view.behind` shows a line under the header. The fresh lists replace the
  copy's in place: rows are keyed by task id, so a row that didn't change is the same element; `settle` folds away the
  rows gone first and fades in the ones new to the screen (`flashed.arrived`). A copy's tasks are the store's where
  those are as new (`keptRows`, by `updated`), and none deleted this session. Each loader reads (`readToday`,
  `readProject`, `readChecklists`) apart from putting it on screen, so `preload` can load the copies of the other tabs
  in the background (`preloads`: Today, the project opened last, Checklists), one at a time when the phone is idle,
  without touching the screen or the store.
- A change shows at once, as it'll be; it looks waiting only once it has waited `WAIT_MS` (2.5 seconds, `sync.js`), or
  at once without a connection: `markSlow` (`app/sending.js`) keeps `slow`, the outbox entries that look it, which the
  task row (`waits`), a run's steps (`slow`) and the header's button (`waitShown`) go by. A task not sent yet is on its
  list from the start, where it'll be (`todayOrder`, `positionOrder`), so it doesn't move once it's sent.
- Pocket says what happened where it happened: `say(msg, {row, place, action})` (`app/lines.js`). A message about one
  row is a line in the row's place (`rowLine`, shown by `markup/row-line.html`): a tick that takes a task off its list,
  a deletion, a repeating task's tick, a tick not saved (with Try again). Anything else goes to a place on the screen
  (`sayAt`, shown by `markup/place-line.html`): under Overdue's heading, by the add box, in the open sheet under what
  it's about (`sheet:notes`; a sheet's go with it), on a run. Only what has none of those goes to the toast at the
  bottom (`toast.js`). Each is said to a screen reader through `#said`. The words are in `messages.js`, beside `app/`,
  so the unit tests check them. A deletion is apart from how it's shown: `holdDelete` puts it in the outbox, held back
  (`sync.held`), and `sendHeld` sends it when its line folds, the screen is left, or Pocket is put away; `undoDelete`
  takes it out.
- Sharing progress (a task's, a project's or a run's ⋯) is `app/sharing.js`: it gathers what's on screen into items,
  `{title, done, pct, people, items}`, and `share.js` writes them as a text or a Markdown list, from data only, never
  HTML, so the unit tests check every rule (`share.test.mjs`). `navigator.share` is called straight from the tap, with
  nothing awaited before it, as a phone allows it only then; without it, the text is copied.
- Colours are custom properties, in `styles.css`'s `:root`, with dark mode's in the block after it.
- `npm run lint` (ESLint) catches a name that isn't defined or imported, and a variable that's never used. It also fails on `fetch()` anywhere but `api.js`, which signs the request and renews the session (the two other requests, signing out and looking for a new version of Pocket, say why where they are), and, with `scripts/check.mjs`, on a colour written out (`#hex`, `rgb()`, `hsl()`) in `styles.css` outside `:root`, or anywhere in `markup/`, and on `:style` given an object in `markup/` (`x-style`, in `component.js`, does that). CI runs it.

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, on Postgres, with the plugin loaded straight from `pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. `DB=sqlite npm run dev` (or `test:local`) puts Vikunja on SQLite instead. Its containers are `pocket-dev`, `pocket-dev-sso` and `pocket-dev-db`; the next run replaces them. Sign in as `dev` / `dev-password`, or with **Mock SSO**. It keeps building the page as `src/` changes, so edits show up when you reload, until you stop it with Ctrl+C (Vikunja keeps running). After changing `main.go`, run `npm run dev` again.

## Tests

- `tests/unit/`: the parts of the app that need no browser, under Node's own test runner (`node --test`), in a second
  and with no server: the order of a list and subtasks under their parents, a done one too (`lists.test.mjs`), due dates in words
  (`dates.test.mjs`), Today's order and what's under Added today, no date (`lists.test.mjs`), progress, sliding to the snaps and swiping to Delete (`progress.test.mjs`), a
  checklist's steps, their order and times (`checklists.test.mjs`), the address, util.js and what's waiting to send, and when it looks it (`helpers.test.mjs`), what Pocket says (a tick too) and in which place
  (`messages.test.mjs`), a project's order: its List view, a move's position, a task's siblings, a drag, and
  which task the add box adds subtasks to and where they go (`order.test.mjs`), progress as a text and as a
  Markdown list: the bar, names, due dates, nesting, a run and a project, and what collapses (`share.test.mjs`), the one
  copy of each task (`tasks.test.mjs`), what the one row asks by its options: a step's tick, what's under its title and
  who's on it (`rows.test.mjs`), and what's done to a task (`actions.test.mjs`): ticking a parent closes its open subtasks and
  Undo opens exactly those, with their progress, from its sheet too, a done parent over its open subtasks opened again
  where it is, and one ticked with a subtask left open staying over it, a repeating task whose reply is lost is ticked once, progress at 100%, saves one after
  another, deleting, a subtask's tick with no message, a deletion held until its Undo has gone (and sent without a
  connection later, or brought back if Vikunja turns it down), and Move all to today. The app's methods run as they
  are, on a pretend component, with a pretend Vikunja behind `fetch()` (`fake.mjs`). `browser.mjs` gives the modules what they look for in a browser as they load,
  and nothing more: there's no DOM, so reading a task's notes (Pocket's lines in them) stays in `parse.mjs`. A test file
  per area: a new one is picked up by its name, `*.test.mjs`.
- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, how pasted lists lose their bullets and checkboxes, how checklist steps are read, a template's order line, and a run's, with steps inserted in it, and what's a template, its name, and where Vikunja moves one that comes round. It loads `src/js/quickadd.js` and `src/js/checklists.js` as they are, so it needs no build and no server, and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, adds subtasks in the sheet with quick add's chips, claims one and lets it go, and a task from its row, adds subtasks from the add box on a project's list to the task
  touched last (after its last subtask, or right after a subtask touched, in order, and back to a task with its ×, a
  scroll or another screen), ticks a subtask in a list (it stays, with no message), swipes a row and a subtask in a sheet to Delete with the Undo in the row's place, sets progress in snaps (and lets go when moved up or down after the hold), gives two ticks an Undo each, moves a task to Overdue as its time passes (lighting it up, with no message at the bottom), says by the add box where a task went when it isn't on the screen, and with Open, says a tick not saved on its row and a save not made in the sheet, each with Try again, says Move all to today under the Overdue heading, adds and removes reminders in the sheet (keeping those changed elsewhere meanwhile), offers the 🔔 chip only for a time and only when reminder emails reach you, ticks off a parent and its subtasks with it ("Closed … + 2 subtasks", and an Undo that opens only those), shows a parent done elsewhere over its open subtasks and opens it again, adds quick ticks up into one Undo, takes the top suggestion on Enter, reads a bare hour as daytime and warns of a repeat Vikunja can't do, closes a sheet with the phone's Back and keeps the draft through a reload, moves a ticked search result to Done, keeps notes and a comment being written when the sheet closes, doesn't write over notes changed elsewhere meanwhile, adds a label with Enter and a suggested person, undoes a repeating tick (its reminder at a set time too), ticks one whose reply is lost, leaves a repeating subtask alone when its parent is ticked, moves and deletes a task with its subtasks, keeps a project's list in its List view's order and moves a task and a subtask in it by holding them (and a subtask in a sheet), checked in Vikunja and after a reload, says on its row a move turned down for an API token, moves a task with its ⋯'s Move up and with Alt+↓, opens and folds a project's Done section (from an old link too) and reopens a task there, renames and deletes a project from its ⋯, shares a task's and a project's progress as a text (through a share
  sheet, and copied where there's none) and as a Markdown list, with Open in Vikunja's address, and copies a task's notes
  and a comment, opens Today at once with the copy kept of it while its lists answer late (no Loading, a line under the
  header after a second) and changes a row in place, shows a new task at once and dotted only after a few seconds,
  shows a subtask added today without a date on Today only if it's assigned to you, keeps a long title with no spaces
  from widening the page, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side (keeping what was being written when Vikunja signs you out), single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), adds a subtask and a comment in a sheet offline, and a subtask from the add box on a project's list, puts a cancelled task's words back in the box, shows what's waiting in the header and lists it in Waiting to send (dropping one from there), moves over what an older Pocket left waiting, and has two tabs send the same waiting task. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (rows typed with Enter, times in words, a step to count from, a row moved, and Make again after a step's reply is lost), moves a step, held and moved up, and from its ⋯ (only its order line is written, a tapped step has no ↑ ↓, the order stays after a reload, a move cut off goes back, one whose reply is lost stays, and notes and moves saved elsewhere meanwhile are kept), starts runs (a template changed after a start leaves the run as it was; for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too, with a step of yours they've claimed), ticks, skips, unticks and adds notes, ticks a step whose ✅ is refused (kept to try again, with an untick waiting behind it), does again a step someone else skipped, claims a step and lets it go (online, offline, and someone else's, which Done still works on), checks that a timed step gets a reminder and that a countdown alerts once at zero, checks that a run has no tick on Today and that a step ticked there gets a ✅, opens a run and a step from Today and from the run's sheet, keeps a note with its step, sends a note typed before Done, finishes a run and checks the next one's Last time, finishes one by ticking it in its project, after it asks (it stays over its steps not done), undoes a start, and names a run when starting it, renames it and makes it for someone else as well, then instead, from its ⋯, inserts a step and repeats one from a step's › (marked, in their place after a reload, deleted, with a reply lost, and offline, ticked before it's sent), holds a step to set its progress (its line, Undo, 100% is done, not from its ›, with a box open, and held past 100% while the screen redraws), with Last time's notes answering late and the steps not moving as they come, checks a run's row under Checklists has its progress line, shares a run's progress with who did each step, opens the finished run from Last time, then deletes it, cancels a start that waits, and one whose run was copied without a connection after, reads a step's time counted from a step named in words, goes Back from a project to Checklists, and changes, removes and deletes a template's steps, with ⋯ and × only on the step tapped, and writes a step's notes in its own sheet. It writes a template's name and steps with quick add (a person or priority read, shown as chips, sent, and a step changed in place read the same way). A template that comes round: its date and repeat set in its sheet leave it not done, it's on Today with no tick and opens Start, for its assignees; a start ticks it (the run due then, with no repeat or reminders), but not one days before it's due; a lost reply to the tick doesn't skip twice; one left for months moves past now; without a repeat a start ends it; taking its date off leaves it done; and a task with a due date made a template comes round. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step and a reply lost, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
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
made a while before it's sent. A toast is made to go at once (`toastGone`), as its own timer would. A message in its
place is found with `placeLine(page, 'overdue')` or `rowLine(page, text)` (`tests/helpers.mjs`). Vikunja's clock is
real, so the page's goes back to the real time after, and what Vikunja dates itself still takes real time: a change a
second after another (its times have whole seconds), a task made on the web before one from Pocket. Those few waits say
why. Moving the clock on runs everything due meanwhile at once, and what that starts (a request, a redraw) lands after,
so it's for a wait that's about time, not one that lets the page settle.

**Waiting for Pocket to load.** A screen opened again shows the copy kept of it at once, with no Loading, and is
loaded afresh behind it: `loaded(page)`, in `tests/helpers.mjs`, waits until it's loaded (no Loading, and `#view` not
`aria-busy`), for a test that reads the screen once rather than with `expect`.

**Waiting for Pocket to send.** `<html data-sync>` says where sending stands: `sending`, `waiting` (something is kept
that can't go now: no connection, a deletion whose Undo still shows, one Vikunja turned down), or `idle`. `synced(page)`,
in `tests/helpers.mjs`, waits for `idle`, so a test checks Vikunja once, after it, rather than asking it again and again.
The helpers also have Playwright's own `expect`, used without its test runner: `await expect(locator).toBeVisible()`
tries again until it passes, so new tests find things by their role and name (`page.getByRole('button', {name:
'Mark done: ' + title})`) and use it, rather than `waitForSelector` and a check.

Vikunja on SQLite (the local one, with `DB=sqlite`) now and then answers 500, "database is locked", when a request
comes while it's still writing the one before: the tests' own requests to Vikunja try again, a few times, as Pocket's do.

The tests delete what they create, except a `pocket-smoke` label that the end-to-end test reuses on later runs, and the `template` label of the checklists test, since Task Management tokens can't delete labels. The checklists test needs a token that can create and update projects and add reactions. With a token that can't create projects, the project step is skipped.

## Gotchas

What tripped up earlier work, for whoever starts next.

- **The page's own timers.** Today checks the time once a minute, a run's screen reloads every 20 seconds, countdowns
  tick every second, and lines and toasts fold after 5. A test that waits in real time collides with them: move the
  page's clock with `later(ms)` instead. `later()` puts the clock back on the real time after, and the page's frames
  follow its clock, so for a moment after it `waitForSelector` (which looks every frame) can stall: use `expect`, or
  `waitForFunction` with `polling: 100`.
- **Many timers at once are slow under Playwright's clock.** It runs the page's timers one at a time, with a real
  `setTimeout` between each, and looks through all of them each time: 1,000 `setTimeout(0)`s take 15 seconds, where a
  browser takes 5ms. Alpine's `:style` with an object starts one each time it's worked out, so on every row of a list,
  on every change, late in `smoke.mjs` it left the page's timers up to 20 seconds behind. `x-style` does the same
  without the timer, and `npm run lint` keeps `:style` to strings. Something else that starts a timer per row would
  bring it back: `window.__pwClock.controller._timers` lists the page's timers, to look.
- **The outbox sends in the background.** A tick, a claim or a deletion is still on its way when the screen has
  changed. `await synced(page)` before checking Vikunja or deleting what the test made. It knows of changes being
  written and of what's in the outbox: after a tap whose handler reads first (a deletion asks Vikunja for the
  subtasks), wait for what the screen shows first. A deletion waits for its Undo to go: `later(5000)` folds its line.
- **Alpine applies `x-if` and `x-show` a frame apart,** so one part of a change can be on screen before the other.
  `$nextTick` runs on a timer, which Playwright's clock owns: with the clock moved, it runs when the clock says.
- **`:text-is()` matches the innermost element** with that text, which is often not the one meant. Prefer
  `getByRole` with a name, or `:has-text`.
- **Vikunja keeps times in whole seconds.** Two changes less than a second apart can carry the same `updated`, and a
  due time set by the test comes back rounded down. The few waits for this say so.
- **"database is locked"** comes only with `DB=sqlite` now; the tests' requests try again.
- **`toContainText` is case-sensitive**; `:has-text` isn't. Pass `ignoreCase: true` where it matters. Given a regular
  expression, `toHaveText` doesn't fold the markup's line breaks into spaces: a `.*` stops at them.
- **A row to hold has to be on the screen,** and clear of its top and bottom edges, where moving it scrolls the list
  (or the sheet) by itself: a test scrolls it to the middle first (`scrollIntoView({block: 'center'})`).
- **`.sec + .list` no longer finds a group's list:** a group's heading can have a message under it (and its
  `<template>`), so use `.sec ~ .list`.
- **Nothing on screen may move as late data comes.** A run's screen used to show Last time's notes on the step's card
  once they came, pushing its steps down from under a finger (the flaky `hold-a-step-to-set-its-progress`). Now they
  come with the run, or under it, and on a card only from the next step on (`readLast`, `lateLast`, `app/runs.js`);
  the test makes them answer late and checks the steps stay put. Something new that loads late above what can be
  touched needs the same care. Measure a row with `steady()`.
- **A screen opened again is the copy kept of it first.** A test that reads it once, right after going there, may read
  the old copy: wait with `expect`, or `loaded(page)`. A pending row is `.row.pending` from the start, and `.waits`
  (tinted, its tick dotted) only after `WAIT_MS`: move the page's clock with `later()` to see it.
- **Vikunja on Postgres gives a task's subtasks in no set order** (`related_tasks`), and the order can change as they're
  saved. Pocket orders them itself; a test that checks the order they were made in sorts them by id first, and one that
  picks a subtask finds it by its id, not its place in the sheet.
- **This Windows machine.** Git Bash eats backslashes in a heredoc: write code with backslashes through Python raw
  strings in a file, or the Edit tool. A checkout can have CRLF line endings. Without Playwright's own Chromium
  installed, `BROWSER_CHANNEL=chrome` uses the installed Chrome, for `test:parse` too.
- **Never stop processes by name** (`taskkill /IM`, `pkill`): that closes the person's own Chrome and Node. Stop only
  what you started, by its PID, or the `pocket-dev` containers.
- **Never run `npm run build` while tests run.** A changed page makes the open copies reload in the middle of a test.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with a small café's made-up tasks and checklists for two users of its own, `alex`, who owns it, and `priya`, the shift lead, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. New examples in the README and the guide follow the same café. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## The task row's specimen

`npm run specimen` makes `specimen/index.html`, a page for working on how a task's row looks: `markup/task-row.html` in every state (open, done, waiting to send, with progress, subtasks at each depth, due dates, priority, labels, people and comments, a run's row, read only, and a task's subtasks in its sheet with who's doing each, and a row held, swiped to its Delete, and in a line's place; and a run's steps on its screen: done by you or someone else, skipped, inserted, repeated, counting down, late, held, a tick waiting to send, and in a run finished or read only), in light and dark side by side. It uses the real stylesheet and Pocket's own component, given made-up tasks instead of signing in (`scripts/specimen/`), so it needs no server: open the file in a browser, and run it again after a change. It's for development only: git ignores `specimen/`, and nothing in `pocket/app/` refers to it, so it's never served or saved for offline.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag in `src/index.html`.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag in `src/index.html`.
