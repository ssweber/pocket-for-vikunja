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

### Added

- A template step can ask for a number, yes or no, a choice or a line of text, and each checklist's card records the
  answers ([guide](docs/guide.md#asks)).
- A task can move to another project from its ⋯ menu, taking its subtasks along, with Undo.
- A Copy button beside ⋯ on a project, a checklist and a task copies its progress as text in one tap.
- Today has a folded Done today group with what you finished today, and its Copy gives it as text
  ([guide](docs/guide.md#tasks)).

### Changed

- Reordering in a task's menu says "Up one place" and "Down one place", because "move" in Vikunja means moving to
  another project.
- The ⋯ menu item that opens the phone's share sheet says "Share as text".
- A checklist's step shows its latest comment, cut to one line, and how many files are attached, in place of a comment
  count.
- Checklists lists every checklist finished in the last 7 days, with its ring, its skipped steps and its comments, in
  place of the last few.
- In Pocket, only a template's maker or a project admin can change it, and someone with read access sees why they
  can't start a checklist from it ([guide](docs/guide.md#checklists)).

### Fixed

- A `pocket:` line that Vikunja's web app partly formats, such as one with a link in it, is now hidden and kept whole.

### What Pocket writes into Vikunja

- Each ask is a `pocket:ask` line in a step's notes.
- Each answer comment has a `Label: value` line for each answer, then the line `pocket:answer`.
- Ticking a task in a shared project, finishing a checklist, or adding a task already done adds the user's ✅
  reaction to it, and unticking or reopening it takes the ✅ off.

## 0.1.0 (2026-10-13)

- The first release, with checklists, quick add, progress set by swiping, and offline use
  ([release notes](https://github.com/ssweber/pocket-for-vikunja/releases/tag/v0.1.0)).
