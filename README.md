# Pocket for Vikunja

A single-file mobile web app for [Vikunja](https://vikunja.io). Drop it on any static host.

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
- **An app on your home screen:** installs on iOS and Android and follows the phone's light or dark mode.
- **A shortcut link:** opening `…/#/add?text=Buy+milk` starts a task with the text filled in, handy from an iOS Shortcut or a bookmark.

### Quick add

Pocket understands the prefixes and phrases from Vikunja's [Quick Add Magic](https://vikunja.io/help/quick-add-magic/) (in its default mode). As you type, chips show what will be saved. If Pocket reads something you didn't mean, like `3/4 inch` as March 4, tap the chip and those words stay in the title.

<img src="docs/screenshots/pocket-capture.png" width="390" alt="Typing 'Call Ana Friday at 10 +work !3' shows chips for Work, Friday 10:00 AM and Priority 3">

| Type | Sets |
|---|---|
| `+work` or `+"Side project"` | Project (its full name or the start of it) |
| `*calls` or `*"follow up"` | Label (created if it doesn't exist) |
| `@sarah` | Assignee (their username) |
| `!1` to `!5` | Priority |
| `today`, `tonight`, `tomorrow`, `this weekend`, `next week`, `next month` | Due date |
| `friday` or `fri`, `next monday`, `in 3 days`, `in 2 weeks` | Due date |
| `Oct 12`, `12 Oct`, `10/12`, `2026-10-12`, `the 17th`, `end of month` | Due date. `10/12` follows your phone's region. |
| `at 5pm`, `at 17:30`, `at 2` | Due time. A bare 1 to 6 means afternoon. Without a time, the task is due at noon. |
| `every day`, `every 3 days`, `every week`, `every 2 weeks`, `every month`, `every monday` | Repeats. Without a date, it starts at the next noon. |

With more than one line in the box, each line is its own task with its own shortcuts. **↳ Under first line** turns the rest into subtasks of the first.

Not supported: subtasks marked by indenting, and the Todoist-style shortcuts Vikunja offers as a setting.

## Setup

Pocket runs entirely in the browser and talks straight to your Vikunja. Setup is: host the files, allow Pocket's address in Vikunja, and sign in. Tested with Vikunja 2.6.0.

1. **Host the files.** Upload the contents of `app/` to any static web host that serves HTTPS, for example a Cloudron Surfer app at `pocket.example.com`. Give Pocket its own subdomain rather than a folder on a site that hosts other things, because the browser stores your sign-in per site.

2. **Allow Pocket's address in Vikunja.** Pocket's requests come from a different address than Vikunja's, so Vikunja has to allow it. Add it to `cors.origins` in Vikunja's `config.yml`, then restart Vikunja:

   ```yaml
   cors:
     enable: true
     origins:
       - "https://pocket.example.com"
       - "http://127.0.0.1:*"
       - "http://localhost:*"
   ```

   Setting `origins` replaces Vikunja's defaults, which are the last two lines, so keep them if you want to run Pocket locally. The address must match exactly: include `https://` and leave off any trailing `/`. If Vikunja is configured with environment variables, set `VIKUNJA_CORS_ORIGINS` instead.

3. **Sign in on your phone.** Open Pocket, enter your Vikunja address, then use either:
   - **Password**, if your server has local or LDAP accounts.
   - **API token**, which works with every server, including ones that use single sign-on. In Vikunja, go to *Settings → API Tokens*, choose the **Task Management** preset, and also tick **User** and **Users** under *Other*. *Users* lets Pocket find people by username for `@sarah`.

4. **Add it to your home screen** from the browser's Share or menu button.

To save your team a step, share a link with the address filled in: `https://pocket.example.com/?server=https://tasks.example.com`.

### Troubleshooting

- **"Can't reach …", but Vikunja opens fine in the browser:** Vikunja isn't allowing Pocket's address. Check the `cors.origins` entry for typos, and check that Vikunja was restarted.
- **"That token didn't work":** the token has expired, or **User** under *Other* isn't ticked.
- **"Your API token doesn't allow this":** the token is missing a permission, for example **Users** when you use `@name`. Vikunja can't add permissions to an existing token, so create a new one.
- **"This user does not have access to the project":** you can only assign people the project is shared with.

## Privacy and security

- Pocket has no server of its own. It only talks to the Vikunja address you enter.
- Your sign-in is stored in the browser on that device. Signing out removes it. To revoke an API token entirely, delete it in Vikunja.
- Notes and comments are cleaned before they're shown. Attachments other than images, PDFs and plain text are downloaded instead of opened. Together, these stop content from people you share projects with from running code inside Pocket.

## Development

```
app/     the app: upload this folder's contents
tests/   end-to-end test
docs/    screenshots
```

All of the app's code is in `app/index.html`: plain CSS, and JavaScript that uses [Alpine.js](https://alpinejs.dev) to keep the screen in sync with the data. There's no build step. Dates are read by [chrono-node](https://github.com/wanasit/chrono), with a few rules of Pocket's own on top (see `parseCapture`).

Both libraries are kept in the repo rather than loaded from a CDN, so the app depends only on your own hosting:

- `app/alpine-<version>.min.js`: to upgrade, download `dist/cdn.min.js` from the `alpinejs` npm package, rename it, and update the `<script>` tag.
- `app/chrono-<version>.en.min.js`: the English-only build, from `https://cdn.jsdelivr.net/npm/chrono-node@<version>/en/+esm`. Rename it and update the `import` line above the Alpine `<script>` tag.

To run it locally:

```sh
npm run serve    # http://127.0.0.1:8000
```

### Tests

`tests/smoke.mjs` drives the app in a headless browser against a real Vikunja. It signs in with a token, quick-adds a task, ticks it off and undoes that, then opens it, comments, edits, completes and deletes it. It pastes a list with a parent, works with the subtasks, and undoes a pasted list. It also checks the security measures: attachment handling, note cleaning and color values.

```sh
npm install
npx playwright install chromium    # or set BROWSER_CHANNEL=msedge or chrome
VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test

# also test @assignees: needs a token with Other → Users, and a project shared with that user
ASSIGNEE=sarah ASSIGNEE_PROJECT="Team" VIKUNJA_URL=... VIKUNJA_TOKEN=... npm test
```

Use a test account. The test deletes the tasks it creates, but leaves behind a `pocket-smoke` label that it reuses on later runs, since Task Management tokens can't delete labels.

## License

MIT. See [LICENSE](LICENSE). Alpine.js and chrono-node are also MIT licensed.
