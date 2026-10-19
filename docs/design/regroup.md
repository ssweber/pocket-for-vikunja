# Rows move where they belong when the batch clears

Decided with the user on 2026-10-19. Read `AGENTS.md`, `docs/development.md` and `docs/design-rules.md` first. Delete
this file once it is built.

## The problem

Only a screen's load decides which tasks are on it and in which group (`todayFrom`, `readProject`,
`readChecklists`, `loadSearch`). Between loads, `view.groups` changes only through special cases written one action at
a time (`moveInSearch`, `intoDoneToday`, `placeOnToday`, `regroupToday`, `removeRow`). Anything they don't cover waits
for the next load:

| Action                                                   | Place                                          | Today it shows                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Untick in Done today                                     | Today                                          | Stays in Done today, unticked, until the next load (`toggleDone`'s `was && !moves()` returns before any mark; `listBase` keeps it) |
| Reopen from Finished                                     | Checklists                                     | Stays under Finished until Checklists loads                                                                                        |
| Finish a checklist                                       | Checklists                                     | Leaves Open, but appears under Finished only at the next load                                                                      |
| Move to another project                                  | The project it left                            | Stays until the sheet closes and the op is sent. Offline, until a reload                                                           |
| Unlink a card's subtask                                  | Today                                          | Leaves the card, but gets no row until the next load (`cardSubs`)                                                                  |
| Date change in the sheet, task in "Added today, no date" | Today                                          | Stays in that group (`regroupToday` regroups only dated groups)                                                                    |
| A subtask added makes a task a card                      | Today                                          | At the next load (`view.cards`)                                                                                                    |
| Claim, assign                                            | Today's claimed steps, Done today (`doneByMe`) | At the next load                                                                                                                   |

Two bugs come from the same code:

- **Offline date changes.** When a reload lists a task by Vikunja's copy while its `due` op waits, `placeDated`
  (`alerts.js:90`, `|| week`) puts a task dated 8 or more days ahead, or with no date, into Next 7 days. The minute's
  `regroupToday` does the same.
- **Rows move under a finger.** The reload's `settle`/`keepMarked` and the minute's `regroupToday` swap groups without
  checking that the batch timer is holding (`design-rules.md`, rule 7).

## The decision

**Pocket moves and removes rows from the store when the batch clears. Rows that Vikunja adds to a screen appear when
the screen loads.**

- Rows stay put while the user works. When the batch clears (3 seconds after the last mark, never while a finger is
  down or the list scrolls), every row on the visible screen that now belongs in another group moves there, with the
  arrival flash, together with the ticked rows leaving. A row that no longer belongs on the screen leaves like a ticked
  row.
- An untick in Done today, or a reopen in Finished, marks the row `open` at once, as an untick in a project's Done
  does, and the row moves with the batch.
- The same regroup runs when the sheet closes, at the end of a catch-up, and at the minute tick, each only while the
  batch timer isn't holding.
- No new requests. A task Pocket doesn't have on the screen (a teammate's new task, a row whose parent's card went)
  still appears at the next load.
- A hold on Today keeps its gap and Undo (`today-moves.md`). It is the one deliberate move that lands at once.

## How

1. **One `placeOf(t)` per screen**, used at load and at regroup:
   - Today: `dayGroup`; done and `doneByMe` → Done today; out of Today when 8 or more days ahead; no date → "Added
     today, no date" only when created today, else off Today.
   - A project: by `project_id` and `done`.
   - Search: by `done`.
   - Checklists: Open or Finished.

   It replaces `pendingPlace`, the destination in `searchGroups`, `intoDoneToday`, and the choice of group in
   `regroupToday` and `placeOnToday`. Remove the `|| week` fallback in `placeDated`.

2. **The regroup is a step, not a getter.** It splices only the moved tasks into `view.groups`, so `listGroups` reads
   what it reads now and returns the same group object for an unchanged group (`sameGroup`, rule 10).
3. **Card places** (`view.cards`, `heads`, `doneByMe`, the claimed undated steps) are worked out by the same step, so
   a new card, an unlinked subtask and a claim follow the rule.
4. **Save the screen after a regroup** (`keepScreen(…, false)`), so a saved screen opens as last shown.
5. **Hold the reload's group swap and `settle` while a finger is down**, as the batch is held.

## Tests

- `ticks.test.mjs`: an untick in Done today is marked open and moves into its Today group when the batch clears, not
  before, and not while a finger is down. A reopen in Finished moves to Open.
- `reschedule.test.mjs`: an offline date change to 10 days ahead leaves Today; one to no date leaves Today unless the
  task was created today. The minute tick doesn't put either into Next 7 days.
- `lists.test.mjs`: a project move leaves the old project with the batch, offline too. A finished checklist appears
  under Finished.
- `cards.test.mjs`: an unlinked subtask gets its own row with the batch. A subtask added makes its parent a card.
- A reload whose answer arrives while a finger is down swaps groups only once the finger lifts.
- Rule 10: `npm run perf:rows -- counts` before and after. A tick still redraws only its row and its group's count.
