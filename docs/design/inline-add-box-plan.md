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

The user, asked: "one behavior everywhere (but add the repeat button)". At the bottom the box has its "Add a step
after X" line and Repeat, as now. A nudge still puts the step on the card, and now also moves the box under that
step's row. Inline, the words go and **Repeat** comes with the box.

## 5. A template's steps

- **An existing template:** one box at the foot of its steps, in place of the rows with ↑ ↓ ×. Enter adds the step
  where the box is and saves it, with the order line. A nudge on a step moves the box under it. A step is swiped
  left to its Delete, with the question it asks now; its × stays, as the tap for it.
- **New template:** the user chose one send at the end. A step typed in the box joins the list as a row not sent yet:
  numbered, held to move, swiped to delete, tapped to change. **Create template** sends them together, so it still
  works offline and the timers are checked once, before anything is made.
- The box reads a step as now: `@`, `*`, `!` and a time in words, with its ⏱ chip, and no dates. Timers are checked
  when a step is added and when one is moved.
- `moveDraftRow` and the ↑ ↓ buttons go. Move up and Move down stay in a step's ⋯, with Alt+↑ ↓.
- My call, to check with the user if it shows: the step keeps a row of its own, with the task row's gestures, and
  isn't folded into `task-row.html`. It has a number, no tick and no progress, and each thing the shared row has to
  ask is asked for every row of every list (development.md, rule 10).

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
