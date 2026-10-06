# Who's on a step, and writing steps with quick add — plan

Decided with the user on 2026-10-06, after looking for places that take one person only, or where a task or step is
written in a box that isn't quick add's.

## What was found

- Start's For and a run's ⋯ For took one person: fixed with templates that come round (b777c71).
- A step's or subtask's slot shows one picture and "+1", though it can have several people.
- A done step showed a ✓ pill with who did it (22px) beside the slot with who it's assigned to (28px, ringed when it's
  you): your initials twice, at two sizes, on a step you did yourself.
- Steps written in New template and Add steps had a box of their own: it read a step's time, but showed no chips or
  suggestions, though quick add read `@person`, `*label` and `!priority` in them on the way to Vikunja. A step changed in
  place was saved as typed: `@priya` stayed in its name. New template's name was a plain field read by quick add too.
- Names of runs and projects, notes, comments and search are plain, as they should be: they aren't tasks.

## Decided

1. **A done step:** one size of picture for everyone. Its assignees' pictures, and whoever did it gets a small ✓ on the
   corner of theirs (⏭ for a skip, grey while it waits to be sent). Someone who did it without being assigned is shown
   too, with the badge. No separate ✓ pill.
2. **Several people:** up to two pictures, a little overlapped, yours first and ringed, then "+N".
3. **Quick add's box** for steps being written (New template, Add steps), for a step changed in place, and for New
   template's name: chips and suggestions for people, labels and priority, with the step's time chip as now. Dates stay
   out: a step's time is its T#. A step changed in place is read the same way: `@priya` assigns it, `*front` labels it.

Built 2026-10-06: 1 and 2 in 31dbebe, 3 after it.

## Next: Insert a step, from any step (decided, not built)

The box above the step on screen is always there, in the way most of the time. Instead (the user's pick of four: › on
each step, + between steps, swipe a step, one closed link):

- Each step in a run's Steps has a small › at its left edge. Tapping it opens a box under that step, saying where:
  "After “Turn on the espresso machine”". What's typed goes after that step; 🔁 in it repeats that step there. One open at
  a time; tapping › again, or another step's, closes it.
- "+ Add a step at the end" stays after the last step.
- To settle when it's built: whether 🔁 is offered on a step not done yet, and what Back does with a box open.
