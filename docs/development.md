# Developing Pocket

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the sign-in screen, the app and its screens, the sheet and each kind of sheet, a task's row
               (task-row.html), a row or a card on Today (today-item.html), a card's strip, on Today and on a
               run's step card (card-strip.html), a run's step card (step-card.html), who's doing a task or a step
               (claim-slot.html), a message in a row's place
               (row-line.html), one in its place: under a heading, by the add box, in a sheet (place-line.html),
               and what the add box adds subtasks or a run's steps to (cap-target.html)
  styles.css   all of the CSS
  js/          main.js, where the code starts; component.js, which puts the Alpine component together; the helpers
               (messages.js: what Pocket says; order.js: a project's order; share.js: progress as a text or a Markdown
               list; batch.js: when rows ticked or deleted leave together; cards.js: Today's cards); and app/, the
               parts of the component
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
  the one way, from a list or its sheet, which hands a run to `tickRunTask`), its progress, deleting it, moving it to another project, its place in its project's list (`reorder`), adding subtasks, its people and labels, and saving a change. Each one makes the request, changes what's on screen and gives the way to take it back (a row's tick again, Restore, an Undo), so the lists and the sheet call these rather than `api()`. A run and its steps go through the outbox instead (`act`, in `app/runs.js`), and a template's steps are moved by `moveStep` (`app/checklists.js`).
- Each task on screen is one object, in `tasks`, by id (`app/tasks.js`): every list's rows are those objects, so a change shows on all of a task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` (`util.js`) is apart from it: Vikunja's last copy of each task, as it said it, for an Undo to compare with and a failed save to put back. A task's sheet still has a copy of its own, and a run's screen its own steps (see `roadmap.md`).
- A task's row is `markup/task-row.html`: in every list of tasks, for the subtasks in a task's sheet, and for a run's
  steps on its screen. Ticked or deleted in a list, it's marked (`leaving`, below), and shows it in place. What differs
  is said by the list it's in, `g`: `g.depth` (each row's depth under the task above
  it), `g.heads` (done tasks over their open subtasks), `g.sheet` (a subtask in its parent's sheet: its own tick, its
  words alone for a title, its due date only under them) and `g.run` (a run's steps, each `t` a step as `runView`
  works it out, in `app/runs.js`). On a run, `g.at` is the step on its card, lit (`.row.current`), which the bottom
  box adds steps after (below); and `g.locked` a run finished or shared with you to read: no tick or ×. What a finger can do on a row besides its progress is its list's too: `g.delete` (swiped to its Delete)
  and `g.reorder` (held and moved up or down). A screen gives its lists these (`screenRows`, `lists.js`, in
  `listGroups`): a project both, search only `delete`, Today neither, as Today is for doing; a task's sheet gives its
  subtasks both. A list's `g` can't be reached from the row's element, so the row writes them on itself
  (`data-gestures`, `rowGestures`), and the gesture code reads them there, in one place (`allows`, `app/progress.js`).
  The row asks the component by those options: its tick (`tickRow`: `tickStep` through the outbox for a
  step), what's under its title (`rowMeta`: a step's Inserted or Repeated, notes, and countdown; a run's row who it's
  for, and no count of its steps or the next, which its line says; no 🔔 on a run's step, whose reminder is Pocket's,
  for its countdown), and who's doing it
  (`rowSlot`, shown by `markup/claim-slot.html`; a done step shows who did or skipped it, ✅ or ⏭️ on their picture,
  instead). Every slot is `claimSlot`'s (`app/claims.js`), and it shows "+ me" only where someone else could take the
  task: in a project only you can see (`onlyYou`: `seenBy[pid] === 0`), no slot, nor your own picture, only someone
  else assigned to it, and a slide claims nothing. `seenBy` (project id → how many besides you can see it) is
  `loadPeople`'s (`app/quickadd.js`: Vikunja's `/projects/{id}/users/search` for each project, four at a time, which
  counts teams and parent projects), kept on the phone (`saved`, `seenBy`), so Today opens with it; it's loaded in the
  background with the other tabs (`preload` → `refreshPeople`), once signed in and again after `PEOPLE_AGE` (10
  minutes). Until a project's known, or for an API token that can't ask (`accessBlocked`), its slots are as anywhere. A step held is `stepSlide` (`app/progress.js`). A template's steps keep a row of their own, an editor, with
  the same slot, and their number plain where a tick would be (`.check.step-n`, as the start sheet numbers them: a square box
  is a step you tick, in a run). A template's sheet, and its step's, have no Comments (`ofTemplate`): a run is Vikunja's
  copy of them, which takes their notes, attachments, labels and people but not their comments. A step's box is square wherever it shows (`isStepRow`: a run's screen, its sheet, a list), a task's
  round; a run's own row has its line in segments, one per step (`runLineOf`, from `runLine` in `progress.js`, as
  `--segs`, and `--fill`, a gradient filling each segment by whether its own step is done, cut by a CSS mask; past
  `MANY_STEPS`, one line with ticks, `.many-steps`, each step's stretch filled the same way), as has a card's strip, on
  Today and on its screen's step card.
- Today is on one line (motion-and-rows-plan, section 9): its lists' option `g.line` (from `screenRows`) makes a row
  `.one-line`: its title cut short with "…", and at its right `rowWhen` (`app/views.js`): its priority's bars, small, as
  on a card's heading (a tick is never coloured by priority: one-concept-plan, part 4), when it's due, short
  (`shortDue`, `dates.js`; a run's step's `countdown`; nothing for today with no time under the Today heading, its
  group's `g.key`, which a card's step line has too), red when late, and its project's dot; labels and counts are left
  off. All of `rowMeta` but labels and
  counts (its `extra`) is said to a screen reader instead, in an `.sr` after the title (`rowWhen(t, g).said`). The row
  works `rowWhen` out once, as it does its slot (an `x-for` of one, `w`), and `rowWhen` reads `rowMeta`'s, countdown
  and all. Projects, search and sheets keep `rowMeta`'s second line.
- Today is cards and rows (`markup/today-item.html`, its lists' option `g.cards`, from `screenRows`): a task with open
  subtasks, or a run with open steps, is a card (`.day-card`, `app/cards.js`) of three lines, the same height whatever
  its steps hold: its title, a heading that opens it (`cardHead`, worked out once per card, given its group as a row's
  `rowWhen` is: its title, a run's name without the day it was started, `runWithoutDay` in `checklists.js`, so it reads
  as a task's; its priority bars and when it's due, short; and, said to a screen reader, when in words, its priority
  and its project or who a run is for); then one step line, the task row with the card's options (`g.card`,
  `g.line`), on one line as Today's rows are, its own tick and slot, and "Step 3 of 5" to a screen reader, its
  progress filling its segment of the strip (`runLine`'s fill, by `pctOf`) rather than a bar of its own (shown only
  while it's held and slid); then, as its footer, its strip (`.card-strip`, a grid): `‹`, its task's line in segments,
  as a run's, the step showing outlined on it (`.card-mark`, at `--at`, sliding as it's paged), `›`, and its count, "3
  of 5" (`.card-n`), the step's place among all its subtasks, done ones too (`placeOf`, `cards.js`), while paging goes
  through the open ones only. It's 48px tall, its arrows and line taking taps its full height, clear of the step
  line's, its line a clear gap under the step's bar; the arrows keep their places when hidden, so the line keeps its
  length. Dragged along, the strip is a scrubber (`cardScrub`, holdToSlide's `scrub`: the open step nearest the finger,
  `segmentOf` and `scrubTo` in `cards.js`, shown with no slide, said once the finger lifts). A tap on an open step's
  segment shows it (`tapSegment`: the same two, when the open step nearest is the one tapped; none past `MANY_STEPS`),
  a pointer's shortcut only. The arrows stop at the first and last open step (`pageCard`), dimmed there
  (`aria-disabled`); they're outside
  the keyed row, so they keep the focus. The strip is `markup/card-strip.html`, given the card `c`; a run's step card
  has it too (below). A plain swipe on the step line or the heading does nothing (`cardGesture`). Subtasks are never rows of their own on Today. What's a card, and why, is `todayItems`
  (`cards.js`, beside `app/`, so the unit tests check it): a task due, a subtask due, a subtask of yours made today
  without a date (Vikunja doesn't say when a task was assigned), a run of yours or one you're on a step of; `view.cards`
  keeps, by task id, the earliest date that brought each (`when`, which `placeDated` and `todayOrder` place it by, with
  `todayAt`), when the latest subtask of yours that did was made, and that subtask (`focus`). `readCards` reads the
  cards' tasks and their subtasks once per project, from its List view with `expand=subtasks` (their positions with
  them, the done ones' too, which the view gives along with their task), and a run's with Today's run index. `cardOf` works a card out as it's drawn: its open steps in order, a step
  ticked staying until the batch clears (`leaving`), and which shows (`cardAt`: paged in `cardPage`, `pageCard`, reset on
  leaving Today; else the focus; else the first; a run's by its screen's rule instead, `runPick`: `whereNext`, below). A tick or a slide on the step pins the card where it is (`pinCard`), so
  once the step has gone the one after it comes in, fading or sliding in (`cardEntered`); `rowsOf` (`leaving.js`) leaves
  the step line out of the batch's folding. A run's step there has its countdown, to the minute (`countdown`, in
  `rowMeta`).
- A run's screen (`screens/run.html`) is its step card (`markup/step-card.html`), the step on it `runView.step`, at
  `runView.at` (`app/runs.js`; `view.run.at` once a step's put there, by `showStep`), then its steps, its comments and
  Last time. What's written on a run or a step is a Vikunja comment, and the screen calls it one ("Comment on this
  step", "Comments on this run"), as a task's sheet does: "Notes" is only ever a task's description. The code keeps its
  older names for them (`addNote`, the act `'note'`, `runDrafts`, `notes`, `lastNotes`, `#step-note`, `#run-notes`). The card has a card's strip at its top, the same markup and code as Today's (`runView.card`, with `runScreen`:
  `showCardStep` puts the step on the card with `showStep`, and the strip's scrubbed by `stripScrub`, as Today's is by
  `cardScrub`): the run's line, the card's step marked and filled by its progress, its place ("3 of 6", `at`), and
  paging through the open steps, and the card's step if it's done (shown from its row). Beside its title, the step's
  slot, its row's (`rowSlot`). Where the run goes next is one rule, `whereNext` (`checklists.js`, so the unit tests
  check it): the next step that can be done now, past any counting down. The screen opens on it (`r.at` null), a tick
  goes to it (`nextStep`), and a run's card on Today opens on it (`runPick`, its countdowns as Today shows them).
  A step is added to a run from quick add's box at the bottom, as a subtask is on a project's list: on a run's screen
  it's the box `'ins'` (`capW`; its text is `runInsert`, apart from quick add's own), shown while the run can be
  written to and isn't finished. It's aimed at the card's step (`runAim`, `app/runs.js`), the line above it
  (`cap-target.html`) saying "Add a step after “…”"; steps added one after another go each after the last
  (`runAdded`, kept as each is put in the outbox, so one typed before it's sent goes after it), until the card's step
  changes (`showStep` clears it). Every step done, it aims at the last. `insertStep` reads the box's lines and
  `addSteps` puts them in the outbox (`addStep`, each with the step it goes before and after); Repeat on the line,
  `repeatCard`, is `repeatStep` of the card's step there, with an Undo by the box (`undoAdded`: `dropStep`, or
  `deleteAddedStep` once it's sent). A nudge on a step's row puts it on the card (`nudged`), as a tap does.
- What a finger does on a row is `app/progress.js`: held, then slid sideways, progress, in snaps of 25% (the sums are in `progress.js`, beside `app/`, so the unit tests can check them), and on a row no one is doing, in a project someone else can see, a claim: `claimOnSlide` (`app/claims.js`) shows you on it as the slide starts (`slideClaim`, laid over its people by `peopleOf`) and sends the claim through the outbox only if the slide changed something (`claimsOnSlide` says who may), as does the bar in a task's sheet (`sheetSlot`: after its save, whose reply would otherwise be shown over the claim; its Assigned row shows `peopleOf`); moved up or down after the hold, its place among its siblings (`dragOf`: the row follows the finger, the rows it passes make room, and the page scrolls near the edges); swiped left, the row's Delete, or past half the row, deleted, the row carrying on off the screen, leaving its gap (`sweep`); on Today, a card's strip dragged along, mostly sideways, scrubs through its steps (`cardScrub`, `app/cards.js`; `scrubStarts` in `progress.js`), while a hold on its step line is that step's progress, and a plain swipe there or on its heading does nothing (`cardGesture`). The last two only where the row's list allows them (above); a sideways move that isn't a swipe it can take does nothing, not even a tap. `haptics.js` is the tick felt at each snap.
  A row held, swiped or paged is never text: no selection starts meanwhile (`noSelect`, on `selectstart`), and one the
  phone's long press made is cleared at the hold and as the row moves. A long press picks the nearest words it can
  select, so the rows, a sheet's subtasks' card and the headings (`.h3`) can't be selected at all; notes, comments and
  what's typed can.
  Until a slide first sets progress, on this phone (`hint`, kept as `pocket.hint.slide`), the first row of a list that
  takes a slide (`rowSlides`; on Today, a card's step line, the hint then being the card's) says "Hold and slide to
  start working on it", under its title: `pickHint` picks it once, as the screen is first drawn (`hint.pick`, set by
  `render`), never later, so it never pushes rows down; put away by a slide or a tap, it fades, keeping its space
  while a finger may be on the list: by the batch's rules, a second after the finger lifts with the list still
  (`hintAway`, `closeHint`, `app/leaving.js`), it folds. A screen reader hears it once, through `#said`.
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
  repeats) stays as one (`makeHead`), and one opened again stays where it is (`reopenedHead`). What lives on Checklists
  is left out of a project's lists and search (`withoutTemplates`, `app/checklists.js`, on what was loaded, with no
  request of its own): a template marked done and its steps, everywhere, and a run's steps on a project's list (Open and
  Done), where a run is one row, so a run finished with steps not done goes to Done, not over them. A step's template is
  known by its parent: a template in the same list, one kept from Checklists (`templatesKept`, saved as `templates`) or
  in `cache`, or a title starting "TEMPLATE:" (Vikunja gives a task's parent without its labels). A project for
  checklists' Done isn't counted by Vikunja (most of its done tasks are those), but once loaded.
- On a project's list, quick add's box adds subtasks to the task touched last, the cursor (`cursor`, in
  `app/quickadd.js`): its sheet opened, ticked, or its progress slid. It's then the box `'under'` (`capW`), which reads
  lines as the sheet's subtask box (`'sub'`) does, and both send through `addSubtasks` (`app/actions.js`), each with its
  position (`placeAfter`, in `order.js`): after the cursor's subtask, or the last one added from the box, or the
  parent's last. Its row is watched with an `IntersectionObserver`, and the box goes back to adding a task once the row
  is out of sight; leaving the screen (`navigated`) clears it too. A nudge aims it as well (on a run, at a step): a touch
  that starts on a row and turns into a short, slow scroll (`watchNudges`, `app/progress.js`, followed by touch events,
  as the phone ends the pointer events once it scrolls; `nudged`, `app/quickadd.js`). To tune it, change the
  `NUDGE_*` numbers in `src/js/progress.js` (how far is past a tap, how far is more than a nudge, how fast is a fling,
  over how long that's measured, and whether a tick is felt); `isNudge` and `releaseSpeed` there are what the unit tests
  check.
- A screen opens at once (`render`, `app/views.js`): Today, a project and Checklists with the copy kept of them on the
  phone (`savedView`, `showSaved`: `saved`, by `viewKey`, this account's only), Projects with the projects in memory;
  only a screen with no copy says Loading (Today's copy holds its cards, and their steps). It's then loaded afresh behind (`view.updating`, `<main id="view"
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
- A row ticked, opened again or deleted in a list (Today, a project, search, a task's sheet for a deletion) is marked:
  `markRow` (`app/leaving.js`) keeps it where it is, at its height, as `leaving[id]` says (`'done'`, `'open'`,
  `'deleted'`: a gap at its height, `.del-gap`, holding only "Deleted" and Restore where its slot was; tapped, the row slides back in, `restoreRow`), with the rows that go with it (subtasks closed
  with a task, or deleted with it). Its tick meanwhile is the mark's `undo` (`unmark`, from `tickRow`); a deleted row's
  tap anywhere restores it. Each mark restarts the batch (`batch.js`): 3 seconds after the last, counted from when the
  finger lifts, never while a finger is down or the page or a sheet scrolls; then every marked row that leaves (`out`)
  folds at once and each mark's `gone` runs (`clearBatch`): off Today, between Open and Done (`moveInSearch`), a
  repeating task's next date, a deletion sent. Leaving the screen, or Pocket put away, clears it at once (`clearNow`,
  from `foldLines`), and a list loaded meanwhile keeps the marked rows (`keepMarked`). While marked, a row keeps the
  slot it had (`rowSlot`), so its title doesn't move.
- A task sheet's label-and-value rows (`.prop`) take a tap anywhere: `propTap` (`app/sheet.js`) works the control
  marked `data-tap` (a date's `showPicker()`, a select's, or the row's Add), and leaves a tap on a control or a button
  in the row to it. A row with only a select (Repeats, Project) has it over the whole row instead (`.prop.sel`), as
  Safari on an iPhone can't open a select from code.
- Pocket says what happened where it happened: `say(msg, {row, place, action})` (`app/lines.js`). A message about one
  row that went wrong is a line in the row's place (`rowLine`, shown by `markup/row-line.html`): a tick not saved (with
  Try again), a move turned down. A tick or a deletion shows on its row (above), and `#said` says it. Anything else goes to a place on the screen
  (`sayAt`, shown by `markup/place-line.html`): under Overdue's heading, by the add box, in the open sheet under what
  it's about (`sheet:notes`; a sheet's go with it), on a run. Only what has none of those goes to the toast at the
  bottom (`toast.js`). Each is said to a screen reader through `#said`. The words are in `messages.js`, beside `app/`,
  so the unit tests check them. A deletion is apart from how it's shown: `holdDelete` puts it in the outbox, held back
  (`sync.held`), and `sendHeld` sends it when its marked row goes (or its toast, with no row on screen), the screen is
  left, or Pocket is put away; `undoDelete` (Restore) takes it out.
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

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, on Postgres, with the plugin loaded straight from `pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. `DB=sqlite npm run dev` (or `test:local`) puts Vikunja on SQLite instead. Its containers are `pocket-dev`, `pocket-dev-sso` and `pocket-dev-db`; the next run replaces them. Sign in as `dev` / `dev-password`, or with **Mock SSO**. `dev` shares a project, Team, with `bob`, and its default project with `carol`, so a task there has **+ me** (it shows only where someone else could take the task), which the tests rely on: run against your own Vikunja, give the test account's default project to someone too. It keeps building the page as `src/` changes, so edits show up when you reload, until you stop it with Ctrl+C (Vikunja keeps running). After changing `main.go`, run `npm run dev` again.

## Tests

- `tests/unit/`: the parts of the app that need no browser, under Node's own test runner (`node --test`), in a second
  and with no server: the order of a list and subtasks under their parents, a done one too, and what a project's lists and search leave out (templates marked done and their steps, and a run's steps on a project's) (`lists.test.mjs`), due dates in words, and short, for a row on one line
  (and nothing for today with no time under Today's heading) (`dates.test.mjs`), Today's order, a card's by what brought it (`lists.test.mjs`), which tasks are cards on Today
  and why, where each sits, which step shows, paging it through the open ones, stopping at the ends, and scrubbing along its strip, its count (the step's place, the done ones counted) and the
  segment its line marks, which step a tap on its line shows (none past 12 steps), its line and a step's countdown, a row on one line (what's at its right, and what it says: a run's step's countdown, photos waiting to upload, not its labels or counts), where a run goes next (`whereNext`), a run's card opening by that rule, and its heading as a task's (its name without the day it was started, when it's due at the right), and a run's step card: the step it opens on, its strip, paged, tapped and scrubbed as Today's, and its slot, and its bottom box: aimed at the card's step, steps added each after the last until that changes, after the last step with every one done, none on a run finished or read only, and Repeat with its Undo (`cards.test.mjs`), progress, sliding to the snaps and swiping to Delete, who a slide claims for, a run's line in segments, each filled by whether its own step is done, and a nudge told from a tap and a fling (`progress.test.mjs`), a
  checklist's steps, their order and times (`checklists.test.mjs`), when rows ticked or deleted leave together, and what a tap on a marked row does (`batch.test.mjs`), the address, util.js and what's waiting to send, and when it looks it (`helpers.test.mjs`), what Pocket says (a tick too, and a run's comments called comments) and in which place
  (`messages.test.mjs`), a project's order: its List view, a move's position, a task's siblings, a drag, and
  which task the add box adds subtasks to and where they go (`order.test.mjs`), progress as a text and as a
  Markdown list: the bar, names, due dates, nesting, a run and a project, and what collapses (`share.test.mjs`), the one
  copy of each task (`tasks.test.mjs`), what the one row asks by its options: a step's tick, what's under its title (a
  run's row without its steps done or the next, a run's step without a 🔔) and who's on it, what a finger can do on a screen's rows, a slide claiming a row no one is doing (and the sheet's bar, after its save), no "+ me" nor your picture in a project only you can see, and who can see each project, kept and loaded again, which boxes are square, and which row the
  one-time hint goes on (`rows.test.mjs`), and what's done to a task (`actions.test.mjs`): ticking a parent closes its open subtasks,
  shown in place with it and gone together when the batch clears, and its tick again opens exactly those, with their
  progress, from its sheet too (with an Undo), a done parent over its open subtasks opened again
  where it is, and one ticked with a subtask left open staying over it, a repeating task whose reply is lost is ticked once, and one shown done then back at its next date (or off Today), progress at 100%, saves one after
  another, deleting, a subtask's tick with no message, a deletion held until its row has gone (and sent without a
  connection later, or brought back if Vikunja turns it down), and Move all to today. The app's methods run as they
  are, on a pretend component, with a pretend Vikunja behind `fetch()` (`fake.mjs`). `browser.mjs` gives the modules what they look for in a browser as they load,
  and nothing more: there's no DOM, so reading a task's notes (Pocket's lines in them) stays in `parse.mjs`. A test file
  per area: a new one is picked up by its name, `*.test.mjs`.
- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, how pasted lists lose their bullets and checkboxes, how checklist steps are read, a template's order line, and a run's, with steps inserted in it, and what's a template, its name, and where Vikunja moves one that comes round. It loads `src/js/quickadd.js` and `src/js/checklists.js` as they are, so it needs no build and no server, and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, adds subtasks in the sheet with quick add's chips, claims one and lets it go, and a task from its row, adds subtasks from the add box on a project's list to the task
  touched last (after its last subtask, or right after a subtask touched, in order, and back to a task with its ×, a
  scroll or another screen, and aimed by a nudge: a short, slow touch-drag, not a long or fast one, a hold, a done or read-only row, or one on Today, while a tap still opens the sheet), ticks a subtask in a list (it stays, with no message), slides progress on a task no one is doing to claim it (not on a slide that changed nothing, nor on someone else's, and kept when slid back to 0%), and a task sheet's bar the same (shown in Assigned as the slide starts), checks a project only you can see (no "+ me", nor your picture, someone given a task in a shared project, then moved there, still shown, a slide claiming nothing, and a task due today with no time showing no time under Today's heading), shows the one-time hint on a phone of its own, on the first row that takes a slide, without moving a row as it goes, put away by a tap or a slide, its space closing only once no finger is down, and still away after a reload, taps the sheet's Due, Reminders, Repeats, Project, Labels and Assigned rows anywhere (and the × that clears a date), shows a row on Today on one line (its priority's bars before when it's due, short, no priority on its tick, and its project's dot, a long title cut short, the rest said to a screen reader) and with its second line on its project's list, checks a row's three tap zones (its tick over the whole left gutter, its title, its slot, each the row's full height and 48px across), swipes a row on a project's list and a subtask in a sheet to Delete (a full swipe carrying on off the screen, leaving a gap at its height, with Restore, a tap on the gap bringing the row back, sliding in, nothing sent until the batch clears, and sent at once on leaving the screen), checks that on Today a swipe shows no Delete and a held row isn't moved (nor its position written), while its progress still slides, and that search's rows are swiped to Delete but not moved, its subtasks as rows under their task, sets progress in snaps (and lets go when moved up or down after the hold), ticks rows that stay in place at their height until 3 seconds after the last (a finger down holding them), then leave together, folding (fading, with less motion), and ticks one again to open it, moves a task to Overdue as its time passes (lighting it up, with no message at the bottom), says by the add box where a task went when it isn't on the screen, and with Open, says a tick not saved on its row and a save not made in the sheet, each with Try again, says Move all to today under the Overdue heading, adds and removes reminders in the sheet (keeping those changed elsewhere meanwhile), offers the 🔔 chip only for a time and only when reminder emails reach you, ticks off a parent and its subtasks with it ("Closed … + 2 subtasks", all shown done in place, and its tick again opening only those), shows a parent done elsewhere over its open subtasks and opens it again, adds quick ticks up into one Undo, takes the top suggestion on Enter, reads a bare hour as daytime and warns of a repeat Vikunja can't do, closes a sheet with the phone's Back and keeps the draft through a reload, moves a ticked search result to Done once the batch clears, keeps notes and a comment being written when the sheet closes, doesn't write over notes changed elsewhere meanwhile, adds a label with Enter and a suggested person, shows a repeating task ticked, then back at its next date, and its tick again putting its dates back (its reminder at a set time too), ticks one whose reply is lost, leaves a repeating subtask alone when its parent is ticked, moves and deletes a task with its subtasks, keeps a project's list in its List view's order and moves a task and a subtask in it by holding them (and a subtask in a sheet), selecting no text, even what a long press picks near the sheet's subtasks (its heading, its notes, which can still be selected on their own), checked in Vikunja and after a reload, says on its row a move turned down for an API token, moves a task with its ⋯'s Move up and with Alt+↓, opens and folds a project's Done section (from an old link too) and reopens a task there, renames and deletes a project from its ⋯, shares a task's and a project's progress as a text (through a share
  sheet, and copied where there's none) and as a Markdown list, with Open in Vikunja's address, and copies a task's notes
  and a comment, opens Today at once with the copy kept of it while its lists answer late (no Loading, a line under the
  header after a second) and changes a row in place, shows a new task at once and dotted only after a few seconds,
  shows a task with subtasks as a card on Today, on its next subtask in its List view's order (with no rows of its subtasks), ticks its step line (the next coming in once the batch clears), shows its count at its strip's end, the step's place with the done ones counted (2 of 3 with the first done), fills each segment of its line by whether its own step is done, and the step showing's by its progress (the step line having no bar of its own), keeps its height paged to a step with a date, pages it by a tap on an open step's segment (not a done one's, nor any past 12 steps), by its arrows, through the open ones, stopping at the ends (dimmed there), and by a finger dragged along its strip (past 12 steps too), the done ones skipped, not by a plain swipe on its step line or heading, the segment marked on its line moving along, its height steady and its line's length too as its arrows go, and back to its next step on leaving Today, checks its tap zones (its strip's, at its foot, clear of its step line's, and its step line's tick at its left edge, as a row's is), holds its step line to set that step's progress (stopping at 100% of it) and checks its line's segments, brings a task onto Today, opened on it, by a subtask of yours made today without a date (not one made before today), and by a subtask due today, and opens Today with its cards from the copy kept, keeps a long title with no spaces
  from widening the page, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side (keeping what was being written when Vikunja signs you out), single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), adds a subtask and a comment in a sheet offline, and a subtask from the add box on a project's list, puts a cancelled task's words back in the box, shows what's waiting in the header and lists it in Waiting to send (dropping one from there), moves over what an older Pocket left waiting, and has two tabs send the same waiting task. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (its sheet's steps numbered plainly, and no Comments, nor in its step's sheet; rows typed with Enter, times in words, a step to count from, a row moved, and Make again after a step's reply is lost), moves a step, held and moved up, and from its ⋯ (only its order line is written, a tapped step has no ↑ ↓, the order stays after a reload, a move cut off goes back, one whose reply is lost stays, and notes and moves saved elsewhere meanwhile are kept), starts runs (a template changed after a start leaves the run as it was; for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too, with a step of yours they've claimed), ticks, skips, unticks and adds comments (called that, on a step and on the run), ticks a step whose ✅ is refused (kept to try again, with an untick waiting behind it), does again a step someone else skipped, claims a step and lets it go (online, offline, and someone else's, which Done still works on), slides a step to claim it (kept when slid back to 0%, never someone else's), checks a run in a project only you can see (no slots on its steps or its card, nor your picture, someone else's still, and a slide claiming nothing), with its square box and the run's line a segment per step, checks the step card's strip (no bar at the top; the step's place, 2 of 3; its arrows through the open steps, stopping at the ends; a tap on an open step's segment, a done one's doing nothing; dragged along as a scrubber; a done step shown from its row, with no slot; and the card's slot, claimed and let go), checks that a timed step gets a reminder and that a countdown alerts once at zero, checks that a run is a card on Today, its heading its name without its day (and, started from a template that came round, its due time at the right, late), on its next step with its countdown, with no tick of its own, its line a segment per step (its count 3 of 3 with two done, the third marked), and that a step ticked there gets a ✅, and that a step someone else claims brings your run onto their Today, opened on it, opens a run and a step from Today and from the run's sheet, keeps a note with its step, sends a note typed before Done, finishes a run and checks the next one's Last time, checks a run is one row on its project's list (its steps not under it nor counted in Open, its row saying who it's for, not its steps done or the next), finishes one by ticking it there, after it asks (it goes to Done with the batch), and checks Done (counted once it's opened) has no template, template's step or run's step, and that search finds a template's runs but not the template nor its steps, and a run's step counting down with no 🔔, undoes a start (its line saying only "Started"), and names a run when starting it, renames it and makes it for someone else as well, then instead, from its ⋯, adds steps from the bottom box after the step on the card, each after the last, and repeats the card's step with Repeat, with its Undo (no › on the rows, the line above the box naming where each goes, marked, in their place after a reload, deleted, with a reply lost, offline, ticked before it's sent, and called off, a pasted list in order, and a step put on the card by a nudge, not by a longer scroll; and after the last step with every one done), checks that a run, and its card on Today, open on the step that can be done now (a step added after two counting down), holds a step to set its progress (its line, Undo, 100% is done, with the bottom box focused, and held past 100% while the screen redraws), with Last time's notes answering late and the steps not moving as they come, checks a run's row under Checklists has its progress line, a segment per step, and who it's for, with no count of its steps or the next, shares a run's progress with who did each step, opens the finished run from Last time (with no box at the bottom), then deletes it, cancels a start that waits, and one whose run was copied without a connection after, reads a step's time counted from a step named in words, goes Back from a project to Checklists, and changes, removes and deletes a template's steps, with ⋯ and × only on the step tapped, and writes a step's notes in its own sheet. It writes a template's name and steps with quick add (a person or priority read, shown as chips, sent, and a step changed in place read the same way). A template that comes round: its date and repeat set in its sheet leave it not done, it's on Today with no tick and opens Start, for its assignees; a start ticks it (the run due then, with no repeat or reminders), but not one days before it's due; a lost reply to the tick doesn't skip twice; one left for months moves past now; without a repeat a start ends it; taking its date off leaves it done; and a task with a due date made a template comes round. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step and a reply lost, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
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
made a while before it's sent, rows ticked leaving together (`later(3000)`). A toast is made to go at once
(`toastGone`), as its own timer would. A message in its place is found with `placeLine(page, 'overdue')` or
`rowLine(page, text)` (`tests/helpers.mjs`); a row ticked or deleted, waiting for the batch, is `.row.leaving`
(`.deleted` too for a deletion). Vikunja's clock is
real, so the page's goes back to the real time after, and what Vikunja dates itself still takes real time: a change a
second after another (its times have whole seconds), a task made on the web before one from Pocket. Those few waits say
why. Moving the clock on runs everything due meanwhile at once, and what that starts (a request, a redraw) lands after,
so it's for a wait that's about time, not one that lets the page settle.

**Waiting for Pocket to load.** A screen opened again shows the copy kept of it at once, with no Loading, and is
loaded afresh behind it: `loaded(page)`, in `tests/helpers.mjs`, waits until it's loaded (no Loading, and `#view` not
`aria-busy`), for a test that reads the screen once rather than with `expect`.

**Waiting for Pocket to send.** `<html data-sync>` says where sending stands: `sending`, `waiting` (something is kept
that can't go now: no connection, a deletion that can still be restored, one Vikunja turned down), or `idle`. `synced(page)`,
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
  tick every second, lines and toasts fold after 5, and rows ticked or deleted leave 3 seconds after the last. A test that waits in real time collides with them: move the
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
  subtasks), wait for what the screen shows first. A deletion waits for the batch: `later(3000)` clears it, as does
  leaving the screen.
- **The batch runs on the page's clock, which keeps the real time.** A test that ticks a row, then reads Vikunja before
  ticking it again, has 3 real seconds (from the tick's reply) before the row goes: tap first and read after, or keep
  the reads short. `page.mouse.down()` holds the batch, as a finger does, until `mouse.up()`.
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
  strings in a file, or the Edit tool. `.gitattributes` keeps text files' line endings LF in the working copy, as git
  has them, even with `core.autocrlf` on, so a file reads the same here as on Linux (the build also takes out any
  `\r` it's given, so the source map matches CI's either way). Counting `\r\n` in a file with `grep` from Git Bash
  counts "rn": the backslashes are gone before grep sees them. Without Playwright's own Chromium installed,
  `BROWSER_CHANNEL=chrome` uses the installed Chrome, for `test:parse` too.
- **Never stop processes by name** (`taskkill /IM`, `pkill`): that closes the person's own Chrome and Node. Stop only
  what you started, by its PID, or the `pocket-dev` containers.
- **The one-time hint adds a line to a screen's first row** on a phone that's never slid one: the end-to-end tests put
  it away from the start (`hintSeen(context)`, in `tests/helpers.mjs`), except the step that tests it, in a browser
  context of its own. A new context in a test needs it too.
- **Never run `npm run build` while tests run.** A changed page makes the open copies reload in the middle of a test.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with a small café's made-up tasks and checklists for two users of its own, `alex`, who owns it, and `priya`, the shift lead, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. New examples in the README and the guide follow the same café. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## The task row's specimen

`npm run specimen` makes `specimen/index.html`, a page for working on how a task's row looks: `markup/task-row.html` in every state (open, done, waiting to send, with progress, subtasks at each depth, due dates, priority, labels, people and comments, a run's row, read only, and a task's subtasks in its sheet with who's doing each, and a row held (a subtask too), swiped to its Delete, ticked and deleted in place, a delete carrying on off the screen, the batch clearing, and a tick not saved in a line's place; and a run's steps on its screen: done by you or someone else, skipped, inserted, repeated, counting down, late, held, a tick waiting to send, and in a run finished or read only; a step's square box beside a task's round one, runs' lines in segments, of a few steps and of more than 12, and a row slid that's just become yours; Today's rows on one line, from no priority to do now, and Today's cards: a task's subtask paged mid-way, 3 of 5 with one done, of high priority, a run's step counting down, one step only, with no arrows, and one of 14 steps, on the 8th, its line with ticks, of low priority; runs' rows as under Checklists, on a project's list and in search, with no count of their steps; a run's step counting down with no 🔔 for its reminder, beside a task's 🔔; and a run's step card, with its strip: on a step of yours counting down, one Priya is on, half done, and one done, shown from its row; and a run's screen adding steps from the bottom box, two after the card's step and a third waiting to send, the line above the box naming the last, with Repeat; a run's card on Today headed by its name without its day, and one due at 6 PM; and a template's steps as in its sheet, numbered plainly), in light and dark side by side. It uses the real stylesheet and Pocket's own component, given made-up tasks instead of signing in (`scripts/specimen/`), so it needs no server: open the file in a browser, and run it again after a change. It's for development only: git ignores `specimen/`, and nothing in `pocket/app/` refers to it, so it's never served or saved for offline.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag in `src/index.html`.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag in `src/index.html`.
