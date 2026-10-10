# Quick add: tasks that arrive done, parents in a pasted list, and Markdown that comes back

Settled with the user on 2026-10-09, from a note written with an outside chat. Built on 2026-10-10, each part in
commits of its own, in the order given; **As built**, at the end, says what the build chose where this left a detail
open.

## The goal

Pocket's two ways of sending a list out get a job each:

- **Share as text is what you see.** Bars, ◐ and ○, "due Fri", "2 of 5 done": the figures the screen shows, for a
  person to read. It isn't read back, and it stays as it is.
- **Copy as a Markdown list comes back.** It's written in quick add's words, so pasted into Pocket's add box it makes
  the same tasks: the same done state, nesting, people, labels, priority, dates, repeats and progress.

Design rule 9 says so, in place of what it says now:

> 9. **What you share matches what you see; what you copy comes back.** A shared text says the same figures the screen
>    shows. A copied Markdown list is written in quick add's words, so pasting it into Pocket's add box makes the same
>    tasks.

Vikunja's quick add has no shortcut for done or for progress, so both are Pocket's own, and the guide says so. Vikunja's
web app already reads indented lines as subtasks (`parseSubtasksViaIndention` in its frontend: any number of levels,
counted in spaces), and strips `- `, `* `, `+ ` and `- [ ] ` from the start of a line. It doesn't read `[x]` or
`(50%)`: there they stay in the title. The promise is Pocket's add box; Vikunja's gets most of the way.

What a copy never carries, so a paste never makes: notes, comments, photos, and a project's done tasks.

## What this changes that's built

- **A ticked line is left out today** (`TICKED` in `src/js/quickadd.js`, the chip "2 lines ticked off already: left
  out", the guide's Quick add section, `tests/parse.mjs` and `tests/smoke.mjs`). With this, it arrives done instead.
  The old way stays one tap away: see part 1.
- **Indenting isn't read today:** `captureLines` trims every line, and the guide lists "Subtasks marked by indenting
  aren't supported" among the ways Pocket differs from Vikunja. That line goes.
- **The outbox knows one shape of list:** `nest` makes the first line the parent of all the rest (`isChild`,
  `src/js/sync.js`). A list with several parents, or subtasks of subtasks, needs each line to say which line it's under.
  Entries kept on a phone from before still send as they would have.
- **Copy as a Markdown list writes words for people today:** `- [ ] Tables (50%, due Fri)`, and a second line `Due Fri
  · @sam` under the heading (`markdownText`, `src/js/share.js`; `tests/unit/share.test.mjs`; the guide's Sharing
  section). Pasted back, "due" stays in the title and the second line is a task. Those words for people are Share as
  text's job; the copy becomes quick add.
- **A run's Copy as a Markdown list goes** (`#r-copy-md` in `src/markup/sheet/checklist-options.html`, its tests, the
  guide): see part 3.
- **Design rule 9** changes as above. The note dropped partial progress from the copy, because quick add can't read
  it; with the new rule, Pocket reads it instead (part 1), so nothing on a copied list is lost on the way back.

## 1. A line that says it's done, or how far along it is

- At the start of a line, an x marker followed by a space makes the task arrive done: `x Call Sam`, `x - Call Sam`,
  `x- Call Sam`, `[x] Call Sam`, `- [x] Call Sam`, `* [X] Call Sam`, and `☑ Call Sam` and `☒ Call Sam` as now.
- No space after the marker means it's a title: `x-ray the pipe` stays as typed. A bare capital `X ` is a title ("X
  marks the spot").
- `[ ]`, `- [ ]` and `* [ ]` mean open, and are taken off the title, as now.
- A figure at the end of a line, `(50%)` or `50%`, is the task's own progress, as a slide would set it. On a line with
  lines under it, it's dropped: a parent's progress is worked out from its subtasks (rule 5).
- **One line:** a **Done** chip, and a chip for the progress, like the others: tapping one keeps its words in the title.
- **A pasted list:** one chip counts them, "2 arrive done". Tapping it leaves those lines out, as Pocket did before,
  "2 ticked off already: left out", and tapping again brings them back. (Keeping `[x]` in each title, as a single line's
  chip does, would help no one.)
- The marker is marked in the box, as the other words read are.
- It works whichever quick add mode is set, as checkboxes do today: it's about the list, not Vikunja's shortcuts.
- A task added done shows ticked on its row and leaves with the batch, as a tick does (rule 7). One that repeats moves
  to its next date, as a tick moves it.
- Sent as a tick is: created, then marked done the way a tick marks it, so a repeat and a parent's figure behave the
  same. A line's progress is written the same way.
- **Which boxes:** quick add and the subtask boxes. A run's box and a template's steps keep today's rule, a ticked line
  left out: a step is done by doing it, with your ✅.

## 2. Parents in a pasted list

The user's ask: a little marker that says "the first line is the parent". Two ways, both read:

- **A heading:** a line starting `## ` (or `###`) is a task, and the lines under it, up to the next heading, are its
  subtasks. It's what a task's copy starts with, and what Markdown notes write. A `# ` heading, one `#`, is the name of
  the whole list (a project's copy starts with one): it's left out, and a chip says so.
- **Indenting,** as in Vikunja: a line indented more than the line above it is under it, to any depth. Spaces or tabs,
  any width: only "more than the line above" counts.
- **For typing:** a first line ending with a colon, `Groceries:`, is the parent of the rest, the colon taken
  off. It's how a list starts in a message.
- **↳ Under first line** stays for a list with none of these, and shows on by itself when the first line is a parent;
  tapping it off makes them all tasks of their own.
- The chip says what it makes: "2 tasks + 7 subtasks".
- Each line in the outbox says which line it's under. A parent's worked-out figure is written once its subtasks are
  in, when any of them arrived done or with progress (parent-tasks-plan, part 3).
- In a subtask box, a heading or an indented line goes under the line it's under, which is under the open task.

## 3. Copy as Markdown writes quick add

```markdown
## Pack the van @priya !3 2026-10-16
- [x] Load chairs
- [ ] Tables (50%)
  - [ ] Legs
- [ ] Sound system @sam *hire every week 2026-10-15 at 15:30
```

- The task is the heading, in quick add's words. Its figure isn't written: it's worked out from what's under it.
  (Today's second line, `Due Fri · @sam`, goes.)
- Each item: `- [x]` done or `- [ ]` open, two spaces in for each level, its own progress `(50%)` if it has some and no
  subtasks, then `@user`, `!priority`, `*label` and its repeat (`every week`, `every month`), with the user's own
  prefixes (`+user` and `@label` in Todoist mode), then its due date.
- The due date comes last, as `2026-10-16`, with `at 15:30` when its time isn't the default due time. Pocket reads a
  numeric date only at the start or end of a line, and with its year it means the same day pasted next week or next
  year, overdue or not ("Oct 1" pasted after October 1 would be next year's).
- A title that quick add would read words in is quoted, so it isn't: `- [ ] "Lunch friday" @sam 2026-10-16`. Vikunja
  has no escape for one word, only quotes round the whole text, which turn everything off. Pocket's own extension:
  quotes round the start of a line hold its title, read as typed, and the words after them are read as usual. The copy
  quotes a title only when it needs it (the title alone would read as something: a date, a person, `x ` at its start),
  so most lines have none. Chosen over a backslash (`Lunch \friday`): Markdown escapes only punctuation, so a
  backslash before a letter shows in every notes app; it's hard to reach on a phone's keyboard; and it would have to
  cover a phrase like `next week`, where quotes simply go round the title. A title with a `"` in it is quoted with
  `'` instead.
- A project's copy: `# Café · 12 open · 5 done`, then its open tasks, each with its open subtasks, as now. Pasted
  back, the heading is left out and its tasks are made.
- Nothing collapsed, as now.
- **A run has no Markdown copy.** Its copy was a record of who did each step and who skipped one, which can't come
  back: pasted, `- [x] Load chairs @priya` would put Priya on it, and quick add has no word for skipped. **Copy as a
  Markdown list** leaves a run's menu; **Share as text** keeps the record (`✓ Load chairs · Priya`), and making the run
  again is Repeat.

## Tests

- `tests/parse.mjs`: each done marker, `x-ray` and `X ` staying titles, open markers taken off, `(50%)` read and a
  parent's figure dropped, headings, indenting and a first line's colon making parents, and a quoted title read as
  typed with the words after it read.
- `tests/unit/share.test.mjs`: the new Markdown, with the user's prefixes in Todoist mode; and a copied task's and a
  project's Markdown read back by `captureLines` and `parseCapture` into the same items, the rule's own test.
- `tests/smoke.mjs`: the Done chip and tapping it away; a pasted list with done subtasks, the parent's ring right from
  the start, and "2 arrive done" tapped to leave them out; a task's copy pasted back into quick add matching the
  original.

## Decisions

The user's answers, 2026-10-09:

1. **Parent markers:** `##` headings, indenting, and a first line ending with a colon.
2. **A pasted list's ticked lines** arrive done; a tap on "2 arrive done" leaves them out.
3. **A run** has Share as text only.
4. **A title with quick add's words in it** is quoted, `"Lunch friday" @sam`, not escaped with a backslash.

## As built

Where the plan left a detail open, the build chose these (2026-10-10):

- **Done markers.** `x ` counts only at the very start of a line (after `>` quote marks), not after a bullet: `- x
  marks the spot` is a title. `[x]`, `☑` and `☒` need no space after them, as before. A heading can say it's done,
  `## [x] Pack the van`, which is how a done task's copy starts.
- **Progress.** 1 to 100 is read; `0%` and anything past `100%` are words, and so is a figure alone on a line. `100%`
  is done. "The end of a line" is the end of its title once its other words are read, so the copy's `Tables (50%) @sam
  2026-10-15` has one. It's read whichever quick add mode is set, as done is, but not in a checklist's steps. A line
  that says it's done and has a figure arrives done, the figure taken off.
- **The example in part 3** shows `Tables (50%)` with a subtask under it; the rule beside it says a figure is written
  only for a task with no subtasks, and that's what's built: `- [ ] Tables`, then `  - [ ] Legs`.
- **Headings.** A heading with more `#`s is under the one before it with fewer (`###` under `##`). A line with one
  `#` is the list's name only when the box holds other lines; alone, it's a title as typed, so a line like "# of
  chairs we need" can still be added.
- **Indenting.** A tab counts as four spaces.
- **A first line's colon** is read in quick add's box only: a subtask box has no ↳ Under first line to turn it off
  with. With ↳ tapped off, the colon stays in the title, as a chip tapped off keeps its words.
- **↳ Under first line** on a list whose first line isn't a parent, but which has parents further down: tapped on,
  the first line becomes the parent of every line with none, the rest of the list as written. Such a list can't be
  made flat.
- **A list's count of done lines, tapped:** the lines under a line left out go under what it was under.
- **The copy with quick add turned off** has each line's title, done state, nesting and progress, which are read
  whichever mode is set, and none of the other words, which wouldn't be.
- **Quoting** is decided by reading each line back: if quick add wouldn't make the same task of it, its title is
  quoted. So what follows the title counts too: "Sign in" is quoted before a date, which "in" would go with. The
  title ends at the first such quote with a space, or the end of the line, after it.
- **A repeat** is written in the largest unit that fits ("every 2 weeks", "every 30 days"); one that isn't whole
  hours has no words and is left out. A repeat counted from the day a task is done comes back as a plain one.
- **A subtask's labels** are in a task's copy only where Pocket has loaded that subtask itself: Vikunja gives a
  task's subtasks without them.
- **A run opened as a task** has no Copy as a Markdown list either.
- **Where a line's words go back** (a task that couldn't be added, a waiting one cancelled): a done line goes back as
  `x …`, whichever marker it was typed with, and a list's shape isn't kept.
