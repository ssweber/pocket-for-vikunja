# Checklist goals

A template can have a goal: how many checklists from it should be finished a day, on which weekdays. Each template's
row on the Checklists screen shows the week's score, and **Copy goals** copies it as text with the time each
checklist finished. The goals are for the team, not per person.

## Decided

- **A goal is a count per day and a set of weekdays.** For example: Opening up, weekdays, 1 a day. Walkabout, weekdays,
  4 a day. No hourly slots and no window between two checklists. Start with a low count and raise it.
- **The times show bunching, not a rule.** The copied report lists the time each checklist finished, so four
  walkabouts done in ten minutes are plain to see.
- **A day counts the checklists finished that day, up to the goal.** A checklist that was started but not finished
  doesn't count. Days after today aren't scored.
- **Stored as a line in the template's description**, like the switches: `pocket:goal mon-fri 4 since 2026-11-23`,
  the date being when the goal was last set. Only someone who can change the template can change its goal. A
  checklist doesn't copy the line, because the score reads the template's goal.
- **A finished checklist belongs to the template it was copied from.**
- **The template's sheet** gets a Goal card under the switches card: a stepper for the count ("Checklists to finish a
  day") and seven weekday chips, Mon to Sun. A note under it: "Checklists shows how many were finished each day this
  week."
- **The template's row carries the week**, with no separate section. A template with a goal shows its ring where the
  checklist icon was, counting the week's finished checklists out of the goal so far. The line under the title replaces
  "4 steps": "4 a day · Mon 4 · Tue 2 · Wed 3", or at 1 a day only the misses: "1 a day · none on Wed", "1 a day · none
  missed". It may wrap. A template without a goal keeps its icon and step count. Every template's title starts at the
  same place, so the icon sits in a slot as wide as the ring.
- **Copy goals** is a link in the project's heading, left of Open project. The text is "Checklists this week · Mon,
  Nov 23 – Fri, Nov 27", then for each goal "Walkabout · 15 of 20 finished · 4 a day" and one indented line per day
  with its finish times, or "Wed none".
- On a Monday the rows show this week, so the rings start empty. Only Copy goals copies last week, as Copy week does.
- Tapping a template's ring opens the template, as the row does.
- On a row that wraps, the ring sits level with the title, at the top.
- The count's stepper goes down to Off, which removes the goal. Templates start with no goal.
- Repeats stays separate. It puts a template on Today when it's due, and a goal counts what was finished.

## Streak

A streak counts the goal's days in a row on which the template met its goal. It belongs to the template and the team,
never to a person.

- Only the goal's weekdays count. A weekend neither adds to a Mon–Fri streak nor breaks it.
- It reads "3 days in a row" up to two weeks' worth of the goal's days (10 for Mon–Fri, 6 for Mon/Wed/Fri), then "2
  weeks in a row", "3 weeks in a row". It shows from 3 days on, at the end of the row's line under the title and in
  Copy goals.
- Today only adds to it: the streak runs to yesterday, plus today once today's goal is met.
- A day on which no checklist from any template in the project was finished is skipped, as a day off. It neither
  counts nor breaks the streak. This needs no list of closed days. The week's ring and its "none on Wed" still show
  that day as short.
- A broken streak just disappears, with no message. Research on streaks finds that showing a broken one makes people
  give up, while showing one that still runs keeps them going.
- Changing the goal starts a new streak from the goal's `since` date, because Pocket keeps only the current goal.
  Pocket reads finished checklists back to that date, at most about 12 weeks.
- No streak freeze for now.
