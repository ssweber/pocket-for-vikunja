# Developing Pocket

```
pocket/        copy this folder into Vikunja's plugins folder
  main.go      the plugin: serves app/ at /api/v1/plugins/pocket/
  app/         the app itself; sw.js lets it open offline
tests/         the four test files described below
scripts/       dev.mjs: a local Vikunja with the plugin loaded
docs/          this file and the README's screenshots
```

All of the app's code is in `pocket/app/index.html`: plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. There's no build step. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

## Running it locally

With Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.6.0 at `http://127.0.0.1:3456`, with the plugin loaded straight from `pocket/` and a mock single sign-on provider, and prints Pocket's address. Sign in as `dev` / `dev-password`, or with **Mock SSO**. Edits to `pocket/app/` show up when you reload; after changing `main.go`, run `npm run dev` again.

## Tests

- `tests/parse.mjs`: how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests, and how pasted lists lose their bullets and checkboxes. It needs no server and runs in a few seconds.
- `tests/smoke.mjs`: Pocket in a headless browser against a Vikunja with the plugin. It signs in with a token, then adds, ticks off, sets the progress of, searches for, edits, comments on and deletes tasks, pastes a list with subtasks, attaches a file and a photo, creates a project, assigns someone, and checks the security measures.
- `tests/session.mjs`: Pocket and Vikunja's web app side by side: signing in and out on either side, single sign-on, and renewing an expired sign-in from both at once.
- `tests/offline.mjs`: with the connection cut, Pocket must open with the last-loaded list and queue tasks, then send them once back online without adding any twice. `BROWSER=webkit` runs it on Safari's engine.

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja and runs all four

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

The tests delete what they create, except a `pocket-smoke` label that the end-to-end test reuses on later runs, since Task Management tokens can't delete labels. With a token that can't create projects, the project step is skipped.

## Upgrading the libraries

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag.
