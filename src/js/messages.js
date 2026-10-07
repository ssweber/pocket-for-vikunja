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
