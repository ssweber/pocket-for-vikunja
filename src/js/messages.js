// The sentences Pocket says when something happens. lines.js decides where each is shown. These functions only build
// the text, so the unit tests can check it.
import {NetError} from './api.js';
import {dueInfo, fmtTime} from './dates.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* The row at the end of a list of done tasks shown `per` at a time, most recently done first (a project's Done,
   search's done matches), with `left` not shown yet. Returns {title, note}, where note says how many are left and is ''
   when the title says it, or null when none are left and there is no row. */
export function moreDone(left, per){
  if (!(left > 0)) return null;
  if (left <= per) return {title: `Show the last ${left === 1 ? 'one' : left}, done before these`, note: ''};
  return {title: `Show ${per} more, done before these`, note: `${left.toLocaleString()} more not shown`};
}

// A change Vikunja didn't save, and why, in a few words.
export const notSaved = e => e instanceof NetError ? 'Not saved: no connection' : 'Not saved: ' + e.message;
// A move Vikunja turned down. When an API token without the right permission caused it (api.js), the message names
// the permission.
export const notMoved = e => e?.code === 'token' ? 'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.'
  : 'Not moved: ' + (e instanceof NetError ? 'no connection' : e?.message || 'Vikunja turned it down');

/* Where tasks just added went, said by the add box when they aren't on the screen being looked at (a task due next
   month added on Today, or one for another project). `n` lines were added, `subs` of them subtasks of the others, to
   `project`. A single task may be due `due`. `but` is what didn't go as asked (", but …"). */
export function addedWhere({n, subs = 0, project, due = null, photos = 0, but = ''}){
  const what = n === 1 ? 'Added' : subs ? `Added ${plural(n - subs, 'task')} with ${plural(subs, 'subtask')}` : `Added ${plural(n, 'task')}`;
  const when = n === 1 && due ? ', due ' + dueInfo(due).label.replace(/^(Today|Tomorrow|Yesterday)/, w => w.toLowerCase()) : '';
  const with_ = photos ? (photos === 1 ? ', with the photo' : `, with ${photos} photos`) : '';
  return `${what} to ${project || 'its project'}${when}${with_}${but}`;
}

/* What Move all to today says under Overdue: how many moved, and `stays`, a sentence about what stayed where it was.
   `left` is how many Vikunja didn't save. */
export function movedText(n, left, stays){
  if (!n) return stays ? 'Nothing moved. ' + stays : 'Nothing moved. Vikunja didn\'t save the changes.';
  return `Moved ${n} to today` + (left ? `. ${left === 1 ? '1 wasn\'t' : left + ' weren\'t'} saved and ${left === 1 ? 'is' : 'are'} still overdue.` : '')
    + (stays ? (left ? ' ' : '. ') + stays : '');
}

// The Undo of Move all to today, or of a task held on Today and moved, when `k` tasks couldn't go back because they
// changed since or weren't saved. `still` is the date they are still due ("today"), or null when their date was taken
// off and still is.
export const notMovedBack = (k, still) => `${plural(k, 'task')} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still ${still ? 'due ' + still : 'without a date'}.`;

/* A row or a card held on Today and moved to a new date (app/throw.js), said with its Undo: "Moved to tomorrow". `day`
   is the date's name as its chip has it ("Today", "Tomorrow", "Mon 12"), or null when the date was taken off. A card
   whose subtask `kept` (its title) is due sooner stays where it was, and the message says so: "Moved to Friday. Its
   subtask “Buy paint” is due sooner, so it stays here." */
export const movedTo = (day, kept = null) => (day ? `Moved to ${dayWord(day)}` : 'Took its date off')
  + (kept ? `. Its subtask “${kept}” ${day ? 'is due sooner' : 'has a date'}, so it stays here.` : '');
// A day's name inside a sentence: "today", "tomorrow", "Friday".
export const dayWord = day => /^(Today|Tomorrow)$/.test(day) ? day.toLowerCase() : day;

/* A task ticked done, with `closed` of its `open` subtasks closed with it, as its row's line says it: {text, title,
   more}. With no subtasks, "Done: Pack the van". With all of them closed, "Closed Pack the van + 4 subtasks". With some
   not saved, how many were. */
export function doneLine(closed, open, title){
  if (!open) return {text: 'Done:', title, more: ''};
  if (!closed) return {text: 'Done:', title, more: `— its ${plural(open, 'subtask')} couldn't be closed`};
  return {text: 'Closed', title, more: closed === open ? '+ ' + plural(open, 'subtask') : `+ ${closed} of ${plural(open, 'subtask')}: the rest couldn't be closed`};
}
// The same as one string, for a place other than the row (the sheet's subtasks), with a long title cut short.
export const doneText = (closed, open, title) => {
  const l = doneLine(closed, open, title.length > 40 ? title.slice(0, 38) + '…' : title);
  return [l.text, l.title, l.more].filter(Boolean).join(' ');
};
// A done task shown over its open subtasks on a project's list, and why it is there.
export const headText = n => n ? `Done, but ${n === 1 ? '1 subtask is' : n + ' subtasks are'} still open` : 'Done';

/* The name of a waiting row's Cancel button, for a screen reader. It says what becomes of the `n` lines waiting under
   the row: they go under `over` (the title of what the row was under), or, for a row at the top, become tasks of their
   own, as cancelPending (app/sending.js) does. */
export const cancelName = (title, n = 0, over = '') => 'Cancel ' + title + (!n ? '' : `: the line${n === 1 ? '' : 's'} under it `
  + (over ? `${n === 1 ? 'goes' : 'go'} under “${over}”` : n === 1 ? 'becomes a task of its own' : 'become tasks of their own'));
// A checklist's step done or skipped without a connection, and when the change is sent.
export const sentLater = what => `${what}. It's sent once Pocket reaches Vikunja.`;

/* Who started a checklist, and when. In a finished checklist's summary: "Started by <name> at 6:02 AM", or on another
   day "Started by <name>, Oct 8, 6:02 AM". At the top of its ⋯ sheet (`day`), always with the day. `who` is their
   name or "you". Returns '' when who isn't known, and only who when the time isn't. */
export function startedText(who, at, {now = new Date(), day = false} = {}){
  if (!who) return '';
  const d = at ? new Date(at) : null;
  if (!d || !(d.getTime() > 0)) return `Started by ${who}`;
  const today = d.toDateString() === new Date(now).toDateString();
  return `Started by ${who}` + (today && !day ? ' at ' + fmtTime(d) : ', ' + d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}));
}

// What is said after a copy, where it was copied from: progress as a text (where there is no share sheet), a Markdown
// list, which pasted into Pocket's add box makes the same tasks, a task's notes, or a comment. Or that the browser
// didn't allow the copy.
export const COPIED = {text: 'Copied. Paste it into a message', markdown: 'Copied as a Markdown list. Paste it into your notes, or into Pocket\'s add box to make the same tasks', notes: 'Copied the notes',
  comment: 'Copied the comment', failed: 'Not copied. This browser didn\'t allow it'};

// Names in a sentence: "A", "A and B", "A, B and C". Past `most` names, the first of them and how many more: "A, B, C
// and 2 more".
export function namesText(names, most = 3){
  const shown = names.length > most ? [...names.slice(0, most), `${names.length - most} more`] : names;
  return shown.length < 2 ? shown.join('') : shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1);
}
/* The question a parent's ring asks (sheet/complete.html): {head, body, yes: the button's label}. For a task: complete
   it, and the open subtasks in `names` with it, leaving the `stay` that repeat as they are. For a checklist (`run`):
   finish it, leaving the steps in `names` not done. The names are in a sentence, not a list, so they aren't taken for
   boxes to pick from. */
export function completeAsk({title, run = false, names = [], stay = 0}){
  const n = names.length, which = namesText(names);
  if (run) return {head: `Finish this checklist with ${plural(n, 'step')} not done?`, yes: 'Finish checklist',
    body: `“${title}” is finished, and ${n === 1 ? 'its step not done stays' : `its ${n} steps not done stay`} that way: ${which}.`};
  const stays = !stay ? '' : stay === 1 ? 'The one that repeats stays as it is.' : `The ${stay} that repeat stay as they are.`;
  const goes = !n ? '' : n === 1 ? `Its open subtask will be marked done too: ${which}.` : `Its ${n} open subtasks will be marked done too: ${which}.`;
  return {head: `Complete “${title}”?`, body: [goes, stays].filter(Boolean).join(' '), yes: n ? `Complete all ${n + 1}` : 'Complete it'};
}
