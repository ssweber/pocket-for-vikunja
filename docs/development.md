# Developing Pocket

```
pocket/        copy this folder into Vikunja's plugins folder
  main.go      the plugin: serves app/ at /api/v1/plugins/pocket/
  app/         the app itself; sw.js lets it open offline
tests/         the six test files described below
scripts/       dev.mjs: a local Vikunja with the plugin loaded; demo.mjs: the README's GIFs and screenshots
docs/          this file and the README's screenshots
```

All of the app's code is in `pocket/app/index.html`: plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. There's no build step. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, with the plugin loaded straight from `pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. Sign in as `dev` / `dev-password`, or with **Mock SSO**. Edits to `pocket/app/` show up when you reload; after changing `main.go`, run `npm run dev` again.

## Tests

- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, and how pasted lists lose their bullets and checkboxes. It needs no server and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side, single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), moves over what an older Pocket left waiting, and has two tabs send the same waiting task. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (rows typed with Enter, times in words, a step to count from, a row moved), moves a step, starts runs (for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too), ticks, skips, unticks and adds notes, finishes a run and checks the next one's Last time, and undoes a start. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
- `tests/steptimes.mjs`: the plugin's step times, through the API only, so it needs a Vikunja with them on (`npm run test:local` turns them on). It sets up a template and two runs as Pocket does, then checks that a tick sets the due dates of the steps timed from it, chained and from a name; that the other run, a template marked done, a done step saved again or labelled, and a step marked not done change nothing; that a step done early counts from when it was done; and that a tick from the web app works too.

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja and runs all six

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

The tests delete what they create, except a `pocket-smoke` label that the end-to-end test reuses on later runs, and the `template` label of the checklists test, since Task Management tokens can't delete labels. The checklists test needs a token that can create and update projects and add reactions. With a token that can't create projects, the project step is skipped.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with made-up tasks for two users of its own, `alex` and `priya`, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag.
