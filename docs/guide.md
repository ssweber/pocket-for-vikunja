# Pocket guide

Reference for Pocket's syntax, non-obvious behavior, and admin setup. The [README](../README.md) covers what Pocket is and how to install it.

- [Quick add](#quick-add)
- [Tasks](#tasks)
- [Assigning](#assigning)
- [Checklists](#checklists)
- [Timed steps](#timed-steps)
- [Step times](#step-times)
- [Reminders](#reminders)
- [Offline](#offline)
- [API tokens](#api-tokens)
- [Troubleshooting](#troubleshooting)
- [Privacy and security](#privacy-and-security)

## Quick add

Pocket uses the syntax of Vikunja's [Quick Add Magic](https://vikunja.io/help/quick-add-magic/) and follows your Vikunja setting for it: Vikunja mode (below), Todoist mode (`#project`, `@label`, `+person`), or off. Parsed words are highlighted as you type, and chips show what will be saved.

<img src="screenshots/pocket-capture.png" width="320" alt="Quick add parsing 'Order 6 bags of house blend fri at 9 +orders !3'">

| Syntax | Sets |
|---|---|
| `+orders` or `+"Café"` | Project, by full name or prefix |
| `*suppliers` or `*"call back"` | Label, created if it doesn't exist |
| `@priya` | Assignee, by username |
| `!1` to `!5` | Priority |
| `today`, `tomorrow`, `fri`, `next monday`, `in 3 days`, `end of month`, `Oct 12`, `2026-10-12`, `10/12` | Due date. Numeric dates are read only at the start or end of the text, so "Table 4/5 wobbles" is left alone. |
| `at 5`, `at 5pm`, `at 17:30` | Due time. A bare hour from 1 to 7 means afternoon or evening. Without a time, the task uses your default due time from Vikunja's settings. |
| `every day`, `every other week`, `every month`, `weekly` | Repeat. Vikunja can't repeat on weekdays only or on specific days; `every weekday` stays in the title and a chip says so. |
| `(50%)` or `50%` at the end | Progress. `100%` is done. Pocket only. |
| `x ` or `[x] ` at the start | Done already. Pocket only. A capital `X` works too. |

**Undoing a parse.** Tap a chip to keep those words in the title. Wrap the whole text in quotes to disable parsing: `"Friday night jazz poster"`. Quotes at the start hold the title and leave the rest to parse: `"Lunch friday" @priya tomorrow`.

**Pasting a list.** Each line becomes a task. The whole list goes to one project, the first `+project` found. Lines under a `## ` heading, lines indented more than the previous, and lines after a first line ending in a colon (`Groceries:`) become subtasks. The **↳ Under first line** chip makes everything a subtask of the first line. Ticked lines arrive done; tap the chip to omit them instead.

**Differences from Vikunja's parser.** The same text usually produces the same task in both. Pocket differs deliberately here:

- `at 5` is 5 PM. Vikunja reads it as 5 AM.
- `every month` repeats on the same day each month. Vikunja uses every 30 days.
- Dates resolve to the next occurrence: in June, `2nd March` is next March.
- `10/12` follows your phone's locale. Vikunja always reads it as US format.
- Pocket also reads `every monday`, `every other day`, and `the 17th` anywhere in the text.

**Shortcut link.** `…/#/add?text=Order+milk` opens Pocket with the text prefilled, for use from an iOS Shortcut or a bookmark.

## Tasks

Behavior you might not expect:

- **Overdue** means the due time has passed, not the end of the day. A task due at midnight, which is how Vikunja's web app stores a date without a time, is overdue once that day ends.
- **Setting progress on an unassigned task assigns it to you** in a shared project. Lowering it back to 0% keeps the assignment; tap your avatar to remove it.
- **Completing every subtask doesn't close the parent.** The card shows **Close** and waits. To close a parent with open subtasks, tap its ring or swipe the header fully right; with more than one open, Pocket asks first.
- **A parent's progress is the average of its subtasks'**, and Pocket writes that figure to Vikunja.
- **A task with progress takes two swipes to delete:** the first swipe lowers it to 0%.
- **Ticked and deleted tasks stay in place for three seconds**, then leave together. Until then, un-ticking and **Restore** work. A tick reaches Vikunja at once; a delete is sent only when the row leaves.
- **Moving a task on Today:** hold it until it lifts. **Today** is left, **Tomorrow** right, **Next week** above, **No date** below, always in the same places. Release without moving to tap one, or **Pick a date…**.
- **Nudging a row moves the add box under it.** A nudge is a press and a slight scroll; with a mouse, a short, slow drag up or down on the row. Under a task the box adds that task's first subtask; under a subtask it adds the next one. On a project's list, **⇤** moves the box out a level to add a task there instead, and **⇥** moves it back in (Tab and Shift+Tab on a keyboard). **×**, a tap on the empty slot at the bottom, or scrolling the row away sends the box back. **Add a subtask here** in a task's **⋯** does the same as a nudge. Nudging works on a project's list, on Today, in a task's sheet, on a checklist, and on a template's steps. In a sheet and on a checklist the box is at the foot of the list, not in a bar at the bottom of the screen, and nudging the last row changes nothing.
- **The subtask box doesn't read `+project`.** A subtask stays in its parent's project. In a checklist project it doesn't read dates either, since subtasks there may become template steps.
- **Copy as a Markdown list** round-trips: pasted into Pocket's add box, it recreates the tasks. Notes, comments, and attachments aren't included.
- **Every swipe and hold has an equivalent in the ⋯ menu**, for keyboard and screen-reader use.

## Assigning

A user can only be assigned a task in a project they can access.

- **`@priya` without a `+project`:** if your default project isn't shared with Priya but exactly one of your projects is, Pocket picks that one and shows a chip. Otherwise a chip warns before you send.
- **+ me** appears only in shared projects. In a private project the slot is empty.
- **Assignment never marks anything done.** Completion is recorded for whoever ticks it.
- **A checklist's row shows who it's for.** Change it from the checklist's **⋯**. Vikunja notifies them once per checklist, not per step.
- **To reassign a checklist step:** checklist's **⋯** → **Open as a task**, then tap the step.

## Checklists

A checklist template is a procedure done repeatedly. Starting it creates a checklist, which records who completed each step and when. Templates and checklists are ordinary Vikunja tasks.

<p align="center"><img src="screenshots/pocket-checklist.gif" width="300" alt="Starting a checklist and completing two steps"></p>

**Setup.** Under Projects, **Set up checklists** creates a project with an example template, or mark an existing project with **Use for checklists** in its **⋯**. Share it in Vikunja's web app with **Read & write**. Vikunja defaults to *Read only*, which lets people see checklists but not tick steps.

**Templates.** Steps are parsed like quick add (`@priya`, `*front`, `!3`) except dates; step timing is separate (see **Timed steps**). Tap a step to edit it, hold it to reorder, and swipe it left to delete. **Notes and photos** under a step are copied into every checklist, as are the template's own notes, attachments, labels, and assignees. An existing task with subtasks becomes a template via **Use as checklist template**.

**Checklists.** A checklist can be started offline. Entering a name on start, such as "Saturday", replaces the number in its title. A comment typed on a step is posted with **Done** or recorded as the reason with **Skip**. **Last time** shows comments from the previous completed checklist. To finish early, tap the checklist's ring; remaining steps stay incomplete.

**Recurring.** Give the template a due date and repeat interval. It becomes a repeating Vikunja task: at its time it appears on Today for its assignees (or everyone with write access), and tapping it opens Start. Starting a checklist on the due day advances the template, and the checklist inherits the due time, so an unfinished one shows overdue. A start at 7:55 counts as the 8:00 occurrence. A start before the due day doesn't advance it. Missed occurrences aren't made up.

**Changing a checklist.** The box under the steps adds a step at the end, for this checklist only. Nudge a step to make it current and move the box under it; a step added there goes after it. **Repeat**, the ↻ button in the box, duplicates the current step, right after it. Template steps can't be removed from a checklist, only skipped.

**Completion record.** Done is a ✅ reaction, skipped is ⏭️, so the web app shows "Done by Priya at 4:46 PM". Vikunja only lets users remove their own reactions, so un-ticking someone else's step asks first and leaves their reaction.

**In Vikunja's web app.** A template is a task labeled `template`, titled "TEMPLATE: …", with its steps as done subtasks. A recurring template is a repeating task there; ticking it in the web app skips that occurrence. A checklist is a copy named like "Opening up · Oct 4 · #3". Step order is stored in a `pocket:order 12 15 13` line in the template's description; leave it in place. Steps it doesn't list sort last.

## Timed steps

Write the delay in the step: "Dial in the grinder **in 20 min**", "Take the croissants out **after 18 minutes**". A chip shows what was parsed. To count from a different step, select it in the chip, or write "**20 minutes after** Turn on the espresso machine". Durations that describe the action, like "steam **for** 2 minutes", aren't parsed.

Pocket stores the timer in the step's title using PLC duration syntax, which is also how to enter one in Vikunja's web app:

| Step title | Due |
| --- | --- |
| `Wipe the counters T#20m` | 20 minutes after the previous step is done. For the first step, after the checklist starts. |
| `Put the croissants in the oven {#croissants}` | No timer. `{#croissants}` names the step. |
| `Take the croissants out T#18m:croissants` | 18 minutes after the step named "croissants" is done, regardless of what's done in between. |

- Units: `d`, `h`, `m`, `s`, `ms`. They combine: `T#1h30m`.
- A timer must reference an earlier step, and names must be unique. Pocket validates on edit, reorder, and start.
- Checklist steps get their titles with `T#` and `{#…}` removed.
- A step inserted during a checklist has no timer and isn't "the previous step" for the one after it. A step timed from a repeated step counts from whichever copy was done last.

## Step times

Timed steps get due dates in Vikunja, and so appear on Today, in the web app, and in email reminders, when `steptimes: true` is set in `config.yml` (or `VIKUNJA_PLUGINS_POCKET_STEPTIMES=true`). Without it, Pocket still counts down on the checklist screen.

When a step is marked done, the plugin sets the due date of each step in the checklist timed from it: completion time plus timer. Marking it incomplete clears those due dates. The plugin writes due dates and reminders only, on incomplete steps of that checklist, only when the date changes, and doesn't update the task's modified timestamp. The logic is one function, `writeStepDueDates` in [`pocket/main.go`](../pocket/main.go).

Limitations:

- Vikunja's web app and CalDAV clients save the whole task from their loaded copy. Saving a step from a copy loaded before its due date was set overwrites the due date. Pocket's countdown is unaffected.
- CalDAV clients and saved filters don't see the new due date until the step changes some other way, since the modified timestamp isn't updated.
- A step ticked offline is timed, in Vikunja, from when the tick reaches it. Pocket counts down from when you ticked it.
- A tick the plugin handles more than 2 minutes after Vikunja recorded it, or during a restart, sets no due dates.

## Reminders

Timers sound while Pocket is open. When Pocket is closed, reminders arrive by Vikunja's email. Pocket shows no system notifications and requests no permissions.

- A countdown reaching zero chimes, once per step, and vibrates on Android. An iPhone with the silent switch on may not sound.
- The screen stays awake while a checklist with a countdown is on screen.
- The app icon shows the overdue count, on phones that support it.
- Email reminders need `mailer` and `service.enableemailreminders` in Vikunja's config (Cloudron handles this), and email reminders enabled in your Vikunja settings.
- Typing a time in quick add shows a 🔔 chip offering a reminder at that time. It's off until tapped.
- Timed steps get a reminder at their due time, sent to whoever started the checklist and the step's assignees. Requires step times. A step due less than a minute after its reference gets none; Vikunja checks reminders once a minute.

Vikunja's web push, in progress in [go-vikunja/vikunja#4020](https://github.com/go-vikunja/vikunja/pull/4020), would allow phone notifications.

## Offline

Pocket opens without a connection and shows lists as last loaded.

- **Works offline:** new tasks and subtasks, comments, and checklists. Ticking or editing other tasks needs a connection.
- **Queued items** show tinted with a dashed circle. The refresh button turns amber with a count; tap it to see the queue, cancel items not yet started, or **Try now**.
- **Nothing is lost.** Queued text survives app closes and session expiry. If Vikunja rejects an item permanently, the text returns to the input. Notes changed elsewhere while you were editing aren't overwritten; both versions are shown.
- **iPhones don't allow background sending.** Items go out the next time Pocket is opened.

## API tokens

Pocket accepts an API token as an alternative to password or single sign-on. In Vikunja, go to *Settings → API Tokens*, choose the **Task Management** preset, and add:

- **User** and **Users** under *Other*, and **Users search** under *Projects*: to resolve `@priya` and check project access.
- **Create**, **Update**, and **Delete** under *Projects*: to create, rename, archive, and delete projects, and mark them for checklists.
- **Reactions**: to record who completed each checklist step.

The preset already includes what reordering needs: **Position** under *Tasks*, and reading a project's views. A token without them shows each project's tasks in creation order and can't reorder them. Vikunja can't add permissions to an existing token; create a new one.

## Troubleshooting

- **Pocket's URL returns "not found":** check Vikunja's log for `pocket` or `plugin`.
  - `couldn't find app/index.html`: files aren't at `plugins/pocket/app/`.
  - `Failed to load yaegi plugin pocket`: the plugin didn't load, possibly because a Vikunja update changed the plugin API. Vikunja keeps running.
  - Nothing: plugins aren't enabled, or Vikunja hasn't been restarted.
- **Old version in the log after updating:** Vikunja reads `main.go` at startup. Restart it.
- **"Too many attempts from here":** 10 sign-in attempts per minute per address. Wait.
- **"That token didn't work":** expired, or **User** under *Other* isn't enabled.
- **"Your API token doesn't allow this":** a permission is missing. See [API tokens](#api-tokens).
- **"@priya can't see Inbox":** share the project with them, or add a `+project` they can access.

## Privacy and security

- Pocket has no server of its own and communicates only with the Vikunja that serves it.
- It uses Vikunja's own session, stored where the web app stores it. To revoke an API token, delete it in Vikunja.
- For offline use, Pocket stores the last-loaded lists, the send queue, and in-progress text in the browser. Signing out clears them. Another account signing in on the same device never sees them. To recognize a returning session, Pocket stores a SHA-256 hash of the credential, never the credential.
- Notes and comments are sanitized before display, and attachments other than images, PDFs, and plain text are downloaded rather than opened inline. This prevents collaborators' content from running code in Pocket, which shares Vikunja's origin.
- The plugin runs inside Vikunja. Review [`pocket/main.go`](../pocket/main.go) before installing. It serves `app/` and, with step times enabled, sets due dates on checklist steps. Nothing else.
