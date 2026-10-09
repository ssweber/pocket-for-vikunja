# One way of acting on rows, parents as headers, and stacked cards

Settled with the user on 2026-10-09, from a design review. It follows `one-concept-plan.md` (all of it built) and
changes parts of `motion-and-rows-plan.md`, named below. Check every part against `docs/design-rules.md`.

## How to work

- Every decision here is settled. Stop to ask only when the code shows something this plan didn't expect: a rule that
  can't be kept, or a part much bigger than it looks. Say what you found, with file and line, and what you recommend.
- Where a small UI detail is left open, choose what fits the design rules, reusing what exists rather than adding a
  second way, and list each choice in your report for the user to review.
- Read `AGENTS.md`, `docs/development.md` (with its **Gotchas**), `docs/roadmap.md` and `docs/design-rules.md` first.
- **The user reviews before the slow tests.** Build one part at a time, in order. For each part: build it, keep
  `npm run lint`, `npm run test:unit` and `npm run test:parse` green (unit tests for what changed go with it), run
  `npm run build`, and commit it locally (`feat`/`refactor`, src with the built page). Don't run the end-to-end tests or
  `test:local` then: the user uploads `pocket/` to their own server and tries it first. The end-to-end tests are
  brought up to date, and the full suite run, after the user has reviewed (the last part). Don't push.
- Each part adds its new states to the specimen (`scripts/specimen/`). The guide, `development.md` and the README are
  brought up to date in the last part, not per part, since the user may change things on review.
- **Never kill processes by name** (`taskkill /IM`, `pkill`): that once closed the user's own Chrome. Stop only
  processes you started, by their PID. Never `npm run build` while tests run.

## 1. Gestures on a row

These apply on Today, a project's list, search, a task's sheet and a run's steps alike, and on a card's step lines.
This replaces section 2 of `motion-and-rows-plan.md` ("Today is for doing", no delete or reorder on Today, hold then
slide for progress, no plain swipe right) and section 3's "hold first".

- **Swipe right, with no hold first:** progress. It snaps at 25%, 50% and 75%, and a full swipe is done. It still
  claims a task no one is doing (where someone else can see it: one-concept-plan part 4 stays). The swipe takes over
  only once the drag is clearly sideways, so a vertical scroll never catches; a nudge (`watchNudges`) still works.
- **Swipe left: delete,** as now, on Today too. A full swipe deletes and leaves the gap with Restore. Progress and
  delete are one track: a row at 50% swiped left goes down through 25% and 0%, then on into its Delete, as Gmail's
  does. A done row swiped left opens again at 75%, then on down.
- **Hold: move up or down only.** On a project's list and in a task's sheet it reorders, as now. On Today it
  reschedules (part 4); until then a hold there does nothing. Search has no order of its own: a hold does nothing.
- **Progress is drawn in the tick, not under the row.** The tick fills a quarter, a half, three quarters or whole,
  matching the snaps. The line under a row goes (`.row::after` and its `--pct`), which is where the room comes from.
  While a swipe is setting progress, the row can still show the fill and the percentage as now.
- **Tapping a tick ticks it,** whatever its progress. Tapping again takes it back, with its progress as it was.
- **The one-time hint** says the plain swipe, in a sentence that states it (not "Hold and slide").
- **Rows stay at least 56px tall,** glove-safe. Nothing gets smaller; the density comes from the removed line.
- A run's step swiped left: only where a step can be deleted now (an inserted one); elsewhere a left swipe lowers its
  progress and stops at 0%. A template's steps keep their own editor row.

## 2. The stacked card

A task with open subtasks, or a run with open steps, is one component everywhere it appears: the stacked card.

- **Today and search: collapsed,** showing its top subtask and the peek.
- **A project's list: open,** every open subtask listed, replacing the indented group under the parent. A run is a card
  too, open there with its open steps, replacing its one row (one-concept-plan part 3). Nested subtasks: a card lists
  its own open subtasks; one of them with open subtasks of its own shows as a parent row (part 3's ring) that opens its
  sheet. Choose what's simplest and list it.
- **Collapsing an open card** brings back the peek, so "1 more ⌄" works both ways.
- **Its rows act as section 1 says.** Its header is part 3's.

How it looks:

- **The strip goes:** the `‹`, the segments, the `›`, "n of m", dragging along it and tapping a segment
  (`card-strip.html`, `cardScrub`, `stripScrub`, `tapSegment`, `segmentOf`, `scrubTo`, `pageCard`, `cardPage`,
  holdToSlide's `scrub`). Also from the run screen's step card: there, the steps list below it shows where the run is,
  and tapping a row puts that step on the card, as now. No "Step N of M" line replaces it.
- **The top row is the most urgent open subtask:** overdue first, then due today, then the earliest date, then list
  order.
- **A run's top row is its next step in order,** even while it counts down, with its countdown. A timed step whose time
  has come (its countdown at zero or late) comes before it. This replaces `whereNext`'s "the next that can be done now,
  passing over steps still counting down", for the run screen (after a tick and on opening) and for Today's card alike:
  one rule, still one function in `checklists.js`.
- **The next one peeks beneath** as a shorter, inert strip: "Interview · 1 more ⌄". One target; its tick can't be hit.
  A tap opens the card in place; an opened card on Today or in search collapses again once scrolled off screen.
- **Ticking the top row keeps the batch:** it stays, ticked, until the batch clears, then the next slides up.
- **With one open subtask, there's no peek.**
- **The count stays at the right of the title** (part 3 makes it the ring's).

## 3. A task with subtasks is a header

A run is a parent too: its steps are its subtasks.

- **A ring instead of a tick,** with its count (2/4) inside or beside it, drawn so it can't be taken for a task's own
  tick: thinner, never filled by a quarter.
- **Its progress is worked out:** each open subtask counts its own percent, a done one 100%, and the parent shows the
  average. One subtask at 50% of four is 13% (rounded). A run's skipped steps count as done, as its line does now.
- **The worked-out figure is written to the parent's `percent_done` with the change that caused it,** not as a save of
  its own the user sees: the same outbox entry, or sent right after it by the same action, so offline it waits with
  it. A run has no such path today (the plugin writes only step due dates, and stays a file server: see
  `roadmap.md`), so this is new, through the outbox (`act`, `app/runs.js`) for a run and the progress code in
  `app/actions.js` for a task. Write it only when it changes.
- **The manual value isn't brought back.** A parent whose subtasks are all removed keeps its last figure and can be
  swiped again.
- **Ticking a parent no longer closes its subtasks.** The "Closed … + N subtasks" path and its Undo go
  (`leftOpenUnder`, `makeHead` where they serve it; check what a repeating parent and a done parent over open
  subtasks still need).
- **The last subtask done doesn't close the parent.** It shows "All subtasks done" with a **Close** button. A subtask
  added drops the ring back and takes the button away.
- **Tapping the ring, or a full swipe right on the header, opens a sheet:** "Complete 3 open subtasks?". Confirming
  completes them and the parent, with the batch. With one open subtask, no sheet: that subtask and the parent are
  completed, with an Undo.
- **A partial swipe right on a parent springs back:** it has no progress of its own. A swipe left deletes it, as now
  (with the question about its subtasks).

## 4. Holding to reschedule on Today

- **Hold a row or a card and drop it on another section** (Today, or a day in the week ahead) to move its due date
  there. Its time of day stays; a task with no time stays without one.
- **Overdue isn't a drop target.** Dropped in its own section, it springs back: order there is by time.
- **A card moves only the parent's date. A repeating task moves only this occurrence.**
- **It's "Move all to today" one at a time:** share its code and its Undo.

## 5. Shared progress matches the screen

- **"Share progress as a text" and the copied Markdown list use the worked-out figure,** with a bar of one segment per
  subtask, filled for each done:

  ```
  A test task  ▰▱▱▱ 13% · due today · Sam
  ◐ One subtask 50% · due today · Sam
  ○ Another
  ○ And another
  ○ And another
  ```
- A unit test checks the text's percent and segments match the ring's figure for the same task.

## 6. Open, not decided

Reported to the user, not changed:

- **A parent can be due before its subtasks:** due today at 5 PM, its subtasks Monday, its card sits in Overdue
  showing a subtask that isn't. Which date puts a card in a section?

## 7. Tests, docs and pictures, after the user's review

- **End-to-end tests** for: swiping right with no hold, its snaps and a full swipe; claiming; progress down past 0% into
  delete; tapping a partly done tick; the parent's ring, its worked-out figure and the one write; Close, and the ring
  dropping back; the sheet from a tap and from a full swipe, and none with one open subtask; a partial swipe springing
  back on a parent; the peek, opening and the next sliding up; the card collapsed on Today and in search and open on a
  project's list; rescheduling by a hold on Today, keeping the time, no drop on Overdue, springing back; shared text
  matching the ring. The tests of what's gone (the strip, hold then slide, Today without delete, a parent closing its
  subtasks) are changed or removed. Then the full `BROWSER_CHANNEL=chrome npm run test:local`.
- **The specimen** shows ticks at each quarter, a parent's ring, a card with a peek, a card with one subtask, and "All
  subtasks done".
- **Docs:** `docs/design-rules.md` is linked from `AGENTS.md` and `development.md`; the guide, `development.md` and
  the README: its Today paragraph (nothing deleted or moved on Today) is replaced, "Hand it off" updated, one sentence
  on finishing a parent added, the alt texts rewritten, and the pictures remade (`npm run demo`).

## Build order

| Part | What |
|---|---|
| 1 | Gestures on a row, progress in the tick (1) |
| 2 | The stacked card, the strip gone, a run's next step in order (2) |
| 3 | A parent as a header: ring, worked-out progress, Close, the sheet (3) |
| 4 | Holding to reschedule on Today (4) |
| 5 | Shared progress matches the screen (5) |
| 6 | After the user's review: end-to-end tests, docs, the README and its pictures (7) |
