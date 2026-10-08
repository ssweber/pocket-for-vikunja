# Task notes: saved as you type, with lists and checkboxes

A direction, split out of the motion and rows plan on 2026-10-08, to build after it (`motion-and-rows-plan.md`).
Unlike that plan, this one isn't settled: the questions at the end come first, and need the user's answers before
building.

## Today

A task's notes are edited in a plain textarea (`src/markup/sheet/task.html` ~line 81), opened by tapping them, with
Cancel and **Save notes** buttons. Pocket turns the text into HTML on saving (`textToHtml`) and back on opening
(`htmlToText`). Notes changed elsewhere are never written over: both versions are shown, and Save again replaces
(the user's rule of 2026-10-06; `descBase`/`descConflict`, `notesPatch` in `src/js/app/sheet.js`). Notes that couldn't be
saved stay as a draft through a reload.

## What's wanted

- **Saved automatically**, about a second after typing stops, and when the box loses focus or Pocket is hidden
  (`visibilitychange`), since iOS can close an installed app in the background without warning. A quiet "Saved" by the
  box, not a message elsewhere, and no Save button.
- **Enter makes a new line** (`enterkeyhint="enter"`), never sends or closes.
- **Lists and checkboxes are easy:**
  - typing `- ` starts a bullet, and `[] ` a checkbox;
  - a small bar above the keyboard has bullet and checkbox buttons (placed with the `--kb` value from part 1 of
    `fast-tasks-plan.md`);
  - Enter carries the list on, and Enter on an empty item ends it;
  - tapping a checkbox in the shown notes ticks it and saves.
- **Checkboxes in notes are marks, not tasks.** They don't count towards progress.
- **They work in Vikunja too:** written in the HTML that Vikunja's own editor (TipTap) uses for a task list, so a box
  ticked in either app shows ticked in the other.

## To settle first

1. **Autosave and notes changed elsewhere.** Saving every second makes a clash with an edit made elsewhere more likely
   to happen mid-typing. Recommendation: when a save finds the notes changed elsewhere, stop saving automatically and
   show both versions as now, until the user picks.
2. **Editing in a textarea or in place.** Keeping the textarea (text ↔ HTML) is simpler, and the `- ` and `[] `
   shorthand fits it. Editing the shown notes directly (contenteditable) is closer to Vikunja's editor, and much harder
   on phones. Recommendation: the textarea.
3. **Ticking a box in the shown notes** means letting `sanitize` keep checkbox inputs in notes, and saving the changed
   HTML. Check that this can't be used to sneak in anything else.
4. **Offline:** an autosave without a connection becomes a draft that waits, as notes do now. Through the outbox?
