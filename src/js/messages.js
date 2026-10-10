// What Pocket says when something happens, as plain sentences. Where each is shown is lines.js's; these only say it, so
// the unit tests can check them.
import {NetError} from './api.js';
import {dueInfo, fmtTime} from './dates.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* The row at the end of a list of done tasks shown `per` at a time, the most recently done first (a project's Done,
   search's done matches: performance-plan, part 9), with `left` of them not shown yet: {title, note: how many that is,
   '' when the title says it}, or null when none are left, and there's no row. */
export function moreDone(left, per){
  if (!(left > 0)) return null;
  if (left <= per) return {title: `Show the last ${left === 1 ? 'one' : left}, done before these`, note: ''};
  return {title: `Show ${per} more, done before these`, note: `${left.toLocaleString()} more not shown`};
}

// A change Vikunja didn't save: why, in a few words.
export const notSaved = e => e instanceof NetError ? 'Not saved: no connection' : 'Not saved: ' + e.message;
// A move Vikunja turned down; refused for an API token that doesn't allow it (api.js), the permission it needs.
export const notMoved = e => e?.code === 'token' ? 'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.'
  : 'Not moved: ' + (e instanceof NetError ? 'no connection' : e?.message || 'Vikunja turned it down');

/* Where tasks just added went, said by the add box when they aren't on the screen being looked at (a task due next
   month, added on Today; one for another project). `n` lines, `subs` of them subtasks of the others, in `project`, the
   one task due `due`. `but`: what didn't go as asked (", but …"). */
export function addedWhere({n, subs = 0, project, due = null, photos = 0, but = ''}){
  const what = n === 1 ? 'Added' : subs ? `Added ${plural(n - subs, 'task')} with ${plural(subs, 'subtask')}` : `Added ${plural(n, 'task')}`;
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

/* A card thrown on Today to a new date (app/throw.js) whose subtask `kept` (its title) is due sooner, so the card stays
   where that puts it, said in its place: "Moved to Friday. Its subtask “Buy paint” is due sooner, so it stays here."
   (`day`: dueInfo's label or the ring's, "Today", "Tomorrow", "Thu 15"; null: its date taken off, "… has a date, so it
   stays here.") Without `kept`, only the first sentence. */
export const movedTo = (day, kept = null) => (day ? `Moved to ${dayWord(day)}` : 'Took its date off')
  + (kept ? `. Its subtask “${kept}” ${day ? 'is due sooner' : 'has a date'}, so it stays here.` : '');
// A day's name inside a sentence: "today", "tomorrow", "Friday".
export const dayWord = day => /^(Today|Tomorrow)$/.test(day) ? day.toLowerCase() : day;

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

/* What a waiting row's Cancel is called, for a screen reader: with what becomes of the `n` lines waiting under it,
   which go under what it was under (`over`, its title; none for a line at the top: they're tasks of their own), as
   cancelPending (app/sending.js) does it. */
export const cancelName = (title, n = 0, over = '') => 'Cancel ' + title + (!n ? '' : `: the line${n === 1 ? '' : 's'} under it `
  + (over ? `${n === 1 ? 'goes' : 'go'} under “${over}”` : n === 1 ? 'becomes a task of its own' : 'become tasks of their own'));
// A run's step done or skipped without a connection: when it goes.
export const sentLater = what => `${what}. It's sent once Pocket reaches Vikunja.`;

/* Who started a run, and when, as its history says it: in a finished run's summary, "Started by Priya at 6:02 AM" (on
   another day, "Started by Priya, Oct 8, 6:02 AM"); at the top of its ⋯ (`day`), always with the day. `who`: their name,
   or "you". '' when it isn't known who; with no time known, only who. */
export function startedText(who, at, {now = new Date(), day = false} = {}){
  if (!who) return '';
  const d = at ? new Date(at) : null;
  if (!d || !(d.getTime() > 0)) return `Started by ${who}`;
  const today = d.toDateString() === new Date(now).toDateString();
  return `Started by ${who}` + (today && !day ? ' at ' + fmtTime(d) : ', ' + d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}));
}

// Something copied, said where it was copied from: progress as a text (where there's no share sheet), a Markdown list
// (the copy that comes back: design rule 9), a task's notes, a comment; or that the browser wouldn't allow it.
export const COPIED = {text: 'Copied: paste it into a message', markdown: 'Copied as a Markdown list: paste it into your notes, or into Pocket\'s add box to make the same tasks', notes: 'Copied the notes',
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
