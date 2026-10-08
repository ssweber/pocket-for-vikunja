# One concept for each job: a simplifying pass

Settled with the user on 2026-10-08, after a review of every screen (screenshots and notes in the git-ignored
`scratchpad/ux-review/`). It follows `motion-and-rows-plan.md`, all of it built. The last round got the gestures, adding
and removing right; this one makes sure that where two or three things on screen do one job, one does it.

## How to work

- Every decision here is settled. Stop to ask only when the code shows something this plan didn't expect: a rule that
  can't be kept, or a part that turns out much bigger than it looks. When you do ask, say what you found, with file and
  line, and what you recommend.
- Where a small UI detail is left open, choose what makes one concept do the job, and list each choice in your report
  for the user to review.
- Read `AGENTS.md`, `docs/development.md` (with its **Gotchas**) and `docs/roadmap.md` first.
- Build one part at a time, in order. Commit a part when the full `BROWSER_CHANNEL=chrome npm run test:local` run is
  green. While working, run lint, `test:unit`, `test:parse` and only the affected e2e file; the full suite once at the
  end of the part. Each commit passes the unit tests on its own. Don't push.
- Each part adds its new states to the specimen (`scripts/specimen/`), and updates `docs/guide.md` and
  `docs/development.md` where they describe what changed. The README's pictures are remade at the end of the round,
  not per part.
- **Never kill processes by name** (`taskkill /IM`, `pkill`): that once closed the user's own Chrome. Stop only
  processes you started, by their PID. Never `npm run build` while tests run.

## 1. The run screen borrows Today's card

The run screen stays the detailed screen for doing a checklist: a big card for the step, with **Done** and **Skip**,
and every step listed under it, where people sharing a run claim steps ("I got this one"). What changes is that the
things saying where you are, and the run's name, are said once.

- **The strip from Today's card** goes at the top of the step card: `‹`, the run's line in segments with the card's
  step marked (filled by its progress, as on Today), `›`, and "3 of 6", the step's place. It replaces both the bar at
  the top (`.run-bar`, "2 of 6 done") and the card's "‹ Step 3 of 6 ›". It works as Today's strip does: scrubbed,
  a tap on an open step's segment, the arrows; paging goes through open steps. A done step is shown by tapping its row,
  as now. Reuse the card's strip markup and code rather than a copy. The bar was sticky, to get back to the step from
  far down a long run; the strip isn't. Tapping a row puts that step on the card, and the bottom box's line (part 2)
  names it.
- **"N of M" always means the step's place.** The done count is the line itself. The finish card's summary ("4 of 6
  done · 2 skipped") stays: it's a summary, not a place.
- **The run's name once.** The line after starting says "Started · Undo", not the name again under the header.
- **The card shows who's on its step**, with the same claim slot as the step's row ("+ me", or initials), so no one
  presses Done on a step someone else has claimed without seeing it.
- **One rule for the next step.** After a tick, the run screen goes to the next step that can be done now, passing over
  steps still counting down (`nextStep`, `app/runs.js`). Today's card for a run opens on the same step, by the same
  code (move it into a helper both use). (Part 3 takes "Next: …" off run rows.)
- The countdowns card (`#run-timers`), the step's description, photos, comment box and Last time all stay as they are.

## 2. Adding a step to a run: the bottom box

The `›` at the left of every step row, and the box it opens under the row (`step-gap`), go. Adding a step works as
adding a subtask on Projects: with the box at the bottom and the line above it saying where it goes.

- **The bottom box shows on the run screen** (it's hidden there now: `app.html`), while the run can be written to and
  isn't finished. It's the `'ins'` box: it reads people, labels and priority as now, a pasted list is a step a line,
  and dates stay words. Placeholder: "Add a step, or paste a list".
- **It's aimed at the card's step**, always: the line above it (`cap-target.html`, or one like it) says **"Add a step
  after “Unlock the door”"**. Steps added one after another go in order, each after the last added (as
  `cursor.after` does on Projects), until the card's step changes.
- **A nudge on a step row** (a short, slow scroll that starts on it, `watchNudges`) puts that step on the card, as
  tapping it does, so the box aims there. One current step on the screen, never two.
- **Repeat**, a button on that line: one tap adds a fresh copy of the card's step after it, at once, with an Undo
  (an inserted step can also still be deleted while it's on the card). It replaces the 🔁 that put the step's words in
  the box (`armRepeat`, and its note).
- No × on the line: a step always goes after some step. All steps done, it aims at the last.
- The step rows get the width the `›` took.

## 3. Counts, run rows, and templates out of the lists

- **Run rows** (Checklists' "In progress", Projects, search): no "☑ 2/6" and no "Next: …". The segmented line shows
  how far it is. Who it's for stays.
- **A run is one row on Projects**, as on Checklists: its steps aren't listed under it (they're on its screen, a tap
  away), and they don't count in the open count.
- **Templates and their steps stay out of a project's Done and out of search.** They're Vikunja tasks marked done, so
  today they fill Done (15 in the review, for two templates) and search's Done, with their raw step syntax
  (`T#20m:machine`, `{#croissants}`). They live on Checklists. A template that comes round (due, on Today and Projects
  as "Checklist: tap to start") stays where it is.
- **No 🔔 on a run's step.** Its reminder is Pocket's own, for its countdown, which the row shows already.

## 4. Priority and claims

- **Priority is the bars, everywhere**, as in the sheet's top-left. The tick's ring is never coloured by priority (it
  was `--overdue` red for 3–5, and part 9 of `motion-and-rows-plan.md` made it Today's only sign). On a Today row the
  bars show small, as on a card's heading, before the time, for any priority set. Red then means late, or Delete.
  This changes section 9 of `motion-and-rows-plan.md`.
- **"+ me" only where someone else could take it:** the claim slot shows on a project shared with someone (people or
  a team, `loadPeople` knows who can see each project), and not on one only you can see. There, a task assigned to
  someone else still shows their picture, and sliding progress claims nothing. Who can see each project has to be known
  as Today opens, from the kept copy, so slots don't appear or go under a finger: load it in the background once
  signed in and keep it, as the projects are.
- **"Today" on a row under the Today heading says nothing new:** a row due today with no time leaves its time empty
  there (it still says "Today" under Overdue, and elsewhere).

## 5. Words and sheets

- **"Notes" is a task's description; "Comment" is a Vikunja comment, everywhere.** On a run, the step's box becomes
  "Comment on this step", the run's "Comments on this run" ("Comment for this run, and the next"), "Done or Skip sends
  this comment with it", and so on: the read-only line, the run's ⋯ ("with their comments and photos"), Last time,
  `messages.js`, the guide and the README. A task's sheet already says Notes and Comments.
- **A template's steps have plain numbers**, as the start sheet shows them, not square boxes: a square box means a
  step you tick.
- **A template's sheet shows what a template uses.** Check what each section does for a template (is its Notes copied
  to a run? are its comments, attachments or Assigned used?) and hide the ones that do nothing, listing which.
- **Today's card for a run** has a heading like a task's card: title and when it's due at the right.

Considered and left: the project at the top of a task's sheet and in its Details (one goes there, the other moves it);
the task's "#1"; the "run 1" in a run's name.

## 6. Tidy what the last round left

A refactor with no change in behaviour, from the notes of the agent that built section 9:

- Count-based line fill is dead: the `--done` fallbacks in the CSS, the `done` field, `.run-bar .track i` with `--pct`
  (gone with part 1), and the tests still checking `--done`.
- `rowWhen(t, g)` is called up to six times per row in `task-row.html`, `cardWhen(t)` five in `today-item.html`: work
  each out once, as the claim slot is. `rowWhen` filters `rowMeta` by key for the screen reader's note, and the
  countdown is worked out in both. `cardMeta` only feeds that note now.
- Overlapping segment helpers (`segmentAt`/`segmentOf`, `stepOfSegment`/`scrubTo`: a segment's tap can share
  `scrubTo`; `turnPage` is a one-line clamp), and old names in the gesture code (`holdToSlide` calling scrub mode
  'page', `cardScrub` returning `{el: null, page}`, `entering`'s 'none' marker, `showCardStep`'s `quiet`).
- `swipeOn` in the tests only checks that nothing happens.

## Build order

| Part | What |
|---|---|
| 1 | The run screen borrows Today's card (1) |
| 2 | Adding a step to a run with the bottom box (2) |
| 3 | Counts, run rows, templates out of the lists (3) |
| 4 | Priority as bars, "+ me" only where shared, "Today" under Today (4) |
| 5 | Words and sheets (5) |
| 6 | Tidy (6) |
