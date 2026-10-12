# The add box goes where the new line will go

From the user's note of 2026-10-12 (written in a chat without the code), checked against the code, with the user's
answers of the same day: nothing in it is left open. Not built. `rows-and-sheet-fixes-plan.md`'s **How to work** applies: a part is built with the
fast checks, tried by the user on their phone, and only then given its end-to-end tests.

## What's there now

- **A nudge** (a short, slow scroll that starts on a row, read when the finger lifts: `watchNudges`, `nudged`) aims the
  bottom box on a project's list only. The row lights up, a line over the box says "Add a subtask to X, after Y", and
  the box adds subtasks until its ×, or until the lit row is scrolled out of sight. A tick, a swipe, and opening a
  task's sheet aim it too (`aim`, `aimAfterTick`).
- **On Today** a nudge does nothing, and the box only adds tasks.
- **In a task's sheet** the box is its own (`#d-subbox`), at the foot of the subtasks.
- **On a checklist's screen** a nudge puts that step on the card, and the bottom box adds a step after the card's step,
  with "Add a step after X" and **Repeat** on the line over it.
- **A template's sheet** has its steps as rows of their own (not `task-row.html`): the step's number where a tick would
  be, held to move, tapped to change in place, with × and ⋯ (Move up, Move down), and the slot for who does it. Steps
  being written, in New template and under an existing template, are separate boxes with ↑ ↓ × (`draft-steps.html`).

## 1. A nudge moves the box into the list

One behaviour on every screen: a project's list, Today, a task's sheet, a checklist's screen, a template's steps.

- Nudge a task: the box is under it, to add its first subtask. Nudge a subtask: under that subtask. Nudge the last
  subtask: at the end. On a template or a checklist, under the step nudged.
- The box is drawn at the indent of what it will make. Its place and its indent say where the line goes, so the
  "Add a subtask to X" line goes. Inline, its placeholder is what it makes: "Subtask", "Task" or "Step". At the
  bottom it reads as now.
- The box's place at the bottom stays, empty, at its height: the list doesn't grow into it. A tap there brings the
  box home.
- It doesn't take the focus when it moves: a nudge can be a slip. Tapped, the phone scrolls it above the keyboard,
  and that scroll doesn't send it home. Only a scroll by the finger does, once the box is out of sight; so does ×.
- Enter adds the line and keeps the box inline, under the new line, at the same level.
- A pasted list goes in after the box's place, its indents counted from the box's level.
- The new line takes the place it was shown in, written as a move is (`cursorPlaces`, `order.js`). In a project with
  no List view it goes last, and the box says so.

## 2. Its level, on a project's list

- A ⇤ at the box's left edge moves it out a level: it's then after the nudged task and its subtasks, and adds a task
  there. ⇥ moves it back in.
- On a keyboard, Tab is ⇥ and Shift+Tab is ⇤, as in any editor (the user, 2026-10-12). The key is taken only when it
  can move the box: with the box as far in or out as it goes, it moves the focus as usual, to the chips and Send.
- Today and a task's sheet add subtasks only, and a template's and a checklist's steps are one level: no ⇤ there, and
  Tab always moves the focus.

## 3. Today

- Nudging a plain task adds its first subtask, and the task becomes a card. Nudging a card's row adds under that row.
- A card is folded to its next subtask, and a new subtask with no date sorts last. It stays in sight in its card
  until the screen is left.

## 4. A checklist's screen

First: "one behavior everywhere (but add the repeat button)", built as the bottom bar with its line and Repeat, the
box moving up on a nudge. Then, having seen it (the user, 2026-10-12): "should have the add new/repeat under the list
of steps, and pull up on nudges, like the Task page with subtasks. No bottom bar that stays around."

- The box is at the foot of the steps, the same piece as a sheet's list has (`markup/list-box.html`), and the screen
  has no bar at its bottom. What's written goes after the last step.
- A nudge on a step puts it on the card, as before, and the box under its row: what's written goes after it, and the
  box is under what was written. The last step nudged changes nothing.
- **Repeat** is in the box, and copies the step on the card right after that step, wherever the box is: it's about
  the step you're on (the user's choice).

## 5. A template's steps

Settled again with the user on 2026-10-12, after the first build of it, which had a template's steps, New
template's and a task's subtasks as three things made to look alike: "They should be 1 and the same."

- **One list in three places:** a task's subtasks, a template's steps, and New template's steps are the same list
  (`sheet/sub-list.html`), each line the task row, with one box at its foot, always there: "Add subtasks, or paste a
  list", or "Add steps, or paste a list". Enter or its button adds what's in it, a line each.
- **A step is a subtask's row** with its number where the tick would be: tapped to change it, held to move it,
  swiped left to delete it. It has no ⋯ and no ×, as a subtask has none: the user chose that over a tap for
  everything, here.
- **New template differs in one way:** its steps are on the phone only, "virtual", until **Create template** sends
  them all. So it still works offline, and the timers are checked once, before anything is made.
- **A nudge on a row puts the box under it,** and its place at the foot is then kept, empty. The last row nudged
  changes nothing: the box is under it already.
- **Timing is left alone.** A step timed from a named step stays that way. "The step before" is the step before,
  so a step added in between is the one counted from, as the step's line then says. Pinning it would be a footgun.
- The box reads a step as before: `@`, `*`, `!` and a time in words, with its ⏱ chip, and no dates.

## What it bends

- **Nothing moves under a finger.** The rows below the box move down by its height when it arrives. That's after the
  finger has lifted, and never on a tick or a swipe.
- **Every gesture has a tap** (rule 3). A nudge's tap is new: **Add a subtask here** in a task's ⋯, which moves the
  box and, being meant, gives it the focus.
- **Today is for doing.** Adding a subtask there is new. It adds, and doesn't reorder or delete.

## Try first, on an iPhone

Two things the note takes for granted, to try before the rest is built on them:

- **The page jumping.** Safari doesn't keep the page still when something above the screen changes height. A box that
  goes home while it's above the screen moves everything by its height, in the middle of a scroll. Scroll the page
  by the same height in the same frame, or keep the box's place until the scroll ends.
- **The keyboard.** The bottom box is laid out against the keyboard now. A box in the middle of a list is scrolled
  into view by the phone, and its chips need room under it.

In the code: there's one box, with one text. An element put among the rows of an `x-for` is moved by Alpine
(Gotchas), and a row may ask only about itself, by its id, as it does of `lit`.

## What moves the box

Only a nudge, and **Add a subtask here** in a task's ⋯ (the user, 2026-10-12). A tick, a swipe and closing a task's
sheet aimed the bottom box before; they leave the box where it is now, so rows never shift under the next tick.

## Build order

1. A project's list, plainly: the box moves on a nudge and goes home on a scroll or ×. Tried on the phone before the
   rest.
2. The rest of a project's list: ⇤ ⇥, Enter, places, a pasted list, the placeholder, the line gone, the ⋯ item.
3. Today, and a task's sheet.
4. A checklist's screen, with Repeat.
5. An existing template's steps.
6. New template's rows.
7. After the user's look: the end-to-end tests (the old "Add a subtask to…" line and the ↑ ↓ buttons among them), the
   guide's lines on the bottom box, the specimen, and the README's pictures.

## As built (2026-10-12)

Parts 1 to 4, each its own commit, then the template parts built twice: first as rows of their own, then, after the
user asked for one list, as the shared row (`ef215f6`, `9dd9a43`). The fast checks only: the end-to-end tests, the
specimen and the README's pictures wait for the user's look. Tried in desktop Chrome with a made-up finger
(`scratchpad/inline/`), and part 1 by the user on their phone ("that feels pretty good").

- **One box, laid over room.** The box is never moved in the page: its row is given the box's height under it
  (`.boxed`), and the box is drawn over that room, where the room is being asked every frame (`seatBox`, `boxSeat`,
  `app/quickadd.js`). So Enter keeps the focus and the keyboard. A sheet's list does the same with its box
  (`seatSub`, `app/sheet.js`).
- **One row, and its step parts in one copy.** A template's step is the task row with `g.step`. What only a step has
  (its number, its box when tapped) is between `<!-- only step -->` and `<!-- /only -->`, and the build keeps it in
  the sheet's copy of the row alone (`scripts/build.mjs`). Counted on 659 rows: 27,148 bindings as the list opens,
  before and after; without that it was 28,466.
- **New template's steps are rows shaped for the task row** (`newStepRow`: an id for the row, a key for how the steps
  read together), kept in `sheet.newTpl.rows`, and changed in place: the row is what its box changes.
- **Today gives no place.** It has no one List view, and shows a subtask only once it's sent, on its task's card: the
  box stays where it was put, the card opens so what was added is in sight, and a task with no date is a card too,
  until the screen is left (`cardKept`).
- **A new line's place is never one another task has** (`clearOf`, `order.js`). Vikunja moves two tasks with the same
  position apart, which put a task's first two subtasks in the wrong order in a new project.

To know when trying it:

- Scrolling its row out of sight sends a box home only while it isn't being typed in.
- Not seen on an iPhone yet: the page keeping still when a box goes home above the screen, and a box in the middle of
  a list against the keyboard.
