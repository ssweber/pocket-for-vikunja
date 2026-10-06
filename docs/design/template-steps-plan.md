# A template's steps, written like subtasks — plan

Agreed with the user on 2026-10-06. Steps are now written three ways: subtasks in a task's sheet, steps in New template
and under a template (bare rows, a line under the words, plain or grey round buttons), and a step being changed (a line
under it, grey round buttons beside every step). They should read as one thing: the subtask rows and the subtask box.
A step's notes also have no way in from its template, and they're what each run copies onto its step.

## Steps in a template's sheet

- A saved step looks like a subtask row: its number in the circle where a subtask has its tick, the title, and in grey
  under it when it's due, as now, then the first line of its notes, cut to one line.
- ↑ ↓ × show only on the step that's been tapped, not on every step.
- Tapping a step opens it for writing: its title goes into the same quiet box as the subtask box (a light border that
  turns green with the focus), with the time chip under it as in New template, and a **Notes and photos ›** link under
  that. The keyboard opens with the tap, so dictation works.
- New steps are added a row each, as now (Enter opens the next row, each row has its own time chip and "counts from"
  choice), but each row is the same numbered circle and quiet box, and **Add a step** sits where the subtask box is.
- New template uses the same rows.

## A step's own sheet

- **Notes and photos ›** opens the step in its own sheet, the way a subtask opens. Its path says the template it's in,
  and tapping that goes back to it.
- It has the step's notes (the same editor as any task's, with its drafts and its check for notes changed elsewhere),
  attachments and comments.
- No tick, progress, due date, reminders or subtasks: a template's step is never done or not done, and its time comes
  from the template.
- Its title shows without its T# and isn't changed here: the name and time are changed in the template, where the steps
  before it are, which its time can count from. Under the title, in grey, when it's due, as in the template.

## Notes for the code

- `checklistRole` gets `'tplstep'` for a step whose parent is a template. Vikunja's related tasks don't carry labels, so
  the parent is checked in the cache and in the templates kept for offline.
- The step's notes are what `duplicate` copies onto a run's step, so the run screen shows them with no change there.
