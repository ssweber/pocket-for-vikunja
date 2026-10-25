# What Pocket stores in Vikunja

How Pocket's templates, checklists, timers and answers look in Vikunja, for anyone editing them in Vikunja's web app or reading them for an export. The [guide](guide.md) covers using Pocket.

- [Templates and checklists](#templates-and-checklists)
- [Pocket's lines in descriptions](#pockets-lines-in-descriptions)
- [Timers](#timers)
- [Asks](#asks)
- [Answers](#answers)
- [Reactions](#reactions)
- [What the plugin writes](#what-the-plugin-writes)

## Templates and checklists

- A template is a task labeled `template`, titled "TEMPLATE: …", with its steps as done subtasks.
- A repeating template is a repeating task. Ticking it in the web app skips that occurrence.
- A checklist is a copy of the template, named like "Opening up · Oct 4 · #3". A name given when it starts, such as "Saturday", replaces the number.
- A checklist's steps are its subtasks. A step's notes, photos and asks are copied from the template's step, as are the template's own notes, attachments, labels and assignees.
- In Pocket, only the template's creator or an admin of its project can change it, delete it, or make a task into a template. Vikunja's web app doesn't know this rule, so anyone with write access can change a template there.
- The web app doesn't know the template's switches either, so a step can be ticked there at any time.

## Pocket's lines in descriptions

Pocket keeps its own records as lines in descriptions. Pocket hides any line starting with `pocket:` from the notes and keeps it when the notes are edited. Leave them in place.

| Line | In | Means |
| --- | --- | --- |
| `pocket:checklists` | A project's description | The project holds templates and checklists. |
| `pocket:order 12 15 13` | A template's or checklist's description | The step order, by task id. Steps it doesn't list sort last. |
| `pocket:wait` | A template's or checklist's description | **Enforce step times** is on. |
| `pocket:in-order` | A template's or checklist's description | **Enforce step order** is on. |
| `pocket:run` | A checklist's description | The task is a checklist. |
| `pocket:step Preheat T#10m` | A checklist step's description | The template step it was copied from. |
| `pocket:added` | A checklist step's description | The step was added or repeated on this checklist, not copied from the template. |
| `pocket:ask …` | A step's description | An ask. See [Asks](#asks). |
| `pocket:answer` | The last line of a comment | The comment holds answers. See [Answers](#answers). |

A checklist copies `pocket:wait` and `pocket:in-order` when it starts, so changing the template's switches changes only later checklists.

## Timers

A step's timer is part of its title, in PLC duration syntax:

| Step title | Due |
| --- | --- |
| `Wipe the counters T#20m` | 20 minutes after the previous step is done. For the first step, after the checklist starts. |
| `Put the croissants in the oven {#croissants}` | No timer. `{#croissants}` names the step. |
| `Take the croissants out T#18m:croissants` | 18 minutes after the step named "croissants" is done, whatever is done in between. |

- Units are `d`, `h`, `m`, `s` and `ms`, and they combine: `T#1h30m`.
- A timer must refer to an earlier step, and names must be unique. Pocket checks this when a template is edited, reordered or started.
- A checklist's steps have `T#` and `{#…}` removed from their titles. The timer is kept in the step's `pocket:step` line.
- A step added during a checklist has no timer, and isn't "the previous step" for the step after it.
- A step timed from a repeated step counts from whichever copy was done last.

## Asks

An ask is a line in a step's description:

| Line | Records |
| --- | --- |
| `pocket:ask Notes: text` | A line of text |
| `pocket:ask Temp: number °C 0..5` | A number. The unit and the range are optional and can come in either order. |
| `pocket:ask Seal intact: yes-no` | Yes or No |
| `pocket:ask Belt: choice Good \| Worn \| Replace` | One of the options |

- The label is everything before the first `: `. A step with one ask can leave the label out, and the step's title is the label then.
- A range is `0..5`, `..5`, `0..` or `-18..-15`. Both ends are included.
- Pocket ignores a line it can't read. The template's row for that step says which line.
- The web app's editor turns some typed characters into symbols, such as `--` into a dash. Paste a line to keep it exactly as written.
- Changing a template's asks changes only checklists started afterwards.

## Answers

Each set of answers is a comment on the step. It has one `Label: value` line per answer, then the line `pocket:answer`:

```
Temp: 7.5 °C
Seal intact: Yes
pocket:answer
```

- A number is written with a full stop for decimals, then its unit.
- The comment's author and time say who answered and when.
- A corrected answer is a new comment. The newest answer for a label counts, and older comments stay.
- A number outside its range is saved as typed.

To export answers, read the comments that end with `pocket:answer`, and the asks in the step's description for their types and ranges. Vikunja sends a webhook to a private address, such as an n8n flow on the same network, only with `outgoingrequests.allownonroutableips: true` in its config.

## Reactions

Vikunja doesn't record who ticked a task, so Pocket records it with reactions.

- A checklist step done in Pocket gets a ✅ reaction from the person who ticked it, and a skipped step gets ⏭️. The web app shows "Done by … at 4:46 PM".
- A comment typed on a step before **Skip** is the reason it was skipped.
- Any task ticked in Pocket gets the ticker's ✅. **Done today** lists the tasks with your ✅, tasks assigned to you, tasks in projects only you can see, and checklists you started. A task ticked in the web app gets no ✅.
- Vikunja lets people remove only their own reactions. Un-ticking someone else's step in Pocket asks first, and leaves their reaction in place.

## What the plugin writes

The plugin passes Pocket's changes to Vikunja's API as the signed-in user, so Vikunja checks permissions as it does for any request. It writes two things of its own:

- **The `pocket_relay` table.** It keeps Vikunja's answer to each change for 31 days, so a change sent twice is made once. The answers include the tasks they changed. Removing the plugin leaves the table in place, and it can be dropped.
- **Step due dates**, with `steptimes: true`. When a step is marked done, the plugin sets the due date and a reminder on each step timed from it, at the completion time plus the timer. Marking the step incomplete clears them. It writes only incomplete steps of that checklist, only when the date changes, and leaves the task's modified time alone. The code is `writeStepDueDates` in [`pocket/main.go`](../pocket/main.go). The [guide](guide.md#step-times) lists its limits.
