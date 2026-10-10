# Fast with long lists

Pocket loads each screen's whole list and draws every row. Measured on 2026-10-09 (`scratchpad/perf/FINDINGS.md`)
with 600 open tasks and 3,000 done in one project, on a desktop CPU (a phone is about 4 times slower): opening Today
from its kept copy took 10.4 s to be fresh, Today to the project 36.8 s, its Done section 11.3 s. Nearly all of it is
the phone working, not the network: code that does work for the whole list once for each row. This plan removes that
work, draws the first screenful first, opens without waiting on the network, and fetches lists in fewer round trips.
Nothing here changes what a screen shows.

## How to work

- Every decision here is settled (the user, 2026-10-09). Stop to ask only when the code shows something this plan
  didn't expect. Say what you found, with file and line, and what you recommend.
- Read `AGENTS.md`, `docs/development.md` (with its **Gotchas**), `docs/roadmap.md` and `scratchpad/perf/FINDINGS.md`
  first.
- **Measure every part, before and after**, with the harness in `scratchpad/perf/` (its FINDINGS says how), and put the
  numbers in the commit message's body and your report. A part that doesn't make a measured difference isn't kept.
- Build one part at a time, in order. For each part: keep `npm run lint`, `npm run test:unit` and `npm run test:parse`
  green (unit tests for what changed go with it), run `npm run build`, and commit it locally (src with the built page).
  The end-to-end tests and `npm run test:local` run once, in the last part (the user, 2026-10-09: the work is mostly not
  on screen). Don't push.
- **Never kill processes by name** (`taskkill /IM`, `pkill`): that once closed the user's own Chrome. Stop only
  processes you started, by their PID. Never `npm run build` while tests run.

## 1. Alpine's scheduler

Alpine 3.17.4 (and its main branch, `packages/alpinejs/src/scheduler.js`) runs reactive updates from a queue that is
quadratic in three places: before each job of a flush it sorts the rest of the queue again whenever an `x-for`/`x-if`
job was queued meanwhile, working out each element's depth afresh for every sort; `queueJob` checks
`queue.includes(job)`; `dequeueJob` finds the job with `indexOf`. Each row has about ten nested `x-for`/`x-if`, so a
long list makes thousands of sorts: 56% of the project screen's time.

- Pocket ships its own copy of Alpine, so the fix goes in that copy: a Set for the jobs queued; during a flush, a
  structural job inserted in its place by binary search after its equals (what the stable sort did), so the queue stays
  sorted; depths kept for the whole flush; dequeueing without a linear search. The order jobs run in stays the same.
  `scratchpad/perf/patch-alpine.mjs` is the version measured (9.9 s → 4.65 s); the dequeue part is new.
- The patched file gets a new name (`alpine-3.17.4-pocket.1.min.js`, say): `sw.js` keeps the libraries by name, so a
  changed file under the old name would never reach an installed Pocket.
- Alpine's readable build is kept in `src/vendor/`, committed first as published and then patched in its own commit,
  each change marked; `npm run build` minifies it into `pocket/app/`. An upgrade replaces the file and redoes the changes.
- Later, the user's call: offer the fix to Alpine upstream.

## 2. Work done once, not per row

- `checklistProjects` and `checklistIds` (`app/checklists.js`) are getters, worked out on every call, and are called
  for every row (`isRunTask`, `isChecklistProject`); each call parses every project's description as HTML. Work them
  out once when the projects change.
- Then profile Today and the project again (`scratchpad/perf/prof.mjs` with an unminified build) and do the same for
  any other getter or helper that does whole-list work per row (`listGroups`, `waitingByTask`, …). List what you
  changed, with the numbers.

## 3. Rows leaving after a load

- `settle` (`app/views.js`) finds each row that's gone with its own `querySelectorAll` over the page: 12 s when 2,000
  rows go. Find them in one pass.
- `collapse` sets a style and reads `offsetHeight` for each row, a layout of the page each time: 3.5 s for 2,000 rows.
  Read every height first, then start the animations. And fold away only rows that are on screen, and only a few
  (as a tick's does); when many go at once, or they're off screen, they simply go.

## 4. A project's kept copy and its Done section

- A bug: the kept copy of a project reopens Done as it was when the copy was saved, not as it is now
  (`doneOpen`). Open Done in a long project, close it, come back: the copy draws every done row, then the fresh load
  folds each one away. The copy opens Done only if it's open now.
- The kept copy stores every done task loaded (localStorage, about 5 MB for everything, and a save that doesn't fit
  fails silently). Keep only Done's count in the copy; its tasks are loaded when it's opened, as now.

## 5. The first screenful first

A screen draws its first rows (about 20, enough to fill a phone) at once, and the rest in small batches, a frame's
worth at a time, after the first paint. So the first screen takes the same time however long the list is.

- Each list on a screen draws `g.tasks` up to a count kept per screen, raised a batch at a time until all are drawn,
  across a screen's lists in order (Today's Overdue, then Today, …). The loops are keyed by task id, so a longer slice
  only adds rows.
- Scrolling near the end of what's drawn draws the rest at once, so the end of a list is never mistaken for the end.
- While rows are still to be drawn, the screen counts as busy (`#view[aria-busy]`), so the tests' `loaded()` waits
  for them; anything that needs every row (dragging a row to the far end, `settle`, the hint) waits too or draws the
  rest first.
- Loading a screen afresh over its kept copy keeps the same task object where Vikunja's `updated` is the same, so a
  row whose task didn't change does no work.
- Done (2,000 rows: 4.5 s after parts 1–3) is drawn the same way when opened.

## 6. Opening without waiting

- **Kept screen first** (the user: yes, same sign-in only). `boot` (`app/auth.js`) shows the kept copy of the screen
  before asking Vikunja for `/user` and the projects, when the session's token is the one Pocket last confirmed as
  this person's (kept with the copies); then checks `/user` behind it and loads as now. If the person turns out to be
  someone else, everything kept is cleared at once, as now. Any other token waits as now.
- **The saved page first** (the user: yes). `sw.js` answers opening Pocket from the page it saved, and fetches the page
  behind it to save for next time; `updateIfNew` already reloads into a new version when you're not busy. Bump
  `CACHE`, and keep a 5xx or an offline open working as now.
- **A pre-compressed page from the plugin** (the user: yes). The build also writes `index.html.br` and
  `index.html.gz`; `serve` (`pocket/main.go`) sends the one the browser accepts, with `Vary: Accept-Encoding`, and the
  page as now otherwise. Still only serves files. CI's check that the page is the build of `src/` covers them too.

## 7. Fewer round trips

- `allPages` (`api.js`) asks for page 1, then all the rest at once, at the server's `max_items_per_page` from `/info`
  (50 if it doesn't say). Measured: 690 open tasks 1.5 s → 0.3 s, 3,000 done 7.5 s → 0.4 s.
- No more silent stop at 40 pages: a list is read to its end.
- The README's `config.yml` block gets `service: maxitemsperpage: 500`, with the line about an existing `service:`
  section and the environment variable as a footnote (agreed 2026-10-09):

  ```yaml
  service:
    maxitemsperpage: 500   # Pocket loads a long list in fewer requests; Vikunja's web app is unaffected
  ```

### 5b. The rest in batches of about a second (the user, 2026-10-10)

Measured after part 5: on a phone, every frame has a fixed cost to lay out and paint the page, growing with the rows
on it, so a batch a frame made drawing everything slower than before (Done 45 s → up to 67 s). Drawing the rest in
one go was fastest but leaves the screen deaf to taps for seconds once it looks ready. The user chose: the first 20
rows at once, frame batches up to about 3 screens (60 rows), then batches of about a second each, so a tap or a scroll
is answered within about a second. The scroll trigger and the draw-the-rest before a held row moves stay as guards.

## 9. Done shows its latest 100 (the user, 2026-10-10)

Since part 7 a project's Done reads every done task (no 40-page stop): 3,000 rows, about 100 s to draw on a slow
phone. Nobody scrolls through them; they come to tick one back or to check something was done lately.

- A project's Done shows the 100 tasks done most recently (as now, the most recently done first). Its heading keeps
  the whole count, "Done (3,000)".
- At its end, a row to tap, which loads and shows the next 100:

  ```
   Done (3,000)                          ⌃
   ─────────────────────────────────────────
   ☑ restock price #2,991            Oct 9
   ☑ ...      100 rows, done most recently
   ☑ pack invoice #2,892             Sep 2
   ─────────────────────────────────────────
      Show 100 more, done before these
      2,900 more not shown
  ```

  The second line says how many are left (fewer than 100 left: "Show the last 12, done before these"); with none
  left, no row. It's a tap, so rule 3 holds; rows in Done act as rows do everywhere (rule 4).
- Reading: the first 100 with one request (`per_page` 100, or as many pages as the server's limit needs), the next 100
  on the tap. The count comes from Vikunja's `total`, as Done's count does now.
- Each visit to the project starts again at 100. A task ticked back leaves Done as now, and the count goes down.
- Search's done matches (now the 50 most recently done, with no way to see more) get the same row at their end, 50 at
  a time as now.
- What's shared or copied from a project (`share.js`) says what the screen shows (rule 9): check how it treats Done.

## 8. Tests, docs and the harness

- End-to-end tests for what changed, in the file for each area: the kept copy of a project with Done closed after it
  was open; a screen's rows all there after the batches; Pocket opening on its kept screen with Vikunja slow to answer.
  Then the full `npm run test:local`, and fix what fails.
- `development.md`: the patched Alpine, both patches (the scheduler, part 1; x-for keeping the keys and scopes of the
  items at the start of a list that are where they were, part 5) and its script, drawing in batches (for whoever adds a
  list: hand x-for the list unwatched, keyed by a path into the item), and how to measure.
- The harness moves from `scratchpad/perf/` to `scripts/perf/` with an `npm run perf`, so a change can be measured
  later: its numbers, before this plan and after, in `development.md` or the harness's README.

## Not doing

- A faster replacement for Alpine: none is maintained, and Alpine already uses Vue's current reactivity.
- Virtual scrolling: no Alpine plugin, and a generic one fights dragging rows, folding them, and the code that
  measures them. Part 5 gets the first screen without it.
- The plugin compressing Vikunja's API replies: the user's nginx already does.
- Kept copies in IndexedDB: only if they're measured near the storage limit after part 4.

## Build order

1–4 (one agent, a commit each), then 5, then 6–7, then 5b, then 9, then 8.
