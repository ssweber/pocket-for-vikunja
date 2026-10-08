# Motion and rows: a refinement pass

Settled with the user on 2026-10-08. It follows `fast-tasks-plan.md` (built 2026-10-07): read that first, since this
changes some of what it built, and each change is named below. Task notes (autosave, lists and checkboxes) have their
own plan, `task-notes-plan.md`, built after this one.

## How to work

- Every decision here is settled. Stop to ask only when the code shows something this plan didn't expect: a rule that
  can't be kept, or a part that turns out much bigger than it looks. When you do ask, say what you found, with file and
  line, and what you recommend.
- Where a small UI detail is left open, choose what best fits the principles below. List each choice in your report,
  for the user to review.
- Read `AGENTS.md`, `docs/development.md` (with its **Gotchas**) and `docs/roadmap.md` first.
- Build one part at a time, in the order of the build table at the end. Commit a part when the full
  `BROWSER_CHANNEL=chrome npm run test:local` run is green. While working on a part, run only the affected test file;
  run the full suite once at the end of the part. Don't push.
- **Never kill processes by name** (`taskkill /IM`, `pkill`): that once closed the user's own Chrome. Stop only
  processes you started, by their PID.

## 1. Principles

- **Content doesn't move under a finger.** A layout shift causes mis-taps: that's why Google measures Cumulative
  Layout Shift. That includes rows getting shorter.
- **Motion explains a change, it doesn't decorate it.** One clear "these left" beats several rows leaving one at a time
  (Nielsen Norman Group).
- **Motion caused by an interaction can be turned off** (WCAG 2.3.3). Respect `prefers-reduced-motion`.
- **Every swipe has a tap alternative** (WCAG 2.5.1). The ⋯ menu covers every gesture.
- **Tap targets are at least 44×44pt** (Apple's guidelines). Pocket uses 48px. What's drawn can be smaller; the area
  that takes the tap can't.
- **Things that behave differently look different** (consistency, and the Gestalt principle of similarity).
- **Show the next action, not the container.** A project isn't something you can do; its next step is (GTD).
- **A destructive gesture is never one slip away from a harmless one.** On Projects, a plain swipe left deletes, while
  holding first and then dragging left lowers progress: the hold is what keeps them apart. A mistaken plain swipe
  only reveals Delete, and any delete can be restored in place (section 5).

## 2. Two screens, two jobs

**Today is for doing. Projects, search and a task's sheet are for managing.** One rule per screen is easier to learn
than one rule per kind of row, and it keeps destructive swipes off the screen used fastest.

### Today

| Action | Result |
|---|---|
| Tap the checkbox | Done |
| Tap the initials or "+ me" | Claim, or let go |
| Hold, then drag sideways | Progress, on the step showing (or on the task, if it has no open steps) |
| Plain swipe left or right on a card | Page through its open steps (section 4) |
| Plain swipe on a row without steps | Nothing |
| Tap the title | Open the task |

- **No delete and no reorder on Today.** This changes part 4 of `fast-tasks-plan.md`, which put swipe-to-Delete on
  every row. Order on Today comes from due dates. Delete stays in the task's ⋯.

### Projects, search and a task's sheet

| Action | Result |
|---|---|
| Tap the checkbox | Done |
| Tap the initials or "+ me" | Claim, or let go |
| Hold, then drag sideways | Progress, both ways |
| Hold, then drag up or down | Reorder (not in search: its results have no order of their own) |
| Plain swipe left | Shows Delete; carrying on past half the row deletes, with a haptic as it passes (built) |
| Tap the title | Open the task |

- A delete, by tap or full swipe, goes straight into the deleted state of section 5, so Restore is one tap away.
- **No plain swipe right for done**, anywhere. It would share a direction with progress, and a mistaken done is
  expensive.
- Search shows subtasks as rows, as Projects does, not as cards.

## 3. The progress drag

Progress means "I'm working on it" more than a precise number. Mostly built in part 4: keep how it feels.

- Relative to where it was; dragging left lowers it. Stops at 25, 50 and 75%. At 100% it's done; dragging a done item
  below 100% opens it again. The first ~10px decide the direction. Haptics: a tick on the hold and at each stop, a
  stronger one at 100% (the iPhone trick is built and still needs trying on a real iPhone).
- **New: progress on a task nobody has claims it for you.** "+ me" turns into your initials as the drag starts.
  Someone else's claim is never replaced. Dragging back to 0% keeps the claim; letting go is a separate tap.
  Vikunja emails a task's creator when someone assigns themselves, so on a shared project, starting a task tells
  whoever made it. That's wanted.
- The percentage label stays as built: it sits on the side away from the finger.
- **Bug to fix:** on a subtask, the fill drawn while dragging starts at the row's left edge, while its progress line
  starts at the indent. The line (`.row.sub::after`) already allows for the indent; the fill
  (`.row.setting`'s gradient, `src/styles.css` ~line 196) doesn't. Have both read one inset value (e.g. `--row-inset`,
  set on subtask rows), so they match at any depth.

## 3a. Checklist steps look different from subtasks

- **Square checkboxes for checklist steps**, round ones for tasks and subtasks.
- **A run's progress line is in segments**, one per step, filling as steps are done, and it can't be dragged. Past
  about 12 steps, a continuous line with small tick marks instead. A task's line stays continuous.
- A run itself has no progress drag: its steps are its progress (already so).
- **No new "in 18 min" chip.** A template's steps already show their time, and a run's steps their countdown. The
  card's step line (section 4) shows the same.
- **First, one row for steps.** A run's steps are drawn by their own row in `src/markup/screens/run.html`, which shares
  only the claim slot and pictures with `src/markup/task-row.html`. Section 4 needs one row component for subtasks and
  steps, with options. So bring run steps into `task-row.html`, with options for what differs: square box, step
  number, the › that inserts a step, the countdown, the ✅ of who did it. Template steps keep their own editor row.
  This is the largest piece of work in this plan, and it's done first, as a refactor with no change in behaviour.

## 4. Today: a card showing the next step

Anything with open subtasks or steps shows on Today as a card: its title, and one line for its next step. Subtasks
never show as rows of their own on Today. **This changes #167 as built in part 9 of `fast-tasks-plan.md`**, where a
subtask assigned to you showed as its own row under "Added today, no date".

**It isn't a separate widget.** The step line is the row from section 3a, with paging on and reorder and swipe-to-delete
off. A change to the row shows up in both places.

- **The card's title** has no checkbox. It's a heading: tapping it opens the task. Closing the whole thing is done in
  its sheet or on Projects, where ticking a parent closes its subtasks.
- **The step line** shows one subtask or step, with its own checkbox, initials or "+ me", and progress. Drags act on
  the step, never on the parent: the step line is the drag target, not the whole card. One drag, one step: 100%
  finishes that step, and the next comes in once the batch clears (section 6). A long drag never runs on into the
  next step.
- **Which step shows:** the next open step in order, whoever it belongs to, with their initials. One rule for
  checklists (their order line) and tasks (the List view order from part 5). When a subtask of yours brought the card
  onto Today, it opens on that one.
- **Paging:** a plain swipe left or right on the card, or the `‹ ›` arrows at the ends of the step line, with a `2/5`
  count between them. The arrows look small, but take taps over 48px. Hidden when there's one open step. Paging wraps
  round. Leaving Today puts every card back on its next step.
- **The parent's progress** is a line under the step line, counted from its subtasks (steps done out of all of them),
  in segments as in section 3a. A task's own % still shows on Projects and in its sheet.
- **What brings a card onto Today:**
  - the parent being due, by Today's groups (overdue, today, the coming week); or
  - one of its open subtasks being due, by the same groups; or
  - an open subtask assigned to you that is due, or has no date but was added or assigned today (as "Added today, no
    date" works); or
  - a step you've claimed in a run in progress (as now).
  An old, undated subtask of yours doesn't keep a card on Today forever.
- Today opening at once from its kept copy (part 9) keeps working: the copy holds the cards.
- **Cost to watch:** a card needs every open subtask of its parent and their order. The order comes from each project's
  List view (part 5 reads it for one parent at a time in the sheet). For Today, read it once per project shown, not
  once per card.

## 5. Done and deleted: in place, at the same height

A row marked done or deleted keeps its exact height and place until the batch clears (section 6). Nothing shrinks.
**This replaces part 4's Undo line**, which shrank the row to a 48px line with its own Undo for 5 seconds.

- **Done:** a filled check and strikethrough, at full strength. Tapping the checkbox opens it again.
- **Deleted:** the same row dimmed, without strikethrough, title still readable. Its initials or "+ me" turn into
  **Restore**, in the same place and shape. Tapping anywhere on the row restores it. The delete is sent only when the
  batch clears (the deferred delete from part 4 stays: in the outbox, held, sent on clearing, on leaving the screen, or
  when Pocket is hidden or closed).
- **A parent ticked with open subtasks** (Projects): they all show done in place, and leave together.
- **A repeating task** shows done like any other. When the batch clears it doesn't leave: it turns back to open with
  its new date ("next Fri"), or leaves if that date is past what the screen shows. Tapping its checkbox before the
  batch clears puts its old date back.
- Screen readers hear each change ("Done: Pack the van", "Deleted: Pack the van. Restore is on the row"), through the
  `#said` live region.
- Part 4b's other in-place messages stay as they are, such as "Not saved: no connection · Try again" on a row.

## 6. Leaving together

- **Each mark or delete restarts a 3-second timer, counted from when the finger lifts.** When it runs out, every row
  waiting to leave goes at once.
- Never while a finger is down or the list is scrolling. Leaving the screen clears them at once.
- **The exit:** about 200–300ms, all rows collapsing together; the rows below close up once.
- Done rows go to the folded Done section (on Projects) and its count goes up.
- With reduced motion, they fade or simply go, without collapsing or sliding.

## 7. Tap targets

Part 4 made the tick, the claim slot and Delete 48px. Check and extend:

- **The checkbox:** the circle drawn is about 25pt; its tap area covers the whole left gutter, at the row's full height.
- **"+ me", initials and Restore:** about 27pt tall as drawn; the tap area is the row's full height.
- **The title area** opens the task.

Three clear zones on every row, no dead space, nothing under 44pt.

## 8. Finding the gestures

- **A one-time hint on the first row** that can take it: "Hold and slide to start working on it". It goes after the
  first drag that sets progress, and is remembered on the phone (localStorage, in a try/catch).
- The `‹ ›` arrows teach paging without a hint.
- The ⋯ menu has every gesture.

## Build order

| Part | What | Changes from `fast-tasks-plan.md` |
|---|---|---|
| 1 | One row for subtasks and run steps (3a, last bullet): a refactor with no change in behaviour | |
| 2 | Done and deleted in place, leaving together (5, 6), the subtask fill fix (3), tap targets (7) | Replaces part 4's Undo line |
| 3 | Today's rules (2): no delete or reorder; search follows Projects | Changes part 4's swipe on every row |
| 4 | Progress claims (3), square boxes and segmented run lines (3a) | |
| 5 | Today's card with its next step (4) | Changes #167 from part 9 |
| 6 | The one-time hint (8) | |

## Sources

- [Cumulative Layout Shift — web.dev](https://web.dev/articles/cls)
- [The Role of Animation and Motion in UX — Nielsen Norman Group](https://www.nngroup.com/articles/animation-purpose-ux/)
- [10 Usability Heuristics — Nielsen Norman Group](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [WCAG 2.3.3 Animation from Interactions — W3C](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html)
- [WCAG 2.5.1 Pointer Gestures — W3C](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures.html)
- [prefers-reduced-motion — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- [Accessibility (touch target size) — Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/accessibility)
