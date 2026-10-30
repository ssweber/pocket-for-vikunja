# Changelog

<!-- Style guide: one sentence per entry. Describe the user-visible effect, not the
     implementation. Group related fixes/features into a single entry when they share
     a theme. Breaking changes and migration steps can be longer — users need the
     specifics. Detail belongs in commit messages and PR descriptions, not here.

     Review and condense before release — entries accumulate during development and
     should be edited into shape before moving from Unreleased to a version heading. -->

What changed in each release of Pocket. Versions follow [semantic versioning](https://semver.org). Until 1.0, a
release that adds a feature or changes what Pocket writes into Vikunja is a new 0.x.0, and a release with only fixes
is a new 0.x.y.

## Unreleased

## 0.4.0 (2026-10-30)

### Added

- Tapping a project on a Today row shows only that project's tasks, as tapping a label does
  ([guide](docs/guide.md#tasks)).
- While Today shows one project or label, a chip at the top sets what Today shows from it from then on: **All**,
  **Yours** (the tasks assigned to you or that you added) or **None**, and each phone keeps its own choice.

### Changed

- On Today, a row's project is a pill in the line under its title, which you can tap.
- While Today shows one project, a task added in the box goes into that project.

## 0.3.1 (2026-10-27)

### Fixed

- A title changed in a task's sheet just after ticking the task now shows the new title, in the sheet and on the row.

## 0.3.0 (2026-10-23)

### Added

- Two switches on a template, **Enforce step times** and **Enforce step order**, stop a checklist's step being ticked
  before its time, or while a step above it is open ([guide](docs/guide.md#timed-steps)).
- A task's labels show under its title, and tapping one on Today shows only the tasks with that label
  ([guide](docs/guide.md#tasks)).
- Searching for `*errands` lists every open task with that label, by project, and typing `*` offers the labels.
- Text after ` // ` in an add box becomes the task's notes, and a task with notes shows the notes icon after its
  title ([guide](docs/guide.md#quick-add)).
- A box holding a list shows the ways to add it as pictures of the tasks each makes, one of them a single task whose
  notes are the other lines, in place of **↳ Under first line**.
- Holding **+ me**, or your own picture, opens a menu of the people who can see the project, to assign or unassign
  them ([guide](docs/guide.md#assigning)).

### Changed

- Pocket opens on its saved screen sooner, and a checklist opened before shows its steps at once from its saved copy.
- The header always has the Today, Projects and Checklists tabs, and Checklists offers to set up a checklist project
  when there is none.
- A screen with nothing saved on the phone shows grey rows while it loads, instead of "Loading…".
- Today's rows show the title on one line, with the time, project and counts on a line under it, as a project's list
  does.
- Holding a task on Today shows a ring that follows the thumb, and a hold picks a date only between the tick and
  "+ me".
- On Today, a checklist step's countdown counts the seconds in its last minute, as the checklist's screen does.
- Copy as a Markdown list includes each task's notes, and pasting the copy into an add box brings them back.
- An `@` suggestion for someone who can't see the project names the project the task would move to.
- "Move all to today", "Open project" and the label chips under search are easier to tap.

### Fixed

- Pocket reloads only for a new version, not when the server can't be reached or sends an error.
- A change no longer waits in the Outbox for good when the server's database fails or another tab changed the Outbox.
- When the server's rate limit is reached, Pocket waits as long as the server asks, and "Waiting for Vikunja" says
  when it tries again.
- A tick or a date change cancelled in the Outbox while offline puts the task back on its list at once.
- A monthly task due on the 29th, 30th or 31st shows the date Vikunja 2.7.1 moves it to, such as Feb 28 for Jan 31.
- A finished checklist counts every skipped step and comment, also past Vikunja's 50 comments.
- Date chips left open on Today no longer close when a moved row's gap leaves the bottom of the page.
- Your own bots are offered only on projects shared with them, and an assignment Vikunja refuses leaves the Outbox and
  says why.
- When the phone's storage for Pocket is full, Pocket drops the oldest saved screen to make room, instead of not
  saving.
- A default due time in Vikunja's settings that isn't HH:MM is read as noon, as Vikunja's web app does.
- A tap beside "+ me", under a row's labels, opens the task.

### What Pocket writes into Vikunja

- A template's switches are the lines `pocket:wait` and `pocket:in-order` in its notes, and each checklist gets a copy
  of them when it starts.

## 0.2.0 (2026-10-19)

### Before you update

- Send or cancel everything in the Outbox on each phone first. Changes saved by Pocket 0.1.0 and not yet sent are
  dropped.
- Signing in with an API token is gone. Pocket signs in with Vikunja's own session, by password or single sign-on.
- Each screen saved on the phone shows "Loading" once after the update.

### Added

- Every change works offline and waits in the Outbox, and a change Vikunja refuses waits there too, with Try again
  and a Cancel that says what Vikunja still has.
- The plugin passes Pocket's changes to Vikunja with a key, so a change whose reply was lost is never made twice.
- Coming back to Pocket, or getting a connection back, shows what others changed or deleted since.
- A template step can ask for a number, yes or no, a choice or a line of text, and each checklist's card records the
  answers ([guide](docs/guide.md#asks)).
- A task can move to another project from its ⋯ menu, taking its subtasks along, with Undo.
- A Copy button beside ⋯ on a project, a checklist and a task copies its progress as text in one tap.
- Today has a folded Done today group with what you finished today, and its Copy gives it as text
  ([guide](docs/guide.md#tasks)).
- Typing `+` in an add box suggests your projects, as `@` and `*` suggest people and labels.
- Quick add reads "morning", "afternoon", "evening" and "night" after a day or a repeat as 9am, 3pm, 6pm and 8pm,
  so "friday evening" is Friday at 6pm, "tonight" is today at 8pm and "every day morning" repeats daily at 9am
  ([guide](docs/guide.md#quick-add)).
- Quick add reads a bare hour after a part of the day as people mean it, so "tomorrow morning at 6" is 6am, "tonight
  at 10" is 10pm and "tonight at 1" is 1am tomorrow.

### Changed

- Undo puts back only what nobody has changed since, and says so when something has.
- A task held on Today and moved to another date leaves a gap with Undo where its row was, such as "Moved to
  Tomorrow", and its row shows plainly where it went.
- Rows that belong somewhere else now, such as a task unticked in Done today, a checklist finished or reopened, or a
  task moved to another project, move there as ticked rows leave, and never while you touch the screen.
- Pocket says one thing for each situation: "Saved offline", "Waiting for Vikunja", "… couldn't be saved: <reason>",
  or "… may not have reached Vikunja".
- Offline, Pocket opens Today, Checklists, the last 5 projects and the last 8 checklists from the phone.
- In the ⋯ menu, reordering says "Up one place" and "Down one place", and the item that opens the phone's share
  sheet says "Share as text".
- A checklist's step shows its latest comment, cut to one line, and how many files are attached, in place of a comment
  count.
- Checklists lists every checklist finished in the last 7 days, with its ring, its skipped steps and its comments, in
  place of the last few.
- In Pocket, only a template's maker or a project admin can change it, and someone with read access sees why they
  can't start a checklist from it ([guide](docs/guide.md#checklists)).
- When a `@user`, `*label` or `+project` is typed mid-sentence, quick add keeps its word in the title, without the
  sign.
- The start of a project's name, as in `+gar`, picks a project only when no other project's name starts the same way,
  and otherwise the add box offers to create the project.
- A label's chip says "new label" when sending the task will create that label.

### Fixed

- On Today, a done task with a subtask still open, such as one that repeats, stays a card over that subtask, marked
  done. Before, the task went to Done today and its subtask showed nowhere.
- Ticking a shared task again soon after unticking it keeps your ✅, so the task stays in Done today after a reload.
- Done today's Copy leaves out yesterday's tasks, as the screen does, in a copy of Today saved yesterday.
- A finished checklist's ring counts a step undone on another phone, and its comment count includes comments past
  the first 50.
- Dropping a finish or a reopen that only partly reached Vikunja says what Vikunja now has.
- Claiming a step and unassigning yourself before either is sent leaves nothing in the Outbox, whether you used the
  claim slot, a slide, the sheet or a step's edit box.
- In a template step's edit box, adding `@user` no longer also queues a rename of the step, and an edit isn't saved
  once the user's access arrives and doesn't let them change the template.
- A `pocket:` line that Vikunja's web app partly formats, such as one with a link in it, is now hidden and kept whole.
- A change waiting to be sent redraws only the rings it changes, not every checklist's ring.
- On a phone set to a region that writes the day first, quick add reads "Oct 24" as 24 October, not October 2024.
- A weekly repeat typed on its own weekday, such as "every monday morning" on a Monday afternoon, starts next week
  instead of being overdue at once.

### What Pocket writes into Vikunja

- The plugin adds a table, `pocket_relay`, to Vikunja's database. It keeps each change's key and Vikunja's answer for
  31 days, so a change sent again gets the same answer.
- Each ask is a `pocket:ask` line in a step's notes.
- Each answer comment has a `Label: value` line for each answer, then the line `pocket:answer`.
- Ticking a task in a shared project, finishing a checklist, or adding a task already done adds the user's ✅
  reaction to it, and unticking or reopening it takes the ✅ off.

## 0.1.0 (2026-10-13)

- The first release, with checklists, quick add, progress set by swiping, and offline use
  ([release notes](https://github.com/ssweber/pocket-for-vikunja/releases/tag/v0.1.0)).
