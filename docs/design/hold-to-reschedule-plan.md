# Holding a task on Today: four dates, around the finger

Settled with the user on 2026-10-10, from their draft, checked against the code. It replaces the ring of
`parent-tasks-plan.md`, 4b (Today, Tomorrow, an arc of five weekdays, No date a long pull down; `src/js/throw.js` and
`src/js/app/throw.js`), and ends design rule 8's one exception. Built after `rows-and-sheet-fixes-plan.md`, whose
**How to work** applies here too.

## The four directions

From where the finger was held:

- **Left: Today,** with its date ("Fri 9").
- **Right: Tomorrow** ("Sat 10").
- **Up: Next week,** next Monday, with its date ("Mon 12").
- **Down: No date,** drawn dashed.

The same for either hand, with no setting. Which direction means what, and each one's day, is one list (`THROW`),
as now: Next week and No date may change places later.

## Flicking

- After the hold, the direction the finger has moved past a short threshold (about 24px) picks a date. It's chosen
  when the finger lifts. A flick counts by its direction even before the chips have drawn, as now.
- The date under the finger's direction is lit, and a tick is felt each time it changes. Back near where it was held,
  none is lit, and letting go there changes nothing and closes it.
- The task keeps its time of day; one with no time stays without. Moved to Today with its time already gone, the
  time is the next whole hour, as now.
- A date that would leave the task as it is (Today, on a task due today) is dimmed, and picking it does nothing.
- **A task that repeats can't be moved by a hold,** as now: Vikunja keeps one due date, and its later dates would
  follow the new one. Its dates all show dimmed, with "It repeats: tick it to move on to its next date." The same for
  a checklist that comes round, a run and a run's step, each with its own line.
- On a Sunday, next Monday is tomorrow: Up and Right both show, and mean the same day.

## Holding without moving

- Lifting the finger without ever having passed the threshold leaves the four dates open, to tap. They're buttons
  then: named for a screen reader ("Tomorrow, Sat 10"), the first one focused, Escape closing them.
- With them, **Pick a date…**, in the middle, where the finger was: it opens the phone's own date picker, and the
  date picked moves the task as a direction does. (In the middle, it needs no room of its own, so the dates sit in the
  same place whether they're flicked to or tapped.)
- A tap anywhere else closes it all, changing nothing.
- So the hold has its tap path in itself (design rule 3), beside the sheet's Due.

## Undo

- **Every date changed by a hold has an Undo,** for a few seconds, where Pocket says where the task went ("Moved to
  tomorrow", by the add box, or on its row if it's still on the screen): Undo puts back the date it had, its time too.
- So No date needs no long pull: it takes the same short move as the others.
- Design rule 8 loses its last two sentences, the exception: "Bulk actions confirm; single actions undo. Completing a
  parent's open subtasks asks first; a tick, a delete or a move of one task has its Undo or Restore instead."

## How it looks

- No veil over the screen: it stays as it is, dimmed very lightly at most (about 8%).
- The row held lifts where it is, with a shadow and its outline, as a row held to move does on a project's list. A
  card held by its header lifts whole. Nothing follows the finger: the date it points at lights.
- The four dates are chips around the finger, over the rows above and below, each with a soft shadow, scaling and
  fading in over about 120ms; with less motion, they're simply there.
- They stay on the screen: near an edge, the header or the add box, the whole set moves, never one chip, and the
  directions still count from where the finger was held.
- A chip is at least 56px each way, for gloves.

## What it bends

- Rule 1 says up and down is for finding and organizing. After a hold on Today, up and down pick a date: Today has
  no order to move a row in, and the arc it replaces was up there already.

## Tests

- `tests/unit/throw.test.mjs`: each direction's day on each day of the week, Sunday's Monday; the threshold, and back
  near the start; a flick; dimmed dates; the time kept, and one gone by; the set kept on a 360px screen for a row at
  the top and at the bottom, its directions unchanged.
- `tests/unit/actions.test.mjs` and `rows.test.mjs`: a date changed with its Undo putting back the date and time; a
  task that repeats, a checklist, a run and its step not moved.
- `tests/smoke.mjs`, in place of the hold in `today-deletes-by-a-swipe-and-a-hold-does-nothing`: each direction on a
  flick; let go near the start; the four open to tap after a hold without a move, each tapped; Pick a date…; a tap
  outside closing it; Undo; a repeating task's dates dimmed with its line; the chips on screen for the first row and
  the last; and no veil.
- The specimen: the chips around a row mid-screen, at the top and at the bottom, one lit, Today dimmed, open to tap
  with Pick a date…, and a repeating task's.

## Decisions

The user's answers, 2026-10-10:

1. **A task that repeats** stays as it is today: not moved by a hold, its dates dimmed with the reason.
2. **The chips sit around the finger,** over the rows next to the one held, which lifts in place.
3. **No date** takes the same short move as the others, and every date changed by a hold has an Undo.
4. **The add box's line** keeps its words, "Add a subtask to P, after X": the draft's part on the nudge is covered by
   `rows-and-sheet-fixes-plan.md`, part 3.

Chosen while writing this plan, for the user to read: Pick a date… in the middle; letting go near the start closes it
only if the finger had moved out first; a time already gone becomes the next whole hour, and a date that changes
nothing is dimmed, both as the ring did.
