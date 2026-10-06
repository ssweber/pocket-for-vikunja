# Pocket guide

The [README](../README.md) says what Pocket is for and how to install it. This is everything else: each screen in full,
quick add's shortcuts, checklists and timed steps, reminders, working offline, API tokens, troubleshooting, and
privacy.

The examples follow a small café: Alex owns it, and Priya is the shift lead who opens up.

- [Pocket and Vikunja's web app](#pocket-and-vikunjas-web-app)
- [Tasks](#tasks)
- [Quick add](#quick-add)
- [Assigning](#assigning)
- [Checklists](#checklists)
- [Timed steps](#timed-steps)
- [Step times](#step-times)
- [Reminders and alerts](#reminders-and-alerts)
- [Offline](#offline)
- [Signing in with an API token](#signing-in-with-an-api-token)
- [Troubleshooting](#troubleshooting)
- [Privacy and security](#privacy-and-security)

## Pocket and Vikunja's web app

Vikunja's web app works on a phone, but it's built for a bigger screen. Pocket covers the day on your feet: what's due,
adding and finishing tasks, handing them on, and checklists. Boards, project settings and sharing stay in Vikunja.

<table>
  <tr>
    <th>Vikunja's web app</th>
    <th>Pocket</th>
  </tr>
  <tr>
    <td><img src="screenshots/vikunja-home.png" width="260" alt="Vikunja's home screen on a phone"></td>
    <td><img src="screenshots/pocket-today.png" width="260" alt="Pocket's Today screen, grouped into Overdue, Today and Next 7 days"></td>
  </tr>
  <tr>
    <td><img src="screenshots/vikunja-task.png" width="260" alt="A task in Vikunja's web app on a phone"></td>
    <td><img src="screenshots/pocket-task.png" width="260" alt="The same task in Pocket's task sheet"></td>
  </tr>
</table>

<sub>Same account, same tasks, same phone-sized screen.</sub>

## Tasks

- **Today** groups tasks into Overdue, Today and Next 7 days, plus **Added today, no date**, so a task added without a
  date stays in view until tonight instead of vanishing into a project. A task is overdue once its time has passed, as
  in Vikunja: "friday" is due at your default due time, noon unless you changed it. One due at midnight, as Vikunja's
  web app sets a day without a time, is overdue once that day is over. Left open, Today moves tasks to Overdue as their
  time passes. **Move all to today** brings every overdue task to today, each at the time of day it had, or the next
  whole hour if that time has gone today. A repeating task stays where it is: tick it to move it on to its next date.
- **Ticking off:** a ticked task slides away, with an Undo. Ticks in a row add up into one message, "3 done", whose Undo
  opens them all again. A task's open subtasks are ticked off with it. A repeating task moves to its next date, and Undo
  puts its date back. An Undo leaves alone a task that was changed elsewhere since.
- **Progress:** hold a task, then slide sideways to set how far along it is, in steps of 10%. Sliding to 100% marks it
  done. A checklist run's bar shows how many of its steps are done instead.
- **The task sheet:** due date, repeat, project, priority, progress, people, labels, notes, subtasks, attachments and
  comments. Changes save as you make them. Subtasks are added with the same box as quick add. Moving a task to another
  project takes its subtasks along. The **⋯** at the top of the sheet deletes it, with its subtasks. Tap the project above the title to open it.
- **Search:** the magnifier finds open and done tasks in all your projects, by words in their title or notes, or by
  number. A ticked result moves from Open to Done.
- **Projects:** your project tree with favorites, and the open or done tasks in each. **New project** makes one, inside
  another if you like. A project's **⋯** renames or archives it if it's shared with you to write, and deletes it if
  you're its admin. A project shared with you to read only shows its tasks without ticks, and says so.
- **Signing in:** sign in once, with your usual Vikunja login, and Pocket and Vikunja's web app are both signed in on
  that device.
- **On the home screen**, Pocket follows the phone's light or dark mode, and the phone's Back closes an open sheet,
  keeping what you wrote, then steps back through Pocket's screens.
- **A shortcut link:** `…/#/add?text=Order+milk` opens Pocket with the text filled in, handy from an iOS Shortcut or a
  bookmark.

## Quick add

Quick add uses the prefixes and phrases of Vikunja's [Quick Add Magic](https://vikunja.io/help/quick-add-magic/), and
follows your setting for it in Vikunja: the prefixes below, Todoist-style ones (`#project`, `@label`, `+person`), or
none. As you type, the words it reads are highlighted in the box, and chips under it show what will be saved.

<img src="screenshots/pocket-capture.png" width="320" alt="Typing 'Order 6 bags of house blend fri at 9 +orders !3' highlights the words it reads, and chips show Orders, Friday 9:00 AM and Priority 3">

| Type | Sets |
|---|---|
| `+orders` or `+"Café"` | Project: its full name or the start of it |
| `*suppliers` or `*"call back"` | Label, created if it doesn't exist |
| `@priya` | Person to assign, by username. Once assigned, the name leaves the title, as in Vikunja. |
| `!1` to `!5` | Priority |
| `today`, `tonight`, `tomorrow`, `this weekend`, `later this week`, `next week`, `next month`, `end of month` | Due date |
| `friday` or `fri`, `next monday`, `in 3 days`, `in 2 hours` | Due date |
| `Oct 12`, `21st June`, `2026-10-12`, `10/12`, `01.02`, `17th` | Due date. Dates in numbers only, and a bare `17th`, count only at the start or end, so "Table 4/5 wobbles" stays as it is. |
| `at 5`, `at 5pm`, `at 17:30`, `@ 3pm` | Due time. A bare hour is daytime: `at 1` to `at 7` mean the afternoon or evening, `at 8` to `at 11` the morning. Write `am` or `pm`, or `05:00`, to say otherwise. Without a time, the task is due at your default due time from Vikunja's settings, noon unless you changed it. |
| `every day`, `every 3 days`, `every other day`, `every two weeks`, `every month`, `daily`, `weekly`, `biannually` | Repeat. Without a date, it starts at the next due time. Vikunja can't repeat on weekdays only, or on two days a week: `every weekday` or `every monday and thursday` stay in the title, and a chip says so. |

- **Suggestions:** as you type a label or a person, chips offer your labels and the people you share projects with,
  those who can see the task's project first. Tap one to finish the word, or press Enter for the first.
- **Read something you didn't mean?** Tap its chip and those words stay in the title. Tap again to undo. To turn it all
  off for one task, wrap the whole text in quotes: `"Friday night jazz poster"`.
- **Pasting a list:** with more than one line in the box, each line becomes a task, with its own dates and shortcuts.
  Bullets, numbering and checkboxes are removed, and a line already ticked off, like `- [x] napkins`, is left out. The
  whole list goes to one project: add `+orders` to any line. **↳ Under first line** makes the rest subtasks of the
  first.
- **New projects:** if a `+project` doesn't exist yet, tap **Create project** to make it.
- **A photo:** the camera button attaches one to the new task.

<table>
  <tr>
    <th>Tap a chip to undo it</th>
    <th>Paste a list</th>
    <th>Create a project</th>
  </tr>
  <tr>
    <td><img src="screenshots/pocket-chip-undo.png" width="240" alt="'Write the Sunday brunch menu' with the Sunday chip tapped off and struck through"></td>
    <td><img src="screenshots/pocket-paste-list.png" width="240" alt="A pasted supplier order with 'Under first line' turned on, showing '1 task + 3 subtasks'"></td>
    <td><img src="screenshots/pocket-new-project.png" width="240" alt="'Get quotes for patio heaters friday +Patio' with a 'Create project Patio' chip"></td>
  </tr>
</table>

**Where Pocket's quick add differs from Vikunja's.** The phrases come from Vikunja's own tests, so the same text mostly
gives the same task in both apps. Pocket differs on purpose here:

- A bare hour is daytime: `at 5` is 5 PM. Vikunja reads it as 5 AM.
- `every month` repeats on the same day each month. Vikunja's quick add uses every 30 days.
- Dates always mean the next one: in June, `2nd March` is next March.
- `10/12` follows your phone's region, which is 12 October in most places. Vikunja always reads it US-style.
- A pasted list goes to one project, the first `+project` in it. Vikunja reads each line on its own.
- Pocket also understands `every monday`, `every other day` and `the 17th` anywhere in the text, and drops a word like
  "by" or "in" along with its date.
- Subtasks marked by indenting aren't supported; use **↳ Under first line**.

## Assigning

`@priya` in quick add, or **Assigned → Add** in a task's sheet, gives the task to someone. They can only be given a task
in a project they can see.

<img src="screenshots/pocket-assign.png" width="320" alt="'Clean the milk steamer tomorrow @priya', with chips showing Café, Tomorrow and @priya">

- Without a `+project`: if your default project isn't shared with them but exactly one of your projects is, Pocket picks
  that one and shows it as a chip; tap it to undo. Otherwise a chip says they can't see the project, before you send.
- In the sheet, only people who can see the task's project are suggested.
- A checklist run is for one person, picked when it's started or later from its **⋯**. Vikunja tells them about it once,
  not once per step.

**Who's doing a subtask or a step:** every subtask in a task's sheet, and every step of a run, has a slot at the end of
its row. **+ me** says you'll do it, which assigns it to you; tap your picture to let it go. Someone else's picture
shows who has it; to hand it over, open it and use **Assigned**. Done or skipped is still recorded for whoever taps it,
whoever has the step, and claiming never ticks anything. A step you claim in someone else's run shows on your Today.
Vikunja tells the task's creator (for a step, whoever started the run) when you claim it.

## Checklists

Checklists are the things done the same way again and again: opening up, closing down, a delivery check. Each start of
one is a run, with who did each step and when. They're ordinary Vikunja projects and tasks.

<p align="center"><img src="screenshots/pocket-checklist.gif" width="300" alt="Starting a run of the café's Opening up template. Once the espresso machine is on and the croissants are in, 'Dial in the grinder' and 'Take the croissants out' count down, pinned at the top."></p>

1. **Use a project for checklists.** Open it, tap **⋯** and choose **Use for checklists**, or tick **Use for
   checklists** in **New project**. Everyone it's shared with gets a **Checklists** tab. Share it in Vikunja with the
   people who'll run it, at *Write*.
2. **Make a template.** Under Checklists, tap **New template**, name it, and write its steps, a row each: **Enter** or
   **Add a step** starts the next one, and a pasted list becomes a row a line. Move steps up or down, then tap **Make
   template**. In a template's sheet, tap a step to change it, or × to remove it; runs already started keep theirs.
   A task with its steps as subtasks can also be made one, with **Use as checklist template** in its sheet's **⋯**.
3. **Start a run.** Tap **Start** and choose who it's for: people who can work on the project. A name, like "Saturday",
   takes the place of "run 3" in the run's name. A run can be started without a connection, from the templates last
   seen under Checklists, and is set up once Pocket reaches Vikunja. A step assigned to someone in the template stays
   assigned to them in every run.
4. **Work through it.** One step at a time: **Done**, or **Skip**. A note typed on the step goes with either: **Done,
   with the note** saves it on the step, and **Skip with the note** makes it the reason. Add a photo or a note to a step,
   or a note to the whole run. **Last time** shows the notes from the last finished run of the same template, as a
   handover. After the last step, **Finish run**, with an Undo.

- **Who did a step** is a ✅ reaction on it, or ⏭️ for a skipped one, so Vikunja's web app shows it too. A step ticked on
  Today counts the same.
- **Today** shows your runs, under **Checklist runs**, and their steps that are due, each with its run's name, to the
  person who started the run and the person it's for. A run has no tick on Today: it's finished on its screen. Tapping a
  run opens it; tapping a step opens its run on that step.
- **The run on screen** updates by itself as teammates tick steps.
- **A run's ⋯** changes its name and who it's for, opens it as a task, reopens a finished run, and deletes a run with its
  steps. A run waiting to be set up can be cancelled with its ×. Finished runs are under **Finished lately**.
- **Offline:** ticks, skips, notes and photos are sent once Pocket reaches Vikunja, in the order you did them.
- **In Vikunja's web app**, a template is a done task labelled `template`, with its steps as done subtasks. A run is a
  copy of it, named like "Opening up · run 3 · Oct 4", which Vikunja links to the template as "copied from". The web app
  can't reorder steps, so reorder them in Pocket: it keeps the order in a line like `pocket:order 12 15 13` in the
  template's description (the steps' task numbers). Leave that line be; steps it doesn't list, like one added in the
  web app, come last. A run keeps the order it was started with. Everyone with *Write* access can change templates
  there too.

## Timed steps

Write the time in the step: "Dial in the grinder **in 20 min**", "Take the croissants out **after 18 minutes**", "Restock
the cups **20 minutes later**". A chip under the step shows what Pocket read, "⏱ 20m after the step before". To count
from another step, pick it in the chip, or write it: "Dial in the grinder **20 minutes after Turn on the espresso
machine**". Tap × to keep the words as they are. Words that tell what to do, like "steam **for** 2 minutes", aren't read
as a time.

Pocket saves the time in the step's title in the template, written the way PLC programs write times, which is also how
to write one in Vikunja's web app:

| In the step | It's due |
| --- | --- |
| `Wipe the counters T#20m` | 20 minutes after the step before it is done. On the first step, 20 minutes after the run starts. |
| `Put the croissants in the oven {#croissants}` | When it's next. `{#croissants}` names the step "croissants". |
| `Take the croissants out T#18m:croissants` | 18 minutes after the step named "croissants" is done, whatever is done in between. |

- Units are `d`, `h`, `m`, `s` and `ms`, and they combine: `T#1h30m`. A step without a `T#` has no due date: it's simply
  next.
- Picking a step to count from gives it a name made from its first words, like `{#put-the-croissants}`.
- A time counts from an earlier step, and each name is used once. Pocket checks this as you write the steps, when you
  move one, and when you start a run.
- A run's steps get their titles without `T#` and `{#…}`.
- On the run screen, a timed step says what it waits on ("Due 18m after “Put the croissants in the oven”"). Once that
  step is done, it counts down. Countdowns for other steps are pinned above the step on screen, soonest first.

## Step times

Timed steps get due dates in Vikunja, and so show on Today and in Vikunja's web app, through the plugin's step times:
`steptimes: true` in the [install's config](../README.md#install). Without it, Pocket still counts down on the run
screen.

What it does: when a step of a checklist run is marked done (in Pocket, in Vikunja's web app, or through the API), the
plugin sets the due date of each step of the same run timed from it: the time it was marked done, plus that step's
time. When the step is marked not done again, the steps waiting on it lose that due date until it's done again, so no
reminder goes off for a step that's still waiting. It writes only due dates (not even when a task was last changed),
and the time of a reminder counted from the due date, only on steps of that run that aren't done, and only when the
date changes. It only acts on a run Pocket would make: the run and its steps in one project, each step with the time
it was started with (or, for a run started before Pocket kept those, copied from a step of a template labelled
`template` in the project). It doesn't act on templates, or
on a done step saved again. All of it is in one function, `writeStepDueDates` in [`pocket/main.go`](../pocket/main.go).
It can also be turned on with `VIKUNJA_PLUGINS_POCKET_STEPTIMES=true`.

A step ticked offline counts, in Vikunja, from when the tick reaches it. Pocket counts down from when you ticked it.

What it can't do:

- Vikunja's web app, and apps that sync through CalDAV, save a whole task from the copy they loaded. A step saved that
  way from a copy loaded before its due date was set loses the due date again (and its reminder). Pocket still counts
  down to it.
- The plugin sets due dates without changing when a task was last changed, so apps that sync through CalDAV, and
  Vikunja's saved filters, don't see them until the step is changed some other way.
- A tick Vikunja handles while it's restarting, or more than 2 minutes late, sets no due dates.

## Reminders and alerts

Pocket promises only what always works: **timers ring while Pocket is open, and reminders arrive by email when it's
closed.** It shows no system notifications and asks for no permission.

**While Pocket is open:**

- A run's countdown that reaches zero chimes, says so, and vibrates on Android, once per step. The sound is made ready
  when you tap Start or Done, as phones only allow sound after a tap. On an iPhone with the silent switch on, it may not
  sound.
- While a run with a countdown is on screen, the screen stays on, where the phone allows.
- Today moves tasks to Overdue as their time passes, and says when a task's due time or reminder passes while you're
  looking.
- The app's icon shows how many tasks are overdue, on phones that allow it.

**While it's closed, Vikunja emails reminders** to the task's creator and the people it's assigned to. That needs mail
set up on the server (`mailer` and `service.enableemailreminders` in Vikunja's config; on Cloudron, it's set up for
apps already), and reminder emails turned on in your own Vikunja settings. Pocket sets reminders in three places:

- **Reminders** in a task's sheet: at the due time, 15 minutes, an hour or a day before it, which move with the due
  date, or at a set date and time.
- **🔔 in quick add:** type a time ("at 4pm", "in 2 hours") and a 🔔 chip offers a reminder at it. It's off until you tap
  it. A day without a time ("friday") gets none, and it only shows when Vikunja's reminder emails reach you.
- **Timed steps** of a run get a reminder at their due time, which goes to whoever started the run and anyone who's
  claimed the step. It goes off once the plugin's [step times](#step-times) give the step its due date. A step due less
  than a minute after the one it waits on gets none: Vikunja checks reminders once a minute, so it would never be sent.
  Pocket still rings for it while it's open.

Vikunja's web push, being worked on in [go-vikunja/vikunja#4020](https://github.com/go-vikunja/vikunja/pull/4020), would
let reminders ring the phone too.

## Offline

Pocket opens without a connection and shows your lists as they were last loaded.

<img src="screenshots/pocket-offline.png" width="320" alt="Pocket offline: a banner saying what's sent once back online, and 'Buy till receipt rolls' tinted under Today, waiting to be sent">

- **What works offline:** new tasks and subtasks, comments, and what you do in a checklist run. A task waiting to be
  sent has a light tint and a dashed circle; its × cancels it and puts its words back in the box. Ticking off or editing
  other tasks needs a connection, and the offline banner says so.
- **Nothing you write is lost:** a comment, notes, subtasks, a step's note or a new template is kept on the phone until
  it's sent, even if Pocket is closed, and through a sign-in that runs out. Something Vikunja turns down for good says
  what it was, and its words go back in the box. Notes someone changed elsewhere while you wrote yours aren't written
  over: both are shown, and saving again replaces theirs.
- **Sending:** waiting things are sent when Pocket is opened, when it comes back to the front, and when the connection
  returns, in the order they were done, and a connection that drops halfway doesn't send anything twice. Vikunja not
  answering within 20 seconds counts as no connection. On an iPhone, waiting things are sent the next time Pocket is
  opened, since iPhones don't let web apps send in the background.

## Signing in with an API token

If single sign-on and passwords don't suit you, Pocket also takes an API token. In Vikunja, go to *Settings → API
Tokens*, choose the **Task Management** preset, and also tick:

- **User** and **Users** under *Other*, and **Users search** under *Projects*: to find people for `@priya` and check that
  they can see the task's project. Without **Users search**, `@priya` still works, but people aren't suggested and no
  project is picked for them.
- **Create**, **Update** and **Delete** under *Projects*: to create projects from quick add, to rename, archive and use
  them for checklists, and to delete them.
- **Reactions**: for checklists, to record who did each step.

A token is kept by Pocket alone, so signing in or out of Vikunja's web app doesn't affect it.

## Troubleshooting

- **Pocket's address shows "not found":** look for lines mentioning `pocket` or `plugin` in Vikunja's log.
  - `couldn't find app/index.html`: the files aren't at `plugins/pocket/app/`.
  - `Failed to load yaegi plugin pocket`: the plugin didn't load, for example because a Vikunja update changed how
    plugins work. Vikunja itself keeps running.
  - Nothing at all: plugins aren't turned on, or Vikunja hasn't been restarted since.
- **Stuck on Vikunja's page after single sign-on:** on the home screen, single sign-on opens in the same window and ends
  on Vikunja's page. Close that page to come back to Pocket. In a browser, it opens a new tab that closes by itself.
- **"Too many attempts from here":** Vikunja allows 10 sign-in attempts a minute from one address. Wait a minute.
- **"That token didn't work":** the token has expired, or **User** under *Other* isn't ticked.
- **"Your API token doesn't allow this":** the token is missing a permission ([see above](#signing-in-with-an-api-token)).
  Vikunja can't add permissions to an existing token, so create a new one.
- **"@priya can't see Inbox":** you can only assign people a project is shared with. Add a `+project` they can see, or
  share the project with them in Vikunja.

## Privacy and security

- Pocket has no server of its own. Vikunja serves its files, and Pocket only talks to that same Vikunja.
- Pocket uses Vikunja's own sign-in, stored in the browser where Vikunja's web app keeps it, and renews it the way
  Vikunja does. To revoke an API token entirely, delete it in Vikunja.
- For offline use, Pocket keeps the lists it last loaded, what's waiting to be sent, and what you're still writing, in
  the browser on that device. Signing out removes them, and asks first if something is still waiting.
- Notes and comments are cleaned before they're shown, and attachments other than images, PDFs and plain text are
  downloaded instead of opened. Together, these stop content from people you share projects with from running code
  inside Pocket, which shares its web address with Vikunja.
- The plugin runs inside Vikunja, so read [`pocket/main.go`](../pocket/main.go) before installing it. It serves the
  files in its `app/` folder and, with step times on, sets the due dates of checklist steps, and nothing else.
