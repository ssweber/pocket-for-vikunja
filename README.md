# Pocket for Vikunja

A focused phone client for [Vikunja](https://vikunja.io): today's tasks and fast capture, nothing else. It's one static `index.html` (no build step, no dependencies) that installs as a PWA on iOS and Android.

## What it does

- **Today**: overdue, due today and the next 7 days, grouped and sorted.
- **Projects**: the project tree with favorites; open or done tasks per project.
- **Quick add** from the bar at the bottom, with inline syntax:

  | Type | Meaning |
  |---|---|
  | `+project` or `+"Two words"` | project (exact or prefix match) |
  | `*label` | label (created if missing) |
  | `!1` … `!5` | priority |
  | `today` `tonight` `tomorrow` `next week` `friday` `in 3 days` `in 2 weeks` | due date |
  | `at 5pm` / `at 17:30` | due time (after a date) |

  Example: `Call Ana tomorrow at 10am +Sales !3 *phone`

- **Task sheet**: title, due date, project, priority, labels, notes, attachments and comments. Also mark done (repeating tasks roll forward) and delete.
- **Deep link**: `…/#/add?text=Buy+milk+friday` opens with the capture box filled in. Useful from an iOS Shortcut or a bookmark.

## Signing in

Enter the Vikunja address, then either:

- **Password**: for servers with local or LDAP accounts. The session refreshes itself.
- **API token**: for everything else, including OIDC-only servers. Create the token in Vikunja under *Settings → API Tokens* with read and write on projects, tasks, labels and comments, plus `user`.

You can pre-fill the address with `?server=https://tasks.example.com`. The server and token are stored in the browser's `localStorage` on that device only.

## Hosting

Serve the files from any static host over HTTPS. The one requirement is **CORS**: the browser calls the Vikunja API directly, so Vikunja must allow the origin Pocket is served from.

- **Separate origin** (for example a Cloudron *Surfer* app at `pocket.example.com`): add that origin to Vikunja's config and restart Vikunja:

  ```yaml
  cors:
    enable: true
    origins:
      - https://pocket.example.com
  ```

  A different subdomain of the same domain is still a different origin, so it has to be listed.

- **Same origin as Vikunja**: no CORS change is needed. The files must be served from under Vikunja's own host, though, so this depends on how Vikunja is deployed.

If the app says it "can't reach" the server but Vikunja opens fine in the browser, CORS is almost always the cause.

## Development

```sh
python -m http.server 8000      # then open http://localhost:8000
```

`http://localhost:8000` must be in Vikunja's `cors.origins` for local testing.

### Smoke test

`tests/smoke.mjs` drives the real app in a headless browser against a real server. It signs in with a token, then quick-adds a task with a date, priority and label, comments on it, edits it, completes it and deletes it. It also checks the Projects view and the `#/add` deep link. It cleans up the task and label it created.

```sh
npm install
npx playwright install chromium   # or set BROWSER_CHANNEL=msedge / chrome
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
```

Use a test account or a token you don't mind writing to. Never commit tokens.
