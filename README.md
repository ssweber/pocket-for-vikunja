# Pocket for Vikunja

A single-file mobile web app for [Vikunja](https://vikunja.io), served by Vikunja itself.

Vikunja's web app works on a phone, but it's built for a bigger screen. Pocket is a small companion for what you need on the go: seeing what's due and adding tasks quickly. Projects, boards, sharing and settings stay in Vikunja.

It isn't an app from an app store or a service you sign up for. Pocket is one readable HTML file and a plugin of about 100 lines. Your own Vikunja serves both, and you can read every line before you install it.

<sub>Pocket is an unofficial companion, not made by the Vikunja team. Please report problems with it here, not to Vikunja.</sub>

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

- **Today:** tasks grouped into Overdue, Today and Next 7 days, plus **Added today, no date**, so a task you add without a date stays in view until tonight instead of vanishing into a project. Tick one off and it slides away, with an Undo.
- **Quick add:** a task in one line, with its date, repeat, project, priority, labels and people.
- **Paste a list:** each line of a list from an email or a note becomes a task, optionally as subtasks of the first.
- **Task details:** due date, repeat, project, priority, people, labels, notes, subtasks, attachments and comments. Changes save as you make them.
- **Projects:** your project tree with favorites, and the open or done tasks in each.
- **Offline:** Pocket opens without a connection, and tasks you add are sent once you're back online.
- **Your Vikunja sign-in:** sign in once, with your usual login, and Pocket and Vikunja's web app are both signed in on that device.
- **A home-screen app** for iOS and Android that follows the phone's light or dark mode.
- **A shortcut link:** `…/#/add?text=Buy+milk` opens Pocket with the text filled in, handy from an iOS Shortcut or a bookmark.

## Install

Pocket runs as a plugin inside your Vikunja, which serves it at `https://<your Vikunja>/api/v1/plugins/pocket/`. There's nothing else to host. It needs Vikunja 2.3 or later, and is tested with 2.6.0.

Since the plugin runs inside Vikunja, read [`pocket/main.go`](pocket/main.go) before installing it. It only serves the files in its `app/` folder. The app itself is [`pocket/app/index.html`](pocket/app/index.html) and a 40-line [`sw.js`](pocket/app/sw.js) for offline use, all plain, unminified code. The only outside code is the two libraries bundled with it, Alpine.js and chrono-node.

1. **Copy the `pocket` folder** from this repo into Vikunja's `plugins` folder, so that you have `plugins/pocket/main.go` and `plugins/pocket/app/index.html`.
   - On Cloudron, use the Vikunja app's **File Manager** to put it at `/app/data/plugins/pocket/`. Create the `plugins` folder if it isn't there.
   - Elsewhere, `plugins` goes in Vikunja's root path: `service.rootpath` in its config, or the folder Vikunja runs in.

2. **Turn plugins on** in Vikunja's `config.yml` (`/app/data/config.yml` on Cloudron), then restart Vikunja:

   ```yaml
   plugins:
     enabled: true
     loader: yaegi
   ```

   Vikunja's log should now include `pocket: serving … at /api/v1/plugins/pocket/`.

3. **Open Pocket on your phone** at `https://<your Vikunja>/api/v1/plugins/pocket/` and sign in the way you sign in to Vikunja, with single sign-on or a password. You're then signed in to both on that device.

4. **Add it to your home screen** from the browser's Share or menu button.

**Updating:** replace the files in `plugins/pocket/app/`, then reopen Pocket while online. Only a changed `main.go` needs a Vikunja restart.

<details>
<summary>Signing in with an API token instead</summary>

If single sign-on and passwords don't suit you, Pocket also takes an API token. In Vikunja, go to *Settings → API Tokens*, choose the **Task Management** preset, and also tick **User** and **Users** under *Other*. *Users* lets Pocket find people for `@sarah`. To create projects from quick add, also tick **Create** under *Projects*.

A token is kept by Pocket alone, so signing in or out of Vikunja's web app doesn't affect it.

</details>

## Quick add

Quick add uses the prefixes and phrases of Vikunja's [Quick Add Magic](https://vikunja.io/help/quick-add-magic/), and follows your setting for it in Vikunja: the prefixes below, Todoist-style ones (`#project`, `@label`, `+person`), or none. As you type, chips under the box show what will be saved.

<img src="docs/screenshots/pocket-capture.png" width="320" alt="Typing 'Call Ana Friday at 10 +work !3' shows chips for Work, Friday 10:00 AM and Priority 3">

| Type | Sets |
|---|---|
| `+work` or `+"Side project"` | Project: its full name or the start of it |
| `*calls` or `*"follow up"` | Label, created if it doesn't exist |
| `@sarah` | Person to assign, by username. It stays in the title, as in Vikunja. |
| `!1` to `!5` | Priority |
| `today`, `tonight`, `tomorrow`, `this weekend`, `later this week`, `next week`, `next month`, `end of month` | Due date |
| `friday` or `fri`, `next monday`, `in 3 days`, `in 2 hours` | Due date |
| `Oct 12`, `21st June`, `2026-10-12`, `10/12`, `01.02`, `17th` | Due date. Dates in numbers only, and a bare `17th`, count only at the start or end, so "The 9/11 Report" stays as it is. |
| `at 5pm`, `at 17:30`, `@ 3pm` | Due time. Without one, the task is due at your default due time from Vikunja's settings, noon unless you changed it. |
| `every day`, `every 3 days`, `every two weeks`, `every month`, `every year`, `daily`, `weekly`, `biannually` | Repeat. Without a date, it starts at the next due time. |

- **Read something you didn't mean?** Tap its chip and those words stay in the title. Tap again to undo. To turn it all off for one task, wrap the whole text in quotes: `"Read 1984 by Friday"`.
- **Pasting a list:** with more than one line in the box, each line becomes a task with its own dates and other shortcuts, and bullets, numbering and checkboxes are removed. The whole list goes to one project: add `+Kitchen` to any line, say the end of the last one. **↳ Under first line** makes the rest subtasks of the first.
- **New projects:** if a `+project` doesn't exist yet, tap **Create project** to make it. The task goes there when you send it.

<table>
  <tr>
    <th>Tap a chip to undo it</th>
    <th>Paste a list</th>
    <th>Create a project</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/pocket-chip-undo.png" width="240" alt="'Watch Monday night football' with the Monday chip tapped off and struck through"></td>
    <td><img src="docs/screenshots/pocket-paste-list.png" width="240" alt="A pasted grocery list with 'Under first line' turned on, showing '1 task + 3 subtasks'"></td>
    <td><img src="docs/screenshots/pocket-new-project.png" width="240" alt="'Call contractor friday +Kitchen' with a 'Create project Kitchen' chip"></td>
  </tr>
</table>

<details>
<summary>Where Pocket's quick add differs from Vikunja's</summary>

The phrases and their meanings come from Vikunja's own tests, so the same text gives the same task in both apps. Pocket differs on purpose in a few places:

- `every month` repeats on the same day each month. Vikunja's quick add uses every 30 days.
- Dates always mean the next one: in June, `2nd March` is next March. Vikunja sometimes picks a date that has passed.
- `10/12` follows your phone's region, which is 12 October in most places. Vikunja always reads it US-style.
- A pasted list goes to one project, the first `+project` in it, since tagging a list once is what you'd expect on a phone. Vikunja reads each line on its own, so there `+Kitchen` only moves its own line.
- Pocket also understands `every monday` and `the 17th` anywhere in the text, and drops a word like "by" or "in" along with its date.
- Subtasks marked by indenting aren't supported; use **↳ Under first line**.

</details>

## Offline

Pocket opens without a connection and shows your lists as they were last loaded. A task you add appears with a light tint and a dashed circle until it reaches Vikunja; tap × to cancel it. Waiting tasks are sent when Pocket is opened, when it comes back to the front and when the connection returns, and a connection that drops halfway doesn't add a task twice.

<img src="docs/screenshots/pocket-offline.png" width="320" alt="Pocket offline: a banner saying when the list was loaded, and 'Call the plumber' tinted in Next 7 days">

Only new tasks work offline. Ticking off or editing a task needs a connection. On an iPhone, waiting tasks are sent the next time Pocket is opened, since iPhones don't let web apps send in the background.

## Troubleshooting

- **Pocket's address shows "not found":** look for lines mentioning `pocket` or `plugin` in Vikunja's log.
  - `couldn't find app/index.html`: the files aren't at `plugins/pocket/app/`.
  - `Failed to load yaegi plugin pocket`: the plugin didn't load, for example because a Vikunja update changed how plugins work. Vikunja itself keeps running.
  - Nothing at all: plugins aren't turned on, or Vikunja hasn't been restarted since.
- **Stuck on Vikunja's page after single sign-on:** in the home-screen app, single sign-on opens in the same window and ends on Vikunja's page. Close that page to come back to Pocket. In a browser, it opens a new tab that closes by itself.
- **"Too many attempts from here":** Vikunja allows 10 sign-in attempts a minute from one address. Wait a minute.
- **"That token didn't work":** the token has expired, or **User** under *Other* isn't ticked.
- **"Your API token doesn't allow this":** the token is missing a permission, such as **Users** for `@name` or **Projects → Create** for new projects. Vikunja can't add permissions to an existing token, so create a new one.
- **"This user does not have access to the project":** you can only assign people the project is shared with.

## Privacy and security

- Pocket has no server of its own. Vikunja serves its files, and Pocket only talks to that same Vikunja.
- Pocket uses Vikunja's own sign-in, stored in the browser where Vikunja's web app keeps it, and renews it the way Vikunja does. To revoke an API token entirely, delete it in Vikunja.
- For offline use, Pocket keeps the lists it last loaded, and any tasks waiting to be sent, in the browser on that device. Signing out removes them, and asks first if tasks are still waiting.
- Notes and comments are cleaned before they're shown, and attachments other than images, PDFs and plain text are downloaded instead of opened. Together, these stop content from people you share projects with from running code inside Pocket, which shares its web address with Vikunja.

## Development

All of the app is in `pocket/app/index.html`, with no build step. `npm run dev` starts a local Vikunja with the plugin loaded. See [docs/development.md](docs/development.md) for the layout, the tests and upgrading the bundled libraries.

## License

MIT. See [LICENSE](LICENSE). Alpine.js and chrono-node are also MIT licensed.
