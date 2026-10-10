# Measuring Pocket

How long Pocket takes with long lists, in a real browser against a Vikunja of its own, so a change can be measured
before and after. Everything these scripts keep (the seeded Vikunja's token, browser profiles, results, profiles) goes
in `test-results/perf/`, which git ignores. They need Docker and Chrome (`BROWSER_CHANNEL=msedge` for Edge).

```sh
node scripts/perf/up.mjs --seed M          # a fresh Vikunja on 127.0.0.1:3470, seeded, with Pocket as at HEAD
npm run perf                               # the app benchmark: fast, 3 runs
npm run perf -- --profile phone --runs 2   # as on a phone: slow, so fewer runs
node scripts/perf/up.mjs --at b884d9a      # the same data, Pocket as at another commit, to compare
```

- `up.mjs`: the Vikunja (containers `pocket-perf` and `pocket-perf-db`, apart from `npm run dev`'s `pocket-dev`).
  `--seed S|M|L` starts it afresh and seeds user `perf`: a project, Big, with 150 open tasks and 500 done (S), 600 and
  3,000 (M) or 2,000 and 8,000 (L), a twentieth of the open ones overdue, a twentieth due in the next 8 days, every
  twentieth a parent of 3 subtasks, a tenth labelled, a third with long notes; and Errands, with 25. Due dates are from
  the day it's seeded, so Today's lists change as the days go by: seed again before comparing on another day. Without
  `--seed` it restarts only Vikunja, keeping the data: with Pocket as at a commit (`--at`, HEAD if not given, from
  `git archive`, so what's being edited doesn't count), or from a folder as it is (`--plugin`); and `--maxpp` sets
  Vikunja's `max_items_per_page` (50, its default, unless given).
- `app-bench.mjs` (`npm run perf`): signs in, opens Big once (so it's the project kept), and then, for each run, times
  four steps: opening Pocket on Today with the copy kept of it; the same without the copy (a first opening); Today to
  Big; and Big's Done opened. Each step's `rows` is when its first row is in the page and `fresh` when it's loaded from
  Vikunja with every row drawn, in ms from the step's start, the median of the runs, with how many API requests and KB
  it took. `--profile fast` (the computer as it is), `phone` (CPU 4 times slower, 100 ms round trips, 5 Mbps, behind a
  proxy that gzips as nginx does and passes on the plugin's compressed page), `phone-raw` (no compression), `weak` (CPU
  4x, 300 ms, 1 Mbps). `--label` names the results file, `test-results/perf/results/<label>.json`.
- `proxy.mjs`: what app-bench puts between the browser and Vikunja, for the profiles' network.
- `api-bench.mjs`: how long reading Big's open and done tasks takes, page by page or the rest at once, at each page
  size (`--per 50,500`), through the proxy (`--rtt`, `--kbps`, `--gzip`).
- `prof.mjs big|done|today`: a CPU profile of one step, with the time it spent in each function (`agg.mjs`, which
  totals a saved `.cpuprofile` again; `--mine` for Pocket's own functions only). Pocket's page is minified, so for
  names worth reading run Vikunja on an unminified build: copy `src/`, `scripts/`, `pocket/` and `package.json` to a
  folder in `test-results/perf/`, set `minify: false` in that copy's `scripts/build.mjs` `js()` (not `css()`), run
  `node <copy>/scripts/build.mjs`, then `node scripts/perf/up.mjs --plugin <copy>/pocket`.

Timings vary from run to run by a tenth or so, more on the phone profile, and with whatever else the computer is doing:
compare two versions back to back, on the same seed, and look at the runs as well as the median.

## The performance round, 2026-10-09 and 10

`docs/design/performance-plan.md`, measured on 2026-10-10 back to back on a fresh seed M (Big: 660 open tasks, 30 of
them subtasks, and 3,000 done; Today 506 rows, as every undated task was made today), Vikunja 2.7.0 on Postgres with
`max_items_per_page` 50, through `up.mjs --at`: before the round (8307355), after its parts 1 to 4 (b884d9a), and
after it (HEAD, e28bc07: Pocket as at dcabdeb). Milliseconds from the start of each step to its first row / to fresh,
every row drawn; fast the median of 3 runs, phone the slower of 2.

| Step                   | fast, 8307355   | fast, b884d9a | fast, HEAD | phone, b884d9a  | phone, HEAD    |
|------------------------|-----------------|---------------|------------|-----------------|----------------|
| Open Today (kept copy) | 1,533 / 10,052  | 1,051 / 2,131 | 204 / 2,145 | 12,446 / 25,712 | 2,362 / 25,244 |
| Open Today (no copy)   | 1,853 / 1,853   | 1,355 / 1,355 | 381 / 1,437 | 15,827 / 15,827 | 3,324 / 17,846 |
| Today -> Big           | 5,458 / 33,818  | 1,248 / 2,636 | 220 / 1,904 | 16,217 / 31,673 | 1,947 / 23,599 |
| Open Done              | 10,883 / 10,883 | 3,852 / 3,852 | 120 / 236   | 48,216 / 48,216 | 1,331 / 3,229  |

Open Done draws 2,000 done rows (where reading stopped, at 40 pages) from 40 requests (1,591 KB; 82 KB gzipped on the
phone) before part 9, and its latest 100 from 2 (79 KB; 4 KB) after. The first screenful (rows) comes 5 to 36 times sooner on the phone; everything drawn
on Today takes as long as before, or 2 s longer without a copy, as the rest is drawn in batches of about a second
that leave taps answered between them (part 5b).

`api-bench.mjs` on the same seed, no network slowing, 50 a page: Big's open tasks one page after another 380 ms, the
rest at once 107 ms; its 3,000 done 982 ms and 167 ms.
