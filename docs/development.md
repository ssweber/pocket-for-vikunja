# Developing Pocket

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the sign-in screen, the app and its screens, the sheet and each kind of sheet, a task's row
               (task-row.html), one thing in a list with cards: a row, or a stacked card (list-item.html), a
               parent's ring (ring.html), a run's step card (step-card.html), who's doing a task or a step
               (claim-slot.html), a message in a row's place (row-line.html), one in its place: under a heading, by
               the add box, in a sheet (place-line.html), and what the add box adds subtasks or a run's steps to
               (cap-target.html); in sheet/, a task's sheet (task.html), the card it leads with: its row, notes and
               photos (task-card.html), and the question a parent's ring asks (complete.html)
  styles.css   all of the CSS
  js/          main.js, where the code starts; component.js, which puts the Alpine component together; the helpers
               (messages.js: what Pocket says; order.js: a project's order; share.js: progress as a text or a Markdown
               list; batch.js: when rows ticked or deleted leave together; cards.js: the stacked cards, and what
               brings one onto Today; progress.js: a swipe's sums and a parent's worked-out figure; throw.js: the ring
               of dates a task held on Today is thrown at); and app/, the parts of the component (app/throw.js
               draws and follows that ring)
  vendor/      Alpine as published, patched for long lists (alpine-3.17.4.js), which the build minifies into
               pocket/app/ (Upgrading the libraries, below)
pocket/        the plugin, as it's installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  app/         the built app (index.html, and index.html.br and .gz, the same page compressed), the libraries it uses,
               and sw.js, which lets it open offline
tests/         the test files described below, helpers.mjs (what the end-to-end ones share), and unit/, the tests
               that need no browser
scripts/       build.mjs: the build; dev.mjs: a local Vikunja with the plugin loaded; demo.mjs: the README's GIFs and
               screenshots; check.mjs: what npm run lint checks besides ESLint; specimen.mjs and specimen/: a page
               showing the task row, the stacked card, a parent's ring and the sheet in every state; perf/: measuring
               Pocket with long lists (Measuring, below)
.github/       CI on pull requests and main, and the zip attached to each release
docs/          this file, guide.md (everything the README leaves out), design-rules.md (what every change to how
               Pocket looks or what a finger does is checked against), the screenshots, design/ (feature plans) and
               roadmap.md: how the code and the way we work on it will change
  design/      plans for features, written before building them
```

The app is plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. It's written in `src/`, and `npm run build` puts it all into one file, `pocket/app/index.html` (with `pocket.js.map` next to it, so the browser's developer tools show the code as it's written in `src/`). Both are committed, so the `pocket` folder works as it is. Edit `src/`, never `pocket/app/`'s copy: CI checks that it's the build of `src/`. The build also writes the page compressed, `index.html.br` (brotli) and `index.html.gz`, committed with it: `main.go` sends the one a browser takes, the page a fifth of its size, and never serves them by their own names. They're made again only when they don't decode to the page, and are the same bytes on every computer, so CI's check covers them too. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

How Pocket looks and what a finger does on it follow nine rules, in [`design-rules.md`](design-rules.md): up and down
finds and organizes, left and right acts, every gesture has a tap path, a row acts the same everywhere, and so on.
Check a change against them, and say in its plan where it bends one.

The JavaScript is ES modules, each importing what it uses. The helpers in `src/js/` know nothing of the screen. The Alpine component, `pocket`, is one object: `app/core.js` has its data and what happens when Pocket opens, and each other file in `app/` adds its methods, put together in `component.js`. In those methods, `this` is the component, so any of them can call any other. A few things to know:

- A module can't assign to another module's variable. A variable lives in the module that changes it; the few that several parts change are properties of `shared`, in `app/core.js`.
- The markup's Alpine expressions see the component's data and methods, and the few helpers `component.js` lists as globals. A helper used in the markup has to be added there.
- What's done to a task is in `app/actions.js`, a method for each thing: ticking it (`toggleDone`, the one way, from a
  list or its sheet, which hands a run to `tickRunTask`; its open subtasks are closed with it only when it's completed
  from its ring, `extra.close`), its progress, deleting it, moving it to another project, its place in its project's list (`reorder`), adding subtasks, its people and labels, and saving a change. Each one makes the request, changes what's on screen and gives the way to take it back (a row's tick again, Restore, an Undo), so the lists and the sheet call these rather than `api()`. A run and its steps go through the outbox instead (`act`, in `app/runs.js`), and a template's steps are moved by `moveStep` (`app/checklists.js`).
- Each task on screen is one object, in `tasks`, by id (`app/tasks.js`): every list's rows are those objects, so a change shows on all of a task's rows at once. A list loaded from Vikunja puts its tasks there with `keep`. `cache` (`util.js`) is apart from it: Vikunja's last copy of each task, as it said it, for an Undo to compare with and a failed save to put back. A task's sheet still has a copy of its own, and a run's screen its own steps (see `roadmap.md`).
- A task's row is `markup/task-row.html`: in every list of tasks, on a stacked card, for the subtasks in a task's
  sheet, leading a task's own sheet, atop a run's screen, and for a run's steps there. A row acts the same everywhere
  (design rule 4); where it is changes only what it shows. Ticked or deleted in a list, it's marked (`leaving`, below),
  and shows it in place. What differs is said by the list it's in, `g`: `g.depth` (each row's depth under the task
  above it), `g.heads` (done tasks over their open subtasks), `g.sheet` (a subtask in its parent's sheet: its own
  tick, its words alone for a title, its due date only under them), `g.own` (the task's own row atop its sheet,
  `SHEET_ROW` in `lists.js`: its tick is `sheetDone`, a tap on its title changes it there, `editTitle`, and under it
  only when it's due, `OWN_META`), `g.top` (the run's own row atop its screen, `RUN_ROW`, below), `g.card` (a row on a
  stacked card, below) and `g.run` (a run's steps, each `t` a step as `runView` works it out, in `app/runs.js`). On a
  run, `g.at` is the step on its card, lit (`.row.current`), which the bottom box adds steps after (below); and
  `g.locked` a run finished or shared with you to read: no tick or ×. Every row takes a swipe for its progress (below);
  what else a finger can do on it is its list's: `g.delete` (swiped left at 0%, its Delete), `g.reorder` (held and
  moved up or down) and `g.reschedule` (held on Today, thrown at a ring of dates). A screen gives its lists these
  (`screenRows`, `lists.js`, in `listGroups`): a project `delete` and `reorder`, search only `delete`, as its results
  have no order of their own, Today `delete` and `reschedule`; a task's sheet gives its subtasks `delete` and
  `reorder`. A list's `g` can't be reached from the row's element, so the row writes them on itself
  (`data-gestures`, `rowGestures`), and the gesture code reads them there, in one place (`allows`, `app/progress.js`).
  The row asks the component by those options: its tick (`tickRow`: `tickStep` through the outbox for a step,
  `sheetDone` for `g.own`), or a parent's ring in its place (`rowRing`, below), what's under its title (`rowMeta`: a
  step's Inserted or Repeated, notes, and countdown; nothing on a run's row about its steps, which its ring says, nor
  who it's for, which its slot shows; no 🔔 on a run's step, whose reminder is Pocket's, for its countdown), and who's
  doing it (`rowSlot`, shown by `markup/claim-slot.html`; a done step shows who did or skipped it, ✅ or ⏭️ on their
  picture, instead; a run's row, and a template that comes round, who it's for, as pictures: `forSlot`, with "For you
  and Bo" to a screen reader). Every slot is `claimSlot`'s (`app/claims.js`), and it shows "+ me" only where someone
  else could take the task: in a project only you can see (`onlyYou`: `seenBy[pid] === 0`), no slot, nor your own
  picture, only someone else assigned to it, and a swipe claims nothing. `seenBy` (project id → how many besides you can see it) is
  `loadPeople`'s (`app/quickadd.js`: Vikunja's `/projects/{id}/users/search` for each project, four at a time, which
  counts teams and parent projects), kept on the phone (`saved`, `seenBy`), so Today opens with it; it's loaded in the
  background with the other tabs (`preload` → `refreshPeople`), once signed in and again after `PEOPLE_AGE` (10
  minutes). Until a project's known, or for an API token that can't ask (`accessBlocked`), its slots are as anywhere. A step swiped is `stepSlide` (`app/progress.js`). A template's steps keep a row of their own, an editor, with
  the same slot, and their number plain where a tick would be (`.check.step-n`, as the start sheet numbers them: a square box
  is a step you tick, in a run). A template's sheet, and its step's, have no Comments (`ofTemplate`): a run is Vikunja's
  copy of them, which takes their notes, attachments, labels and people but not their comments. A step's box is square wherever it shows (`isStepRow`: a run's screen, its sheet, a list), a task's
  round. A row's progress is drawn in its tick, a pie filling a quarter at a time from its `--pct` (styles.css,
  "Progress is drawn in the tick"), a square box's in squares; nothing under the row.
- Today is on one line (motion-and-rows-plan, section 9): its lists' option `g.line` (from `screenRows`) makes a row
  `.one-line`: its title cut short with "…", and at its right `rowWhen` (`app/views.js`): its priority's bars, small, as
  on a card's heading (a tick is never coloured by priority: one-concept-plan, part 4), when it's due, short
  (`shortDue`, `dates.js`; a run's step's `countdown`; nothing for today with no time under the Today heading, its
  group's `g.key`, which a card's rows have too), red when late, and its project's dot; labels and counts are left
  off. All of `rowMeta` but labels and
  counts (its `extra`) is said to a screen reader instead, in an `.sr` after the title (`rowWhen(t, g).said`). The row
  works `rowWhen` out once, as it does its slot (an `x-for` of one, `w`), and `rowWhen` reads `rowMeta`'s, countdown
  and all. Projects, search and sheets keep `rowMeta`'s second line.
- Anything with open subtasks or steps is a stacked card (`markup/list-item.html`, one thing in a list with cards:
  its row, or its card; `cardOf`, `app/cards.js`; parent-tasks-plan, part 2), wherever it's listed. Its lists' option
  `g.cards`, from `screenRows`, says which: `'today'` (the tasks Today brought as cards), `'found'` (search: any open
  task with open subtasks) and `'list'` (a project's open list, `listCard`); a list of done tasks has none. A card is
  its header (`.card-head`: the parent's ring, below, then `.card-open`, its title, which opens the task, its
  priority's bars and when it's due, short, worked out once per card by `cardHead`, which gives a run its name without
  the day it was started, `runWithoutDay` in `checklists.js`, so it reads as a task's, and says the rest to a screen
  reader: its ring's figure, when in words, its priority, its project, or who a run is for), then its rows
  (`.card-rows`: the shared task row, with the card's own options `c.g`, indented one level, as a subtask under its
  parent, each acting as any row does). On Today and in search it's collapsed: its top row only, and under it its
  footer (`.card-more`), a slim tab with ⌄ hanging under the last row ("More" to a screen reader), whose tap
  (`openCard`, kept in `cardOpen`, `app/core.js`) lists every open subtask, and then a plain ⌃ ("Show less",
  `foldCard`). The footer's tap is the card's width and 48px tall, from the row's foot to the next thing listed, so
  the next item's gap goes. An opened card collapses again once it's wholly off the screen (`watchCard`, an
  `IntersectionObserver`; `foldCard` keeps what's in sight still as it shrinks above it), and leaving a screen
  collapses them all (`resetCards`). With one open subtask, it has no footer. Its top row is the most urgent open
  subtask (`urgentFirst`, `cards.js`: overdue first, then due today, then the earliest date, then list order); a run's
  is its next step in order (`runTop`: the step a tick or a swipe pinned, `pinCard` in `cardPage`, until it has gone;
  then `runPick`, the run screen's own rule, `whereNext`, below). A top row ticked stays, ticked (`.step-line`, which
  `rowsOf` in `leaving.js` leaves out of the batch's folding), until the batch clears, and then the next slides up
  (`cardEntered`). On a project's list a card is always open, with no footer: its rows are the subtasks under it there
  (`g.kids`, from `nestSubtasks`, in its List view's order, a run's steps in its order line), those waiting to be sent
  among them; `listItems` (`lists.js`) leaves a card's subtasks out of the list itself. Held by its header, the card
  moves up or down among the tasks at the top, as a row does (`cardHold`); a subtask with open subtasks of its own is a
  row on it, its ring for a tick, that opens its sheet, its own subtasks not on this card. A done task over open
  subtasks is a card too, its title struck through. A card is set apart by a gap of the page's colour above and below
  it, and a list cut by cards and footers reads as rounded blocks (`.item::before`, rounding each item's corners where
  the page shows next to it, `--c-tl` and the rest). What brings a card onto Today, and why, is `todayItems`
  (`cards.js`, beside `app/`, so the unit tests check it): a task due, a subtask due, a subtask of yours made today
  without a date (Vikunja doesn't say when a task was assigned), a run of yours or one you're on a step of;
  `view.cards` keeps, by task id, the earliest date that brought each (`when`, which `placeDated` and `todayOrder`
  place it by, with `todayAt`), and when the latest subtask of yours that did was made. `readCards` reads the cards'
  tasks and their subtasks once per project, from its List view with `expand=subtasks` (their positions with them),
  and a run's with Today's run index; search reads its cards' subtasks the same way. A run's step on a card has its
  countdown, to the minute (`countdown`, in `rowMeta`).
- A task with subtasks, or a run with steps, is a parent: it has no progress of its own to set (design rule 5), and
  a ring in place of a tick (`markup/ring.html`, `ringOf` and `rowRing` in `app/cards.js`): thin, never filled by a
  quarter, so it isn't taken for a task's tick, its arc the worked-out figure and done of all inside it ("2/4"). It's
  on a card's header, on a parent's row (a run's anywhere, Checklists' In progress too), on its own sheet's row and atop
  a run's screen. The figure (`workedOut`, `progress.js`) is the average of its subtasks' progress, a done one 100%, a
  run's skipped step done too, rounded: one subtask at 50% of four is 13%. It's written to the parent's
  `percent_done` with the change that caused it, never as a save of its own: `writeFigure` (`app/actions.js`) saves it
  in the chain of saves right after the change, from Vikunja's copy read just before (`figurePatch`: only when it
  changes), for a subtask's tick, progress, deletion or new subtasks (`refigure`, `parentIdOf`); a run's step acts end
  with a part of their own, `figure` (`ACTS` in `sync.js`), so offline it waits in the same outbox entry. A parent
  whose subtasks are all removed keeps its last figure, and is swiped as any task. Ticking a parent no longer closes
  its subtasks, and its last subtask done doesn't close it (design rule 7): an open parent whose subtasks are all done
  is a card everywhere it's listed, its ring full, and "All subtasks done" (a run's "All steps done") with **Close**
  in place of its rows (`closingCard`, `c.closes`); a subtask added makes it a card with rows again. The ring's tap
  (`ringTap`), its Close and a full swipe right on its header or row are one action: marked and waiting for the batch,
  taken back; done (a done head, a finished run), opened again; every subtask done, closed; a repeating task, moved on
  to its next date, its subtasks as they are; one open subtask, it and the parent completed, with Undo; more, or a run
  with steps not done, asked first (design rule 8: `askComplete`, a sheet of its own, `sheet/complete.html`, its
  sentence from `completeAsk` in `messages.js`: "Its 3 open subtasks will be marked done too: Load chairs, Book the
  hall and Wipe the tables", the first three named, then "and 2 more"; a run's "Finish this run with 2 steps not
  done?"). Confirmed (`confirmComplete`), `closeParent` closes them with `toggleDone`'s `extra.close`, and the card is
  a gap holding "Done" and Undo until the batch clears (it stays a card meanwhile: `closing`). Asked from the parent's
  own sheet, Cancel, or closing the question any other way, goes back to that sheet (`cancelComplete`, from
  `closeSheet`). A partial swipe right on a parent springs back (`ringSwipe`: one stop, its full point); left, it's
  its Delete, which asks about its subtasks.
- A task's sheet (`sheet/task.html`) leads with one card (`sheet/task-card.html`): the task's own row (`g.own`, above),
  then its notes, then its photos and files, so a tap on a task opens the same row it was. Its row is swiped as in a
  list (`sheetRowGesture`, `app/progress.js`), springing back whatever it set: a full swipe right ticks it in place,
  with no gap, as the sheet is about this one task; swiped left at 0%, its Delete, which closes the sheet on the
  list, where the task's gap has Restore. The tap path for progress is the Progress line in Details: 0, 25, 50 and
  75% (`QUARTERS`, the one it's at pressed, `quarterOn`), through `setSheetProgress`, as the swipe's; none for a
  parent, whose ring says its figure. Priority is a row in Details too, above Progress. A template and its step have no
  row (they're never ticked: their name is a heading over the card, `.d-title`), only their notes and files.
  `lines.js` and `leaving.js` leave the sheet's own row out (`.row.own`): what's said about the task goes to its list
  row, or the sheet's places.
- A run's screen (`screens/run.html`) leads with the run's own row (`#run-own`, the task row with `g = RUN_ROW`, `t =
  runOwn` from `app/runs.js`), between Back and ⋯, in the header's place for its name: its ring (`runRing`, worked out
  from the screen's steps, ticks and progress waiting to be sent counted; its tap, `runRingTap`, asks to finish the run
  with steps not done, finishes it once every step is done, or reopens a finished one), its name, which opens the
  run's sheet, and who it's for in its slot. Swiped (`runRowGesture`), it's a parent's: it springs back, and a full
  swipe right is the ring's tap; it has no Delete (a run is deleted from its ⋯). Who started the run is its history:
  the finish card's summary and the ⋯ say it (`startedText`, `messages.js`). Then its step card
  (`markup/step-card.html`), the step on it `runView.step`, at `runView.at` (`app/runs.js`; `view.run.at` once a
  step's put there, by `showStep`), then its steps, its comments and Last time. The steps listed under the card say
  where the run is: a tap on one puts it on the card, a done one too. What's written on a run or a step is a Vikunja
  comment, and the screen calls it one ("Comment on this step", "Comments on this run"), as a task's sheet does:
  "Notes" is only ever a task's description. The code keeps its older names for them (`addNote`, the act `'note'`,
  `runDrafts`, `notes`, `lastNotes`, `#step-note`, `#run-notes`). Beside the card's title, the step's slot, its row's
  (`rowSlot`). Where the run goes next is one rule, `whereNext` (`checklists.js`, so the unit tests check it): the next
  open step after the one just done, in order, even one still counting down, round to the first open one, and before
  it a timed step whose time has come (its countdown at zero, or late), the first such in order. The screen opens on
  it (`r.at` null), a tick goes to it (`nextStep`), and a run's card on Today has it on top (`runPick`, its countdowns
  as Today shows them).
  A step is added to a run from quick add's box at the bottom, as a subtask is on a project's list: on a run's screen
  it's the box `'ins'` (`capW`; its text is `runInsert`, apart from quick add's own), shown while the run can be
  written to and isn't finished. It's aimed at the card's step (`runAim`, `app/runs.js`), the line above it
  (`cap-target.html`) saying "Add a step after “…”"; steps added one after another go each after the last
  (`runAdded`, kept as each is put in the outbox, so one typed before it's sent goes after it), until the card's step
  changes (`showStep` clears it). Every step done, it aims at the last. `insertStep` reads the box's lines and
  `addSteps` puts them in the outbox (`addStep`, each with the step it goes before and after); Repeat on the line,
  `repeatCard`, is `repeatStep` of the card's step there, with an Undo by the box (`undoAdded`: `dropStep`, or
  `deleteAddedStep` once it's sent). A nudge on a step's row puts it on the card (`nudged`), as a tap does.
- What a finger does on a row is `app/progress.js` (`holdToSlide`), the sums beside `app/` in `progress.js`, so the
  unit tests can check them. A plain swipe, with no hold, once it's clearly sideways (`swipeStarts`: 8px, 1.2 times
  more sideways than up or down, not from within 24px of the screen's edges, where the phone's Back starts), is one
  mechanism with mirrored sides (`swipeAt`, each side's numbers in `SIDES`): the row's content moves with the finger,
  the space it uncovers shows what letting go there does, and nothing changes until it's let go. Each side has one job,
  chosen by which way the finger first goes and by the row as the swipe starts, and a swipe keeps that side: dragged
  back past where it started, it stops there, changing nothing. Right (`up`): its progress, the large ring on green in
  the space uncovered filling to 25, 50 and 75% over the first half of the row (`revealOf`), a tick felt at each
  (`swipeFeel`, `haptics.js`); let go, that progress is set and the row springs back, its tick showing the quarter;
  past half, the green fills the row and the ring its ✓, and let go there it's done, the row carrying on off the
  screen to the right and leaving a gap at its height with "Done" and Undo (`sweep`; `markRow`'s `gap`, `swept`). Left,
  a row with progress (`down`): the ring emptying, the same room a quarter, stopping at 0% with a firmer tick however
  far it's pulled, no Delete on the same swipe; a done row opens again at 75% and on down. Left, a row at 0%
  (`delete`): its Delete (`swipeOf`), open on its button if let go past a third of it, and past half the row, deleted,
  the row carrying on off to the left and leaving its gap with Restore. So a row with progress takes two swipes to
  delete, and a slip can't. To give progress more room, change `SIDES`; the space uncovered spans the whole row, from
  the list's edge whatever its indent. A row no one is doing, in a project someone else can see, is claimed once a
  swipe that changed it is let go (design rule 6): `claimOnSlide` (`app/claims.js`) shows you on it (`slideClaim`,
  laid over its people by `peopleOf`) and sends the claim through the outbox (`claimsOnSlide` says who may); the
  sheet's row and its Progress line the same (`sheetSlot`: after its save, whose reply would otherwise be shown over
  the claim; its Assigned row shows `peopleOf`). A hold (`HOLD_MS`) only picks a row up to move it up or down
  (`holdOf`), where its list allows: on a project's list and in a task's sheet, its place among its siblings
  (`reorderOf`, `dragOf`: the row follows the finger, the rows it passes make room, and the page scrolls near the
  edges, `edgeRoll`), and moved sideways after the hold, it's let go; on Today, it's thrown (below); in search it does
  nothing. A sideways move the row can't take does nothing, not even a tap. A run's step is swiped as a task's row
  (`stepSlide`, through the outbox: `stepProgress`); a step can be deleted only if it was inserted or repeated during
  the run (`swipeDeleteStep`), so a template's step stops at 0%.
  On Today, a row or a card held is thrown at a ring of dates (design-rules.md's one exception to rule 8: it moves
  at once, with no Undo, as letting go in the middle calls it off). `src/js/throw.js` is the sums, pure, so the unit
  tests check them: `THROW`, the one list of targets and numbers (Today left, Tomorrow right, an arc of Monday to
  Friday above, each the next such day after tomorrow, and No date a long pull down), `throwTargets` (each target's
  day and new due date, through `movedDue`, its time of day kept; dimmed where it would change nothing),
  `throwLayout` (where each sits, shifted onto the screen), `throwPick` and `throwFlick` (which a finger is on, or
  flicked to). `app/throw.js` draws and follows it: `rescheduleOf` (what can be thrown; a repeating task, a checklist
  that comes round, a run or its step open the ring with every target dimmed and a line saying why), `throwOf` (the
  hold: `lift`, `move`, `end`, the task shrunk to a small box that follows the finger's movement, as the ring is too
  wide to sit around the finger on a phone, so it opens nearly always mid-screen), `ringEl` and `ringLight`. Letting
  go in a target is `reschedule` (`app/actions.js`): the date moved on screen at once (`placeOnToday`), then saved; not
  saved, it goes back with Try again. A card moves only its task's date. It's hooked in at one place:
  `screenRows('today')`'s `reschedule`; without it a hold on Today does nothing.
  A row held or swiped is never text: no selection starts meanwhile (`noSelect`, on `selectstart`), and one the
  phone's long press made is cleared at the hold and as the row moves. A long press picks the nearest words it can
  select, so the rows, a sheet's subtasks' card and the headings (`.h3`) can't be selected at all; notes, comments and
  what's typed can.
  Until a swipe first sets progress, on this phone (`hint`, kept as `pocket.hint.slide`), the first row of a list that
  takes a swipe (`rowSlides`: not a parent, nor one waiting to be sent or read only; on Today, a card's top row, the
  hint then being the card's) says "Swipe right to start working on it", under its title: `pickHint` picks it once, as
  the screen is first drawn (`hint.pick`, set by `render`), never later, so it never pushes rows down; put away by a
  swipe or a tap, it fades, keeping its space while a finger may be on the list: by the batch's rules, a second after
  the finger lifts with the list still (`hintAway`, `closeHint`, `app/leaving.js`), it folds. A screen reader hears it
  once, through `#said`.
- A project's order is its List view's in Vikunja (`order.js`, beside `app/`, with the sums: where a move goes, between
  its neighbours as Vikunja's web app puts it, and which rows are a task's siblings). `positions`, by task id, is read
  with the project's list (`loadProject`) and with a task's subtasks in its sheet (`loadSubOrder`), and sorts both
  (`positionOrder`, in `listGroups` and the sheet's `subtasks`). A move (`reorder`) changes it at once and writes the
  new position through the outbox (a `position` act), so it waits without a connection; if Vikunja keeps another
  value, it renumbered the view, and the list is read again. A template's and a run's steps keep their order line
  instead (`hasOwnOrder`, `moveStep`): Vikunja's List view leaves out done tasks, as a template and its steps are. A
  project's done tasks are its Done section, the list's second group (`fold`), counted when the list loads and loaded
  when it's opened. A done task with subtasks still open is shown on the open list anyway, a card struck through over
  them, a head (`doneParentIds`, in `lists.js`; the open group's `heads`; `isHead`), its ring opening it again: one the
  view didn't give is read, all in one request, and goes where its first open subtask is. A parent completed with a
  subtask that repeats left open under it stays as one (`makeHead`), and one opened again stays where it is
  (`reopenedHead`). What lives on Checklists
  is left out of a project's lists and search (`withoutTemplates`, `app/checklists.js`, on what was loaded, with no
  request of its own): a template marked done and its steps, everywhere, and a finished run's steps on a project's list
  (`onProjectList`: a run in progress keeps its open steps, so it's a card with them), so a run finished with steps not
  done goes to Done, not over them; Done leaves out every run's steps. A step's template is
  known by its parent: a template in the same list, one kept from Checklists (`templatesKept`, saved as `templates`) or
  in `cache`, or a title starting "TEMPLATE:" (Vikunja gives a task's parent without its labels). A project for
  checklists' Done isn't counted by Vikunja (most of its done tasks are those), but once loaded.
- On a project's list, quick add's box adds subtasks to the task touched last, the cursor (`cursor`, in
  `app/quickadd.js`): its sheet opened, ticked, or its progress swiped. It's then the box `'under'` (`capW`), which reads
  lines as the sheet's subtask box (`'sub'`) does, and both send through `addSubtasks` (`app/actions.js`), each with its
  position (`placeAfter`, in `order.js`): after the cursor's subtask, or the last one added from the box, or the
  parent's last. Its row is watched with an `IntersectionObserver`, and the box goes back to adding a task once the row
  is out of sight; leaving the screen (`navigated`) clears it too. A card the box adds to is lit (`.day-card.aimed`),
  as a row is. A nudge aims it as well (on a run, at a step): a touch
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
  those are as new (`keptRows`, by `updated`), and none deleted this session; a task loaded again has only the fields
  that changed written to it (`keep`, `app/tasks.js`), so a row whose task didn't change has nothing to do. A project's
  copy keeps its Done section's count, not its tasks (`keptGroups`, `lists.js`: thousands would fill the phone's
  storage), and opens Done only if it's open now (`doneOpen`). Each loader reads (`readToday`,
  `readProject`, `readChecklists`) apart from putting it on screen, so `preload` can load the copies of the other tabs
  in the background (`preloads`: Today, the project opened last, Checklists), one at a time when the phone is idle,
  without touching the screen or the store.
- Opening Pocket doesn't wait for the network. `sw.js` answers it from the page it saved, and fetches the page behind
  it to save for next time: a new version shows on the next opening, or sooner, when `updateIfNew` finds it (coming
  back to Pocket, or refresh) and nothing is being written; with no page saved, or a 5xx, as before. Then `boot`
  (`app/auth.js`) shows the kept screen before asking Vikunja for `/user` and the projects, when the sign-in is the one
  Pocket last confirmed as this person's: `keepWho` keeps its token's SHA-256 (never the token) beside their copies,
  as `saved.who`, and `keptUser` checks it. Until `/user` answers, a change waits and the outbox isn't sent (`opening`,
  `api.js`); then it goes only if it's still the same person, and someone else has everything kept cleared at once
  (`switchAccount`). Any other sign-in (the web app may have renewed the session) waits for Vikunja, as does a screen
  with no copy.
- A long screen is drawn in batches (performance-plan, part 5), so its first screenful takes the same time however
  long its lists are. `render` calls `drawFrom(0)`: the first `FIRST_ROWS` (20, enough to fill a phone) at once, then,
  after they're painted, a batch at a time, each a frame's work (`FRAME_MS`) for the first three screens
  (`NEAR_ROWS`) and then about a second's (`LATER_MS`), so taps and scrolls are answered between them (`batchMs`,
  `nextBatch`, in `lists.js`). `drawTo` is how many of the screen's rows are drawn, down its lists in order: each list
  draws `drawn(g)`, its share of them (`drawnOf`, by `listGroups`' `before`, the rows above it). Until every row is
  drawn, `drawing` keeps the screen busy (`<main id="view" aria-busy>`), so the tests' `loaded()` waits for them, and
  `preload` waits too. Scrolling down to within a screen of the end of what's drawn draws the rest at once
  (`drawAll`), so the end of what's drawn is never taken for the end of the list. A list added to a screen goes
  through `drawn(g)` too: its `x-for` is handed the list as it is, not as Alpine watches it (`raw`), and keyed by a path
  into the item (`:key="t.id"`), which the patched Alpine reads off the item and, for the rows at the start that are
  where they were, keeps (Upgrading the libraries, below); otherwise each batch goes over every row drawn so far.
  A row held to move it draws the rest first (`reorderOf`, which needs all its siblings); Done opened, and its row for
  more, draw from where they start (`drawFrom(n)`). Rows gone after a load are found in one pass (`settle`), and
  `collapseRows` (`util.js`) folds them only when a few (`FOLD_FEW`) are on screen, reading every height before any
  animation starts; more, or off screen, simply go.
- A project's Done shows the 100 done most recently (`DONE_PART`, `lists.js`; performance-plan, part 9), its heading
  counting them all, from Vikunja's `total` ("Done (3,000)"). `doneTasks` reads a part with `partOf` (`api.js`): as
  few pages as `max_items_per_page` allows, all at once. At its end, `markup/more-row.html` (`moreOf`, its words
  `moreDone` in `messages.js`) shows the next 100 (`showMore`), read from how many are shown, any read twice left out;
  each visit starts again at 100, and a refresh of the screen reads as many as it shows. Search's done matches do the
  same, 50 at a time (`FOUND_PART`, `foundDone`). A project for checklists reads its done tasks whole, as its Done
  leaves most of them out (runs' and templates' steps), and shows them 100 at a time. Every other list is read to its
  end (`allPages`: page 1, then all the rest at once, at the server's `max_items_per_page`, 50 if `/info` doesn't say).
- A change shows at once, as it'll be; it looks waiting only once it has waited `WAIT_MS` (2.5 seconds, `sync.js`), or
  at once without a connection: `markSlow` (`app/sending.js`) keeps `slow`, the outbox entries that look it, which the
  task row (`waits`), a run's steps (`slow`) and the header's button (`waitShown`) go by. A task not sent yet is on its
  list from the start, where it'll be (`todayOrder`, `positionOrder`), so it doesn't move once it's sent.
- A row ticked, opened again or deleted in a list (Today, a project, search, a task's sheet for a deletion) is marked:
  `markRow` (`app/leaving.js`) keeps it where it is, at its height, as `leaving[id]` says (`'done'`, `'open'`,
  `'deleted'`: a gap at its height, `.del-gap`, holding only "Deleted" and Restore where its slot was; tapped, the row
  slides back in, `restoreRow`; done by a full swipe right, or a parent completed from its ring, the same gap holding
  "Done" and Undo, `gap: true`, kept in `swept`), with the rows that go with it (subtasks closed with a parent, or
  deleted with it). Its tick meanwhile is the mark's `undo` (`unmark`, from `tickRow`); a deleted row's
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
  `{title, done, pct, people, items}`, a parent's with its ring (`ring`: `shareRing`, from `ringOf`), so what's shared
  says the figure the screen shows (design rule 9): its percent, and a bar of one segment per subtask, filled for each
  done; and `share.js` writes them as a text or a Markdown list, from data only, never
  HTML, so the unit tests check every rule (`share.test.mjs`). `navigator.share` is called straight from the tap, with
  nothing awaited before it, as a phone allows it only then; without it, the text is copied.
- Colours are custom properties, in `styles.css`'s `:root`, with dark mode's in the block after it. So are the two
  sizes a row is laid out by: `--tick` (28px: every tick, step box and ring) and `--title-x` (where a title starts, 14px
  + the tick + 12px), which the subtask indent, the tick's and ring's touch gutters, a card's footer, "All subtasks
  done" and the sheet's notes line up on. A row's title is placed from its top, its first line centred on its tick. Type
  is one scale: 17px for body text, row titles and headings (a card's header and the sheet's own row heavier, 650), 15
  for labels, 14 for what's under a title, 13 small, and 22 for every sheet's title (one rule in `styles.css`); inputs
  never go under 16, or an iPhone zooms in.
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
  and with no server: the order of a list and subtasks under their parents, a done one too, what a project's lists and
  search leave out (templates marked done and their steps, and a run's steps in a project's Done), Today's groups and
  their order, a card's by what brought it (`lists.test.mjs`); due dates in words, and short, for a row on one line
  (and nothing for today with no time under Today's heading), and a date moved to another day keeping its time of day
  (`dates.test.mjs`); which tasks are cards on Today and why, where each sits, a card's top row (the most urgent; a
  run's next step, kept while a tick has pinned it), collapsed with More under it, opened and collapsed by Less, none
  with one open subtask, search's cards, a project's open cards, a ticked top row staying until the batch clears, the
  hint on a card's top row, a row on one line, a run's card's heading, where a run goes next (`whereNext`) on its
  screen and on its card, the step card's slot, a run's own row (its ring, its slot, who started it), its bottom box
  and Repeat, and a parent's ring: one open subtask completed at once, more asked first, the question asked from a
  sheet going back to it, every subtask done waiting for Close, a repeating parent, a run's ring and a done parent's
  (`cards.test.mjs`); progress in percent, 100% done, the subtasks closed with a parent, the hold's lock, a swipe told
  from a scroll, each side of a swipe (right's stops over the first half and done past it, left going down and
  stopping at 0%, a Delete at 0%, the side kept), what's felt, who a swipe claims for, a parent's worked-out figure and
  when it's written, a parent's header swiped, the sheet's Progress line, and a nudge told from a tap and a fling
  (`progress.test.mjs`); a checklist's steps, their order and times (`checklists.test.mjs`); when rows ticked or
  deleted leave together, and what a tap on a marked row does (`batch.test.mjs`); the address, util.js and what's
  waiting to send, and when it looks it (`helpers.test.mjs`); what Pocket says (a tick too, a run's comments called
  comments, the question a ring asks naming its subtasks in a sentence, a card thrown but kept by its subtask, who
  started a run) and in which place (`messages.test.mjs`); a project's order: its List view, a move's position, a
  task's siblings, a drag, and which task the add box adds subtasks to and where they go (`order.test.mjs`); progress
  as a text and as a Markdown list: the bar, names, due dates, nesting, a run and a project, what collapses, and a
  parent's ring's figure, the text from a task's sheet and a run's screen matching its ring (`share.test.mjs`); the one
  copy of each task (`tasks.test.mjs`); what the one row asks by its options: a step's tick, what's under its title (the
  sheet's own row only when it's due; a run's row nothing, who it's for in its slot; a run's step without a 🔔) and
  who's on it, what a finger can do on each screen's rows (Delete everywhere, moved on a project and in a sheet, thrown
  on Today, nothing more in search), a run's step swiped (only an inserted one on into a Delete), a done step swiped
  down, a step done by a full swipe, a swipe claiming a row no one is doing once it changed something (the sheet's row
  and its quarters after the save), no "+ me" nor your picture in a project only you can see, who can see each project,
  kept and loaded again, which boxes are square, which row the one-time hint goes on, the sheet's own row swiped, and
  a row held on Today thrown at the ring, but not one that repeats, a checklist, a run or its step (`rows.test.mjs`);
  the ring a task held on Today is thrown at: each weekday's tiles on each day of the week, the week's gap and labels,
  dimmed targets, the time kept, which target a finger is on or flicked to, the ring fitting a 375px screen, and what a
  screen reader hears (`throw.test.mjs`); and what's done to a task (`actions.test.mjs`): ticking a parent leaves its
  subtasks as they are, while one completed from its ring closes its open subtasks, shown in place with it and gone
  together when the batch clears, its Undo opening exactly those, from its sheet too, a done parent over its open
  subtasks opened again where it is, and one completed with a subtask left open staying over it; a repeating task whose
  reply is lost is ticked once, and one shown done then back at its next date; progress at 100%, a full swipe's gap
  with Undo, a done task swiped down opened again in one save; a parent's figure written right after a subtask's tick,
  progress or deletion, and a run's in the same outbox entry as its step's change; saves one after another, deleting,
  a deletion held until its row has gone (and sent without a connection later, or brought back if Vikunja turns it
  down), Move all to today, and a row or a card thrown to a new date (at once, with no Undo; not saved, back with Try
  again; a card moving only its task's date). The app's methods run as they are, on a pretend component, with a
  pretend Vikunja behind `fetch()` (`fake.mjs`, which gives a task's subtasks as they are when it's read, as Vikunja
  does). `browser.mjs` gives the modules what they look for in a browser as they load, and nothing more: there's no
  DOM, so reading a task's notes (Pocket's lines in them) stays in `parse.mjs`. A test file per area: a new one is
  picked up by its name, `*.test.mjs`.
- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, how pasted lists lose their bullets and checkboxes, how checklist steps are read, a template's order line, and a run's, with steps inserted in it, and what's a template, its name, and where Vikunja moves one that comes round. It loads `src/js/quickadd.js` and `src/js/checklists.js` as they are, so it needs no build and no server, and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, adds subtasks in the sheet with quick add's chips, claims one and lets it go, and a task from its row, adds subtasks from the add box on a project's list to the task
  touched last (after its last subtask, or right after a subtask touched, in order, and back to a task with its ×, a
  scroll or another screen, and aimed by a nudge: a short, slow touch-drag, not a long or fast one, a hold, a done or read-only row, or one on Today, while a tap still opens the sheet), ticks a subtask in a list (it stays, with no message), swipes progress on a task no one is doing to claim it once it's let go (not on a swipe that changed nothing, nor on someone else's, and kept when swiped back to 0%), and the sheet's own row and a quarter in its Details the same (shown in Assigned), checks a project only you can see (no "+ me", nor your picture, someone given a task in a shared project, then moved there, still shown, a swipe claiming nothing, and a task due today with no time showing no time under Today's heading), shows the one-time hint, "Swipe right to start working on it", on a phone of its own, on the first row that takes a swipe, without moving a row as it goes, put away by a tap or a swipe, its space closing only once no finger is down, and still away after a reload, taps the sheet's Due, Reminders, Repeats, Project, Labels and Assigned rows anywhere (and the × that clears a date), shows a row on Today on one line (its priority's bars before when it's due, short, no priority on its tick, and its project's dot, a long title cut short, the rest said to a screen reader) and with its second line on its project's list, checks a row's three tap zones (its tick over the whole left gutter, its title, its slot, each the row's full height and 48px across), swipes a row on a project's list and a subtask in a sheet to Delete (a full swipe carrying on off the screen, leaving a gap at its height, with Restore, a tap on the gap bringing the row back, sliding in, nothing sent until the batch clears, and sent at once on leaving the screen), deletes a row on Today by a swipe (two swipes for one with progress: the first only lowers it), checks that search's rows are swiped to Delete but not moved, and that a task found with open subtasks is a collapsed card, opened by More and collapsed by Less, swipes progress with no hold (nothing changing while it's held, the tick's pie after, a swipe keeping the side it started on, and a full swipe done, its row a gap with Undo; a partly done tick ticked by a tap), ticks rows that stay in place at their height until 3 seconds after the last (a finger down holding them), then leave together, folding (fading, with less motion), and ticks one again to open it, moves a task to Overdue as its time passes (lighting it up, with no message at the bottom), says by the add box where a task went when it isn't on the screen, and with Open, says a tick not saved on its row and a save not made in the sheet, each with Try again, says Move all to today under the Overdue heading, adds and removes reminders in the sheet (keeping those changed elsewhere meanwhile), offers the 🔔 chip only for a time and only when reminder emails reach you, completes a parent from its ring (the question, Complete all, its subtasks shown done in place, and Undo opening only those), shows a parent done elsewhere over its open subtasks and opens it again by its ring, checks a parent's ring (its figure written, 25%, then 38% once a subtask is swiped, in one write; the question by a tap and by a full swipe, a partial swipe springing back, Complete all with Undo, one open subtask with no question, Close once every subtask is done, and a subtask added dropping the ring back to 4/5 and 80%), a task's sheet led by its row (its tick, its title changed where it is, its swipe, Priority and Progress in Details, its number at the top), and the question asked from a sheet going back to it (by ×, the shade, Back, and asked by a full swipe on its row), adds quick ticks up into one Undo, takes the top suggestion on Enter, reads a bare hour as daytime and warns of a repeat Vikunja can't do, closes a sheet with the phone's Back and keeps the draft through a reload, moves a ticked search result to Done once the batch clears, keeps notes and a comment being written when the sheet closes, doesn't write over notes changed elsewhere meanwhile, adds a label with Enter and a suggested person, shows a repeating task ticked, then back at its next date, and its tick again putting its dates back (its reminder at a set time too), ticks one whose reply is lost, leaves a repeating subtask alone when its parent is completed ("The one that repeats stays as it is."), moves and deletes a task with its subtasks, keeps a project's list in its List view's order and moves a task and a subtask in it by holding them (and a subtask in a sheet), selecting no text, even what a long press picks near the sheet's subtasks (its heading, its notes, which can still be selected on their own), checked in Vikunja and after a reload, says on its row a move turned down for an API token, moves a task with its ⋯'s Move up and with Alt+↓, opens and folds a project's Done section (from an old link too) and reopens a task there, renames and deletes a project from its ⋯, shares a task's and a project's progress as a text (through a share
  sheet, and copied where there's none) and as a Markdown list, with Open in Vikunja's address, and copies a task's notes
  and a comment, opens Today at once with the copy kept of it while its lists answer late (no Loading, a line under the
  header after a second) and changes a row in place, shows a new task at once and dotted only after a few seconds,
  shows a task with subtasks as a stacked card on Today (its most urgent subtask on top, its header with its ring, its rows indented, its footer's tab and its tap area from the row's foot, More and Less, its top row ticked staying until the batch clears and the next sliding up, a row on it swiped and the parent's figure written, a full swipe's gap, and its ring with one open subtask), collapses an opened card once it's scrolled away or Today is left, brings a task onto Today by a subtask of yours made today without a date (not one made before today), and by a subtask due today, and opens Today with its cards from the copy kept, draws a long project's 80 open tasks a batch at a time on a phone's CPU, every row there once it's loaded, shows its Done's 100 done most recently with a row for the last 5, and search's done matches 50 at a time with the same row, opens the project's kept copy with Done closed and no done rows when it was left closed, opens Pocket on that kept screen before Vikunja says who's signed in (a tick made meanwhile sent only after), gets the page compressed from the plugin (brotli and gzip, each the page decoded, and neither served by its own name), keeps a long title with no spaces
  from widening the page, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side (keeping what was being written when Vikunja signs you out), single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), adds a subtask and a comment in a sheet offline, and a subtask from the add box on a project's list (waiting on its parent's card), puts a cancelled task's words back in the box, shows what's waiting in the header and lists it in Waiting to send (dropping one from there), moves over what an older Pocket left waiting, and has two tabs send the same waiting task. It also opens Pocket again from the page it saved, then from the one fetched behind it. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (its sheet's steps numbered plainly, and no Comments, nor in its step's sheet; rows typed with Enter, times in words, a step to count from, a row moved, and Make again after a step's reply is lost), moves a step, held and moved up, and from its ⋯ (only its order line is written, a tapped step has no ↑ ↓, the order stays after a reload, a move cut off goes back, one whose reply is lost stays, and notes and moves saved elsewhere meanwhile are kept), starts runs (a template changed after a start leaves the run as it was; for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too, with a step of yours they've claimed), ticks, skips, unticks and adds comments (called that, on a step and on the run), ticks a step whose ✅ is refused (kept to try again, with an untick waiting behind it), does again a step someone else skipped, claims a step and lets it go (online, offline, and someone else's, which Done still works on), swipes a step to claim it (kept when swiped back to 0%, never someone else's), checks a run in a project only you can see (no slots on its steps or its card, nor your picture, someone else's still, and a swipe claiming nothing), with its square box, checks the step card and the steps under it (a step put on the card by a tap on its row, a done one too, saying who did it, with no slot; and the card's slot, claimed and let go), checks that a timed step gets a reminder and that a countdown alerts once at zero, checks that a run is a card on Today, its heading its name without its day (and, started from a template that came round, its due time at the right, late), its ring for a tick (2/3, 67%), its next step on top with its countdown, and that a step ticked there gets a ✅, and that a step someone else claims brings your run onto their Today, opens a run and a step from Today and from the run's sheet, keeps a note with its step, sends a note typed before Done, finishes a run and checks the next one's Last time, checks a run in progress is an open card on its project's list (its steps not done its rows, Open counting every open task listed), finishes one from its ring there, after the question names its steps not done in a sentence (a gap with "Done" and Undo, which opens it again; finished again, it goes to Done with the batch), and checks Done (counted once it's opened) has no template, template's step or run's step, and that search finds a template's runs but not the template nor its steps, and a run's step counting down with no 🔔, undoes a start (its line saying only "Started"), and names a run when starting it, renames it and makes it for someone else as well, then instead, from its ⋯, adds steps from the bottom box after the step on the card, each after the last, and repeats the card's step with Repeat, with its Undo (no › on the rows, the line above the box naming where each goes, marked, in their place after a reload, deleted, with a reply lost, offline, ticked before it's sent, and called off, a pasted list in order, and a step put on the card by a nudge, not by a longer scroll; and after the last step with every one done), checks that a run, and its card on Today, open on its next step in order, even one counting down, and that a timed step whose time has come goes before it, swipes a step to set its progress (its tick's pie, 100% done with its ✅ and the gap's Undo, with the bottom box focused, and held past 100% while the screen redraws), with Last time's notes answering late and the steps not moving as they come, checks a run's row under Checklists has its ring and who it's for, with no count of its steps or the next, and no line under it, shares a run's progress with who did each step and its ring's figure (67%, a skipped step counted done), opens the finished run from Last time (with no box at the bottom), then deletes it, cancels a start that waits, and one whose run was copied without a connection after, reads a step's time counted from a step named in words, goes Back from a project to Checklists, and changes, removes and deletes a template's steps, with ⋯ and × only on the step tapped, and writes a step's notes in its own sheet. It writes a template's name and steps with quick add (a person or priority read, shown as chips, sent, and a step changed in place read the same way). A template that comes round: its date and repeat set in its sheet leave it not done, it's on Today with no tick and opens Start, for its assignees; a start ticks it (the run due then, with no repeat or reminders), but not one days before it's due; a lost reply to the tick doesn't skip twice; one left for months moves past now; without a repeat a start ends it; taking its date off leaves it done; and a task with a due date made a template comes round. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step and a reply lost, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
- `tests/steptimes.mjs`: the plugin's step times, through the API only, so it needs a Vikunja with them on (`npm run test:local` turns them on). It sets up a template and two runs as Pocket does, then checks that a tick sets the due dates of the steps timed from it, chained and from a name, and moves their reminders with them; that the other run, a template marked done, a done step saved again or labelled change nothing; that a step marked not done takes the due date off the steps waiting on it; that a step done early counts from when it was done; that a run's steps go in the order they were copied, whatever order they're linked in, or in its own order line; that an inserted step isn't the step before, and a step timed from a repeated one counts from the copy, and from the first again once the copy isn't done; that a tick from the web app works too; and that a run keeps its steps' times when its template is changed or deleted, while one started before runs kept them reads its template.
- **Not yet end to end:** the ring a task held on Today is thrown at is checked only by the unit tests so far
  (`throw.test.mjs`, and its parts of `actions.test.mjs` and `rows.test.mjs`): `smoke.mjs`'s
  `today-deletes-by-a-swipe-and-a-hold-does-nothing` still expects a hold on Today to do nothing.

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
loaded afresh behind it, and a long screen draws its rows in batches: `loaded(page)`, in `tests/helpers.mjs`, waits
until it's loaded and every row is drawn (no Loading, and `#view` not `aria-busy`), for a test that reads the screen
once rather than with `expect`. Wait for something on the new screen first: straight after a change of address, the
old screen isn't busy yet.

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
- **Swipe a row with `swipeRow(page, sel, to)`** (`tests/helpers.mjs`): a plain swipe, with no hold, to where letting
  go does `to` (a quarter, 100, `'open'`, `'delete'`, `'back'`), worked out with the app's own `swipeAt`, so changing
  `SIDES` doesn't break the tests. A row with progress takes two swipes to delete.
- **`.sec + .list` no longer finds a group's list:** a group's heading can have a message under it (and its
  `<template>`), so use `.sec ~ .list`.
- **Nothing on screen may move as late data comes.** A run's screen used to show Last time's notes on the step's card
  once they came, pushing its steps down from under a finger (the flaky step test that's now `swipe-a-step-to-set-its-progress`). Now they
  come with the run, or under it, and on a card only from the next step on (`readLast`, `lateLast`, `app/runs.js`);
  the test makes them answer late and checks the steps stay put. Something new that loads late above what can be
  touched needs the same care. Measure a row with `steady()`.
- **A long screen's rows come in batches** (20 at once, then the rest after they're painted): a test that counts rows,
  or looks for one far down, uses `expect` or waits with `loaded(page)` first. A project's Done shows its latest 100,
  and search's done matches 50, with a row for more (`#more-done`).
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
- **The one-time hint adds a line to a screen's first row** on a phone that's never swiped one: the end-to-end tests put
  it away from the start (`hintSeen(context)`, in `tests/helpers.mjs`), except the step that tests it, in a browser
  context of its own. A new context in a test needs it too.
- **Never run `npm run build` while tests run.** A changed page makes the open copies reload in the middle of a test.

## Measuring

`scripts/perf/` times Pocket with long lists, in Chrome against a Vikunja of its own (`pocket-perf`, on :3470, apart
from `pocket-dev`), seeded with a busy project: `node scripts/perf/up.mjs --seed M`, then `npm run perf` (opening
Today with and without its kept copy, Today to the long project, and its Done opened; `-- --profile phone` with the
CPU 4 times slower and a phone's network). `up.mjs --at <commit>` puts Pocket as at another commit in front of the
same data, to compare two versions back to back; `prof.mjs` profiles one step. Its README says how, and has the
numbers from before and after the performance round (performance-plan.md). A change that could slow a long list (a
getter or helper called for every row, a new `x-for`, something per row on every change) is measured before and after.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with a small café's made-up tasks and checklists for two users of its own, `alex`, who owns it, and `priya`, the shift lead, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. New examples in the README and the guide follow the same café. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## The specimen

`npm run specimen` makes `specimen/index.html`, a page for working on how Pocket looks, in light and dark side by side.
It shows `markup/task-row.html` in every state: open, done and waiting to send; progress in the tick, a quarter at a
time, and 30% set on the web; subtasks at each depth; due dates, priority, labels, people and comments; Today's rows
on one line; a project only you can see; a run's row with its ring and who it's for as pictures; a step's square box;
read only; rows swiped right at each stop and past half, the Done gap with Undo, swiped left from 75% down to 0%, then
a second swipe into Delete, a done row opened again, a full delete's gap with Restore, the batch clearing, a claim at
let go, a subtask swiped, a line in a row's place, the add box's target lit, a row held and moved, a project's Done
section, rows just come due and just added; and a run's steps on its screen (done by you or someone else, skipped,
inserted, repeated, counting down, late, a tick waiting to send, a full swipe's gap) and in a run finished or read
only. Then the larger pieces: a task's sheet led by its row (with notes and photos, a subtask's with none, a parent's
with its ring, its row swiped, its title tapped, a done task); Today's stacked cards (a task's opened, a run's next step
counting down, one with one open subtask and no footer, one of 14, plain rows after them in rounded blocks); a parent's
ring (13%, two of four, none of three, all done waiting for Close, closed as a gap with Undo, its header swiped both
ways); the question a ring asks (3 open subtasks, 5 with one repeating, a run's); the ring a task held on Today is
thrown at (on a Monday, a Wednesday with Friday lit and a Friday, Today dimmed, the long pull's No date, a repeating
task's); a project's list with its cards open; a run's step card; a run's screen's top, with its own row; a run adding
steps from the bottom box; what the add box adds to; a template's steps; and a message in its place. It uses the real
stylesheet and Pocket's own component, given made-up tasks instead of signing in (`scripts/specimen/`), so it needs no
server: open the file in a browser, and run it again after a change. It's for development only: git ignores
`specimen/`, and nothing in `pocket/app/` refers to it, so it's never served or saved for offline.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- Alpine is kept readable, as published, in `src/vendor/alpine-<version>.js` (`dist/cdn.js` from the `alpinejs` npm
  package), and patched there for long lists, each change marked with a comment starting `Pocket:`. There are two
  patches, each in a commit of its own after the file as published (5d0950b): Alpine's scheduler (70f4fdd), whose queue
  of updates was quadratic in three places (it sorted the rest of the queue again before each job, working out each
  element's depth afresh for every sort, and searched the queue to add or take off a job): now a Set of the jobs
  queued, a job put in its place by binary search during a flush, depths kept for the flush, and a job taken off
  skipped when its place comes, the order jobs run in the same; and `x-for` (aea10ac), which reads a key that's a path
  into the item (`t.id`, for `t in ...`) off the item, and keeps the key and scope of the items at the start of the
  list that are where they were, rather than working every row out again for each change. `tests/unit/alpine.test.mjs`
  checks both. `npm run build` minifies it into `pocket/app/alpine-<version>-pocket.<N>.min.js`, the name the
  `<script>` tag in `src/index.html` gives: `sw.js` keeps the libraries by name, so a changed file under an old name
  would never reach an installed Pocket. To upgrade Alpine, or change a patch: replace the file with the new version's
  `dist/cdn.js` and commit it as published, redo each `Pocket:` change (compare with `git show 70f4fdd aea10ac`), run
  `npm run test:unit`, and give the `<script>` tag the new version and the next `N` (the build writes that file; delete
  the old one from `pocket/app/`). Measure a long list before and after (Measuring, above).
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag in `src/index.html`.
