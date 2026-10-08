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
- [Opening at once](#opening-at-once)
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
  date stays in view until tonight instead of vanishing into a project. A task with subtasks still open is a card
  there (below), never rows of its subtasks. A task is overdue once its time has passed, as
  in Vikunja: "friday" is due at your default due time, noon unless you changed it. One due at midnight, as Vikunja's
  web app sets a day without a time, is overdue once that day is over. Left open, Today moves tasks to Overdue as their
  time passes, each lighting up for a moment as it moves. **Move all to today** brings every overdue task to today, each
  at the time of day it had, or the next whole hour if that time has gone today; a line under the Overdue heading says
  how many moved, "Moved 6 to today", with **Undo**. A repeating task stays where it is: tick it to move it on to its
  next date. On a card, its task and its subtasks that are overdue themselves are moved; a run's steps stay, as their
  run times them.
- **Cards on Today:** a task with subtasks still open (or a checklist run with steps still open) shows on Today as a
  card: its title, with its due date, priority and project under it, and below that one line for a step, with that
  step's own tick, **+ me** or who's on it, and progress, its bar along the step line's bottom.
  Tap the title to open the task; it has no tick, so close it in its sheet, or on Projects, where ticking a task closes
  its subtasks. The step showing is the next one still open, in the order of its project's **List view** (a run's in its
  own order), whoever it's for, or the subtask of yours that brought the card onto Today. Ticked, a step stays on the
  card, ticked, until the ticks leave together; then the step after it comes in. Holding the step line and sliding sets
  that step's progress, never the task's, and stops at 100%, which ticks it: the next step only comes in after. Under
  the step line, at the card's foot, is its strip: a line in segments, one for each subtask, each filled once its step
  is done, with the step showing outlined on it, and "3 of 5" at its end, where that step is among all the subtasks,
  done ones too. With more than one step open, **‹** and **›** at the strip's ends page through the open ones, and so does a plain
  swipe left or right anywhere on the card (hold first, and it's progress instead): with the first two done, from 3 to
  4, 5, then back round to 3. Tapping a step's segment on the line shows that step, if it's still open (a done one's
  does nothing). Done steps are on the run's screen, or in the task's sheet. Leaving Today puts every card back on its
  next step. Past 12 steps, the line has a tick at each step instead of segments, each step's stretch filled once it's
  done, and the outline is around that step's stretch; those are too small to tap, so page with the arrows or a swipe. A screen reader hears the line as "2 of 5
  subtasks done", the card named by its title, and the step line as "Step 3 of 5: Load chairs".
- **What brings a card onto Today:** its task being due (overdue, today or in the next 7 days); one of its open subtasks
  being due then; a subtask assigned to you that's due, or that was made today without a date (Vikunja doesn't keep when
  a task was assigned, so one made before today doesn't keep the card there); or, for a checklist run, its being yours
  or your being on one of its steps. A card sits in the group of the earliest date that brought it, as a task by its
  due date; with no date, a run's is under **Checklist runs** and anything else under **Added today, no date**.
- **A task's row** has three parts, each the row's full height: its left edge ticks it (the whole margin, not only the
  circle), its title opens it, and its right end says who's doing it, or **+ me** (see **Assigning**, below).
- **Two screens, two jobs:** Today is for doing; Projects, search and a task's sheet are for managing. On Today, a
  task's row (or a card's step line) is ticked, claimed, opened, and held and slid sideways for its progress, and that's
  all: a plain swipe does nothing there but page a card, so nothing is deleted by a slip on the screen you use fastest,
  and holding a task doesn't move it, since Today is in the order things are due. Its **⋯** still deletes it. On a project's list and in a task's
  sheet, a row can also be swiped left to **Delete** it, and held and moved up or down to move it; in search, swiped to
  **Delete**, but not moved, as search's results have no order of their own. No swipe ticks a task, anywhere.
- **Ticking off:** a ticked task stays where it is, at the same height, ticked and struck through, so nothing moves
  under your finger. Tick it again to take it back. Three seconds after your last tick (counted from when your finger
  lifts, and not while it's still on the screen or the list is scrolling), everything you ticked leaves together, the
  tasks below closing up once; leaving the screen sends them at once. A task's open subtasks are closed with it, without
  asking, show ticked under it, and leave with it; ticking it again opens only those, not one that was done before,
  with the progress each had. A subtask that repeats is left alone, since closing it would only move it to its next
  date. On a project's list, ticked tasks go to its **Done** section, whose count goes up; in search, from Open to Done;
  ticked again in a list of done tasks, they move back the same way. A repeating task shows ticked, then comes back
  open, at its next date, or leaves Today if that's more than a week away; ticking it again before then puts its date
  back. In a task's sheet, a subtask ticked stays there, ticked; the sheet's own tick says under its subtasks how many
  it closed, with an Undo. An Undo leaves alone a task that was changed elsewhere since. A screen reader hears each
  tick: "Done: Call Ana". With less motion asked for on the phone, ticked tasks fade out rather than fold away.
- **Progress:** hold a task until it lifts (and, on a phone that can, you feel a tick), then slide sideways to set how
  far along it is. It stops at 0, 25, 50, 75 and 100%, with a tick at each; progress set elsewhere (40%, say) stays as it
  is until you slide it, then goes to the nearest of those. Sliding to 100% fills the tick and marks the task done;
  100% is reached a little short of the screen's edge, so it's in easy reach from wherever you hold. Moving up or down
  after the hold moves the task instead, on a project's list and in a task's sheet (see **Order**, below); anywhere
  else it lets go, changing nothing. Holding a task never selects text, the task's or any near it; a task's notes and
  comments can still be selected to copy, by holding them. The same works on the bar in a task's sheet (the arrow keys move it a stop
  at a time), and on a subtask's row there. A checklist run's bar shows how many of its steps are done instead, and a
  run's steps are held and slid the same way. The bar is all that shows it, with no message: to take it back, slide it
  back. Sliding a task, a subtask or a step no one is doing says you're doing it: **+ me** turns into your picture as
  you start, and it's assigned to you once you let go, if the slide changed its progress (let go where it started, and
  nothing is). Someone else's stays theirs. Sliding it back to 0% later keeps it yours: tap your picture to let it go.
  The bar in a task's sheet does the same, slid or moved with the arrow keys, and its **Assigned** row shows you at
  once. The first time, the first task on a screen that you can slide says "Hold and slide to start working on it",
  until you first set a task's progress this way, or tap it away; the phone remembers. It fades where it is, and its
  space closes a second after your finger lifts, so the tasks under it never move while you're touching the list.
  On an iPhone, Safari has no way to make the phone tick, so Pocket uses a
  trick that works since iOS 18 and may stop working; the percentage always pulses at each stop as well.
- **Order:** a project's list is in the order of its **List view** in Vikunja's web app, each subtask under its
  parent in its own order, so both show the same order; a task's subtasks in its sheet are in that order too. To move
  a task, hold it until it lifts, then move it up or down: it follows your finger, with its subtasks, the tasks it
  passes move aside to make room, with a tick at each, and near the top or bottom of the screen the list scrolls on.
  Let go, and it's there, in Vikunja too. A task moves only among the tasks at its level: a top-level task among the
  top-level ones, a subtask among its parent's subtasks (moving one to another parent is for later). Today and search
  keep their own order, and a done task, one waiting to be sent, or one in a project shared with you to read stays
  where it is. Without a connection, a move is kept and sent later; one Vikunja turns down goes back, and its row says
  why. The task's **⋯** has **Move up** and **Move down**, and **Alt+↑** and **Alt+↓** move the row that has the focus:
  the ways for a keyboard or a screen reader. A project whose List view was deleted in Vikunja is in the order its
  tasks were made, and can't be reordered. A checklist's steps keep an order of their own (see **In Vikunja's web
  app**, under Checklists).
- **Deleting:** on a project's list, in search or in a task's sheet (not on Today), swipe a task's row to the left,
  starting away from the screen's edge, and tap **Delete**; or swipe on past half the row, until the red fills it (and,
  on a phone that can, you feel a tick), and let go. Back under half before you let go, it's only left open. Swipe
  back, or tap anywhere else, to leave it. Deleted, the row carries on off the screen to the left, and its place stays
  as a gap, at the same height, so nothing moves, with only "Deleted" and **Restore** where "+ me" was: tap anywhere
  on the gap to bring the row back, sliding in from the left. (With less motion asked for on the phone, it doesn't
  slide.) The gap closes with the tasks you ticked, three seconds after the last, and the task is deleted in Vikunja
  then, or as soon as you leave the screen or put Pocket away; nothing is sent before. A task with subtasks asks first,
  and they go with it. The task's **⋯** deletes it too, on any screen: the way on Today, and for a keyboard or a screen
  reader. Its row turns into the same gap. Without a connection, it's deleted once Pocket reaches Vikunja.
- **The task sheet:** due date, repeat, project, priority, progress, people, labels, notes, subtasks, attachments and
  comments. Changes save as you make them. Subtasks are added with the same box as quick add, except `+project`: a
  subtask stays in its task's project. In a project for checklists it doesn't read dates either, as a task's subtasks
  there may become a template's steps, whose time is their own; a chip says so. Moving a task to another
  project takes its subtasks along. The **⋯** at the top of the sheet shares its progress (see **Sharing progress**,
  below), and deletes it, with its subtasks: its row in the list then is a gap with **Restore**. Tap the project above the title to open it. Adding a subtask, ticking one or setting its progress shows
  on its row only, with no message. A change that isn't saved goes back, and the sheet says so under what it's about
  (at its top, under its notes, under its subtasks), with **Try again** where that helps. A tap anywhere on a row
  like **Due**, **Repeats**, **Reminders** or **Project** works it, not only on its box: the date's calendar, the
  list to pick from, or **Add** for labels and people. The × that clears a date is still its own.
- **Sharing progress:** a task's **⋯**, a project's **⋯** and a run's **⋯** have **Share progress as a text**. It opens
  the phone's share sheet, to send it in a message, as a few plain lines:

  ```
  Pack the van  ▰▰▰▱▱ 50%
  ✓ Load chairs
  ◐ Tables 50%
  ○ Sound system · Priya
  ○ Lights
  ```

  The bar is the task's own progress, or, when it has none, how many of its subtasks are done: "1 of 4 done". Each
  subtask is ✓ done, ◐ under way (with how far), or ○ not begun, with its own subtasks under it, two spaces in. A person
  is the first word of their name in Vikunja, or their username, and a due date is a few words: "due Fri", "overdue
  since Mon". On a long list, more than 10 lines with more than 5 done, the done ones are one line: "✓ 8 done". A
  project's is its open tasks in its list's order, each with its open subtasks, under its counts: "Café  12 open · 5
  done". A run's says who did each step, "✓ Load chairs · Priya", who skipped one, and who's on the rest. Notes aren't
  included. Where there's no share sheet (on most computers), the text is copied instead, and the sheet says "Copied:
  paste it into a message".
- **Copying:** beside it, **Copy as a Markdown list** copies the same as a list to paste into notes or a document, with
  nothing collapsed: `## Pack the van (50%)`, then `- [x] Load chairs`, `- [ ] Tables (50%)`, `- [ ] Sound system
  @priya`. **Open in Vikunja ↗** opens the task, the project or the run in Vikunja's web app. In a task's sheet, the
  copy button beside **Notes** copies its notes as plain text, and the one on each comment copies that comment.
- **Search:** the magnifier finds open and done tasks in all your projects, by words in their title or notes, or by
  number. A ticked result moves from Open to Done. A subtask is a row, under its task when that's found too, as on a
  project's list.
- **Where Pocket says what happened:** in the place it happened, not at the bottom of the screen. A tick or a deletion
  shows on the task's row itself, which stays until they leave together; a tick that couldn't be saved goes back, and
  its row says why, "Not saved: no connection", with **Try again**. A task added from quick add lights up where it went; if that's not on the screen
  you're looking at (a task due next month, added on Today, or one for another project), a note by the add box says
  where, "Added to Orders, due Friday", with **Open**. The bottom of the screen is left for what has no place of its
  own: a countdown reaching zero, a screen that couldn't load, and what's done once its sheet has closed. A screen
  reader hears each message.
- **Adding subtasks from the bottom box:** on a project's list, the box at the bottom says "Add a task to Moving
  day" and adds tasks to that project. Touch a task (open its sheet and close it, tick it, or slide its progress) and
  its row lights up, and the box says "Add a subtask to Pack the van": what you type there now goes under that task,
  after its last subtask. Touch a subtask instead, and they go right after it, under its parent: "Add a subtask to
  Pack the van, after Load chairs". A nudge touches a task too. Put your finger on it and
  scroll the list a little, slowly, less than a row's height, and it's the one the box adds to; a longer or quicker
  scroll is only a scroll. The box names it either way, so a wrong one is seen, and **×** undoes it. Press Enter and type the next: the keyboard stays open, and each goes after the one
  before. A subtask ticked done hands the box to its parent, so you can add more beside it. The box reads them as the
  sheet's subtask box does (no `+project`; a pasted list is a subtask a line), with no message: they show on their rows
  at once, and without a connection they wait there and are sent later. The **×** beside the task's name goes back to
  adding a task, and so does scrolling the task off the screen, or leaving the project. A run, a template, a done task
  and a project shared with you to read only can't be added to this way. Today's box always adds a task.
- **Projects:** your project tree with favorites, and the tasks in each: its open tasks, in order, then its done tasks
  in a section of their own, folded, with how many: tap **Done (24)** to open it, the most recently done first. Tick
  one there to open it again; it goes back among the open tasks. Pocket remembers, for each project, whether you left
  its Done section open. A done task with subtasks still open (ticked done in Vikunja's web app, which leaves its
  subtasks open, or one of them opened again since) stays among the open tasks, struck through, over those subtasks,
  saying "Done, but 2 subtasks are still open", so they're never left on their own as if they had no parent. Tap it to
  open its sheet; tick it to open it again where it is (tick it again within a few seconds to make it done again). It can't be moved, nor be what the bottom box
  adds to; its subtasks are like any others. A finished run with steps not done shows the same way. In search, a
  subtask whose task isn't above it there says which task it's under: "↳ Pack the van". **New project** makes one, inside
  another if you like. A project's **⋯** shares its progress, and renames or archives it if it's shared with you to write, and deletes it if
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

**Who's doing a task, a subtask or a step:** every task's row, every subtask in a task's sheet, and every step of a
run, has a slot at the end of its row (not a checklist run or a template, whose row says who they're for). **+ me** says you'll do it, which assigns it to you; tap your picture to let it go. Someone else's picture
shows who has it; to hand it over, open it and use **Assigned** (a run's step: the run's **⋯** → **Open as a task**,
then tap the step). Two people who say they'll do a step
at the same moment don't both get it: the first keeps it, and the other is told. Done or skipped is still recorded for whoever taps it,
whoever has the step, and claiming never ticks anything. A step you claim in someone else's run brings the run onto
your Today, as a card opened on your step.
Sliding the progress of one no one is doing claims it for you too (see **Progress**, under Tasks).
Vikunja tells the task's creator (for a step, whoever started the run) when you claim it.

## Checklists

Checklists are the things done the same way again and again: opening up, closing down, a delivery check. Each start of
one is a run, with who did each step and when. They're ordinary Vikunja projects and tasks.

<p align="center"><img src="screenshots/pocket-checklist.gif" width="300" alt="Starting a run of the café's Opening up template: its steps have square boxes, and its line a segment for each step. Once the espresso machine is on and the croissants are in, 'Dial in the grinder' is due in 20 minutes, and 'Take the croissants out', due in 18, is pinned at the top."></p>

1. **Use a project for checklists.** Under Projects, **Set up checklists** makes a project called Checklists with an
   example template to try, "Example: Opening up": start it, then change it into your own or delete it. Or open a
   project of yours, tap **⋯** and choose **Use for checklists**, or tick **Use for checklists** in **New project**.
   Everyone it's shared with gets a **Checklists** tab. Under Checklists, **Getting started** says what's next, for the
   project's owner, until it's hidden; the project's **⋯** shows it again.
   **Share it** with the people who'll run it. That's done in Vikunja's web app, not in Pocket: the link in Getting
   started, or **Share it in Vikunja** in the project's **⋯**, opens its share page. Pick **Read & write**: Vikunja
   starts on *Read only*, which lets them see runs but not tick steps.
2. **Make a template.** Under Checklists, tap **New template**, name it, and write its steps, a row each: **Enter** or
   **Add a step** starts the next one, and a pasted list becomes a row a line. The name and each step are read as quick
   add reads a task, with the same chips: `@priya` assigns it, `*front` labels it, `!3` sets its priority. Dates aren't
   read there: a step's time is its own, and a chip says so. Each box, empty, says what it reads. Move steps up or
   down, then tap **Make template**. When it comes round, if it should, is set in its sheet once it's made. In a template's sheet, tap a step to change it, or remove it with ×; hold a step, then move it
   up or down, to move it (or tap it, and its **⋯** has **Move up** and **Move down**, as **Alt+↑** and **Alt+↓** do in its
   box). Runs already started keep theirs. **Notes and photos** under it opens the step in its own sheet: each run's copy of the step
   comes with its notes, so that's the place for how to do it.
   A task with its steps as subtasks can also be made one, with **Use as checklist template** in its sheet's **⋯**.
   Its **template** label is what makes it one, so its sheet doesn't offer to take that off; delete it from its **⋯**.
3. **Start a run.** Tap **Start** and choose who it's for: tap everyone it's for, one or more people who can work on
   the project, the template's assignees to start with. The steps say who each is for. A name, like "Saturday", takes the place of "run 3" in the run's name. A run can be started without a connection, from the templates last
   seen under Checklists, and is set up once Pocket reaches Vikunja. A step assigned to someone in the template stays
   assigned to them in every run.
4. **Work through it.** One step at a time: **Done**, or **Skip**. A note typed on the step goes with either: Done
   saves it on the step, and Skip makes it the reason. After Done, the next step that can be done is on screen, not one
   still counting down. Add a photo or a note to a step, or a note to the whole run; a step with notes has a mark on its
   row. **Last time** shows the notes from the last finished run of the same template, as a handover, and each step's
   card shows the ones left on it (ones that come after the run is on screen from the next step on, so the steps
   don't move). ‹ and › beside the step's number show the step before and after. On a long run,
   the bar with the count stays at the top: tap it to go back up. A skipped step counts as skipped, not done. A run
   just started says so at its top, with an Undo, until anything's done in it. After the last step, **Finish run**,
   with an Undo. Ticking a run in its project's list, or in its sheet, finishes it too, shown as a task's tick is (in
   its sheet, with an Undo); with steps not done, it asks first, and they stay not done.

- **A checklist that comes round:** give the template a date in its sheet, under **When it's due**, and how it
  **Repeats**: every day at 8:00, say. It's then Vikunja's repeating task: at its time it shows on Today, without a tick,
  to its assignees (or, with none, everyone who can work on the project), and Vikunja emails its reminders. Tapping it
  opens Start. Starting a run of it on the day it's due moves it on to its next time, and the run is due at the time
  the template was, so one left open shows as overdue; the Start sheet says which time it's for. A start at 7:55 is the
  8:00 one. One left for weeks moves on to its next time after now: missed times aren't made up. Under Checklists, its
  line says when it's next due. Without a repeat, starting it ends the schedule; taking its date off does too, and
  keeps its repeat for a date given again. On Today before its day, it says **Checklist, for then**: starting it early
  doesn't move it on. **Move all to today** leaves it where it is, and isn't offered when it's all that's overdue. Runs of the same template can be open at once. A task with a due date made a
  template comes round at that date.
- **A step the template doesn't have:** in **Steps**, the **›** at the left of any step opens a box under it, like the
  subtask box: what's typed in it and added with **+** is a step after that one, for this run only (a pasted list, a
  step a line). The last step's › adds one at the end. Quick add reads labels, people and priority there, but not
  dates. **🔁** beside it puts that step in the box: left as it is, **+** does that step again, as a fresh copy, not
  done, with the template's notes and photos for it but none of this run's; changed, it's a new step. Escape, or its ›
  again, closes the box, keeping what was typed for next time; 🔁 tapped again puts that back. Either says
  **Inserted** or **Repeated** under its title, here, in the run's sheet and in Last time, and works like any step,
  offline too. A run's sheet has no subtask box: steps are added on its screen, so they're marked. One that isn't done yet can be deleted with the ×
  on its row while it's on screen. The template never changes; a step from the template can't be taken out of a run,
  only skipped.
- **Who did a step** is a ✅ reaction on it, or ⏭️ for a skipped one, so Vikunja's web app shows it too, with when:
  "Done by Priya at 4:46 PM". Vikunja lets each person take off only their own ✅, so marking someone else's step not
  done asks first: theirs stays on it. A step ticked on
  Today counts the same.
- **Today** shows your runs in progress, to the person who started the run and the person it's for, each as a card
  (see **Cards on Today**, under Tasks): its name, who it's for, and its next step, with its countdown when the step is
  timed ("in 18m", "5m late"). A step ticked there is ticked as on the run's screen, with your ✅. A run's card is
  under **Checklist runs**, or with a step due, by that step's date. A run's line is in segments, one for each step,
  filled as steps are done (past 12 steps, one line with a small mark at each step): on its card, on its row under
  Checklists, and as the bar at the top of its screen. A run has no tick on Today: it's finished on its screen. Tapping
  a run's name opens it; tapping a step opens its run on that step.
- **A step has a square box**, wherever it shows: on its run's screen, in the run's sheet, and on Today. A task or a
  subtask has a round one. They work differently (a step's tick records who did it, with its ✅), so they look
  different. A template's numbered steps are square too.
- **The run on screen** updates by itself as teammates tick steps.
- **A run's ⋯** shares its progress as a text, with who did each step (see **Sharing progress**, under Tasks), changes
  its name and who it's for, opens it as a task, reopens a finished run, and deletes a run with its steps. A run waiting to be set up can be cancelled with its ×. Finished runs are under **Finished lately**.
- **Offline:** ticks, skips, notes and photos are sent once Pocket reaches Vikunja, in the order you did them. A
  **Not done** made offline isn't sent if the run was finished meanwhile. A step inserted offline can be called off from
  Waiting to send; whatever of it reached Vikunja is taken out.
- **In Vikunja's web app**, a template is a task labelled `template`, its title starting "TEMPLATE: " so it isn't
  deleted by mistake, with its steps as done subtasks. It's done, unless it comes round: then it's a repeating task
  there, and ticking it there skips that time without a run. Pocket shows the name without "TEMPLATE: ". A run is a
  copy of it, named like "Opening up · run 3 · Oct 4", which Vikunja links to the template as "copied from". The web app
  can't reorder steps, so reorder them in Pocket. A template is done, and Vikunja's List view leaves done tasks out, so
  a step's place there can't be read back: Pocket keeps the order in a line like `pocket:order 12 15 13` in the
  template's description (the steps' task numbers). Leave that line be; steps it doesn't list, like one added in the
  web app, come last. A run gets a line of its own when it starts, so it keeps the order it was started with, and a step
  inserted in it goes in its line. A step added during a run has a line `pocket:added`. Everyone with *Write* access can
  change templates there too.

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
- A step inserted during a run has no time, and isn't "the step before" for the step after it. A repeated step has no
  time of its own, but a step timed from the one it repeats counts from whichever of them was done last.
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

## Opening at once

Today, a project, Checklists and Projects open at once, with the copy of them Pocket kept last time, while it loads
them again behind. Anything changed since then changes in place: a row ticked elsewhere folds away, one added elsewhere
fades in, and the rest stay as they are, under your thumb. If loading takes over a second, a thin line runs under the
header. While you're on one screen, Pocket loads Today, the project you opened last and Checklists in the background,
one at a time and only when the phone is idle, so they're up to date when you switch to them; not without a
connection, nor when the phone is set to save data. A run opens once it's loaded, with Last time's notes when they
come quickly; ones that come later are shown under the run straight away, and on a step's card from the next step on,
so the steps never jump down under your thumb.

What you do shows at once too. A new task is on its list straight away, where it will be; it looks waiting (a light
tint and a dashed circle, or "waiting to send" on a run's step) only if Vikunja hasn't answered after a few seconds,
and right away without a connection. If Vikunja turns it down, it goes back as it was, and says so.

## Offline

Pocket opens without a connection and shows your lists as they were last loaded.

<img src="screenshots/pocket-offline.png" width="320" alt="Pocket offline: a banner saying that ticking off or changing tasks needs a connection, except on a run, and 'Buy till receipt rolls' tinted under Today, waiting to be sent">

- **What works offline:** new tasks and subtasks, comments, and what you do in a checklist run. A task waiting to be
  sent has a light tint and a dashed circle (online, once it has waited a few seconds); its × cancels it and puts its
  words back in the box. Ticking off or editing
  other tasks needs a connection.
- **What's waiting:** while anything waits to be sent (without a connection, or for more than a few seconds), the
  refresh button at the top turns amber, with how many. Tap it
  for **Waiting to send**: each thing in words ("Done: Check the milk fridge", "Photo for “Restock cups”"), when you did
  it, and **Don't send it** on anything not started yet. **Try now** sends what it can.
- **Nothing you write is lost:** a comment, notes, subtasks, a step's note or a new template is kept on the phone until
  it's sent, even if Pocket is closed, and through a sign-in that runs out. A task or note Vikunja turns down for good
  says what it was, and its words go back in the box. A tick, skip, claim or finish it turns down is kept: the button
  turns red, and Waiting to send says why, with **Try again** and **Don't send it**. Until then, anything done after it
  on the same task waits behind it. Notes someone changed elsewhere while you wrote yours aren't written over: both are
  shown, and saving again replaces theirs.
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

The preset already includes what moving tasks needs: **Position** under *Tasks*, and reading a project's views. A token
made without them shows each project in the order its tasks were made, and a move says which permission is missing.

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
- To open at once and offline, Pocket keeps the lists it last loaded, what's waiting to be sent, and what you're still
  writing, in the browser on that device. Signing out removes them, and asks first if something is still waiting.
  Someone else signing in on that device never sees them: Pocket drops another account's lists before showing any.
- Notes and comments are cleaned before they're shown, and attachments other than images, PDFs and plain text are
  downloaded instead of opened. Together, these stop content from people you share projects with from running code
  inside Pocket, which shares its web address with Vikunja.
- The plugin runs inside Vikunja, so read [`pocket/main.go`](../pocket/main.go) before installing it. It serves the
  files in its `app/` folder and, with step times on, sets the due dates of checklist steps, and nothing else.
