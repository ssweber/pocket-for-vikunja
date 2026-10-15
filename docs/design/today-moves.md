# Moving tasks on Today

A change to how a task moves to another date on Today. It was discussed and decided. Read `AGENTS.md`,
`docs/development.md` and `docs/design-rules.md` first. Delete this file once it is built.

## The Undo stays where the row left

### The problem

Holding a row on Today and throwing it to another date moves the row at once (`reschedule` and `placeOnToday`,
actions.js). The Undo then shows on the row at its destination. The user's eye is still where the row was, and the
moved row arrives somewhere else already carrying a message. If the row left Today altogether, the Undo goes beside
the add box instead.

### The decision

- **At the origin, a gap.** Where the row was, a gap the row's height shows "Moved to Today" and **Undo**, built like
  the deletion gap (`markup/gap.html`). Tapping anywhere on the gap undoes the move, as tapping a deletion gap
  restores the task.
- **The gap names where the task went:** "Moved to Today", "Moved to Tomorrow", "Moved to Fri 24", "Moved to No
  date". For a task that left Today (8 or more days ahead), the gap is the only trace on the screen, so it always says
  the day.
- **At the destination, a plain row.** The row appears there at once with the arrival flash (`flash([id],
  'arrived')`), and no message.
- **The gap leaves with the batch:** 3 seconds after the last mark, and never while a finger is down (rule 5 in
  `development.md`, rule 7 in `design-rules.md`). Then it collapses like any leaving row.
- **Undo** removes the row from the destination, puts it back where the gap is, and flashes it there. The gap goes.
- **A failed save** turns the gap back into the row, with the error and Try again on the row, as a failed move does
  now.
- **A card held in place** is unchanged. When an earlier subtask keeps a card where it is, the card doesn't move, so
  there is no gap. The message beside the add box says why, as now.
- **Move all is unchanged.** It is a bulk action (rule 8), and a gap per row would leave a block of empty rows. It
  keeps its one message and Undo under Overdue.
- **Only Today.** Holding a row to change its date exists only on Today. A date changed in a task's sheet has no row
  to leave a gap in.

The add box's message is no longer needed for a row that left Today, because the gap is always where the user's finger
was. Delete that path in `reschedule`, and keep only the held-card message.

### The trap: one object per task

Rule 1 in `development.md`: every list's rows are the objects in `tasks`, by id. And `leaving`, `lit` and `flashed`
are read by task id (rule 10). So the task can't be marked as leaving at the origin and shown normally at the
destination: both rows would read the same mark.

The gap is therefore not the task. It is a placeholder in the origin group, with an id of its own, such as
`moved-<task id>`, and the task's id and the words to show. Mark the placeholder with `markRow` under its own id, with
a new kind, `'moved'`, so the batch timer, `holdRow` and `gone` work as for any mark. The `x-for` is keyed by `t.id`,
so the placeholder's id must never equal a task id.

Things to check while building it:

- **Where the placeholder lives.** Keep it in a map by group key that `listBase` (sending.js) adds into that group's
  rows at the old index, the way waiting tasks are added. Don't push it into `view.groups`, which is saved as the copy
  for opening offline (`keptGroups`).
- **Rule 10.** The placeholder must read nothing every row reads, and `listGroups` must keep returning the same group
  object when nothing changed (`sameGroup`). Run `npm run perf:rows -- counts` before and after.
- **Cards.** A placeholder is never a card's subtask, and `listItems` must treat it as a plain row.
- **The row markup.** Add the gap as a branch of `markup/task-row.html` beside the deletion gap, or a sibling
  template. `isGap` in leaving.js currently means "deleted". Give the new gap its own test, such as `isMovedGap`.
- **Words** go in `messages.js`: the gap's text, and what is announced (`said`): "Moved to Today: <title>".
- **Accessibility.** The deletion gap has a hidden span with the task's title for screen readers. Do the same.

### Tests

In `tests/unit/actions.test.mjs`, beside the existing `reschedule` tests (`moveTo`):

- A row thrown from Next 7 days to Today leaves a gap in Next 7 days saying "Moved to Today", and the task is in Today.
- The gap is gone once the batch clears, and stays while a finger is down.
- Undo puts the task back in Next 7 days at the gap's place, and removes it from Today.
- A row thrown 10 days ahead leaves a gap naming that day, and the task is on no group of Today.
- A failed save puts the row back in Next 7 days with Try again, and leaves no gap.
- A card held in place by an earlier subtask leaves no gap, and the message beside the add box says why.
- Move all leaves no gaps.

Add the moved gap to the specimen page (`scripts/specimen/`), which shows every state of a row.

### When

After phase 5 of `single-code-paths.md`. That phase turns `reschedule`'s save and Undo into the `due` op and its
`invert`. Building the gap first would mean writing its Undo twice. The gap uses the op's Undo as it is.

## What else came up, and where it went

| Question | Where it is handled |
|---|---|
| Does the outbox prune a quick tick and untick? Are reschedules batched? | `single-code-paths.md` part 1: pruning. Move all stays one op per task. |
| Does adding a task with `x` add the ✅? | `single-code-paths.md` part 1: one tick op, used by quick add too |
| Move all is unreliable | `movedDue` (dates.js) gives a task whose time has passed today no time, and `single-code-paths.md` part 1 (dates go through the outbox) |
| The Undo shows at the destination | This file |
| Lost replies, and searching after the fact | `single-code-paths.md` part 0, the keyed relay, and `upstream-idempotency-key.md` |
| Inconsistent Undo, task kinds, Today's groups, inline messages | `single-code-paths.md` parts 2 to 5 |
| API-token sign-in, and outbox entries from an older Pocket | Deleted, `single-code-paths.md` part 6 and part 1 |
