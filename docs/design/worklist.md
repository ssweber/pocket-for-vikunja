# Worklist

Decided with the user on 2026-10-22. One build agent at a time, in order. An item marked **picture first** is built
only after the user approves its before/after picture. Tick an item in the commit that finishes it. This file is
deleted once every item is built.

The wording of new text is the builder's to choose: accurate, short, the familiar word. List every new text in the
report.

## A. Decided, no picture

- [x] **A1. Outbox wording.** A refused note still reads "Adding notes on …" (`refused` in `messages.js`). It should
      read "Adding notes to …", like the row above it.
- [x] **A2. Label chips under search** are under 44 px tall. Give each a 44 px tap area without making the bar look
      taller than it needs to.
- [x] **A3. Adding while Today is narrowed to a label.** The new task gets that label, so it shows where the user is
      looking. The add box shows the label as a chip, as if `*label` were typed, and tapping the chip leaves it off,
      as with any other chip.
- [x] **A4. Copy as a Markdown list includes notes.** Always, with no separate menu item. A task's notes go after
      `//` on its line. A note with several lines continues on lines under the task, indented one level deeper and
      starting with `// `. Pasting reads such a line as more notes for the line above, not as a subtask, so the copy
      round-trips. `pocket:` lines are left out (so asks aren't copied), and the notes are plain text. Copy progress
      and Done today's Copy stay without notes. Update the guide's line that says notes aren't included.
- [x] **A5. Today counts the last minute by the second.** Today's rows redraw once a minute (`rowNow`). While a step
      on Today is less than a minute from its time (a countdown or a lock), Today redraws each second, so a countdown
      reads "in 50s", not "in 1m", and a locked step unlocks on time. Back to once a minute when none is.

## B. Waiting and order as template settings, approved

The approved picture is `scratchpad/ui-tplwait/template-waits.png`. Start from `scratchpad/ui-tplwait/inject.mjs`.

Replaces `!T#`. It was never released, so remove it, its per-step lock toggle in the step editor and its guide line,
with no upgrade path. `!T#` in a title is then just text.

- [ ] **B1.** Two switches on a template, both off by default. Off is today's behaviour: nothing is locked.
  - **Wait for step times:** a step with a `T#` time can't be ticked before its time, including `T#18m:name`.
    An hourglass marks it. The Done button is dimmed and counts down, as it does for `!T#` now.
  - **Steps in order:** a step can't be ticked while any step above it is open (not done, not skipped). A padlock
    marks it. The Done button is dimmed and names the step above it to finish first.
  - Both on: the padlock until the steps above are done, then the hourglass until the time.
  - A lock blocks ticking and progress (swipe and sheet). Skip still works. Claiming a locked step is allowed.
  - Stored as `pocket:` lines in the template's notes, copied into each checklist when it starts. A running
    checklist keeps the settings it started with, as it keeps its step times. Vikunja's web app ignores them.
  - The template's own step list shows the hourglass beside each time when waiting is on. No padlocks there.
  - A step added during a checklist counts where it was put for "Steps in order". It has no time, so it never waits.
  - Today redraws when a lock opens: at the step's time, or as soon as the step above it is ticked.
  - Per template only. Finer control (per checklist, by label) only if asked later.
  - As pictured: the switches sit in their own card under the template's steps, above Details. Each row shows its
    mark and a line saying what it does, and the whole row is the tap area. A line under the card says a checklist
    keeps the settings it started with. The lines are `pocket:wait` and `pocket:in-order`. An order lock's Done
    reads "After <the nearest open step above>". The hourglass is the new `i-hourglass`.
  - The new switch replaces the control for "Use for checklists" in New project, so Pocket has one on/off control.

## C. Today uses the list row, approved

The approved picture is `scratchpad/ui-today-rows/today-list-rows.png`, with one change the user asked for after it:
the title is one line, not wrapped. Start from `scratchpad/ui-today-rows/inject.mjs`.

- [ ] **C1.** Today's rows become the row a project's list uses, with the title on one line that takes the row's
      full width, cut with "…" only at its end. Nothing sits beside the title. A project's list still wraps its
      titles. A line under the title shows the time (the time alone where the day heading gives the day), the project's dot and
      name, "↳ parent", the checklist a step belongs to, ↻ and the counts. Labels stay on their own line. Cards keep
      their fixed lines, so they don't jump while their steps are ticked. Cards' rows still use the one-line row, so
      `line` becomes a card-only option. Remove what nothing uses any more. On a row taller than 112 px the date
      chips centre on the touch, not the row. The user accepted that.

## D. Where the thumb is while dragging to a date, approved

The approved picture is `scratchpad/ui-thumb/thumb-ring.png`. Start from `scratchpad/ui-thumb/inject.mjs`.

- [ ] **D1.** Holding a row near the right edge of the screen pushes the date chips left so they fit
      (`throwLayout` clamps the middle to x 158–232 on a 390 px screen). The thumb then sits over the Tomorrow chip,
      but the selection is measured from where the hold started, so nothing is selected and moving left selects
      Today. Draw a ring in the clear middle that stands for the thumb. It starts in the middle, moves with the finger
      by the same distance, and slides onto a chip when that chip lights. It moves only by `transform`, appears with
      the chips and goes on release. When the chips are open as a menu (released without moving), there is no ring.
      As pictured: a 44 px ring in the accent colour with a light tint, in the chip's text colour on a lit chip,
      drawn over the chip's background and under its text. It follows the finger with no transition, and slides
      120 ms only when a chip lights or unlights. In `src/`, take a chip's position from the layout, not the DOM.
