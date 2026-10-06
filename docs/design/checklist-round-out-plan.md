# Steps inserted during a run, checklists that come round again, and what's waiting to send — plan

Proposed 2026-10-06, from the user's PRD "Checklist round-out features", with the user's answers the same day. Nothing
is built yet.

The rule for all three: Pocket runs repeatable work simply. A template is what we expect to do; a run is what actually
happened. No branching, approvals, routing, recurrence language of Pocket's own, or sync console.

Pocket isn't released yet, so nothing here has to allow for data written by an older Pocket.

## What's there already

- A run keeps what it was started from, in lines of its own (c8e7b57): `pocket:run` in its description, and
  `pocket:step <the template step's title then>` in each step's. A template changed or deleted later changes only runs
  started after.
- A run's steps are copied one at a time in the template's order, and shown in id order. Only a template has a
  `pocket:order` line.
- The outbox (`src/js/sync.js`) is in IndexedDB, so it survives a reload, closing Pocket and a lost connection. It's
  sent oldest first, one sender at a time across tabs. Each entry has a random id and keeps how far it got, so a try
  that's cut off carries on where it stopped. A lost reply is never taken for a failure: before trying again, Pocket
  looks for what the last try may have made (a task by title and time, `findSent`; a copy through "copied to" links,
  `findCopy`; a note, `findNote`; a file, `hasAttachment`). Ticks, ✅/⏭️ and claims are safe to send twice.
- Pocket talks only to API v2, and never falls back to another path. Saves send only the fields that changed
  (`patchTask`, and `saveTask`, which re-reads and changes only its part).

So part 3 of the PRD is mostly there. What's missing is seeing it, and keeping what Vikunja turned down.

## 1. Steps inserted during a run

### What it is

It comes up after a step is done, when the run has moved on to the next: "I need to do something else before this
one", or "that last step needs doing again". So both put a step **before the step on screen**:

- Where: in **Steps**, between the step done last and the one on screen (once every step is done, after the last, so a
  step can be added at the end), a box is always there, unfocused, like the
  subtask box: `( ) [Insert a step] 🔁 +`. Nothing near Done and Skip, so a low tap can't add a step.
- **Insert a step**: what's typed in the box, added with **+** or Enter. It's the subtask box: quick add's marks,
  chips and suggestions for labels, people and priority, but no dates (a step's time is its template's) and no project;
  a pasted list inserts a step a line, in order. Escape empties the box.
- **Repeat**: **🔁** puts the step before the one on screen in the box, when it's done, with a note under it ("A fresh
  copy of the step before, not done. Change the words to insert a new step instead."). Left as it is, **+** makes a
  fresh copy of it, right after it; changed, it's an inserted step. The first one stays done, with its ✅, notes and
  photos; the copy starts not done, with none of that.
- An added step that isn't done has a red **×** on its row while it's on screen, to delete it.
- Either is a step like any other: Done, Skip, claim, notes, photos, ✅ by who did it, and offline through the outbox.
- Each says so in grey under its title, **Inserted** or **Repeated**, on the run screen, in the run's sheet and in
  Last time.
- Neither ever changes the template. No "add it to the template" in v1.

### How it's kept in Vikunja

- An inserted step is a subtask of the run, in the run's project, with a line `pocket:added` in its description.
- **Insert a step** makes a new task (as a subtask is added now: `LINE_STEPS`, with the run as parent).
- **Repeat** makes a copy of the template step the first one was copied from, exactly as a start does (the `step` part
  of `RUN_STEPS`: duplicate, link, then the title and the first one's `pocket:step` line, plus `pocket:added`). So it
  has the template step's notes and reference photos, as the first one had, and a lost reply is found through "copied
  to". Vikunja's duplicate copies attachments, so it copies the template step, never the run's step, whose photos are
  this run's history. If the template step is gone, it's a new task with the first one's title, notes and `pocket:step`
  line, without photos.

### The run's order

- Every run gets its own `pocket:order` line when it's started, read the way a template's is (`inOrder`). The
  template's order is copied onto the run as it starts, and from then on the run never reads the template's.
- Starting writes it in one more part of `RUN_STEPS`, once all the steps are copied: the run's description with the
  line of its steps' ids. Written again after a lost reply, it's the same line.
- Inserting a step writes the line with the new id before the step on screen, through `saveTask`'s re-read, so notes
  or another inserted step saved meanwhile are kept. Sent again after a lost reply, it puts the id in only if it isn't
  there already.
- A finished run keeps its line: it's what happened.
- Moving a run's steps by hand isn't in v1. The line would allow it later.
- `stepsOf` reads a run's line instead of sorting by id; so does `main.go`'s `writeStepDueDates`.

### Times (T#) with inserted steps

A step counts from "the step before" or a named step. An inserted step in between would change which one that is.

- An inserted step has no time, and timing doesn't see it: the step after it still counts from the template step
  before it.
- A repeated step has no time of its own. A step timed from the first one counts from the copy once the copy is done
  (the soup tasted again, then 10 minutes to serve). With several copies, the last one done.
- The plugin's `writeStepDueDates` follows the same rules, so its due dates match the countdowns.

### Removing one

An inserted or repeated step that isn't done can be deleted, with a confirm: it was likely a mistake. A step from the
template can't be taken out of a run: Skip it, so the run says it was skipped.

### Offline

- Both go through the outbox, and show on the run screen at once, marked "Waiting to send".
- A step inserted offline has no Vikunja id yet. A tick or note on it waits behind its entry and is sent with the id
  the entry got (Pocket already keeps which entry made which task for a day, in `sync.claimed`).

### Tests

- `checklists.mjs`: a run's order line written at start; insert a step mid-run, online and offline, with its reply
  lost; repeat a step; the order after a reload; the template unchanged; delete an inserted step; Last time shows them
  marked.
- `steptimes.mjs`: a run's order line is followed; an inserted step doesn't change what a step counts from; a step
  timed from a repeated one counts from the copy.

## 2. Checklists that come round again

### What it is

Vikunja has no way to make a task at a set time: a repeating task is the same task, whose dates move on when it's
ticked. So the template itself is the repeating task. Vikunja keeps the schedule, shows it and emails its reminders;
Pocket makes the run when someone starts it, exactly as a manual start does now. Nothing on the server makes tasks, and
the plugin needs no token: it still only keeps step times.

- **A template without a due date** is done, as now, and out of every list.
- **A template with a due date** is left not done. Vikunja shows it at its time, on Today in Pocket and in its own
  Upcoming, emails its reminders (so "remind me 15 minutes before" goes on the template), and moves it on when it's
  ticked, by its own repeat: every so often, every month, or from the day it's ticked.
- **Starting a run** of a template due today or earlier ticks it: with a repeat, Vikunja moves it to the next time and
  leaves it not done; without one, it's a plain done template again, and that schedule is over. A start at 7:55 is the
  8:00 one, so there's no second run.

The template owns the schedule, and a run never repeats. A run is made when the work starts, which is what happened.

### Setting it, in Pocket

- In the template's sheet, its due date and Repeats (Repeats is already in Details).
- Setting a due date on a done template: the date (and repeat), then not done.
- Taking it off: the repeat off first, then no due date and done. In one save, Vikunja would move the date and leave it
  not done: it moves a repeating task's dates when it goes from not done to done, by the repeat it had.
- Make template: a task with a due date becomes a template that comes round at that time, left not done, its repeat
  kept; the confirm says when. Without one, done, as now.

### Starting

- Tapping the template on Today, or Start under Checklists, opens the Start sheet, as now.
- Who it's for starts as the template's assignees, if it has any, else you; it can be changed, as now.
- One more part of `RUN_STEPS`, last, so a start called off ticks nothing: when the start began with the template not
  done and due by the end of that day, tick it. The start keeps the due date it saw, and ticks only if the template is
  still not done and still at that date. A tick sent again after a lost reply would otherwise skip a second time.
- After Vikunja moves it on, if its next time is still past (a template left for weeks), Pocket moves it on to the
  first time after now, on the same beat. No catching up missed runs.
- The run's own due date is the time the template was due, so a run left open shows on Today, and as overdue. A run
  started from a template not due has none, as now.
- The run has no repeat, no "template" label and none of the template's reminders (duplicate copies them all).

### On Today and under Checklists (to discuss before building)

- On Today, a template that's due shows where any task due then would, as runs do: with no tick, and tapping it opens
  the Start sheet. Under it in grey, "Checklist: tap to start".
- Under Checklists, the template's grey line: "Next: Wed Oct 7, 8:00, then every day", or "Due now".
- Runs of the same template can be open at once, scheduled or not, as manual ones can now: one left open doesn't hold
  back the next time.

### In Vikunja's web app

- At its time it shows as a task, labelled "template", with its steps as done subtasks.
- Ticking it there skips that time: with a repeat, Vikunja moves it to the next; without, the schedule is over. No run
  is made.
- Deleting it there deletes the template. So a template's title starts with "TEMPLATE: " ("TEMPLATE: Opening up"),
  which says what it is wherever Vikunja shows it, beside the "template" label. Pocket writes it when a template is
  made, keeps it when one is renamed, and shows the name without it: in Checklists, the Start sheet, a run's title
  ("Opening up · run 12 · Oct 7"), Today and the template's sheet. The label stays what marks a template, for Pocket
  and the plugin; a template without the prefix still is one. A separate task to hold the schedule would need its own
  link, title and clearing up.

### Not in v1

Making runs ahead of time, catching up missed runs, a list of schedules, a run made with nobody starting it, purging
old runs. A later purge must never delete a template.

### Check first, on the local Vikunja 2.7

How far each repeat mode moves a template left for weeks (Vikunja's every-so-often seems to jump past now, its monthly
one month at a time); that saving a done template's repeat leaves it done; that its reminders are emailed while it's
not done; what deleting a template does to its steps.

### Tests

`checklists.mjs`: a due date on a template leaves it not done, on Today with no tick, and tapping it opens Start;
starting ticks it, moved on, the run due at that time with no repeat or reminders; a start well before it's due
doesn't tick it; a lost reply to the tick doesn't skip twice; a template left for weeks moves to the first time after
now; taking the date off leaves it done where it is; Make template from a task with a due date; with no repeat, a start
leaves it done.

## 3. What's waiting to send

### What's missing

- Nothing shows everything waiting in one place. The Offline banner is a paragraph, and only while offline.
- Something Vikunja turns down for good (403, a task deleted meanwhile) is dropped with a toast. A task's or note's
  words go back in their box, so nothing typed is lost, but a tick, skip or claim has nothing to give back, and a toast
  is easy to miss.

### What to add (to discuss before building)

- The refresh button in the header shows what's waiting by changing its icon: as now when all is sent; a different
  icon with a count while something waits; a warning one when Vikunja turned something down. Its label for screen
  readers says it: "2 waiting to send", "1 couldn't be sent".
- While something waits or was turned down, tapping it opens **Waiting to send**, a sheet with a row each, oldest
  first, in plain words with when it was done: "Done: Check the milk fridge", "A note on “Wipe the counters”", "Photo
  for “Restock cups”, 2.1 MB", "Starting Opening up", "Inserted in Opening up: “Flush the line”", "New task: Buy milk".
  At the top, why it's waiting: "No connection: these go when Pocket reaches Vikunja", or Vikunja's last answer. A
  **Try now** button, which also refreshes. With nothing waiting, it refreshes, as now.
- A tick, skip, untick, claim or finish that Vikunja turns down stays in the sheet, with why, and **Try again** and
  **Don't send it** (its confirm says what that leaves: "“Check the milk fridge” stays not done in Vikunja"). Later
  acts on the same task wait behind it, so an untick can't arrive before its tick. Tasks and notes keep going back in
  their box, as now.
- Rows still waiting can be cancelled where they can now (a task, a file, a start), and a tick or note too.
- The Offline banner shrinks to "Offline · showing tasks from …. Ticking off or changing tasks needs a connection,
  except on a run.", as the sheet says what waits.
- Diagnostics, later: Pocket's and Vikunja's versions at the bottom of the account sheet, nothing more in v1. No
  tokens, and no notes or photos beyond what the sheet's rows show.

### Writes added in this round, and what keeps each to once

| Write | Sent again after a lost reply |
|---|---|
| A run's order line at start | the same line again |
| Ticking the template at start | only if it's still not done and still at the due date the start saw |
| Moving a late template to the first time after now | the same date again |
| Insert a step | the task looked for by title, time and who (`findSent`); the link: "already linked" counts as done |
| Repeat | the copy found through "copied to" (`findCopy`); then as above |
| The order line, on insert | puts the id in only if it isn't there, re-reading first |
| Deleting an inserted step | "not found" counts as done |

A double tap on Insert or Repeat: the button is off while the entry is made, and each entry is made once.

### Tests

`offline.mjs`: the button's icons and the sheet offline, a turned-down tick kept with Try again and Don't send it,
later acts on its task waiting, Try now.

## Build order

1. What's waiting to send: small, separate, and it helps check the rest.
2. A run's order line, at start and read by the app and `main.go`; then Insert a step.
3. Repeat, and the timing rules.
4. The checks on the local Vikunja, then templates with due dates.

Each is its own `feat` commit with its tests, after the user's go.

## Decided (2026-10-06)

1. A run's order line is written at every start.
2. An inserted step has no time and timing skips it; a step timed from a repeated one counts from the copy.
3. Inserted and repeated steps can be deleted until done; template steps are skipped, not removed.
4. Both put a step before the one on screen, from a box always there above it in Steps: type and +, or 🔁 to put
   the step before in it. Marked "Inserted" and "Repeated". A done step's who-did-it shows Pocket's tick, not ✅.
5. No scheduler on the server: the template is Vikunja's repeating task, and starting a run ticks it. (A plugin making
   runs would have meant calling Vikunja's internals, or an API token in its config.)
6. Any template with a due date comes round: the due date is the cursor.
7. A run of a template that's due is for the template's assignees.
8. That run is due at the time the template was.
9. The refresh button changes icon when something waits, and opens the sheet.
10. Acts Vikunja turns down stay in the sheet, with Try again and Don't send it.
11. Runs of a template can be open at once: the PRD's "only one run outstanding" is dropped.
12. A template's title starts with "TEMPLATE: ", so it isn't deleted by mistake on the web; Pocket shows it without.

## To note

- "From the day it's done" counts from when the run is started (the template is ticked then), not when it's finished,
  as the PRD had it. The template has no way to know when a run is finished without Pocket open.
