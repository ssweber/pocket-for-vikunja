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

## As built

Built on the branch `hold-reschedule` (2026-10-10), from this plan. What it left open, and what was chosen:

- **Sizes** (`THROW`, `src/js/throw.js`): each chip 100 by 60px; the middle left clear between them 88 by 56px, the
  height of a row on one line, which is also Pick a date…'s size; 6px between them; 8px kept from the screen's edges,
  the header and the add box. The set is 300px wide and 188px tall, so on a 360px screen it follows the finger
  sideways only between 158 and 202px from the left: held anywhere else, it's moved in.
- **The set is drawn at the height of the row held** (a card's header, or its row), not of the finger's exact place in
  it, so the chips above and below lie over the rows next to it and the row shows between them. The directions still
  count from the finger. Today and Tomorrow lie over the ends of the row held: around the finger, there's nowhere
  else for them.
- **No dim at all while the finger is down;** about 8% once the dates are open to tap, when a tap on the screen only
  closes them.
- **A date lit is a change of colour,** with no growing. The chips draw in over 120ms; closing, they're simply gone.
- **A direction is lit at 24px and stays lit back to 16px,** so a finger resting at the edge doesn't flicker it.
- **The row held has its outline in the accent colour** as well as its shadow. A card's is around the card, not the
  footer hanging under it.
- **Where the Undo's line goes:** on its row when the row is in sight in its new place, else by the add box (a task
  that left Today, or whose new place is scrolled away). On its row, the row is a line for those five seconds, and
  can't be held again until it's back; a card folds to a line meanwhile. Always by the add box would be one changed
  line (`reschedule`, `src/js/app/actions.js`).
- **What's said:** "Moved to today", "Moved to tomorrow", "Moved to Mon 12" for Next week, "Took its date off", and
  "Moved to Thu, Oct 15" for a day picked. The chips: "Today", "Tomorrow" and "Next week", each over its day ("Fri
  9"), "No date", and "Pick a date…".
- **Pick a date… offers today and later only:** a hold moves a task on, and a day gone by would come out as today's
  next whole hour, as a time gone by does. It opens on the task's own day, and picking that day changes nothing.
- **Open to tap:** the first date has the focus even when it's dimmed, as the plan says the first one; the arrow keys
  go to the date in their direction, and Tab stays among the five. A task that can't move opens too, all dimmed, so
  its line can be read. The line saying why is over the top chip, across the screen.
- **A flick** is a let-go under 24px that moved at least 12px at 0.3px/ms or faster.
- **Found on the way:** a message in its place (by the add box, under a heading, in a sheet) never went after its
  time, as its timer asked about the line as it was put in the component's data, never the copy Alpine gives back
  (`sayAt`, `src/js/app/lines.js`). Fixed, in a commit of its own, as the Undo's few seconds need it.
