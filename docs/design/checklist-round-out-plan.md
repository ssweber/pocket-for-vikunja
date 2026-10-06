# Steps inserted during a run, runs that start on their own, and what's waiting to send — plan

Proposed 2026-10-06, from the user's PRD "Checklist round-out features", with the user's answers the same day. Nothing
is built yet. What's still open is at the end.

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

- **Insert a step**: a new step, typed like a subtask (quick add, with dates and project left alone, as
  `STEP_IGNORE`).
- **Repeat “Taste the soup”**: a fresh copy of the step before the one on screen, when it's done. The copy goes right
  after it. The first one stays done, with its ✅, notes and photos; the copy starts not done, with none of that.
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

## 2. Runs that start on their own

### What it is

A template's due date is its cursor: the next run to make, or the one being worked through now. With a repeat (Vikunja's
own `repeat_after` and `repeat_mode`), it moves on by itself. When it's due, a run is made on the server, whether or
not anyone has Pocket open. Any template with a due date starts on its own; taking the due date off stops it. Manual
starts work as now and never move the cursor.

### Where it runs: in `main.go`

Turned on in `config.yml` (`plugins.pocket.schedules: true`, or `VIKUNJA_PLUGINS_POCKET_SCHEDULES=true`), like step
times, and listed in the header comment of what the plugin writes.

Vikunja's repeat fields aren't the risk: `repeat_after`, `repeat_mode` and their three modes are long-standing, and
the plugin reads them and works out the next time itself. The risk is that making a run calls Vikunja's own code
(`models.TaskDuplicate.Create`, task relations, saving tasks), whose shape can change between versions, and if Yaegi
can't load `main.go`, Pocket's page isn't served either. Kept small by:

- calling as few of Vikunja's functions as it can, each in one place;
- the CI check from the workflows plan: boot the latest Vikunja image with the plugin and check Pocket loads, so a
  break is seen before a release, not after an upgrade.

### Once a minute

For each template (done, labelled "template", in a project for checklists) with a due date. The plugin keeps a line on
the template saying what it last made: `pocket:made 2026-10-07T08:00:00Z 4812` (the due date it was for, and the run),
hidden in Pocket as `pocket:order` is.

1. Not due yet: nothing.
2. A run it made of this template is still open: nothing. Runs don't pile up behind one left open.
3. It last made a run for this due date, and that run is finished or deleted: move the due date on.
   - No repeat: nothing more. It made its one run. Changing the due date by hand schedules another.
   - Every so often (`repeat_after`, from the due date): the first time after now, on the same beat (due + n × the
     interval). January's monthly run finished in April: next is May, no February or March.
   - Every month (`repeat_mode` 1): a month at a time, until after now.
   - From the day it's done (`repeat_mode` 2): the run's done time plus the interval. A deleted run counts from now.
   - Only the due date is written, and the template stays done. (Vikunja moves a repeating task's dates only when it
     goes from not done to done, so saving a done template's repeat is safe. Its own default mode also skips missed
     times, as here.)
4. Otherwise: make one run for this due date, however late the plugin is, and write `pocket:made`.

Moving the due date happens on the minute after the run is finished, and also covers the plugin having been off.

Making the run and writing `pocket:made` are one transaction, and `pocket:made` is written only if it's still what was
read, so a second Vikunja server on the same database can't make the run twice.

### The run it makes

The same as a run started in Pocket, so the app needs no second kind:

- Title "Opening up · run 12 · Oct 7"; `pocket:run`, its `pocket:order` line, and `pocket:scheduled
  2026-10-07T08:00:00Z`, which is how the plugin and Pocket tell it from a manual run. Its steps with their
  `pocket:step` lines, titles without T#, a reminder on each timed one, the first timed step due from when the run is
  made. No repeat, no "template" label.
- Its own due date is the time it was scheduled for, so it shows on Today, and as overdue if it's left. (A manual run
  has no due date.)
- It's for the template's assignees, which Vikunja's duplicate copies. None: nobody, and it shows to everyone under the
  checklist's In progress.
- Vikunja needs a user to make it as: the template's creator. If they can no longer write to the project, nothing is
  made, and the template says so in Pocket.
- The run screen says "Started on schedule" where it says "started by …".

### In Pocket (to discuss before building)

- The template's sheet shows its due date and Repeats (Repeats is already in Details), and under them in grey: "Next
  run: Wed Oct 7, 8:00, then every day", or "Waiting for the run of Oct 7 to be finished before the next".
- Under Checklists, a template with a due date shows that same grey line.
- The Start sheet, when a scheduled run of this template is open: "A run scheduled for Oct 7 is open: Open it", above
  Start. Starting another is still allowed, and doesn't count as the scheduled one. No starting the next scheduled run
  early in v1.
- Make template clears a repeat before marking the task done: otherwise Vikunja would move its date and leave it not
  done. It keeps the due date, so a task with one becomes a template that starts on its own; the Make template confirm
  says when.

### Not in v1

Making runs ahead of time, catching up missed runs, a list of schedules, purging old runs. A later purge must never
delete a template.

### Spike first

On the local Vikunja 2.7, from Yaegi: `TaskDuplicate.Create` with a `*user.User` as who did it; that events are sent
once it's committed (`events.DispatchPending`), so webhooks and search see the new tasks; whether duplicating a task
with assignees notifies them; that Vikunja sends no reminders for a done template.

### Tests

`tests/schedules.mjs`, through the API like `steptimes.mjs`, with the minute shortened by an environment variable:
one-time, every so often, monthly, from the day it's done; no run behind an open one; one run however late; a deleted
run moves it on; a manual run changes nothing; a template without a due date is left alone.

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
- A tick, skip, untick, claim or finish that Vikunja turns down: still open, below.
- Rows still waiting can be cancelled where they can now (a task, a file, a start), and a tick or note too.
- The Offline banner shrinks to "Offline · showing tasks from …", as the sheet says the rest.
- Diagnostics, later: Pocket's and Vikunja's versions at the bottom of the account sheet, nothing more in v1. No
  tokens, and no notes or photos beyond what the sheet's rows show.

### Writes added in this round, and what keeps each to once

| Write | Sent again after a lost reply |
|---|---|
| A run's order line at start | the same line again |
| Insert a step | the task looked for by title, time and who (`findSent`); the link: "already linked" counts as done |
| Repeat | the copy found through "copied to" (`findCopy`); then as above |
| The order line, on insert | puts the id in only if it isn't there, re-reading first |
| Deleting an inserted step | "not found" counts as done |
| A scheduled run | on the server, one transaction, written only if `pocket:made` is unchanged |

A double tap on Insert or Repeat: the button is off while the entry is made, and each entry is made once.

### Tests

`offline.mjs`: the button's icons and the sheet offline, a turned-down act as decided, later acts on its task waiting,
Try now.

## Build order

1. What's waiting to send: small, separate, and it helps check the rest.
2. A run's order line, at start and read by the app and `main.go`; then Insert a step.
3. Repeat, and the timing rules.
4. The scheduler spike, then the scheduler, then its place in Pocket.

Each is its own `feat` commit with its tests, after the user's go.

## Decided (2026-10-06)

1. A run's order line is written at every start.
2. An inserted step has no time and timing skips it; a step timed from a repeated one counts from the copy.
3. Inserted and repeated steps can be deleted until done; template steps are skipped, not removed.
4. Both put a step before the one on screen: Insert, and Repeat the step before.
5. The scheduler is in `main.go`, behind a config switch.
6. Any template with a due date starts on its own: the due date is the cursor.
7. A scheduled run is for the template's assignees.
8. A scheduled run is due at the time it was scheduled for.
9. The refresh button changes icon when something waits, and opens the sheet.

## Still open

- **Labels**: "Insert a step" and "Repeat “Taste the soup”" on the step screen; "Inserted" and "Repeated" in grey on
  the steps.
- **Turned-down acts**: kept in the sheet with Try again and Don't send it (its confirm says what that leaves:
  "“Check the milk fridge” stays not done in Vikunja"), and later acts on the same task wait behind it; or dropped with
  a toast, as now.
- **Who a scheduled run is made by**: the template's creator.
