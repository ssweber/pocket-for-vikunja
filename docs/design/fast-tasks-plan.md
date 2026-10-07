# Fast tasks: add, delete, reorder, progress, complete, share

Settled with the user on 2026-10-07, from a handoff covering tickets #158–#180 in Vikunja's Pocket project. Each part
below is built, tested and committed on its own, in the order given.

## The goal

Pocket makes six things very fast with one thumb: **adding, deleting, reordering, setting progress, completing, and
sharing tasks as a text message.** Where Vikunja already stores something, Pocket uses Vikunja's copy rather than one
of its own.

## Decisions

### 0. Getting started copy

On Checklists, the Getting started card (`src/markup/screens/checklists.html`) says:

> **Getting started**
> 1. **Share with your team.** In Vikunja, give them *Read & write* so they can check off steps. [Share it in Vikunja ↗]
> 2. **Create a checklist template.** One step per line. `@priya` assigns a step; `in 18 min` sets it due 18 minutes
>    after the step before. [New template]
> 3. **Make it recurring (optional).** Set a date and choose *Repeats*. It'll appear on Today when due.

Each item's button goes on its own line, so the "New template" button no longer runs into the text before it.

### 1. Bugs

- **#175 (with #174): toasts are flaky.** The likely cause: after adding a subtask, the subtask box keeps focus, so
  the keyboard stays open. With a sheet open, the toast is placed at the bottom of the layout viewport
  (`body.sheet-open #toasts`), which is behind the keyboard. Fix: place the toasts against `visualViewport`, so they
  sit just above the keyboard when it's open. Check for other causes too.
- **#158: turning the phone** breaks the highlight of quick add's chips and marks, and the box being typed in freezes or
  loses focus. Reproduce it by changing the viewport size in a test, then fix it.

### 2. One owner per concept (Alpine and the build stay)

Lit and a build-free app were turned down: the roadmap's reasons for one built file still hold.

- **`src/js/app/actions.js`:** one function per verb (complete, delete, move, add a subtask, set progress, reorder).
  Each one owns the API call, the cascade to subtasks, the change on screen and the Undo. Views call these, never
  `api()` directly.
- **One copy of each task:** a store of tasks by id that every view reads from, so a change shows up everywhere at
  once. Done step by step, starting with the rows.
- **One row:** `markup/task-row.html` is used by Today, Project, search and the sheet's subtask list. Run steps keep
  their own row, but share its parts where they're the same.
- **Tokens:** colours are already custom properties with a dark-mode block. Move the few raw colours left (mostly
  shadows) into tokens.
- **Guardrails:** a lint check that `fetch(` appears only in `api.js` (the sign-out and new-version checks are allowed
  exceptions), and a check that there are no raw colours outside `:root`. Also a specimen page, built only for
  development, that shows the row in every state, in light and dark.
- This is a refactor: no change in behaviour, with the tests green before and after.

### 3. Rows

The progress drag already works well. Keep how it feels, and change only what's listed here.

- **For every task row** (Today, Project, search, the sheet's subtasks): the tick on the left, and the claim slot on
  the right, the same as the sheet and runs use now. "+ me" when nobody's assigned; your picture when it's yours (tap
  to let it go); someone else's picture, which does nothing when tapped.
- **Progress** snaps to 0, 25, 50, 75 and 100%, with a haptic tick at each. At 100%: a stronger haptic and a check
  animation. Progress set elsewhere (say 40%) moves to the nearest snap point once slid.
- **Haptics on iPhone:** Safari ignores `navigator.vibrate`. Try the iOS 18 trick of toggling a hidden
  `<input type="checkbox" switch>` where it works (the hold starting, reaching 100%). Where it doesn't, show a visual
  tick instead: a pulse on the % label.
- **On hold:** a haptic tick, and the row lifts (a shadow or a slight scale). The first ~10px of movement after the
  hold decide the direction: sideways sets progress, up or down reorders (part 6).
- **A plain swipe left, with no hold,** shows a Delete button on the row. It doesn't delete straight away. Deleting
  gives an Undo.
- **Toasts:** a subtask's tick and progress show only on its row: no toast. Top-level tasks keep their tick Undo,
  since their row slides away. Deleting, and a parent closing its subtasks, keep their Undo everywhere.
- Every gesture is also in the task's ⋯ menu.

### 6. Order, from Vikunja's List view (before part 4, which needs it)

The server is on Vikunja 2.7.0, which checks that a position's view belongs to the task's project.

- **The Project tab is in List view order:** top-level tasks and subtasks alike, the same order as Vikunja's List view
  on the web. Today keeps its date groups. Read with `GET /projects/{id}/views/{viewId}/tasks`, from the project's
  first List view. Write with `POST /tasks/{id}/position` and `{position, project_view_id}`.
- **Drag to reorder**, after a hold, among siblings only (moving a subtask to another parent comes later). The new
  position is the midpoint of the positions on either side. The screen changes at once and the request goes in the
  background; if it fails, the row snaps back. Find out whether Vikunja rebalances positions that get too close, and
  if it doesn't, renumber the siblings.
- A subtask in another project has no position in this view: those go after the others, by id.
- **Done tasks** go in a collapsed "Done (24)" section below the open ones. It's loaded when opened, with the most
  recently done first, and can't be reordered. It replaces the Show done tasks link.
- **`pocket:order`:** find out whether List view positions can replace the order line in a template's and a run's
  description. Check that the plugin can read positions when it times a step; that steps copied one after another get
  positions in that order; that an inserted step can be given a position between two others; and that a reorder made
  in Vikunja's web app works too. If positions can do it, back the order line out and use them. Then drag-to-reorder
  replaces the ↑ ↓ buttons on a template's steps.
- **#173** (a table of our own) is closed: Vikunja has the field.

### 4. The add footer follows what you touched (Project tab)

- The footer (quick add's box, as on Today) says **"Add a task to <project>"** by default.
- Opening a task's sheet, or ticking a task or sliding its progress, makes that task the cursor. It gets a subtle
  highlight, and the footer then says **"Add subtask to <task> ×"**. × goes back to adding a task.
- If the cursor's task scrolls out of sight, the footer goes back to "Add a task". It only ever names a task you can
  see. Scrolling never moves the cursor.
- If the cursor is on a subtask, the new subtask goes right after it. Several added in a row go in order, each after
  the one before.
- The keyboard stays open after adding, and Enter sends the next one.

### 5. Completing a parent

- Ticking a parent still closes its open subtasks, without asking. Its Undo says **"Closed <task> + 4 subtasks · Undo"**
  and reopens only the subtasks that were open before.
- **A done parent with open subtasks** (finished in Vikunja's web app, say) shows as a struck-through header with its
  open subtasks under it, never leaving them orphaned at the top level.
- Tasks and runs go through the same completion function. Runs keep their exception: finishing a run with open steps
  asks first and leaves those steps open, since a step marked done should carry a ✅ from whoever did it.

### 7. Sharing and copying

- **Share progress** in a task's ⋯ (#170), a project's ⋯ (#177) and a run's ⋯. It's plain text for a text message,
  through the phone's share sheet (Web Share API), falling back to copying to the clipboard:

  ```
  Pack the van  ▰▰▰▱▱ 60%
  ✓ Load chairs
  ◐ Tables 50%
  ○ Sound system · Priya
  ○ Lights
  ```

  Names are the first word of the person's display name, or the username if there's none. On a long list, finished
  items collapse to "✓ 8 done". A run's lines say who did each step.
- **Copy as markdown** sits next to it, in the same menus.
- **Open in Vikunja** in each ⋯ (#180).
- **Copy** buttons on a task's notes and on each comment.

### 8. Instant feel (#179)

- A tab opens straight away with the last copy Pocket kept of it, then updates in place without a flash. The other
  tabs are refreshed in the background, so they're ready.
- Changes show at once. A row looks waiting (dotted) only if the server hasn't answered after a few seconds, and goes
  back if the change fails. This lives in the actions and the store from part 2, not in each view.

### Today: subtasks added today (#167)

A subtask with no date shows under "Added today, no date" only if it's assigned to you.

## Build order and tickets

| Part | What | Closes |
|---|---|---|
| 1 | Copy (0) and bugs (1) | #7 (#175), #8 (#174), #16 (#158) |
| 2 | Actions, store, one row, tokens, guardrails, specimen | |
| 3 | `pocket:order` and positions: findings, decided before part 5 | #9 (#173) |
| 4 | Rows (3) | #14 (#168), #6 (#176) |
| 5 | Order (6) | #11 (#171) |
| 6 | Add footer (4) | #13 (#169), #10 (#172), #4 (#178) |
| 7 | Completing a parent (5) | |
| 8 | Sharing (7) | #12 (#170), #5 (#177), #2 (#180) |
| 9 | Instant feel (8) and #167 | #3 (#179), #15 (#167) |
