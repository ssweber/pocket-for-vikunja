# Copy today and Copy week

Done today's heading gets two buttons, **Copy today** and **Copy week**, so a manager can be told what got done on
which projects without anyone sorting or tagging tasks. The projects are the grouping.

## The buttons

- Both sit at the right of Done today's heading, 20px apart, each a 44px target. Today gets no taller.
- Copy week covers Monday to today. On a Monday it covers last Monday to Sunday and reads **Copy last week**, since
  this week so far would be the same as Copy today.
- Copy week loads the week's done tasks when tapped. Opening Today loads nothing more than before.
- Safari allows a copy only during the tap, so the text that is still loading goes to the clipboard as a promise
  (`ClipboardItem`).

## The text

Both buttons give the same shape. Projects with the most tasks come first, and tasks within a project run oldest
first. The week adds the day to each line.

```
Done this week · Mon, Nov 16 – Wed, Nov 18 · 9 tasks

Café · 5
✓ Wipe down the espresso machine · Mon
✓ Opening up · 9 of 11 done · Tue
✓ Restock › Call the milk supplier · Tue

Errands · 1
✓ Post the invoice · Wed
```

- A subtask names its parent when Pocket has the parent's title.
- The tasks are the ones Done today would list on each day (`doneByMe`), and ticks not yet sent count.
- A repeating task is not listed. Vikunja moves it to its next date instead of marking it done. The guide says so.

## Checks

- Unit: the week's dates on each weekday, the grouping and order of the text, which tasks Copy week keeps.
- Smoke: Copy today's text, and Copy week's text after a tick.
