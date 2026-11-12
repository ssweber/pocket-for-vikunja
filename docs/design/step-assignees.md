# Enforce step assignees

A third switch on a template. On a checklist started with it on, only a step's assignee can tick or skip that step.
With **Enforce step order**, this gives a light sign-off flow. Someone starts the checklist and does the open steps.
Each step assigned to a manager or QA opens when the step above it is done, and only that person can tick it.

The pictures are `scratchpad/ui-assignees/assignees.png` (the switch and the locked step) and `titles.png` (the
title chip, option B).

## Decided

- A step with an assignee can be ticked or skipped only by one of its assignees. Any one of several is enough. A sign-off
  by two people is two steps.
- A step with no assignee stays open to anyone who can write to the project. So does a step added during the checklist,
  unless it was typed with `@user`.
- Skip is locked too, unlike under the other two switches. Otherwise a teammate could skip the sign-off.
- The assignee can release their step, and then anyone can tick it. That is how a step is handed off. Nobody else can
  take over a step that has someone on it in Pocket, as now.
- No override for the template's author or a project admin. A stuck step is fixed in Vikunja's web app.
- Finishing a checklist early leaves its open steps open, so it needs no rule.
- Vikunja's web app ignores the switch, as it ignores the other two. The ✅ reaction records who ticked.
- In a message, a task's title is drawn as a white chip in the app's font (option B), in every message that names a
  task. It replaces the curly quotes.

## Part 1: titles in messages as chips

A message is a string from `messages.js`, drawn as text in three places: a place line (`markup/place-line.html`), a
row line (`markup/row-line.html`) and the toast (`#toast-msg` in `index.html`).

- `messages.js` gets one helper that marks a title inside a message, by wrapping it in U+2068 and U+2069. These are
  Unicode's isolate marks, so they also keep a right-to-left title from reordering the sentence around it. A screen
  reader skips them. Every message that names a task, step, checklist or project uses the helper, in place of `“…”`
  or a bare `${title}`.
- A helper splits a message into parts, `{text, title}`. The three places draw the parts with `x-for`, a title part
  as `<span class="ttl">`. The row line's struck-through title stays as it is.
- `.ttl`: `background: var(--ttl-bg)`, `border-radius: 6px`, `padding: 1px 6px`, `box-decoration-break: clone`, so a
  long title wraps with each line in its chip. `--ttl-bg` is `--surface` on a place line and a row line. The toast is
  dark (`--ink`), so it gets its own value there. Dark mode needs a check on all three.
- Button labels ("After Check the count") and the texts only a screen reader hears keep plain titles.
- `scripts/check.mjs` fails on a curly quote around a `${…}` in `messages.js`, so a title can't be quoted by hand
  again. The other files that build `“${…}”` (`cards.js`, `outbox.js`, `runs.js`) move their sentences into
  `messages.js` if a message renderer draws them. Chips on the add box (`quickadd.js`) keep their quotes.
- The order and time lock messages (`tickableAfter`, `tickableAt`, `waitingFor`) get the chip in this part.

Tests: unit tests for the split (no marks, one title, two titles, a title holding `“`), and a check that
`tickableAfter` marks both titles. An e2e test that compares a message's whole text sees the marks. If one fails on
them, `tests/helpers.mjs` gets a helper that reads a message without them.

## Part 2: the switch

- `checklists.js`: a `pocket:assignees` line, read by `runRules` as `who` and written by `withRules`. A checklist
  copies it when it starts, as it copies the other two (`copyRun`, `ops/runs.js`), with no new code there.
- `markup/sheet/task.html`: a third row in `#d-rules`, `#d-who`, with `#i-user`. **Enforce step assignees**. "Only a
  step's assignee can tick or skip it." `setTemplateRule('who', …)` in `app/checklists.js`.
- `lockOf()` gets the user's id. With `who` on, a step that has assignees, none of them the user, returns
  `{icon: 'lock', at: null, who: [people], skip: false}`. It is checked before the order lock, because it lasts and
  the order lock doesn't. The order and time locks return `skip: true`.
- `tickStep()` (`app/runs.js`) asks the lock for any op but `undone`, and lets a skip through only when
  `lock.skip`. The Skip button and the swipe that skips read the same lock, so one check covers both.
- `storedLock()` (Today's card, a sheet) builds its steps from `stepsOf(run)`, which has no assignees, because Vikunja
  leaves them out of related tasks. The assignee lock needs only the step's own assignees, from `this.tasks[t.id]` or
  `t`, which the row already shows.
- The Done button reads **Only bob**, or **Only bob or Sam** for two, from the people's names as the row shows them.
  Tapping Done, Skip or the lock says "Only bob can tick ‹Check the count›" (the title as a chip), where an order
  lock's tap says its message.
- Un-ticking someone else's step stays as now: Pocket asks first, and their ✅ stays.

Tests:

- Unit, `checklists.test.mjs`: `runRules` and `withRules` with `who`. `lockOf` with `who` for a step assigned to
  someone else, to the user, to the user and another person, and to nobody, alone and with the order rule. A skip passes
  an order lock and not an assignee lock.
- Unit, in the file for `tickStep`: a skip on a locked step queues nothing.
- e2e, `checklists.mjs`: a template with the switch on and a step assigned to `bob`. On `dev`'s checklist, Done and Skip
  on that step queue nothing and show the message. A step with no assignee ticks.

## Docs

- `guide.md`, the **Enforcing** paragraph: the third switch, in one sentence, and that Skip is locked with it.
- `data.md`: the `pocket:assignees` row in the lines table, and the sentence on copying the switches.
- `CHANGELOG.md`, under the next 0.x.0.
- This file is deleted once both parts are built.
