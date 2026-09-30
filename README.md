# Pocket for Vikunja

A single-file mobile web app for [Vikunja](https://vikunja.io), served by Vikunja itself.

Vikunja's web app works on a phone, but it's built for a bigger screen. Pocket is a small companion for what you usually need on the go: seeing what's due and adding a task quickly. Everything else stays in Vikunja.

<table>
  <tr>
    <th>Vikunja's web app</th>
    <th>Pocket</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/vikunja-home.png" width="260" alt="Vikunja's home screen on a phone"></td>
    <td><img src="docs/screenshots/pocket-today.png" width="260" alt="Pocket's Today screen, grouped into Overdue, Today and Next 7 days"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/vikunja-task.png" width="260" alt="A task in Vikunja's web app on a phone"></td>
    <td><img src="docs/screenshots/pocket-task.png" width="260" alt="The same task in Pocket's task sheet"></td>
  </tr>
</table>

<sub>Same account, same tasks, same phone-sized screen.</sub>

## What you get

- **Today:** tasks grouped into Overdue, Today and Next 7 days. Tick one off and it slides away, with an Undo.
- **Quick add:** type a task in one line with a date, project, priority, labels and people. Chips under the box show what will be saved before you send it.
- **Paste a list:** paste lines from an email or a note and each one becomes a task. Bullets, numbering and checkboxes are removed, and one tap makes the rest subtasks of the first line.
- **Task details:** due date, repeat, project, priority, who it's assigned to, labels, notes, subtasks, attachments and comments. Changes save as you make them, and you can add subtasks one at a time or paste a list.
- **Projects:** your project tree with favorites, and open or done tasks for each project.
- **Works offline:** Pocket opens without a connection and shows your lists as they were last loaded. Tasks you add appear in your list, lightly tinted with a dashed circle, until they reach Vikunja once you're back online. A connection that drops halfway doesn't add them twice.
- **An app on your home screen:** installs on iOS and Android and follows the phone's light or dark mode.
- **A shortcut link:** opening `…/#/add?text=Buy+milk` starts a task with the text filled in, handy from an iOS Shortcut or a bookmark.

### Quick add

Pocket understands the prefixes and phrases from Vikunja's [Quick Add Magic](https://vikunja.io/help/quick-add-magic/) (in its default mode). As you type, chips show what will be saved. If Pocket reads something you didn't mean, like `3/4 inch` as March 4, tap the chip and those words stay in the title.

<img src="docs/screenshots/pocket-capture.png" width="390" alt="Typing 'Call Ana Friday at 10 +work !3' shows chips for Work, Friday 10:00 AM and Priority 3">

| Type | Sets |
|---|---|
| `+work` or `+"Side project"` | Project (its full name or the start of it). If there's no such project, tap **Create project** under the box to make it. |
| `*calls` or `*"follow up"` | Label (created if it doesn't exist) |
| `@sarah` | Assignee (their username; it stays in the title, as in Vikunja) |
| `!1` to `!5` | Priority |
| `today`, `tonight`, `tomorrow`, `this weekend`, `later this week`, `next week`, `next month`, `end of month` | Due date |
| `friday` or `fri`, `next monday`, `in 3 days`, `in 2 hours` | Due date |
| `Oct 12`, `21st June`, `2026-10-12`, `10/12`, `01.02`, `17th` | Due date. Numbers-only dates and a bare `17th` count only at the start or end, so "The 9/11 Report" stays as it is. |
| `at 5pm`, `at 17:30`, `@ 3pm` | Due time. Without one, the task is due at your default due time from Vikunja's settings (noon unless you changed it). |
| `every day`, `every 3 days`, `every two weeks`, `every month`, `every year`, `daily`, `weekly`, `biannually` | Repeats. Without a date, it starts at the next due time. |

Wrap the whole text in quotes to turn all of this off: `"Read 1984 by Friday"`.

With more than one line in the box, each line is its own task with its own shortcuts. **↳ Under first line** turns the rest into subtasks of the first.

The phrases and their meanings are taken from Vikunja's own tests, so the same text gives the same task in both apps. Pocket differs on purpose in a few places:

- `every month` repeats on the same day each month. Vikunja's quick add uses every 30 days.
- Dates always mean the next one: in June, `2nd March` is next March. Vikunja sometimes picks the date that has passed.
- `10/12` follows your phone's region (12 October in most places); Vikunja always reads it US-style.
- Pocket also understands `every monday`, `the 17th` anywhere in the text, and drops a word like "by" or "in" along with its date.

Pocket follows your Quick Add Magic setting in Vikunja: the default prefixes above, Todoist-style ones (`#project`, `@label`, `+person`), or none at all. Subtasks marked by indenting aren't supported.

## Setup

Pocket runs as a plugin inside your Vikunja. Vikunja serves it at `https://<your Vikunja>/api/v1/plugins/pocket/`, so there's nothing else to host and nothing to set up besides turning plugins on. It needs Vikunja 2.3 or later, and is tested with 2.6.0.

1. **Copy the `pocket` folder** from this repo into Vikunja's `plugins` folder, so that you have `plugins/pocket/main.go` and `plugins/pocket/app/index.html`.
   - On Cloudron, open the Vikunja app's **File Manager** and put it at `/app/data/plugins/pocket/`. Create the `plugins` folder if it isn't there.
   - Elsewhere, `plugins` goes in Vikunja's root path: `service.rootpath` in its config, or the folder Vikunja runs in.

2. **Turn plugins on** in Vikunja's `config.yml` (`/app/data/config.yml` on Cloudron), then restart Vikunja:

   ```yaml
   plugins:
     enabled: true
     loader: yaegi
   ```

   Vikunja's log should now include `pocket: serving … at /api/v1/plugins/pocket/`.

3. **Open Pocket on your phone** at `https://<your Vikunja>/api/v1/plugins/pocket/` and sign in. Pocket offers whatever your Vikunja does:
   - **Sign in with …** for each single sign-on provider Vikunja is set up with, such as Cloudron's login.
   - **Password**, if your server has local or LDAP accounts.
   - **API token**, as a fallback. In Vikunja, go to *Settings → API Tokens*, choose the **Task Management** preset, and also tick **User** and **Users** under *Other*. *Users* lets Pocket find people by username for `@sarah`. To create projects from quick add, also tick **Create** under *Projects*.

   Single sign-on and password sign-in are shared with Vikunja's own web app on that device: sign in to either and the other is signed in too, and the same goes for signing out. In a browser, single sign-on opens in a new tab that closes by itself when you're done. In the home-screen app it opens in the same window and ends on Vikunja's page; go back to Pocket and it's signed in.

4. **Add it to your home screen** from the browser's Share or menu button.

**Updating:** replace the files in `plugins/pocket/app/` and reload Pocket. Only a changed `main.go` needs a Vikunja restart.

### Troubleshooting

- **Pocket's address shows "not found":** look for lines mentioning `pocket` or `plugin` in Vikunja's log.
  - `couldn't find app/index.html`: the files aren't at `plugins/pocket/app/`.
  - `Failed to load yaegi plugin pocket`: the plugin didn't load, for example because a Vikunja update changed how plugins work. Vikunja itself keeps running.
  - Nothing at all: plugins aren't turned on, or Vikunja hasn't been restarted since.
- **"Too many attempts from here":** Vikunja allows 10 sign-in attempts a minute from one address. Wait a minute.
- **"That token didn't work":** the token has expired, or **User** under *Other* isn't ticked.
- **"Your API token doesn't allow this":** the token is missing a permission, for example **Users** when you use `@name`. Vikunja can't add permissions to an existing token, so create a new one.
- **"This user does not have access to the project":** you can only assign people the project is shared with.

## Privacy and security

- Pocket has no server of its own. Vikunja serves its files, and it only talks to that same Vikunja.
- The plugin only reads the files in its `app/` folder, and it runs inside Vikunja, so read `pocket/main.go` before installing it. It's about 100 lines.
- For offline use, Pocket keeps a copy of the lists it last loaded, and any tasks waiting to be sent, in the browser on that device. Signing out removes them; if tasks are still waiting, Pocket asks first.
- Pocket doesn't keep a sign-in of its own, apart from an API token if you use one. It uses Vikunja's, stored in the browser where Vikunja's web app keeps it, and renews it the way Vikunja does. Signing out removes it. To revoke an API token entirely, delete it in Vikunja.
- Notes and comments are cleaned before they're shown. Attachments other than images, PDFs and plain text are downloaded instead of opened. Together, these stop content from people you share projects with from running code inside Pocket, which shares its web address with Vikunja.

## Development

```
pocket/        copy this folder into Vikunja's plugins folder
  main.go      the plugin: serves app/ at /api/v1/plugins/pocket/
  app/         the app itself (sw.js lets it open offline)
tests/         phrase tests and the end-to-end test
scripts/       dev.mjs: a local Vikunja with the plugin loaded
docs/          screenshots
```

All of the app's code is in `pocket/app/index.html`: plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. There's no build step. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

Both libraries are kept in the repo rather than loaded from a CDN:

- `pocket/app/alpine-<version>.min.js`: to upgrade, download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag.
- `pocket/app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag.

To run it locally, with Docker installed:

```sh
npm install
npm run dev
```

This starts a throwaway Vikunja 2.6.0 at `http://127.0.0.1:3456` with the plugin loaded straight from `pocket/`, plus a mock single sign-on provider, and prints Pocket's address. Sign in as `dev` / `dev-password`, or with **Mock SSO**. Edits to `pocket/app/` show up when you reload; after changing `main.go`, run `npm run dev` again.

### Tests

`tests/parse.mjs` checks how quick add reads about 570 phrases, adapted from Vikunja's Quick Add Magic tests. It needs no server and runs in a few seconds. `tests/smoke.mjs` drives Pocket in a headless browser against a Vikunja with the plugin installed. It signs in with a token, quick-adds, ticks off and undoes, edits, comments, completes and deletes tasks, pastes a list with subtasks, assigns someone, and checks the security measures. `tests/session.mjs` uses Pocket and Vikunja's web app side by side: signing in and out on either side, single sign-on, and renewing an expired sign-in from both at once. `tests/offline.mjs` cuts the connection: Pocket must open with the last-loaded list, queue tasks and pasted lists, send them once back online, and not add a task twice when its reply is lost.

```sh
npx playwright install chromium    # once; or set BROWSER_CHANNEL=msedge or chrome
npm run test:parse                 # phrases only
npm run test:local                 # starts the local Vikunja (with a mock single sign-on provider) and runs all four

# against a real server with the plugin installed (use a test account)
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
# add ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" to test @assignee: a project shared with that user, and a token with Other → Users
```

The end-to-end test deletes the tasks it creates, but leaves behind a `pocket-smoke` label that it reuses on later runs, since Task Management tokens can't delete labels.

## License

MIT. See [LICENSE](LICENSE). Alpine.js and chrono-node are also MIT licensed.
