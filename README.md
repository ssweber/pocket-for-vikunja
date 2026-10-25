# Pocket for Vikunja

**Your team's tasks and checklists, on their phones, in the Vikunja you already host.**

Pocket is a phone app that runs inside Vikunja as a plugin. Your team opens a link, signs in with their Vikunja account, and adds it to the home screen. No app store, no account with anyone else, nothing to pay per person.

> **Everything Pocket makes is ordinary Vikunja data: projects, tasks, comments, attachments, labels and reactions.** Remove the plugin and it's all still there. [What Pocket writes.](docs/guide.md#privacy-and-security)

## Why

"Is anyone doing this yet?" is the question a small team asks all day. The paper checklist on the wall gets skipped, scribbled through, or never collected. Vikunja already holds the tasks, but its web app is built for a desk, not for someone with a tool in the other hand. Pocket is the phone side of the Vikunja you already run.

## Who it's for

**Small teams who work on their feet.** One thumb, no time to type a form.

**Teams with opening, closing or safety checklists** who want to know who ticked each step, and when, without collecting paper.

## What it does

### Add a task in one line

<img src="docs/screenshots/pocket-quickadd.gif" width="240" alt="Typing 'Order 6 bags of house blend fri at 9 +orders !3' shows chips for the project, date and priority before the task is added">

Type `Order 6 bags of house blend fri at 9 +orders !3` and Pocket shows what it read before you send it. Paste a list and each line becomes a task. [Quick add](docs/guide.md#quick-add)

### See who's on it

<img src="docs/screenshots/pocket-people.gif" width="240" alt="Holding the + me chip on a task shows the people who can see the project; tapping one assigns them">

Tap **+ me** and it's yours. Hold it to hand the task to someone else. Swipe right to show how far along you are. **Done today** lists what you finished, ready to paste into a message. [Assigning](docs/guide.md#assigning)

### Checklists that get finished

<img src="docs/screenshots/pocket-checklist.gif" width="240" alt="Starting the Opening up checklist and completing two steps; the next step counts down to when it is due">

One step at a time, with a big **Done**. Each step records who ticked it and when. A step can wait twenty minutes, wait for the one before it, or ask for a temperature, a yes or no, or a note. A template can repeat on a schedule and shows on Today when it is due. [Checklists](docs/guide.md#checklists)

### Works when the signal doesn't

Pocket opens without a connection and sends what you did once it has one. Ticks, deletes and moves can be undone.

## Install

Requires Vikunja 2.7 or later.

1. Download the [latest release](https://github.com/ssweber/pocket-for-vikunja/releases/latest) and unzip it into Vikunja's `plugins` folder, so you have `plugins/pocket/main.go` and `plugins/pocket/app/index.html`.

2. In `config.yml`:

   ```yaml
   plugins:
     enabled: true
     loader: yaegi
     pocket:
       steptimes: true        # optional: timed steps get due dates, so they show on Today and in email reminders
   service:
     maxitemsperpage: 500     # optional: long lists load in fewer requests
   ```

   If you already have a `service:` section, add the line there. As environment variables: `VIKUNJA_PLUGINS_POCKET_STEPTIMES=true` and `VIKUNJA_SERVICE_MAXITEMSPERPAGE=500`. More on [step times](docs/guide.md#step-times).

3. Restart Vikunja. The log should include `pocket: serving … at /api/v1/plugins/pocket/`.

4. Open `https://<your Vikunja>/api/v1/plugins/pocket/` on your phone, sign in, and add it to your home screen.

To update, unzip the new release over `plugins/pocket/`. Every phone picks it up the next time Pocket opens. Restart Vikunja only if `main.go` or `relay.go` changed.

Cloudron: the plugins folder is `/app/data/plugins/` and `config.yml` is `/app/data/config.yml`.

## Good to know

- **Unofficial.** Report problems here, not to Vikunja.
- **0.x.** Expect changes between releases. The [changelog](CHANGELOG.md) says what.
- **No push notifications.** Timers sound while Pocket is open. Otherwise reminders come by Vikunja's email, which needs `mailer` configured.
- **Vikunja checks every change.** The plugin passes Pocket's changes to Vikunja's API as the signed-in user. With step times on, it also sets due dates on checklist steps itself. It makes no outside requests. [Privacy and security](docs/guide.md#privacy-and-security)

## More

The [guide](docs/guide.md) has the full quick-add syntax, gestures, templates, asks, offline behaviour and troubleshooting. To work on Pocket itself, see [docs/development.md](docs/development.md).

MIT licensed.
