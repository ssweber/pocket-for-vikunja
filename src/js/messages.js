// The messages Pocket shows when something happens. lines.js decides where each is shown. These functions only build
// the text, so the unit tests can check it.
import {andList} from './util.js';
import {NetError} from './api.js';
import {dayName, dueInfo, fmtTime, isSet} from './dates.js';
import {parseStep} from './checklists.js';
import {htmlToText} from './html.js';
import {answerLines, textLines} from './asks.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* The row at the end of a list of done tasks that shows `per` tasks at a time, most recently done first (a project's
   Done, the done matches in search). `left` is how many are not shown yet. Returns {title, note}, or null when none are
   left and there is no row. The note gives how many are left, and is '' when the title already gives it. */
export function moreDone(left, per){
  if (!(left > 0)) return null;
  if (left <= per) return {title: `Show the last ${left === 1 ? 'one' : left}`, note: ''};
  return {title: `Show ${per} done earlier`, note: `${left.toLocaleString()} more not shown`};
}

// A change Vikunja didn't save, and why, in a few words.
export const notSaved = e => e instanceof NetError ? 'Not saved: no connection' : 'Not saved: ' + e.message;
// A new place in the list that Vikunja refused. It doesn't say "moved", which means moving to another project.
export const notReordered = e => 'Not reordered: ' + (e instanceof NetError ? 'no connection' : e?.code === 'unknown' ? UNSURE : e?.message || 'Vikunja refused it');
// On the sign-in screen, when Vikunja offers neither a password nor single sign-on.
export const NO_SIGN_IN = 'This server has password sign-in and single sign-on turned off. Ask its admin to turn one on.';

/* Tells the user where tasks just added went. The add box shows this when the tasks aren't on the current screen (a
   task due next month added on Today, or a task for another project). `n` tasks were added to `project`, `subs` of
   them as subtasks of the others. A single task may be due `due`. `but` is what didn't go as asked (", but …"). */
export function addedWhere({n, subs = 0, project, due = null, photos = 0, but = ''}){
  const what = n === 1 ? 'Added' : subs ? `Added ${plural(n - subs, 'task')} with ${plural(subs, 'subtask')}` : `Added ${plural(n, 'task')}`;
  const when = n === 1 && due ? ', due ' + dueInfo(due).label.replace(/^(Today|Tomorrow|Yesterday)/, w => w.toLowerCase()) : '';
  const with_ = photos ? (photos === 1 ? ', with the photo' : `, with ${photos} photos`) : '';
  return `${what} to ${project || 'its project'}${when}${with_}${but}`;
}

/* The message that Move all to today shows under Overdue. `n` is how many tasks moved, and `stays` is a sentence about
   what stayed where it was. */
export const movedText = (n, stays) => !n ? 'Nothing moved. ' + stays : `Moved ${n} to today` + (stays ? '. ' + stays : '');

// The message when an Undo finds that the task changed since, and leaves it as it is.
export const changedSince = title => `Not undone: “${title}” has changed since then`;
// The message when Undo can't move `k` tasks back, after Move all to today or after the user held a task on Today and
// moved it. The tasks changed since, or were not saved. `still` is the date they are still due ("today"), or null when
// their date was removed and they are still without one.
export const notMovedBack = (k, still) => `${plural(k, 'task')} couldn't be moved back (changed since, or not saved) and ${k === 1 ? 'is' : 'are'} still ${still ? 'due ' + still : 'without a date'}.`;

/* The message shown with Undo after the user holds a row or a card on Today and moves it to a new date (app/throw.js),
   such as "Moved to tomorrow". `day` is the date's name as its chip shows it ("Today", "Tomorrow", "Mon 12"), or null
   when the date was removed. If a card has a subtask (`kept`, its title) that is due sooner, the card stays where it
   was and the message says so: "Moved to Friday. Its subtask “Buy paint” is due sooner, so it stays here." */
export const movedTo = (day, kept = null) => (day ? `Moved to ${dayWord(day)}` : 'Removed its due date')
  + (kept ? `. Its subtask “${kept}” ${day ? 'is due sooner' : 'has a date'}, so it stays here.` : '');
// The message shown with Undo after a task moves to another project (moveTask): "Moved to Errands, with its 3
// subtasks". `n` counts the subtasks, at every level, that moved with it.
export const movedToProject = (project, n = 0) => `Moved to ${project || 'the other project'}` + (!n ? '' : n === 1 ? ', with its subtask' : `, with its ${n} subtasks`);
// A day's name inside a sentence: "today", "tomorrow", "Friday".
export const dayWord = day => /^(Today|Tomorrow)$/.test(day) ? day.toLowerCase() : day;

/* The message in a row after the user ticks a task done, when `closed` of its `open` subtasks were closed with it.
   Returns {text, title, more}. With no subtasks it reads "Done: Pack the van". With all subtasks closed it reads
   "Closed Pack the van + 4 subtasks". If some were not saved, `more` says how many were closed and that the rest
   weren't. */
export function doneLine(closed, open, title){
  if (!open) return {text: 'Done:', title, more: ''};
  if (!closed) return {text: 'Done:', title, more: `— its ${plural(open, 'subtask')} couldn't be closed`};
  return {text: 'Closed', title, more: closed === open ? '+ ' + plural(open, 'subtask') : `+ ${closed} of ${plural(open, 'subtask')}: the rest couldn't be closed`};
}
// The same message as one string, for places other than the row (the sheet's subtasks). A long title is shortened.
export const doneText = (closed, open, title) => {
  const l = doneLine(closed, open, title.length > 40 ? title.slice(0, 38) + '…' : title);
  return [l.text, l.title, l.more].filter(Boolean).join(' ');
};
// The message on a done task that a project's list shows above its open subtasks. It explains why the task is there.
export const headText = n => n ? `Done, but ${n === 1 ? '1 subtask is' : n + ' subtasks are'} still open` : 'Done';

/* The label of a waiting row's Cancel button, for screen readers. It also says what happens to the `n` lines waiting
   under the row. If the row was under another task (`over`, that task's title), the lines move under that task. If the
   row was at the top, the lines become separate tasks, as cancelPending (app/sending.js) does. */
export const cancelName = (title, n = 0, over = '') => 'Cancel ' + title + (!n ? '' : `. The line${n === 1 ? '' : 's'} under it `
  + (over ? `${n === 1 ? 'moves' : 'move'} under “${over}”.` : n === 1 ? 'becomes its own task.' : 'become their own tasks.'));
// The message after the user marks a checklist's step done or skipped without a connection. It says when the change
// will be sent.
export const sentLater = what => `${what}. It's sent once Pocket reaches Vikunja.`;

/* The words for each op in the outbox (src/js/ops/), by op name. `title` is the task's title as Pocket knows it, or ''.
   - text(a, title, repeated): the op's row in the Outbox. `repeated` says the step was repeated in its checklist.
   - refused(a, title): the op in a message saying Vikunja refused it, such as "A tick on “Unlock the door”".
   - dropped(a, title): what Vikunja keeps after Cancel. `a.stage` above 0 means the first request was sent. After an
     unknown answer the words say that Vikunja may or may not have the change instead (keeps).
   - saved: what Vikunja already has when it refuses a later request, as in "couldn't be saved in full (it's marked
     done)". */
const named = title => parseStep(title).title;
const row = (title, repeated) => named(title || 'a step') + (repeated ? ' (repeated)' : '');
const on = title => title ? ` on “${named(title)}”` : '';
const it = title => `“${named(title || 'it')}”`;
const REST = ' The rest of the change is not sent.';
const EVERY = {86400: 'every day', 604800: 'every week', 1209600: 'every 2 weeks'};
const dueWords = d => isSet(d) ? 'due ' + dayWord(dayName(d)) : 'without a date';
const repeatText = s => s.repeat_mode === 1 ? 'Repeats every month' : !s.repeat_after ? 'Doesn\'t repeat' : 'Repeats ' + (EVERY[s.repeat_after] || `every ${s.repeat_after / 86400} days`);
const unsure = a => a.failed?.message === UNKNOWN;
const keeps = words => (a, title) => unsure(a) ? UNSURE : words(a, title);
const ticked = {saved: 'it\'s marked done', dropped: keeps((a, title) => a.stage > 0 ? `${it(title)} stays marked done in Vikunja.${REST}` : `${it(title)} stays not done in Vikunja.`)};
const unticked = {saved: 'it\'s marked not done', dropped: keeps((a, title) => a.stage > 0 ? `${it(title)} stays not done in Vikunja.${REST}` : `${it(title)} stays done in Vikunja.`)};
export const OP_WORDS = {
  done: {...ticked, text: (a, title, r) => `Done: ${row(title, r)}`, refused: (a, title) => 'A tick' + on(title)},
  doneNote: {...ticked, text: (a, title, r) => `Done, with a comment: ${row(title, r)}`, refused: (a, title) => `Marking ${title ? `“${named(title)}”` : 'a step'} done, with its comment`},
  skip: {...ticked, refused: (a, title) => 'A skip' + on(title), text(a, title, r){
    const why = htmlToText(a.html || '').replace(/^Skipped:?\s*/, '').trim();
    return `Skipped: ${row(title, r)}` + (why ? ` (${why})` : '');
  }},
  undone: {...unticked, text: (a, title, r) => `Not done: ${row(title, r)}`, refused: (a, title) => `Marking ${title ? `“${named(title)}”` : 'a step'} not done`},
  finish: {saved: 'it\'s marked done', text: (a, title, r) => `Finishing “${row(title, r)}”`, refused: () => 'Finishing the checklist',
    dropped: keeps(a => a.stage > 0 ? 'The checklist stays finished in Vikunja.' + REST : 'The checklist stays open in Vikunja.')},
  reopen: {saved: 'it\'s marked not done', text: (a, title, r) => `Reopening “${row(title, r)}”`, refused: () => 'Reopening the checklist',
    dropped: keeps(a => a.stage > 0 ? 'The checklist stays open in Vikunja.' + REST : 'The checklist stays finished in Vikunja.')},
  progress: {text: (a, title, r) => `Progress: ${a.pct}% on “${row(title, r)}”`, refused: (a, title) => 'Progress' + on(title), dropped: keeps((a, title) => `${it(title)} keeps the progress it has in Vikunja.`)},
  note: {text: (a, title, r) => `A comment on “${row(title, r)}”`, refused: (a, title) => 'A comment' + on(title),
    dropped: a => (unsure(a) ? UNSURE + ' ' : '') + 'Your comment is back where you typed it.'},
  // An answer is named by its ask's label, or by its step when it holds several answers or its ask has no label.
  answer: {text: (a, title, r) => row(title, r), refused: (a, title) => 'Answers' + on(title), dropped: keeps((a, title) => {
    const lines = answerLines(textLines(a.html)) || [], label = lines.length === 1 && lines[0].match(/^(.+?): /)?.[1];
    return lines.length > 1 ? `Your answers to ${it(title)} aren't saved.` : `Your answer to ${label ? `“${label}”` : it(title)} isn't saved.`;
  })},
  claim: {text: (a, title, r) => `Assigning “${row(title, r)}” to you`, refused: (a, title) => `Assigning ${title ? `“${named(title)}”` : 'it'} to you`, dropped: keeps((a, title) => `You are not assigned to ${it(title)}.`)},
  unclaim: {text: (a, title, r) => `Unassigning you from “${row(title, r)}”`, refused: (a, title) => 'Unassigning you from ' + (title ? `“${named(title)}”` : 'it'), dropped: keeps((a, title) => `${it(title)} stays assigned to you.`)},
  delete: {text: (a, title, r) => `Deleting “${row(title, r)}”` + (a.ids?.length > 1 ? `, with ${plural(a.ids.length - 1, 'subtask')}` : ''),
    refused: (a, title) => 'Deleting' + (title ? ` “${named(title)}”` : ' a task'), dropped: keeps((a, title) => `${it(title)} stays in Vikunja.`)},
  position: {text: (a, title, r) => `Moving “${row(title, r)}” in its list`, refused: (a, title) => 'Moving' + (title ? ` “${title}”` : ' a task'), dropped: keeps((a, title) => `${it(title)} stays where it was in Vikunja's list.`)},
  // A new date, named as the message after a move names it. Cancel names the date before the move (`was`).
  due: {text: (a, title, r) => `${movedTo(dayName(a.due))}: ${row(title, r)}`, refused: (a, title) => 'Moving' + (title ? ` “${title}”` : ' a task'),
    dropped(a, title){
      // Taking a repeating template's date off turns its repeat off first, and puts it back last (`rep`, ops/dates.js).
      // Stopped after its first request, the template has no repeat. A move whose answer is unknown names both dates,
      // unless the request in doubt is about the repeat.
      const rep = a.fixed?.seen?.rep;
      if (rep && (a.stage === 1 || (a.stage === 2 && !unsure(a)))) return `${it(title)} no longer repeats, because its date was only partly removed. Set its repeat again in its sheet.`;
      if (unsure(a)) return rep ? UNSURE : `Vikunja may have ${it(title)} ${dueWords(a.was)} or ${dueWords(a.due)}.`;
      return `${it(title)} stays ${dueWords(a.was)}.`;
    }},
  // How a task repeats, in the words of the sheet's Repeats list. Cancel names the repeat before the change (`was`).
  repeat: {text: (a, title, r) => `${repeatText(a.set || {})}: ${row(title, r)}`, refused: (a, title) => `Changing how ${title ? `“${named(title)}”` : 'a task'} repeats`,
    dropped: keeps((a, title) => `${it(title)} still ${repeatText(a.was || {}).toLowerCase()}.`)},
  // An add's line, under what it goes under (`a.over`). Only a line whose task is made (`taskId`) is cancelled in the
  // Outbox with these words. Before that, its Cancel gives the lines back (cancelOf).
  add: {saved: 'it\'s added', text: (a, title) => a.taskId ? `Finishing “${named(title)}”` : a.over ? `Subtask of “${named(a.over)}”: ${title}` : `New task: ${title}`,
    refused: (a, title) => 'Adding' + (title ? ` “${title}”` : ' a task'), dropped: keeps((a, title) => a.taskId ? `${it(title)} stays in Vikunja.${REST}` : '')},
};
// Why a claim or an untick is dropped. Another person was assigned first, or someone finished the checklist.
export const assignedJustNow = names => `${andList(names)} ${names.length === 1 ? 'was' : 'were'} assigned to it just now`;
export const FINISHED_MEANWHILE = 'the checklist was finished in the meantime, so the step stays done';
/* The plugin's relay answers 409 with Idempotency-Unknown when it can't tell whether Vikunja made a change. Pocket
   can't tell either, and only the user can check. So the change waits in the Outbox, and Try again sends it as a new
   request. */
export const UNSURE = 'Vikunja may or may not have this change.';
export const UNKNOWN = UNSURE + ' Check, then tap Try again if it\'s missing.';
export const notKnown = what => `${what} may not have reached Vikunja.`;
// The button on a message about a change kept in the Outbox. It only opens the Outbox, because after an unknown answer
// the user checks Vikunja before the change is sent again.
export const toOutbox = app => ({label: 'Outbox', fn: () => app.openOutbox()});

/* Who started a checklist, and when. A finished checklist's summary shows "Started by <name> at 6:02 AM", or for
   another day "Started by <name>, Oct 8, 6:02 AM". The top of the checklist's ⋯ sheet always includes the day (`day`).
   `who` is the person's name or "you". Returns '' when `who` is unknown, and only the name when the time is unknown. */
export function startedText(who, at, {now = new Date(), day = false} = {}){
  if (!who) return '';
  const d = at ? new Date(at) : null;
  if (!d || !(d.getTime() > 0)) return `Started by ${who}`;
  const today = d.toDateString() === new Date(now).toDateString();
  return `Started by ${who}` + (today && !day ? ' at ' + fmtTime(d) : ', ' + d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}));
}

// The message shown after the user copies something, by what was copied: progress as text (where there is no share
// sheet), a Markdown list (pasting it into Pocket's add box makes the same tasks), a task's notes, or a comment.
// `failed` is for when the browser didn't allow the copy.
export const COPIED = {text: 'Copied. Paste it into a message', markdown: 'Copied as a Markdown list. Paste it into your notes, or into Pocket\'s add box to make the same tasks', notes: 'Copied the notes',
  comment: 'Copied the comment', failed: 'Not copied. This browser didn\'t allow it'};

// Names in a sentence: "A", "A and B", "A, B and C". Past `most` names, it lists the first `most` and counts the rest:
// "A, B, C and 2 more".
export function namesText(names, most = 3){
  const shown = names.length > most ? [...names.slice(0, most), `${names.length - most} more`] : names;
  return shown.length < 2 ? shown.join('') : shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1);
}
/* The question a parent's ring asks (sheet/complete.html). Returns {head, body, yes}, where `yes` is the button's
   label. For a task, the question is whether to complete it together with the open subtasks in `names`. `stay` is how
   many subtasks repeat and stay as they are. For a checklist (`run`), the question is whether to finish it and leave
   the steps in `names` not done. The names are written into a sentence, not a list, so they aren't mistaken for boxes
   to pick from. */
export function completeAsk({title, run = false, names = [], stay = 0}){
  const n = names.length, which = namesText(names);
  if (run) return {head: `Finish this checklist with ${plural(n, 'step')} not done?`, yes: 'Finish checklist',
    body: `${n === 1 ? 'This step stays' : `These ${n} steps stay`} not done: ${which}.`};
  const stays = !stay ? '' : stay === 1 ? 'The one that repeats stays as it is.' : `The ${stay} that repeat stay as they are.`;
  const goes = !n ? '' : n === 1 ? `Its open subtask will be marked done too: ${which}.` : `Its ${n} open subtasks will be marked done too: ${which}.`;
  return {head: `Complete “${title}”?`, body: [goes, stays].filter(Boolean).join(' '), yes: n ? `Complete all ${n + 1}` : 'Complete it'};
}
