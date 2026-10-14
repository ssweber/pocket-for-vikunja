# Changelog

What changed in each release of Pocket. Versions follow [semantic versioning](https://semver.org). Until 1.0, a
release that adds a feature or changes what Pocket writes into Vikunja is a new 0.x.0, and a release with only fixes
is a new 0.x.y.

## Unreleased (0.2.0)

### Added

- **Asks on checklist steps.** A template step can ask for a number, yes or no, a choice, or a line of text. Each
  checklist's card shows a field for each ask. **Save** sends the answers, and **Done** sends any not yet sent. A
  number outside its expected range is saved as typed and shown in amber. Write asks under **Notes, photos and asks ›**
  on a template step, or type them in Vikunja's web app. The [guide](docs/guide.md#asks) has the details.
- **Move a task to another project** from its ⋯ menu, or from the Project row under Details. Its subtasks move with
  it, at every level, and **Undo** puts them all back. A template, a checklist and their steps can't move.

### Changed

- Reordering says "Up one place" and "Down one place" in a task's menu, and "Not reordered" when Vikunja refuses a
  position. In Vikunja, "move" means moving to another project.

### Fixed

- When Vikunja's web app formats part of a `pocket:` line, such as a link in it, Pocket hides the whole line from the
  notes and keeps the whole line when the notes are edited in Pocket. Before, it handled only the part before the
  formatting.

### What Pocket writes into Vikunja

- `pocket:ask …` lines in a step's notes, one for each ask.
- Answer comments on a checklist's steps, one `Label: value` line for each answer, then the line `pocket:answer`.

## 0.1.0 (2026-10-13)

The first release. Checklists started from templates, with timed steps and templates that recur. Quick add with
Vikunja's syntax and pasted lists. Progress set by swiping. Pocket opens and keeps working without a connection. See
the [release notes](https://github.com/ssweber/pocket-for-vikunja/releases/tag/v0.1.0).
