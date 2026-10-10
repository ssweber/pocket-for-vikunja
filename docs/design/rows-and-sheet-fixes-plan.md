# Fixes from the 2026-10-10 list: a swipe's motion, the add box's lit row, typing in a sheet, Today's room

Settled with the user on 2026-10-10, from their list of six items, each looked into in the code first. It changes
parts of `motion-and-rows-plan.md`, `fast-tasks-plan.md` and `parent-tasks-plan.md`, named below. Check every part
against `docs/design-rules.md`. Two plans follow this one, in this order: `hold-to-reschedule-plan.md`, then
`done-and-markdown-plan.md`.

## How to work

- Every decision here is settled. Stop to ask only when the code shows something this plan didn't expect: a rule that
  can't be kept, or a part much bigger than it looks. Say what you found, with file and line, and what you recommend.
- Where a small UI detail is left open, choose what fits the design rules, reusing what exists rather than adding a
  second way, and list each choice in your report for the user to read afterwards.
- Read `AGENTS.md`, `docs/development.md` (with its **Gotchas**), `docs/roadmap.md` and `docs/design-rules.md` first.
- **No stops for review in this round.** The user is away and will try the builds later, so each part is built, tested
  and committed on its own, and a fault found later is found by bisecting. Keep commits small: one for each change a
  person could feel on its own, each with `src/`, the built page and its tests, each passing `npm run lint`,
  `npm run test:unit` and `npm run test:parse` by itself. While working, run only the end-to-end file a change
  touches; at the end of the part, the full `BROWSER_CHANNEL=chrome npm run test:local` must pass before the part's
  last commit, and `dev` is pushed after it.
- A change to what Pocket does comes with its test, a new state with its place in the specimen
  (`scripts/specimen/`), and its lines in `docs/development.md` and `docs/guide.md`, in the same part.
- A long screen draws its rows in batches: a test waits with `loaded(page)` or `expect`. A list's group is the same
  object while nothing in it changed (`sameGroup`), so never change a group in place. Something new worked out for
  every row is measured before and after (`npm run perf`).
- **Never kill processes by name** (`taskkill /IM`, `pkill`): that once closed the user's own Chrome. Stop only
  processes you started, by their PID. Never `npm run build` while tests run.

## 1. Typing in a sheet, and two gestures left behind

What the user met: a task's sheet slid down, or closed, while they were editing its notes or title. The sheet's
slide-down (`initSwipe`, `src/js/app/sheet.js`) is the one gesture that starts from a touch inside a text field: it
follows the finger from the first pixel and closes past 110px, and long notes scroll inside their box, so scrolling
them back up pulls the sheet down.

- **A touch that starts in a text field never starts a gesture:** not the sheet's slide, a row's swipe or hold, nor a
  nudge. One guard says what a text field is (an `input`, a `textarea`, a `select`, anything `contenteditable`), kept
  in `src/js/progress.js` beside `swipeStarts` so the unit tests check it, and used where each gesture starts
  (`holdToSlide`, `watchNudges`, `initSwipe`). It takes the place of the `textarea` check in the sheet's `find`.
- **While a text field in the sheet has the focus, the sheet slides down only from its bar.** Pulling down beside the
  field, as one does to put a phone's keyboard away, no longer closes it. Its ×, the shade and Back close it as before.
- **The notes box grows with its text,** as every other box does (`grow`), so long notes don't scroll inside it.
- **A title being changed is saved when the sheet closes** whichever way it closes. Today that depends on the box's
  blur, which a close by sliding may not cause: check it, and fix it if it's lost.
- **The sheet's own row and a run's own row take a sideways swipe as a list's row does.** The rule that tells the
  phone "sideways here is a swipe, not a scroll" (`touch-action: pan-y pinch-zoom`, `src/styles.css`) names the list's
  rows, the cards and a sheet's subtasks, but not `#d-card > .row.own` nor `#run-own > .row`, which are swiped too.
  Say what takes a swipe in one place if that's as small (every such row and card carries `data-gestures`).
- **The sheet goes back up when the phone takes the touch away mid-slide** (`touchcancel`), instead of staying partly
  pulled down.
- Row gestures still start from a touch beside a field with the keyboard up: a swipe with the add box focused is the
  fast path, and stays.

Tests: the guard in `tests/unit/progress.test.mjs`; what a sheet's `find` gives next to `rows.test.mjs`'s; in
`tests/smoke.mjs`, with real touches (the nudge test's `touch` and `touchDrag` move to `tests/helpers.mjs`, shared
with `checklists.mjs`): a pull down that starts in the notes moves nothing, one beside a focused field moves nothing,
one from the bar closes the sheet, and one from the bar with nothing focused too (the slide-down has no end-to-end
test today); the notes box taller than its text; each swiped row's `touch-action`; a touch cancelled mid-slide.

## 2. Only the row moves

What the user met: on an iPhone in Low Power Mode, after letting go of a full swipe, the row leaving "wobbles". The
follow-through (`sweep`, `src/js/app/progress.js`) runs two animations meant to move as one: the row's `transform`
and the coloured space's `width`. Low Power Mode holds the second to 30 frames a second and not the first, so the ✓
and the coloured edge shake while the row leaves. A page can't tell that mode is on, so the motion is made simple
for everyone. This changes `motion-and-rows-plan.md`'s follow-through and `fast-tasks-plan.md`'s pulse.

- **The colour and its ring are a still layer the row slides over,** not a box inside the row whose width follows
  the finger. During a swipe only the row's `transform` changes, and the follow-through is one `transform`
  animation. The red Delete is laid the same way, so it no longer vanishes or jumps when a short swipe left is let go.
- **Nothing bounces:** the ring's pop past half (`check-pop`) and its pulse at each quarter (`pct-a`, `pct-b`, the
  `data-tick` flip) go, with the rules left from older designs (`.setting`, the `::after` rules that hide a line that
  no longer exists). The green turning solid, the ✓ appearing and the pie stepping at each quarter still say where
  letting go lands.
- **The gap shows when the slide ends,** with "Done" and Undo or "Deleted" and Restore, not when Vikunja answers.
  A save that fails says so on the row, with Try again, as a tick's does.
- **A task with subtasks asks before its row slides away,** not after. Cancel leaves the row where it was.
- **What's felt:** the ✓ on a swipe, the delete, and each quarter, as now; and a tap on a tick, a task's or a step's,
  which had none. All through `haptic()` (`src/js/haptics.js`); a bare `navigator.vibrate` does nothing on an iPhone.
- **On a card's header, the swipe's ring and the header's own line are centred in its strip.** The strip is 44px
  and the 32px ring sat on its foot, cut when it popped. The header's ring, title, bars and time sit centred in the
  44px, and the ring a swipe uncovers is centred too.
- Less motion (`prefers-reduced-motion`) is honoured as now, asked in one place rather than nine.
- A finger still moves the row at 30 frames a second in Low Power Mode: no page can change that.

Tests: the selectors that look for the coloured space inside the row (`tests/smoke.mjs`'s swipe steps,
`tests/checklists.mjs`'s step swipe, `swipeRow` in `tests/helpers.mjs`); a full swipe's gap there before Vikunja
answers (its reply held back), and Try again when it fails; the question before the row moves, and Cancel; a tick's
tap felt (`tests/unit/progress.test.mjs`, beside `swipeFeel`); the header's ring clear of the strip's edges. The
specimen's swiped states are drawn the new way.

## 3. The lit row follows what you add

What the user met: on a project's list, after adding a subtask from the add box, the line over the box moved on to
the one just added ("…, after B") while the row lit on the list stayed the one touched. Two things kept the aim: the
line follows the last subtask added (`cursor.after`), the lit row the row touched (`cursor.id`). The line was right
(`fast-tasks-plan.md`: "Several added in a row go in order, each after the one before"); where the light goes was
never decided.

- **Adding makes the light follow.** The subtask just added is the lit row, at once: while it waits to be sent too,
  and still once Vikunja has given it its id, or when it's sent later.
- **One row is lit.** A parent touched, then a subtask added under it: only the subtask is lit, and the card's header
  goes dark.
- **A nudge always selects.** A nudge, a tick or a swipe on any row aims the box there, also on the row touched
  before: the line goes back to "after" that row, and a tick is felt whenever the lit row changes.
- **The aim never points at a row that's gone.** The subtask the box adds after deleted, called off while waiting,
  moved or ticked done: the box goes back to its parent's last, and the parent is lit.
- The box goes back to adding a task when the lit row is out of sight, as now.
- **The line keeps its words:** "Add a subtask to P, after X". Its comment and `cap-target.html`'s say "unless that's
  the last", which the code doesn't do: the comments are put right.
- **A run's screen stays as it is.** Its lit row is the step on its card (one-concept-plan: "One current step on the
  screen, never two"), and the line says which step a new one goes after.

Tests: `tests/unit/order.test.mjs` (the box on a project's list) and `actions.test.mjs` (`addSubtasks`, through the
pretend Vikunja); in `tests/smoke.mjs`, the lit row beside the line in `the-add-box-adds-subtasks-to-the-task-touched`,
`the-add-box-adds-right-after-a-subtask-touched` and `a-nudge-aims-the-add-box`; in `tests/offline.mjs`, a row lit
while it waits.

## 4. More room for a subtask's words on Today

A card's subtask row on Today has, at 360px wide, 134px for its title with no date, 84px with "in 18m", and 33px with
a priority and "10:30 AM": three or four letters. The room goes to its indent (54px), its slot (84px) and what's at
its right. Today stays on one line (`motion-and-rows-plan.md`, section 9), and the indent stays.

- **A card's rows leave out their project's dot; the card's header shows it once.** A row whose project isn't the
  header's keeps its own.
- **Today's slot is narrower:** as wide as "+ me" needs, about 74px for 84, with less space before it. Every row on
  Today, so the column of times stays in line.
- **A time is written short:** "10:30a" and "3p" for "10:30 AM" and "3 PM", where the phone writes times that way; a
  phone on a 24-hour clock keeps "15:30". A screen reader hears it in full.

Tests: `tests/unit/dates.test.mjs` (the short time, both clocks); `cards.test.mjs` (the header's dot, a row's own
when it differs); `tests/smoke.mjs`'s row on one line. The specimen's Today rows and cards.

## 5. The same thing written twice

From going through every event and attribute binding. The gestures are sound: one engine, nothing bound per row.
What's left is copies that drifted apart. No change to what Pocket does, apart from the three named first.

- **A step being written keeps the keyboard up** when its ↑, ↓ or × is tapped, as a step being changed does.
- **A file uploading to a run's step has "Don't upload",** as one uploading to a task has.
- **Escape, on a desktop, closes what's innermost first:** the ⋯ menu before the sheet, and a template's title being
  changed is called off as a task's is.
- **One piece each** for the gap ("Deleted" with Restore, "Done" with Undo), a quick-add chip (the template's lacked
  `aria-pressed` and its icon) and the setup card. Long logic written in the markup goes to a method beside
  `tickRow` (a row's tap, its Delete). Classes and helpers nothing uses go.
- **One quick-add box.** Its handlers are written five times (the add box, a sheet's subtask box, a step changed in
  place, steps being written, a new template's name) and have drifted: Enter with Shift, what's loaded on focus, what
  a blur does, how the box grows. They become one directive, beside `x-style` in `component.js`, and each box says
  only what differs. A commit of its own: a keyboard and the focus on a phone are delicate.

## 6. What every row costs

Measured before anything is built (`npm run perf`, `scripts/perf/`; the numbers go in its README):

- **A run's screen** works the whole run out again for each of about 45 bindings every second (`runView` reads the
  clock): count the calls and the time, on a run of 20 steps with the CPU 4 times slower.
- **One tick or nudge on a long project** re-runs a binding on every row (each row reads `cursor`, `flashed`,
  `slideClaim`; a group is made anew as a row leaves): time a tick through the batch clearing, on 600 rows.
- **A scroll's start** while a long list is still drawing, under the one touch listener that can stop a scroll.

Built only where a person would feel it (a stutter in a swipe, a tick that takes longer to show, a scroll that starts
late), each in a commit of its own with its numbers before and after: a run worked out once per change, the clock
moving only steps that count down; what's lit, flashed or claimed read by a row's own key, as `leaving` is. What
doesn't show is written down and left.

## Decisions

The user's answers, 2026-10-10:

1. **The stutter** comes after letting go of a full swipe. **Only the row moves.** The gap shows when the slide ends;
   a task with subtasks asks before it slides.
2. **Felt:** the ✓ on a swipe, the delete, each quarter, and a tap on the tick.
3. **The lit row** follows what you add; a nudge always selects; a parent's subtask added, only the subtask is lit.
4. **What moved while typing** was the sheet. Both rules, and the notes box grows.
5. **A card's header:** "centre both it and the text in the strip".
6. **Today's room:** the dot on the header only, a narrower slot, a shorter time. Not less indent, not two lines.
7. **The bindings:** the two gesture fixes, measuring what each row costs, the markup tidied, one quick-add box; and
   the three small differences put right.
