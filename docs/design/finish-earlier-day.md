# Finish a checklist on the day most of it was done

People often tick all but the last step of a checklist, then tick that step or press Finish the next day. The
checklist then counts as done on the later day, in Done today, in Copy week and in Vikunja. Pocket offers to finish it
on the day most of its steps were ticked.

## When Pocket offers it

- The day is the one on which the most steps were ticked or skipped. A tie goes to the later day.
- Pocket offers that day only if it is before today, and at most max(1, ⌊steps / 10⌋) steps were ticked after it or
  are still open. So 2 of 3 steps on Sunday and the last on Monday gets the offer. 6 of 10 on Sunday and 4 on Monday
  doesn't.
- The finish time is the time the last step was ticked on that day.

## What the user sees

- The finish card: a note, "Most steps were done Sun, Nov 22.", with **Finish as Sun, Nov 22** as the main button and
  **Finish today** under it.
- The sheet that asks before finishing with steps still open gets the same note and the same two buttons above Cancel.
- A tap on the ring, or a full swipe right, on a checklist with every step done finishes it at once today. With an
  earlier day to offer, it opens the sheet instead, so the choice is never skipped.
- The toast says "Finished Opening up, as Sun, Nov 22", with Undo.

## Writing the time

Vikunja sets `done_at` itself when a task is marked done, and ignores the value an app sends (tested on 2.7.1). So the
plugin writes it.

- `PUT /tasks/{id}/done_at` through the relay, with a key like every other write. The relay makes this one write
  itself instead of forwarding it, and answers with the task as Vikunja's API returns it.
- The plugin writes only `done_at`, only on a done task the user may edit, and only to the time one of that task's
  done subtasks was done, no later than the task's own `done_at`. `main.go`'s header lists it.
- The finish op records the chosen time. Its last stage reads the checklist from Vikunja once and sends the time of
  the last step done on the same day, so the time is Vikunja's own, not the phone's.
- A plugin too old for the route answers 404 for the route. The checklist then stays finished today.
- Undo and Reopen mark the checklist not done, which clears `done_at` as before.

## Checks

- Unit: which day is offered, with ties, skips, open steps and the step count limit. The finish op's lifecycle sample
  with a chosen time.
- relay.mjs: the route moves `done_at` back to a step's time. It refuses another time, an open task, and a task the user
  can't edit.
- checklists.mjs: with the page's clock a day ahead, the finish card offers the earlier day, and Finish as sets the
  checklist's `done_at` to its last step's.
