# Filter Today by a row's project or label

This replaces the project chips at the top of Today. Tapping a project or a label on a Today row narrows Today to it,
as tapping a label does now. While Today is narrowed, a chip at the top offers three settings for what Today shows from
that project or label: All, Yours or None. A project or label set to Yours or None keeps a chip at the top. Tapping that
chip sets it back to All.

The approved pictures are `scratchpad/ui-today-filter/today-filter.png` (B, the project as a pill in the time line) and
`today-filter-line.png` (the one-line chip, with ✕).

## The settings

- **All** is the default, and Today shows every task as it does now.
- **Yours** keeps the tasks assigned to the user or added by them (`ownTask`), and a card with an open subtask of theirs.
  This is the rule the project chips use now.
- **None** hides every task with that project or label.

Projects and labels use the same three settings. A task is hidden when any project or label it has hides it.
`todayShows` (`src/js/app/cards.js`) applies the rule, so Move all to today, the badge and due alerts follow it, as they
follow the project chips now. Done today is not filtered.

The settings are kept on the phone under a new key, `today.filter`, as `{"p<id>" | "l<id>": {kind, id, title,
hex_color, set}}`. The name and colour are kept because Pocket loads the labels only when needed. The old `today.off`
key is ignored.

## A row's project

On Today, the project in a row's time line is drawn as a pill like a label's, at the line's own height, so the row keeps
its height. A tap on the pill narrows Today to the project instead of opening the task. The pill is inside the row's
button, so `tapRow` gets the event and checks whether the pill was hit. The pill's tap area reaches 44px, above and below
the drawn pill. The task's ⋯ menu gets "Show only Team on Today", because a screen reader can't reach a control inside a
button. Other screens keep the project as plain text.

## The chip line at the top

The line shows only when Today is narrowed or a project or label is set to Yours or None. It stays one line and scrolls
sideways, as it does now.

- **Narrowed, open.** Tapping a project or label on a row puts a wide chip first in the line: the pill, the control
  `All · Yours · None` with the current setting pressed, and ✕. The ✕ is centred vertically in the chip. A long title is
  cut with "…".
- **Narrowed, shrunk.** With no tap for 3 seconds, the wide chip shrinks to a normal chip drawn as pressed, so the other
  chips can be seen again. A finger on the screen holds the shrink off. Tapping the shrunk chip opens it wide again.
  Both are one line, so no row moves.
- **Tapping a setting** saves it and ends the narrowing at once. Today shows every project again, with the new setting
  applied.
- **✕** ends the narrowing and keeps the setting.
- **A chip set to Yours** shows the user's picture in place of the dot, as now. **A chip set to None** is outlined, and its
  title is struck through. Tapping either sets it back to All, and the chip leaves the line.
- A Yours or None chip stays while its project or label has nothing on Today, so it can always be set back.
- A label's chip shows `*label`, as the label bar does now.

Leaving Today ends the narrowing, as it does now. Narrowing to a label or a project replaces the previous one.

## With the add box

While Today is narrowed to a label, a typed task gets the label, as now (`boxOnly`). While it is narrowed to a project,
a typed task goes to that project, so it shows. A task added to a project or label set to None is hidden, as the rule
says.

## Empty Today

Narrowed to a project with nothing due: "Nothing from Team is due this week." The label message stays. When a setting
hides tasks, the body adds "Tap a chip above to show what it hides."

## Tests

Unit tests, in the Today tests (`tests/unit/lists.test.mjs`), replacing the project chip tests:

- Yours and None for a project and for a label: which rows, cards and subtasks stay. A task hidden by either of two
  settings is hidden.
- `belongsIn` agrees with a load, before and after a task's assignees change, under Yours.
- Narrowing to a project and to a label. Tapping a setting saves it and ends the narrowing. ✕ keeps the setting.
- The chip line lists the narrowed chip first, then each Yours and None setting, and keeps a chip with nothing on Today.
- The settings are read back from `today.filter`, and `today.off` is ignored.
- The wide chip shrinks after 3 seconds, and not while a finger is on the screen.

The e2e test for the label bar (`tests/smoke.mjs`) moves to the chip. One e2e check: tap a row's project, tap None,
reload, and the chip is still struck through and the project's tasks are still hidden.
