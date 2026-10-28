# Project chips on Today

Today shows every open task due this week from every project the user can see. In a team project that is mostly other
people's work. A row of project chips at the top of Today lets the user switch a project off. Today then shows only
that project's tasks that are theirs.

The approved picture is `scratchpad/ui-today-off/today-chips.png` (chips at the top, Team off).

## The rule

A project that is off keeps a task on Today when the task is assigned to the user or the user added it
(`created_by`). Every other task from that project leaves Today and stays in the project. A project that is on works
as Today does now.

"Added by the user" matters because a task typed with `+team` and no assignee would otherwise leave Today as soon as it
was added. It is the same test "Added today, no date" already uses (`todayItems`, `src/js/cards.js`).

Checklists and the steps the user is on are theirs already, so the rule changes nothing under Checklists.

## The chip row

- It sits at the top of Today, above the first group, on one line. With more chips than fit, the line scrolls
  sideways. It is not shown when only one project has tasks on Today and no project is off.
- There is one chip per project with a task on Today, counted before the rule hides anything, so an off chip stays
  while its project has tasks there. The chips are in the Projects tab's order.
- A chip has the project's colour dot and title. It reuses `.chip`, 36px tall with a 44px tap area. An off chip is
  outlined and its title is struck through, as in the picture.
- Tapping a chip switches the project on or off. Today redraws at once, like Show all does. A tap is a filter change,
  so rows don't wait for the batch.
- While a project is off, a line under the row states the rule: "Team: only tasks assigned to you or added by you."
  With two or more off, the line names them: "Team, Kitchen: only…".
- The choice is saved on the phone, as `started.hidden` is (`store`, key `today.off`, a list of project ids). It works
  offline and needs nothing from Vikunja. Each phone is set on its own.

## With the label narrower

Tapping a label still narrows Today to it (`narrowToday`). The two filters apply one after the other. The "Only
*label · Show all" bar stays as it is, under the chip row. Show all ends the label and leaves the chips alone.

When Today is narrowed and empty while a project is off, the empty message adds that the project is off, because the
off project may be hiding tasks with that label.

## The trap

Today decides what it shows in two places. A load uses `todayReasons` (`src/js/app/sending.js`), which filters with
`inToday`. A regroup uses `belongsIn`, which places a dated row by its date alone. The rule must be one function both
call, or a change to a task's assignees on an off project shows only after the next load. Unassigning yourself from a
task on an off project should take it off Today when the batch clears, and assigning yourself should bring it back.

## Tests

Unit tests, in the Today tests:

- An off project keeps tasks assigned to the user and tasks the user added, and drops the rest. A card from an off
  project appears only when a subtask that put it on Today passes the rule.
- `belongsIn` agrees with a load for a task on an off project, before and after its assignees change.
- The chips list each project with a task on Today, in the Projects tab's order, and keep an off project's chip while
  it has tasks there. No row with only one project and none off.

One e2e check: switch a project off, reload, and the chip is still off and its other tasks are still hidden.
