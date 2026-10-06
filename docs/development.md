# Developing Pocket

```
src/           the app's code, which npm run build makes into pocket/app/index.html
  index.html   the page, with the markup's pieces included from markup/
  markup/      the sign-in screen, the app and its screens, the sheet and each kind of sheet
  styles.css   all of the CSS
  js/          main.js, where the code starts; the helpers; and app/, the parts of the Alpine component
pocket/        the plugin, as it's installed in Vikunja's plugins folder
  main.go      serves app/ at /api/v1/plugins/pocket/
  app/         the built app, the libraries it uses, and sw.js, which lets it open offline
tests/         the six test files described below
scripts/       build.mjs: the build; dev.mjs: a local Vikunja with the plugin loaded; demo.mjs: the README's GIFs and
               screenshots
.github/       CI on pull requests and main, and the zip attached to each release
docs/          this file, guide.md (everything the README leaves out), the screenshots, design/ (feature plans) and
               roadmap.md: how the code and the way we work on it will change
  design/      plans for features, written before building them
```

The app is plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. It's written in `src/`, and `npm run build` puts it all into one file, `pocket/app/index.html` (with `pocket.js.map` next to it, so the browser's developer tools show the code as it's written in `src/`). Both are committed, so the `pocket` folder works as it is. Edit `src/`, never `pocket/app/`'s copy: CI checks that it's the build of `src/`. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

The JavaScript is ES modules, each importing what it uses. The helpers in `src/js/` know nothing of the screen. The Alpine component, `pocket`, is one object: `app/core.js` has its data and what happens when Pocket opens, and each other file in `app/` adds its methods, put together in `main.js`. In those methods, `this` is the component, so any of them can call any other. A few things to know:

- A module can't assign to another module's variable. A variable lives in the module that changes it; the few that several parts change are properties of `shared`, in `app/core.js`.
- The markup's Alpine expressions see the component's data and methods, and the few helpers `main.js` makes globals. A helper used in the markup has to be added there.
- `npm run lint` (ESLint) catches a name that isn't defined or imported, and a variable that's never used. CI runs it.

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.7.0 at `http://127.0.0.1:3456`, with the plugin loaded straight from `pocket/`, its step times on, and a mock single sign-on provider, and prints Pocket's address. Sign in as `dev` / `dev-password`, or with **Mock SSO**. It keeps building the page as `src/` changes, so edits show up when you reload, until you stop it with Ctrl+C (Vikunja keeps running). After changing `main.go`, run `npm run dev` again.

## Tests

- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, how pasted lists lose their bullets and checkboxes, how checklist steps are read, and a template's order line. It loads `src/js/quickadd.js` and `src/js/checklists.js` as they are, so it needs no build and no server, and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, adds subtasks in the sheet with quick add's chips, claims one and lets it go, moves a task to Overdue as its time passes (waiting for an Undo still showing to say so), adds and removes reminders in the sheet (keeping those changed elsewhere meanwhile), offers the 🔔 chip only for a time and only when reminder emails reach you, ticks off a parent and its subtasks with it, adds quick ticks up into one Undo, takes the top suggestion on Enter, reads a bare hour as daytime and warns of a repeat Vikunja can't do, closes a sheet with the phone's Back and keeps the draft through a reload, moves a ticked search result to Done, keeps notes and a comment being written when the sheet closes, doesn't write over notes changed elsewhere meanwhile, adds a label with Enter and a suggested person, undoes a repeating tick (its reminder at a set time too), ticks one whose reply is lost, leaves a repeating subtask alone when its parent is ticked, moves and deletes a task with its subtasks, renames and deletes a project from its ⋯, attaches a file and a photo, creates a project, assigns someone, loads a new version of Pocket on refresh, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side (keeping what was being written when Vikunja signs you out), single sign-on, renewing an expired sign-in from both at once, and following a switch to another account.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks and photos, then send them once back online without adding any twice. It also cuts the connection mid-upload and between a task and its label, loses replies (for a task with an @username, with `ASSIGNEE`, and for a subtask link), answers 500, fills up Pocket's storage, adds the same title twice (in Pocket, and on the web then in Pocket), adds a subtask and a comment in a sheet offline, puts a cancelled task's words back in the box, moves over what an older Pocket left waiting, and has two tabs send the same waiting task. `BROWSER=webkit` runs it on Safari's engine.
- `tests/checklists.mjs`: checklists end to end, in a project of its own. It uses the project for checklists, makes a template with New template (rows typed with Enter, times in words, a step to count from, a row moved, and Make again after a step's reply is lost), moves a step (only its order line is written, the order stays after a reload, a move cut off goes back, one whose reply is lost stays, and notes and moves saved elsewhere meanwhile are kept), starts runs (a template changed after a start leaves the run as it was; for you, and with `OTHER_USER` for someone else, whose Today and Checklists tab it checks too, with a step of yours they've claimed), ticks, skips, unticks and adds notes, ticks a step whose ✅ is refused, does again a step someone else skipped, claims a step and lets it go (online, offline, and someone else's, which Done still works on), checks that a timed step gets a reminder and that a countdown alerts once at zero, checks that a run has no tick on Today and that a step ticked there gets a ✅, opens a run and a step from Today and from the run's sheet, keeps a note with its step, sends a note typed before Done, finishes a run and checks the next one's Last time, undoes a start, and names a run when starting it, renames and reassigns it from its ⋯, opens the finished run from Last time, then deletes it, cancels a start that waits, and one whose run was copied without a connection after, reads a step's time counted from a step named in words, goes Back from a project to Checklists, and changes, removes and deletes a template's steps. It checks timed steps: a move refused for counting from a later step, steps added to a template from a pasted list with one refused for an unknown step and a reply lost, and countdowns on the run screen. It also starts a run offline, loses the reply to a step's copy and to a note, and ticks a step offline across a reload, counting down from the tick. Last, it makes a project for checklists with New project.
- `tests/steptimes.mjs`: the plugin's step times, through the API only, so it needs a Vikunja with them on (`npm run test:local` turns them on). It sets up a template and two runs as Pocket does, then checks that a tick sets the due dates of the steps timed from it, chained and from a name, and moves their reminders with them; that the other run, a template marked done, a done step saved again or labelled change nothing; that a step marked not done takes the due date off the steps waiting on it; that a step done early counts from when it was done; that a run's steps go in the order they were copied, whatever order they're linked in; that a tick from the web app works too; and that a run keeps its steps' times when its template is changed or deleted, while one started before runs kept them reads its template.

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run lint                       # mistakes ESLint can see
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja and runs all six

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

The tests delete what they create, except a `pocket-smoke` label that the end-to-end test reuses on later runs, and the `template` label of the checklists test, since Task Management tokens can't delete labels. The checklists test needs a token that can create and update projects and add reactions. With a token that can't create projects, the project step is skipped.

## The README's GIF and screenshots

With `npm run dev` running, `npm run demo` remakes `docs/screenshots/pocket-demo.gif`, `pocket-checklist.gif` and the screenshots of Pocket and of Vikunja's web app. It drives the real app in a phone-sized browser, with a small café's made-up tasks and checklists for two users of its own, `alex`, who owns it, and `priya`, the shift lead, and the page's clock fixed at Wednesday 30 September 2026, 10:05, so the dates in the pictures always match the README. New examples in the README and the guide follow the same café. Run it after changing how Pocket looks. `FRAMES=<folder>` also saves the GIFs' frames as images, to check them one by one.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag in `src/index.html`.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag in `src/index.html`.
