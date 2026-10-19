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

## Unreleased (0.2.0)

### Before you update

- Send or cancel everything in the Outbox on each phone first. Changes saved by Pocket 0.1.0 and not yet sent are
  dropped.
- Signing in with an API token is gone. Pocket signs in with Vikunja's own session, by password or single sign-on.
- Each screen saved on the phone shows "Loading" once after the update.

### Added

- Every change works offline and waits in the Outbox, not only new tasks, comments and checklists. A change Vikunja
  refuses also waits there, with Try again and Cancel, and Cancel says what Vikunja still has.
- The plugin passes Pocket's changes to Vikunja with a key, so a change whose reply was lost is never made twice.
- Coming back to Pocket, or getting a connection back, shows what others changed or deleted since.

- A template step can ask for a number, yes or no, a choice or a line of text, and each checklist's card records the
  answers ([guide](docs/guide.md#asks)).
- A task can move to another project from its ⋯ menu, taking its subtasks along, with Undo.
- A Copy button beside ⋯ on a project, a checklist and a task copies its progress as text in one tap.
- Today has a folded Done today group with what you finished today, and its Copy gives it as text
  ([guide](docs/guide.md#tasks)).
- Typing `+` in an add box suggests your projects, as `@` and `*` suggest people and labels.
- Quick add reads a part of the day with its day: "this morning" is today at 9am, "tomorrow afternoon" 3pm, "friday
  evening" 6pm and "tonight" 8pm ([guide](docs/guide.md#quick-add)). "morning" on its own stays in the title. A bare
  hour after a morning is read as written, and after an evening or a night is PM: "tonight at 10" is 10pm. After a
  night, 12 and midnight end the day, and 1 to 4 are the small hours after it: "tonight at 1" is 1am tomorrow.
- Quick add reads a part of the day after a repeat: "every monday evening" repeats weekly from Monday at 6pm, and
  "every day morning" daily at 9am.

### Changed

- Undo puts back only what nobody has changed since, and says so when something has.
- A task held on Today and moved to another date leaves a gap with Undo where its row was, such as "Moved to
  Tomorrow", and its row shows plainly where it went.
- Pocket says one thing for each situation: "Saved offline", "Waiting for Vikunja", "… couldn't be saved: <reason>",
  or "… may not have reached Vikunja".
- Offline, Pocket opens Today, Checklists, the last 5 projects and the last 8 checklists from the phone.
- Reordering in a task's menu says "Up one place" and "Down one place", because "move" in Vikunja means moving to
  another project.
- The ⋯ menu item that opens the phone's share sheet says "Share as text".
- A checklist's step shows its latest comment, cut to one line, and how many files are attached, in place of a comment
  count.
- Checklists lists every checklist finished in the last 7 days, with its ring, its skipped steps and its comments, in
  place of the last few.
- In Pocket, only a template's maker or a project admin can change it, and someone with read access sees why they
  can't start a checklist from it ([guide](docs/guide.md#checklists)).
- The start of a project's name, as in `+gar`, picks a project only when no other project's name starts the same way.
  Otherwise the add box offers to create the project.
- A label's chip says "new label" when sending the task will create that label.
- Quick add leaves the word of a `@user`, `*label` or `+project` typed in the middle of a sentence in the title,
  without its sign: "Fix the *urgent leak" is "Fix the urgent leak", with the label urgent.
- Rows that belong somewhere else now, such as a task unticked in Done today, a checklist finished or reopened, or a
  task moved to another project, move there as ticked rows leave, and never while you touch the screen.

### Fixed

- A `pocket:` line that Vikunja's web app partly formats, such as one with a link in it, is now hidden and kept whole.
- A change waiting to be sent redraws only the rings it changes, not every checklist's ring.
- Ticking a shared task again soon after unticking it keeps your ✅, so the task stays in Done today after a reload.
- Done today's Copy leaves out yesterday's tasks, as the screen does, in a copy of Today saved yesterday.
- A finished checklist's ring counts a step undone on another phone, and its comment count includes comments past
  the first 50.
- Dropping a finish or a reopen that only partly reached Vikunja says what Vikunja now has.
- A template step being edited isn't saved if the user's access arrives and doesn't let them change the template.
- Claiming a step and unassigning yourself before either is sent leaves nothing in the Outbox, whether you used the
  claim slot, a slide, the sheet or a step's edit box.
- Adding `@user` in a template step's edit box no longer also queues a rename of the step.
- On a phone set to a region that writes the day first, quick add reads "Oct 24" as 24 October, not October 2024.
- On Today, a done task with a subtask still open, such as one that repeats, stays that subtask's card, marked done,
  instead of hiding the subtask under Done today.

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
