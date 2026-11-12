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
- The lock follows whoever is assigned when the step is ticked. The assignee can release the step or hand it to
  someone else, and a teammate who changes the step's assignees in a task's sheet can take it over. For a small team,
  reassigning a step to close it out is fine, so the switch adds no rule on who changes a step's assignees.
- No override for the template's author or a project admin. A stuck step is fixed in Vikunja's web app.
- Finishing a checklist early leaves its open steps open, so it needs no rule.
- Vikunja's web app ignores the switch, as it ignores the other two. The ✅ reaction records who ticked.
- In a message, a task's title is drawn as a white chip in the app's font (option B), in every message that names a
  task. It replaces the curly quotes.

## Part 1: titles in messages as chips (built)

Messages already put titles in curly quotes. `titleParts` (`messages.js`) splits a message at its outermost pairs of
quotes, and `markup/title-text.html` draws each title as a chip in the row line, the place line and the toast. The
quotes stay in the text, hidden, so screen readers, confirm dialogs and the tests read them as before. The lock
messages now quote their titles too.

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
