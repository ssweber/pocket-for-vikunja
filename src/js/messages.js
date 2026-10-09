// What Pocket says when something happens, as plain sentences. Where each is shown is lines.js's; these only say it, so
// the unit tests can check them.
import {NetError} from './api.js';
import {dueInfo} from './dates.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// A change Vikunja didn't save: why, in a few words.
export const notSaved = e => e instanceof NetError ? 'Not saved: no connection' : 'Not saved: ' + e.message;
// A move Vikunja turned down; refused for an API token that doesn't allow it (api.js), the permission it needs.
export const notMoved = e => e?.code === 'token' ? 'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.'
  : 'Not moved: ' + (e instanceof NetError ? 'no connection' : e?.message || 'Vikunja turned it down');

/* Where tasks just added went, said by the add box when they aren't on the screen being looked at (a task due next
   month, added on Today; one for another project). `n` tasks, or with `nest` one with n - 1 subtasks, in `project`, the
   one task due `due`. `but`: what didn't go as asked (", but …"). */
export function addedWhere({n, nest = false, project, due = null, photos = 0, but = ''}){
  const what = n === 1 ? 'Added' : nest ? `Added 1 task with ${plural(n - 1, 'subtask')}` : `Added ${plural(n, 'task')}`;
  const when = n === 1 && due ? ', due ' + dueInfo(due).label.replace(/^(Today|Tomorrow|Yesterday)/, w => w.toLowerCase()) : '';
  const with_ = photos ? (photos === 1 ? ', with the photo' : `, with ${photos} photos`) : '';
  return `${what} to ${project || 'its project'}${when}${with_}${but}`;
}

/* Move all to today, said under Overdue: how many moved, and what stayed where it was (`stays`, already a sentence).
   `left`: those Vikunja didn't save. */
export function movedText(n, left, stays){
  if (!n) return stays ? 'Nothing moved. ' + stays : 'Nothing moved: Vikunja didn\'t save the changes.';
  return `Moved ${n} to today` + (left ? `. ${left === 1 ? '1 wasn\'t' : left + ' weren\'t'} saved and ${left === 1 ? 'is' : 'are'} still overdue.` : '')
    + (stays ? (left ? ' ' : '. ') + stays : '');
}

// Move all to today's Undo, or a drop's, with `k` tasks changed since (or not saved), still due `still` ("today").
export const notMovedBack = (k, still) => `${plural(k, 'task')} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still due ${still}.`;

/* A row or a card held on Today and dropped on another day (parent-tasks-plan, part 4), said in its place: "Moved to
   Friday" (`day`: dueInfo's label, "Today", "Tomorrow", "Friday"). A card whose subtask is due sooner (`kept`, its title)
   stays where that puts it, and says so. */
export const movedTo = (day, kept = null) => kept ? `Moved to ${dayWord(day)}. Its subtask “${kept}” is due sooner, so it stays here.` : `Moved to ${dayWord(day)}`;
// A day's name inside a sentence: "today", "tomorrow", "Friday".
export const dayWord = day => /^(Today|Tomorrow)$/.test(day) ? day.toLowerCase() : day;
/* What a hold on Today can't move, as Move all to today leaves them, and why: a repeating task (moved, its next times
   would follow the new date), a checklist that comes round (the same), a checklist run. */
export const STAYS = {repeats: 'It repeats, so it stays: tick it to move on to the next date.',
  checklist: 'A checklist stays: start it to move on to the next time.', run: 'A checklist run stays where it is.'};

/* A task ticked done, with the open subtasks it closed (`closed` of the `open` it had), as its row's line says it:
   {text, title, more}. None: "Done: Pack the van"; all of them: "Closed Pack the van + 4 subtasks"; some not saved,
   how many were. */
export function doneLine(closed, open, title){
  if (!open) return {text: 'Done:', title, more: ''};
  if (!closed) return {text: 'Done:', title, more: `— its ${plural(open, 'subtask')} couldn't be closed`};
  return {text: 'Closed', title, more: closed === open ? '+ ' + plural(open, 'subtask') : `+ ${closed} of ${plural(open, 'subtask')}: the rest couldn't be closed`};
}
// The same in one line, for a place that isn't the row's (the sheet's subtasks), a long title cut short.
export const doneText = (closed, open, title) => {
  const l = doneLine(closed, open, title.length > 40 ? title.slice(0, 38) + '…' : title);
  return [l.text, l.title, l.more].filter(Boolean).join(' ');
};
// A done task shown over its open subtasks on a project's list: why it's there.
export const headText = n => n ? `Done, but ${n === 1 ? '1 subtask is' : n + ' subtasks are'} still open` : 'Done';

// A run's step done or skipped without a connection: when it goes.
export const sentLater = what => `${what}. It's sent once Pocket reaches Vikunja.`;

// Something copied, said where it was copied from: progress as a text (where there's no share sheet), a Markdown list, a
// task's notes, a comment; or that the browser wouldn't allow it.
export const COPIED = {text: 'Copied: paste it into a message', markdown: 'Copied as a Markdown list: paste it into your notes', notes: 'Copied the notes',
  comment: 'Copied the comment', failed: 'Not copied: this browser didn\'t allow it'};

// Names in a sentence: "A", "A and B", "A, B and C"; past `most`, the first of them and how many more: "A, B, C and 2
// more".
export function namesText(names, most = 3){
  const shown = names.length > most ? [...names.slice(0, most), `${names.length - most} more`] : names;
  return shown.length < 2 ? shown.join('') : shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1);
}
/* The question a parent's ring asks (sheet/complete.html): {head, body, yes: its button}. A task: completed with the open
   subtasks named (`names`), those that repeat (`stay`, how many) left as they are. A run (`run`): finished with its steps
   not done (`names`) left that way. Named in a sentence, not listed, so they aren't taken for boxes to pick from. */
export function completeAsk({title, run = false, names = [], stay = 0}){
  const n = names.length, which = namesText(names);
  if (run) return {head: `Finish this run with ${plural(n, 'step')} not done?`, yes: 'Finish run',
    body: `“${title}” is finished, and ${n === 1 ? 'its step not done stays' : `its ${n} steps not done stay`} that way: ${which}.`};
  const stays = !stay ? '' : stay === 1 ? 'The one that repeats stays as it is.' : `The ${stay} that repeat stay as they are.`;
  const goes = !n ? '' : n === 1 ? `Its open subtask will be marked done too: ${which}.` : `Its ${n} open subtasks will be marked done too: ${which}.`;
  return {head: `Complete “${title}”?`, body: [goes, stays].filter(Boolean).join(' '), yes: n ? `Complete all ${n + 1}` : 'Complete it'};
}
