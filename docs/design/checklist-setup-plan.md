# Setting up checklists, for their owner — plan

Agreed 2026-10-06, after the GUI test round: every first-time tester tripped on the same four points when setting up a
project for checklists, and the user asked for Pocket to set one up itself, with an example to try.

The four points:

1. A project made "for checklists" opened on its empty task list, not on Checklists.
2. Nothing in Pocket said sharing is done in Vikunja's web app, and Vikunja's share dialog starts on Read only.
3. Nothing hinted that `@priya` in a step gives it to Priya.
4. When a template comes round was only found in its sheet, once it was made.

All of it is links and words, and one button that makes what New project and New template make already. No new data,
and nothing new on Vikunja's side (Pocket's plugin stays a file server).

## Set up checklists

While you have no project for checklists, Projects, and Checklists' empty screen, have a card:

> **Checklists**: step-by-step lists people run again and again, like opening up or a weekly clean.
> **[Set up checklists]**
> Makes a project called Checklists, with an example template to try.

The button makes, as New project and New template would:

- a project "Checklists", for checklists;
- a template "Example: Opening up", whose notes say it's an example to try, then change or delete, with four steps:
  the first for you (as `@you` would make it), the third due 18 minutes after the second (as "in 18 min" would);
- then it opens Checklists.

Offline it says it needs a connection. If the example can't be made, the project stays, and Checklists says so.

## Getting started

On Checklists, a project's owner (or someone it's shared with as admin: they can share it) sees a card above its
templates until they hide it, kept per phone:

1. **Share it** with the people who'll run its checklists, in Vikunja's web app, at **Read & write**. A link opens
   Vikunja's share page for that project (`/projects/<id>/settings/share`).
2. **Write a template**: the list each run copies, a step a line. "@priya" gives a step to Priya, and "in 18 min"
   makes it due 18 minutes after the step before. A link opens New template.
3. **Have it come round**, if it should: in the template's sheet, under When it's due, a date and Repeats. It shows on
   Today then.

The same share link sits in every project's ⋯ for its owner, with a line saying Read & write is what lets people tick.

## Around it

- A project made with New project and "Use for checklists" opens on Checklists, with the card.
- New template says, under its steps, that when it comes round is set in its sheet once it's made.
- Every quick add box says what it reads while it's empty, `@person` included (see the fix round of the same day).
