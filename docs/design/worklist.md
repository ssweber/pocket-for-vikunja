# Worklist

The open items from the roadmap, the Pocket project in Vikunja, a code review of v0.2.0 and a look at why Pocket
opens slowly. They are built one at a time, in this order. Tick an item in the commit that finishes it. `npm run
test:local` runs at the end of each batch. Delete this file when every item is ticked or moved back to the roadmap.

The code review and the loading look were done by other sessions. Check each claim in the code before fixing it. A
claim that turns out wrong is noted here and dropped.

## Batch 1: fixes

- [x] **A failed update check reloads the page.** After a network failure or a 502, `sw.js` answers with the cached
  page and a 200, and `updateIfNew()` reloads on any 200. Reload only when the server sent a different build. Compare
  a build id written by `scripts/build.mjs` rather than file times.
- [x] **`relayClaim` reads any INSERT error as "key already taken".** If `pocket_relay` is missing, every write gets
  a 409 with Retry-After, the phone waits for good, and the server logs nothing. When `relayGet` then finds no row,
  log the INSERT error and answer 500.
- [x] **The relay prunes old keys before every write.** The `DELETE … WHERE created < ?` has no index on `created`,
  and on SQLite it doubles the write locks per request. Prune at most once a minute and add the index.
- [x] **The relay doesn't check its path for `..`.** `"/api/v2/" + c.Param("*")` goes to Vikunja as it is. Refuse a
  path with a `..` segment.
- [x] **The tests need Node 24, and nothing says so.** On Node 22, 19 unit tests fail, among them "each request
  reaches Vikunja at most once for each key". The fake IndexedDB in `tests/unit/outbox-db.mjs` finishes transactions
  on microtasks, so the result depends on V8's ordering. Real IndexedDB finishes them on tasks. Make the fake finish
  on tasks, so the tests pass on Node 22 and 24, and add `"engines": { "node": ">=24" }` only if they still need it.
  If a real bug shows up, fix it as its own commit. The main cause was Web Locks: Node 22 has none, and Node 24's
  calls a free lock's holder at once. The tests now use a fake that grants locks as a browser does.
- [x] **`Retry-After` and `default_due_time`.** Honour a 429's `Retry-After`, which the relay must pass on too.
  Accept `default_due_time` only as `HH:MM`.
- [x] **The model test fails at seed 616988444.** Path `350:3:4:11:11:15:24:24:17:17:17:18:21:21:21`: StepMade,
  Queue done, Reload(lost), Send, Sheet assign, Queue add, Queue delete, Reload(lost). It breaks check 5, "1's copy
  took a read that ran while another write to it was in flight". It fails on the code before the fake IndexedDB
  changed, too. The bug was in the test. `settle()` counted database requests only, so it stopped while the next
  op in line for the outbox lock was about to send.
- [x] **The waiting message names the time of the next try.** "Waiting for Vikunja. Pocket tries again every 30
  seconds." is wrong after a 429's `Retry-After`. Make it "Waiting for Vikunja. Pocket tries again at 3:42 PM.",
  with the end of the wait or the next 30-second send, whichever is later.
- [x] **A monthly repeat's next date no longer matches Vikunja 2.7.1** (go-vikunja/vikunja#4107). Vikunja 2.7.1
  clamps the day when it moves a monthly task on (Jan 31 → Feb 28). `addMonths` in `src/js/checklists.js` still
  overflows (Jan 31 → Mar 3), so `vikunjaNext` guesses wrong for a task due on the 29th, 30th or 31st. The "next …"
  message after a tick and the Start sheet's note show the wrong date. The catch-up in `ops/runs.js` never matches,
  so a monthly template left for months stays late. Undo and Cancel of a start whose reply was lost think the tick
  never happened. Clamp the day, say 2.7.1 in both comments, and add a Jan 31 case beside the mid-month one in
  `tests/parse.mjs`. Move the test Vikunja (`scripts/dev.mjs`, `scripts/perf/up.mjs`, `docs/development.md`) to
  2.7.1, or the e2e tests compare against the old behaviour.

## Batch 2: import cycles

No change in behaviour. The tests pass before and after.

- [x] **One import cycle runs through all of `ops/` and `app/tasks.js`.** The ops import `TASK`, `MOVED` and `opsId`
  from the store, and the store imports `ops/index.js`. Move `TASK`, the `TASK_*` lists, `MOVED` and `opsId` into a
  small module of their own, and move `DEFAULTS` out of `ops/index.js`, which `ops/comments.js` imports back. Then
  delete the "import an op's helpers from here" warning in `ops/index.js`, and add a lint rule or test that fails on
  a new cycle.
- [x] **A small cycle between `api.js`, `messages.js` and `checklists.js`.** Break it the same way, if the result is
  simpler.

## Batch 3: opening Pocket

The steps below make Pocket open faster from its saved screen. A timing trace from the phone shows which of them
matters there.

- [x] **The outbox holds up the saved Today.** `auth.js` waits up to 3 seconds for `sync.ready` before it shows saved
  tasks. Find out what the wait protects, then shorten or remove it. The wait kept a row from changing after it was
  drawn, when a waiting change arrived late. `sync.js` now keeps a flag in localStorage that says whether the outbox
  had no entries when last read. The saved screen waits only when the flag doesn't say so.
- [x] **Startup waits for projects after checking the account.** When the token has changed, startup checks `/user`
  and then waits for `loadProjects()`. Show the saved screen as soon as the account is confirmed. It is drawn with the
  saved projects, as it is when the token is the confirmed one.
- [x] **A checklist doesn't open from its saved copy.** `savedView()` leaves checklists out. Opening one fetches the
  parent, then each step, four at a time, and can wait another 600 ms for notes. A checklist opened before now shows
  its saved copy and reloads behind it, without the wait. The steps are still read one request each, because
  Vikunja's task list returns at most 50 comments in all for the tasks it lists.
- [ ] **The Checklists screen may lose finished steps' comments.** It reads finished checklists' steps with one task
  list request and `expand=comments` (`src/js/app/checklists.js`, around line 429). On Vikunja 2.7.1 that request
  returns at most 50 comments across all the tasks it lists, so in a busy project a finished row's skip reasons and
  comment counts can be wrong with no sign. Confirm it in the app, then read comments only for the steps that have
  any (`expand=comment_count`). Add the cap to a draft for Vikunja if it is a bug there.
- [x] **A tick cancelled offline leaves its task hidden.** Seen on the phone. Offline, tick a task on a project
  screen. It leaves the list and waits in the Outbox, and stays ticked after Pocket is closed and opened again.
  Cancel it in the Outbox, still offline. The task doesn't come back, after switching screens or after reopening
  Pocket, until Pocket reaches Vikunja again.
- [x] **A template shows on Today after Set up checklists.** Right after Set up checklists, Today lists "TEMPLATE:
  Example: Opening up" under "Added today, no date", as a 4/4 parent with "All subtasks done" and Close. Today
  leaves templates out. Dropped: the screenshot script closed the browser 2 seconds after the tabs changed, while
  Set up checklists was still sending, and the next browser started with no outbox. So the label and the final tick
  were never sent, and Vikunja kept an open task with no "template" label, which is not a template. With its outbox
  kept, Pocket's Today never shows the example, whether Today is tapped during the setup or after it. The outbox survives closing
  the app and signing out, so the sending finishes when Pocket opens again.
- [x] **A steady header and grey rows while loading.** Agreed with the user from
  `scratchpad/ui-tabs-rows/tabs-and-grey-rows.png` and `headings-44.png`. The CSS and markup there are the start.
  - The header always has the three tabs in the compact layout (`.tabs.icons`), so it no longer changes from two
    tabs to three when `checklistProjects` loads. With no checklist project, Checklists shows its setup card.
  - "Loading…" becomes still grey rows (`.skeleton`, `.skel-row`): two groups of 3 and 5 rows under short heading
    bars, a 28 px outlined circle and one 12 px bar per row, in `color-mix(in srgb, var(--muted) 25%,
    var(--surface))`. They show only when no saved screen is ready. A refresh never replaces rows already shown.
  - `.sec-act` gets a 44 px tap target inside its heading's height (`min-width` and `min-height: 44px`,
    `padding: 12px 2px`, `margin: -12px 0 -12px auto`), as `#btn-copy-done` has, and that rule is deleted. The
    Overdue and "Open project" headings become 21 px, like the others, so every list starts 49 px below the header,
    where the grey rows start.

## Batch 4: features for 0.3.0

Each is discussed, with a picture, before it is built.

- [ ] **The batch waits while date chips are open.** Throw a row, then within 3 seconds hold another and let go so
  its chips stay open. When the batch clears the first row's gap, the page shortens, and at the bottom of the page
  the scroll that causes closes the chips. Hold the batch while chips are open, as it is held for a finger.
- [ ] **Filter by label.** Rows don't show their labels today, so that comes first. Then tapping a label on a row
  narrows Today to it. A bar at the top states the rule ("Only *errands · Show all"), and clearing it, or leaving
  Today, shows everything again. One label at a time. Typing `*errands` in search lists every open task with that
  label, wherever it is due, grouped by project.
- [ ] **Notes from the add box.** Text after ` // ` becomes the notes of the task or step. The spaces on both sides
  keep `http://` and file paths in the title.
- [ ] **A minimum time for a step, `!T#`.** `Shape the loaves !T#20m` can't be ticked until 20 minutes after the
  previous step is done. Until then its Done button is dimmed and reads "Waiting 19:42", counting down. Agreed with
  the user: it counts from the same step as `T#`, and `:name` works the same. It is `T#` made strict, so it is also
  due then, chimes at zero, and the plugin writes its due date. Before that step is done, the button reads "Waiting
  for Mix the dough". Every way to tick in Pocket respects it, and Vikunja's web app doesn't, as the guide will say.
  No plain-language form yet. A padlock button in the step's time chip turns it on and off: open and muted when off,
  closed in the accent colour when on. When on, the chip reads "Locked until 20m after the step before". Pocket has
  no lock icon yet, so it gets one in the clock's line style. A picture of the chip and the button comes first.
- [ ] **A long press on "+ me"** offers the project's other people.

## Batch 5: the phone's storage and the test tools

- [ ] **Limit what's saved on the phone.** Drop avatars not refreshed in 30 days. When localStorage is full, delete
  the oldest saved screen and try again.
- [ ] **Test tools.** A `STEP=<regex>` filter for `smoke.mjs`, and a leak check (DOM nodes, Alpine effects, timers)
  after opening the sheet and switching screens many times.
