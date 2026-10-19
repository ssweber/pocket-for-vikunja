// Every sentence Pocket shows, asks or announces, with one wording for each situation. lines.js decides where each is
// shown. These functions only build the text, so the unit tests can check it. Lint fails on such a sentence written
// anywhere else (eslint.config.js).
import { andList, PRIOS } from './util.js';
import { NetError } from './api.js';
import { dayName, dueInfo, fmtTime, isSet, repeats } from './dates.js';
import { parseStep } from './checklists.js';
import { htmlToText } from './html.js';
import { answerLines, textLines } from './asks.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* The row at the end of a list of done tasks that shows `per` tasks at a time, most recently done first (a project's
   Done, the done matches in search). `left` is how many are not shown yet. Returns {title, note}, or null when none are
   left and there is no row. The note gives how many are left, and is '' when the title already gives it. */
export function moreDone(left, per) {
  if (!(left > 0)) return null;
  if (left <= per) return { title: `Show the last ${left === 1 ? 'one' : left}`, note: '' };
  return { title: `Show ${per} done earlier`, note: `${left.toLocaleString()} more not shown` };
}

// The labels of a message's button.
export const UNDO = 'Undo';
export const TRY_AGAIN = 'Try again';
export const OPEN = 'Open';

/* A change that waits while Pocket is offline. `n` changes, sent with `photos` photos. A message that names the change
   says when it goes instead (sentLater). */
export const savedOffline = (n = 1, photos = 0) =>
  'Saved offline' +
  (photos ? `, with ${photos === 1 ? 'the photo' : photos + ' photos'}` : '') +
  `. ${n === 1 && !photos ? 'It goes' : 'They go'} to Vikunja when you're back online.`;
// Vikunja answered busy, so the change waits, as the Outbox says.
export const BUSY = 'Waiting for Vikunja. Pocket tries again every 30 seconds.';
// A change that names itself (`what`, "Finished Wipe the counter") and waits: for a busy Vikunja (`reached`), or
// while Pocket is offline.
export const sentLater = (what, reached = false) =>
  `${what}. ${reached ? BUSY : "It goes to Vikunja when you're back online."}`;
/* What a change that waits says, by sendActs' result `r`: Vikunja was busy (`reached`), or Pocket is offline. A
   request whose reply was lost puts Pocket offline too. Pocket can't tell it from one that never left the phone, and
   sends it again with the same key, so it is made once. */
export const waitText = (r, n = 1, photos = 0) => (r.reached ? BUSY : savedOffline(n, photos));
// The Outbox's line while changes wait, offline or not, and once Vikunja refused some or has them all.
export const OUTBOX = {
  sending: 'Sending…',
  offline: "No connection. These go to Vikunja when you're back online.",
  busy: BUSY,
  refused: 'Vikunja refused these. Fix what its message says, then tap Try again. Or tap Cancel.',
  sent: 'Everything has reached Vikunja.',
};
// Try now in the Outbox while Pocket is still offline.
export const STILL_OFFLINE = "Still offline. These go to Vikunja when you're back online.";
/* What stays direct needs Vikunja's answer, so it can't wait offline. `what` is the action, as "create the project". A
   failure to connect says this. A refusal gives Vikunja's reason with its own words (notDone). */
export const offlineFor = what => `Offline. You can ${what} once you're back online.`;
// The phone had no room in its database for a change, so only the open page holds it.
export const NOT_KEPT = "Pocket couldn't save this on the phone. Keep Pocket open until it's sent.";

/* Vikunja refused change `what` ("“Buy milk”", "The new order") for `reason`. `saved` is what Vikunja already has
   when it refused a later request ("it's marked done"). `next` says what happens next, as KEPT does. */
export const notSaved = (what, reason, { saved = '', next = '' } = {}) =>
  `${what || 'It'} couldn't be saved${saved ? ` in full (${saved})` : ''}: ${(reason || 'Vikunja refused it').replace(/\.$/, '')}.${next}`;
// After notSaved, for a change kept in the Outbox.
export const KEPT = " It's kept to try again.";
// After notSaved, for a comment whose text went back to its box, or whose task was deleted (`words`, what it said).
export const textBack = e => (e.back ? ' Its text is back in the box.' : e.words ? ` It said: “${e.words}”` : '');
// A new place in the list that Vikunja refused. It doesn't say "moved", which means moving to another project.
export const notReordered = e => notSaved('The new order', e?.message);
// A project Vikunja refused to create.
export const projectNotSaved = e => notSaved('The new project', e.message);
// A template Vikunja refused to create, with the reason as `why` (api.js) gives it.
export const templateNotSaved = reason => notSaved('The new template', reason);
// A line added offline that Vikunja refused, and whose text went back to its add box.
export const lineNotSaved = (sub, reason) =>
  notSaved(sub ? 'A subtask you added offline' : 'A task you added offline', reason) +
  ' Its text is back in the add box.';
// A change the sender didn't send, because Vikunja refused an earlier change to the same task (`title`).
export const refusedEarlier = title => `Not sent. Vikunja refused an earlier change to “${title}”.`;
// The note on a refused row in the Outbox, with Vikunja's reason, or an answer the relay couldn't vouch for (UNKNOWN).
export const refusedNote = why => (why === UNKNOWN ? why : 'Vikunja refused it: ' + why);
/* What Pocket didn't do, and why: "Not moved: step 2, …". `done` is the past tense of the action. The reason is a
   failed read's, or the problem Pocket found in a template's steps. A refusal says what couldn't be saved (notSaved). */
export const notDone = (done, why) => `Not ${done}: ${String(why).replace(/\.$/, '')}.`;
/* A direct action that failed: offline (offlineFor, with `action` as "rename the project"), or refused (notSaved, with
   `what` as "Renaming the project"). */
export const directFailed = (e, action, what) =>
  e instanceof NetError ? offlineFor(action) : notSaved(what, e.message);
// A template Pocket didn't make, because of a problem in its steps (`why`).
export const templateProblem = why => 'Template not created: ' + why;
// On the sign-in screen, when Vikunja offers neither a password nor single sign-on.
export const NO_SIGN_IN =
  'This server has password sign-in and single sign-on turned off. Ask its admin to turn one on.';

/* Tells the user where tasks just added went. The add box shows this when the tasks aren't on the current screen (a
   task due next month added on Today, or a task for another project). `n` tasks were added to `project`, `subs` of
   them as subtasks of the others. A single task may be due `due`. `but` is what didn't go as asked (", but …"). */
export function addedWhere({ n, subs = 0, project, due = null, photos = 0, but = '' }) {
  const what =
    n === 1
      ? 'Added'
      : subs
        ? `Added ${plural(n - subs, 'task')} with ${plural(subs, 'subtask')}`
        : `Added ${plural(n, 'task')}`;
  const when =
    n === 1 && due ? ', due ' + dueInfo(due).label.replace(/^(Today|Tomorrow|Yesterday)/, w => w.toLowerCase()) : '';
  const with_ = photos ? (photos === 1 ? ', with the photo' : `, with ${photos} photos`) : '';
  return `${what} to ${project || 'its project'}${when}${with_}${but}`;
}

/* The message that Move all to today shows under Overdue. `n` is how many tasks moved, and `stays` is a sentence about
   what stayed where it was. */
export const movedText = (n, stays) =>
  !n ? 'Nothing moved. ' + stays : `Moved ${n} to today` + (stays ? '. ' + stays : '');

// The message when an Undo finds that the task changed since, and leaves it as it is.
export const changedSince = title => `Not undone: “${title}” has changed since then.`;
/* The message when Undo can't move `k` tasks back, after Move all to today or after the user held a task on Today and
   moved it, because they changed since. A refused Undo says so itself. `still` is the date they stay due ("today"), or
   null when their date was removed. A single task is named by its `title` when it is known. */
export const notMovedBack = (k, still, title = '') =>
  (k === 1 && title
    ? changedSince(title)
    : `Not undone: ${plural(k, 'task')} ${k === 1 ? 'has' : 'have'} changed since then.`) +
  ` ${k === 1 ? 'It stays' : 'They stay'} ${still ? 'due ' + still : 'without a date'}.`;

/* The message shown with Undo after the user holds a row or a card on Today and moves it to a new date (app/throw.js),
   such as "Moved to tomorrow". `day` is the date's name as its chip shows it ("Today", "Tomorrow", "Mon 12"), or null
   when the date was removed. If a card has a subtask (`kept`, its title) that is due sooner, the card stays where it
   was and the message says so: "Moved to Friday. Its subtask “Buy paint” is due sooner, so it stays here." */
export const movedTo = (day, kept = null) =>
  (day ? `Moved to ${dayWord(day)}` : 'Removed its due date') +
  (kept ? `. Its subtask “${kept}” ${day ? 'is due sooner' : 'has a date'}, so it stays here.` : '');
// The message shown with Undo after a task moves to another project (moveTask): "Moved to Errands, with its 3
// subtasks". `n` counts the subtasks, at every level, that moved with it.
export const movedToProject = (project, n = 0) =>
  `Moved to ${project || 'the other project'}` +
  (!n ? '' : n === 1 ? ', with its subtask' : `, with its ${n} subtasks`);
// A day's name inside a sentence: "today", "tomorrow", "Friday".
export const dayWord = day => (/^(Today|Tomorrow)$/.test(day) ? day.toLowerCase() : day);

/* The message in a row after the user ticks a task done, when `closed` of its `open` subtasks were closed with it.
   Returns {text, title, more}. With no subtasks it reads "Done: Pack the van". With all subtasks closed it reads
   "Closed Pack the van + 4 subtasks". If some were not saved, `more` says how many were closed and that the rest
   weren't. */
export function doneLine(closed, open, title) {
  if (!open) return { text: 'Done:', title, more: '' };
  if (!closed) return { text: 'Done:', title, more: `— its ${plural(open, 'subtask')} couldn't be closed` };
  return {
    text: 'Closed',
    title,
    more:
      closed === open
        ? '+ ' + plural(open, 'subtask')
        : `+ ${closed} of ${plural(open, 'subtask')}: the rest couldn't be closed`,
  };
}
// The same message as one string, for places other than the row (the sheet's subtasks). A long title is shortened.
export const doneText = (closed, open, title) => {
  const l = doneLine(closed, open, title.length > 40 ? title.slice(0, 38) + '…' : title);
  return [l.text, l.title, l.more].filter(Boolean).join(' ');
};
// The message on a done task that a project's list shows above its open subtasks. It explains why the task is there.
export const headText = n => (n ? `Done, but ${n === 1 ? '1 subtask is' : n + ' subtasks are'} still open` : 'Done');

/* The label of a waiting row's Cancel button, for screen readers. It also says what happens to the `n` lines waiting
   under the row. If the row was under another task (`over`, that task's title), the lines move under that task. If the
   row was at the top, the lines become separate tasks, as cancelPending (app/sending.js) does. */
export const cancelName = (title, n = 0, over = '') =>
  'Cancel ' +
  title +
  (!n
    ? ''
    : `. The line${n === 1 ? '' : 's'} under it ` +
      (over
        ? `${n === 1 ? 'moves' : 'move'} under “${over}”.`
        : n === 1
          ? 'becomes its own task.'
          : 'become their own tasks.'));
/* The words for each op in the outbox (src/js/ops/), by op name. `title` is the task's title as Pocket knows it, or ''.
   - text(a, title, repeated): the op's row in the Outbox. `repeated` says the step was repeated in its checklist.
   - refused(a, title): the op in a message saying Vikunja refused it, such as "A tick on “Unlock the door”".
   - dropped(a, title, copy): what Vikunja has after Cancel, such as "“Taxes” due date stays Tue, Oct 20". `copy(id)` is
     Pocket's copy of a task, which holds Vikunja's values, or undefined. An op stopped partway (`a.stage` above 0)
     first says what Vikunja already has, then what stays. After an unknown answer the words say what may still be in
     Vikunja instead (keeps), as "“Mop” may still have priority High in Vikunja.", or nothing where Cancel takes the
     change back.
   - saved: what Vikunja already has when it refuses a later request, as in "couldn't be saved in full (it's marked
     done)". */
const named = title => parseStep(title).title;
const row = (title, repeated) => named(title || 'a step') + (repeated ? ' (repeated)' : '');
const on = title => (title ? ` on “${named(title)}”` : '');
const it = title => `“${named(title || 'it')}”`;
const EVERY = { 86400: 'every day', 604800: 'every week', 1209600: 'every 2 weeks' };
const dueWords = d => (isSet(d) ? 'due ' + dayWord(dayName(d)) : 'without a date');
// How a task repeats, as the sheet's Repeats list names it, inside a sentence ("every week"), or null for no repeat.
const everyText = s =>
  s.repeat_mode === 1
    ? 'every month'
    : !s.repeat_after
      ? null
      : EVERY[s.repeat_after] || `every ${s.repeat_after / 86400} days`;
const repeatText = s => (everyText(s) ? 'Repeats ' + everyText(s) : "Doesn't repeat");
const unsure = a => a.failed?.message === UNKNOWN;
// The words `words` gives, or after an unknown answer what may still be in Vikunja, as `maybe` names it.
const keeps =
  (words, maybe) =>
  (a, title, copy = () => undefined) =>
    unsure(a) ? maybe(a, title) : words(a, title, copy);
// What may still be in Vikunja, as "“Mop” may still have priority High in Vikunja."
const still = (title, what) => `${it(title)} may still ${what} in Vikunja.`;
// What Vikunja has after Cancel: "is" once a request was sent, "stays" before.
const is = a => (a.stage > 0 ? 'is' : 'stays');
const pct = t => `${Math.round((t.percent_done || 0) * 100)}%`;
/* The progress of the parent that an op writes last (figure, ops/stages.js), which stays as it is when the op stops
   before then. '' when Pocket has no copy of the parent. */
const upStays = (a, copy) => {
  const up = a.up ?? (a.run && a.task !== a.run ? a.run : null),
    p = up != null && copy(up);
  return p ? ` ${it(p.title)} progress stays ${pct(p)}.` : '';
};
// Whether a task is done. A repeating task that a tick moved on to its next date is named by that date.
const doneWord = t => (t.done ? 'done' : repeats(t) && isSet(t.due_date) ? dueWords(t.due_date) : 'not done');
// A tick's words (`done` true), or an untick's. Without Pocket's copy of the task, a sent op counts as made.
const tickWords = done =>
  keeps(
    (a, title, copy) => {
      const t = copy(a.task) ?? { done: a.stage > 0 ? done : !done };
      return `${it(title)} ${is(a)} ${doneWord(t)}.` + (a.stage > 0 ? upStays(a, copy) : '');
    },
    (a, title) => still(title, done ? 'be done' : 'be open'),
  );
const ticked = { saved: "it's marked done", dropped: tickWords(true) };
const unticked = { saved: "it's marked not done", dropped: tickWords(false) };
// A finish's words (`finished` true), or a reopen's.
const checklistWords = finished =>
  keeps(
    (a, title, copy) => {
      const done = copy(a.task)?.done ?? (a.stage > 0 ? finished : !finished);
      return `${title ? `“${named(title)}”` : 'The checklist'} ${is(a)} ${done ? 'finished' : 'open'}.`;
    },
    (a, title) =>
      `${title ? `“${named(title)}”` : 'The checklist'} may still be ${finished ? 'finished' : 'open'} in Vikunja.`,
  );
// The people assigned to a task, as the sheet's Assigned row names them, with the user as "you".
const peopleWords = (a, t) => {
  const names = (t.assignees || []).map(u => (u.id === a.user ? 'you' : u.name || u.username));
  return names.length ? 'assigned to ' + andList(names) : 'unassigned';
};
// A person by name, or as "you" for the user.
const someone = (a, u) => (u.id === a.user ? 'you' : u.name || u.username);
// Assigning the user reads as a claim does: Assigning “X” to you.
const assigning = (a, title) =>
  a.add
    ? a.person.id === a.user
      ? `Assigning ${task(title)} to you`
      : `Assigning ${someone(a, a.person)} to ${task(title)}`
    : `Unassigning ${someone(a, a.person)} from ${task(title)}`;
const labelling = (a, title) =>
  a.add ? `Adding label ${a.tag.title} to ${task(title)}` : `Removing label ${a.tag.title} from ${task(title)}`;
// A task's due date: "due date stays Tue, Oct 20", or "stays without a due date".
const dueStays = d => (isSet(d) ? `due date stays ${dayWord(dayName(d))}` : 'stays without a due date');
// An edit's words, by the field it changes (ops/edit.js).
const task = title => (title ? `“${named(title)}”` : 'a task');
const EDITED = {
  title: {
    text: (a, title) => `Renaming ${task(title)} to “${a.set.title}”`,
    refused: title => 'Renaming ' + task(title),
    dropped(a, title, t) {
      const v = t?.title ?? a.was?.title ?? title;
      return v ? `${it(title)} title stays “${named(v)}”.` : `${it(title)} keeps its title.`;
    },
    maybe: (a, title) => still(title, `have the title “${a.set.title}”`),
  },
  priority: {
    text: (a, title) =>
      (a.set.priority ? `Priority: ${PRIOS[a.set.priority]?.label ?? a.set.priority}` : 'No priority') +
      ` on ${task(title)}`,
    refused: title => 'Priority' + on(title),
    dropped(a, title, t) {
      const p = t?.priority ?? a.was?.priority;
      if (p === undefined) return `${it(title)} keeps its priority.`;
      return p ? `${it(title)} priority stays ${PRIOS[p]?.label ?? p}.` : `${it(title)} stays without a priority.`;
    },
    maybe: (a, title) =>
      still(
        title,
        a.set.priority ? `have priority ${PRIOS[a.set.priority]?.label ?? a.set.priority}` : 'have no priority',
      ),
  },
  notes: {
    text: (a, title) => `Notes on ${task(title)}`,
    refused: title => 'Notes' + on(title),
    dropped: (a, title) => `${it(title)} notes stay as they are.`,
    maybe: (a, title) => still(title, 'have your new notes'),
  },
  reminders: {
    text: (a, title) => `Reminders on ${task(title)}`,
    refused: title => 'Reminders' + on(title),
    dropped: (a, title) => `${it(title)} reminders stay as they are.`,
    maybe: (a, title) => still(title, 'have your new reminders'),
  },
  asks: {
    text: (a, title) => `Asks on ${task(title)}`,
    refused: title => 'Asks' + on(title),
    dropped: (a, title) => `${it(title)} asks stay as they are.`,
    maybe: (a, title) => still(title, 'have your new asks'),
  },
  order: {
    text: (a, title) => `Moving a step in ${task(title)}`,
    refused: title => 'Moving a step' + (title ? ` in “${named(title)}”` : ''),
    dropped: (a, title) => `${it(title)} steps stay in their order.`,
    maybe: (a, title) => still(title, 'have its steps in the new order'),
  },
};
// A subtask's parent, by its title (`over`), or in words when Pocket doesn't know it.
const over = (a, none) => (a.over ? `“${named(a.over)}”` : none);
const edited = a => EDITED[a.rebase ?? Object.keys(a.set)[0]];
/* A link's words (`link` true), or an unlink's: whether the task is a subtask of its parent `a.up`, from Pocket's copy
   of the task when the copy lists its parents. */
const subWords = link =>
  keeps(
    (a, title, copy) => {
      const parents = copy(a.task)?.related_tasks?.parenttask,
        sub = parents ? parents.some(p => p.id === a.up) : link ? a.stage > 0 : !(a.stage > 0),
        parent = over(a, link ? 'another task' : 'its parent');
      if (!(a.stage > 0)) return `${it(title)} ${sub ? 'stays a subtask of' : "isn't a subtask of"} ${parent}.`;
      return `${it(title)} is ${sub ? 'a subtask of' : 'no longer a subtask of'} ${parent}.${upStays(a, copy)}`;
    },
    (a, title) =>
      link
        ? still(title, `be a subtask of ${over(a, 'another task')}`)
        : `${it(title)} may no longer be a subtask of ${over(a, 'its parent')} in Vikunja.`,
  );
export const OP_WORDS = {
  done: { ...ticked, text: (a, title, r) => `Done: ${row(title, r)}`, refused: (a, title) => 'A tick' + on(title) },
  doneNote: {
    ...ticked,
    text: (a, title, r) => `Done, with a comment: ${row(title, r)}`,
    refused: (a, title) => `Marking ${title ? `“${named(title)}”` : 'a step'} done, with its comment`,
  },
  skip: {
    ...ticked,
    refused: (a, title) => 'A skip' + on(title),
    text(a, title, r) {
      const why = htmlToText(a.html || '')
        .replace(/^Skipped:?\s*/, '')
        .trim();
      return `Skipped: ${row(title, r)}` + (why ? ` (${why})` : '');
    },
  },
  undone: {
    ...unticked,
    text: (a, title, r) => `Not done: ${row(title, r)}`,
    refused: (a, title) => `Marking ${title ? `“${named(title)}”` : 'a step'} not done`,
  },
  finish: {
    saved: "it's marked done",
    text: (a, title, r) => `Finishing “${row(title, r)}”`,
    refused: () => 'Finishing the checklist',
    dropped: checklistWords(true),
  },
  reopen: {
    saved: "it's marked not done",
    text: (a, title, r) => `Reopening “${row(title, r)}”`,
    refused: () => 'Reopening the checklist',
    dropped: checklistWords(false),
  },
  progress: {
    text: (a, title, r) => `Progress: ${a.pct}% on “${row(title, r)}”`,
    refused: (a, title) => 'Progress' + on(title),
    dropped: keeps(
      (a, title, copy) => {
        const t = copy(a.task),
          v = t ? pct(t) : a.stage > 0 ? `${a.pct}%` : a.was !== undefined ? `${a.was}%` : 'as it is';
        return `${it(title)} progress ${is(a)} ${v}.` + (a.stage > 0 ? upStays(a, copy) : '');
      },
      (a, title) => still(title, `have progress ${a.pct}%`),
    ),
  },
  note: {
    text: (a, title, r) => `A comment on “${row(title, r)}”`,
    refused: (a, title) => 'A comment' + on(title),
    dropped: (a, title) =>
      (unsure(a) ? still(title, 'have your comment') + ' ' : '') + 'Your comment is back where you typed it.',
  },
  // An answer is named by its ask's label, or by its step when it holds several answers or its ask has no label.
  answer: {
    text: (a, title, r) => row(title, r),
    refused: (a, title) => 'Answers' + on(title),
    dropped: keeps(
      (a, title) => {
        const lines = answerLines(textLines(a.html)) || [],
          label = lines.length === 1 && lines[0].match(/^(.+?): /)?.[1];
        return lines.length > 1
          ? `Your answers to ${it(title)} aren't saved.`
          : `Your answer to ${label ? `“${label}”` : it(title)} isn't saved.`;
      },
      (a, title) =>
        still(title, (answerLines(textLines(a.html)) || []).length > 1 ? 'have your answers' : 'have your answer'),
    ),
  },
  claim: {
    text: (a, title, r) => `Assigning “${row(title, r)}” to you`,
    refused: (a, title) => `Assigning ${title ? `“${named(title)}”` : 'it'} to you`,
    dropped: keeps(
      (a, title, copy) => `${it(title)} stays ${peopleWords(a, copy(a.task) ?? {})}.`,
      (a, title) => still(title, 'be assigned to you'),
    ),
  },
  unclaim: {
    text: (a, title, r) => `Unassigning you from “${row(title, r)}”`,
    refused: (a, title) => 'Unassigning you from ' + (title ? `“${named(title)}”` : 'it'),
    dropped: keeps(
      (a, title, copy) => `${it(title)} stays ${peopleWords(a, copy(a.task) ?? { assignees: [{ id: a.user }] })}.`,
      (a, title) => `You may still be unassigned from ${it(title)} in Vikunja.`,
    ),
  },
  // A person (`a.person`) or a label (`a.tag`) put on a task or taken off. Cancel names the people or labels Vikunja
  // has, or the row's before the change (`was`).
  assign: {
    text: (a, title) => assigning(a, title),
    refused: (a, title) => assigning(a, title),
    dropped: keeps(
      (a, title, copy) => `${it(title)} stays ${peopleWords(a, { assignees: copy(a.task)?.assignees ?? a.was })}.`,
      (a, title) =>
        a.add
          ? still(title, `be assigned to ${someone(a, a.person)}`)
          : `${a.person.id === a.user ? 'You' : someone(a, a.person)} may still be unassigned from ${it(title)} in Vikunja.`,
    ),
  },
  label: {
    text: (a, title) => labelling(a, title),
    refused: (a, title) => labelling(a, title),
    dropped: keeps(
      (a, title, copy) => {
        const list = copy(a.task)?.labels ?? a.was ?? [];
        return list.length
          ? `${it(title)} labels stay ${andList(list.map(l => l.title))}.`
          : `${it(title)} has no labels.`;
      },
      (a, title) => still(title, `${a.add ? 'have' : 'be without'} label ${a.tag.title}`),
    ),
  },
  delete: {
    text: (a, title, r) =>
      `Deleting “${row(title, r)}”` + (a.ids?.length > 1 ? `, with ${plural(a.ids.length - 1, 'subtask')}` : ''),
    refused: (a, title) => 'Deleting' + (title ? ` “${named(title)}”` : ' a task'),
    dropped: keeps(
      (a, title, copy) =>
        a.stage > 0 ? `${it(title)} is deleted.${upStays(a, copy)}` : `${it(title)} stays in Vikunja.`,
      (a, title) => `${it(title)} may already be deleted in Vikunja.`,
    ),
  },
  position: {
    text: (a, title, r) => `Moving “${row(title, r)}” in its list`,
    refused: (a, title) => 'Moving' + (title ? ` “${title}”` : ' a task'),
    dropped: keeps(
      (a, title) => `${it(title)} stays where it was in its list.`,
      (a, title) => still(title, 'be in its new place in its list'),
    ),
  },
  // A new date, named as the message after a move names it. Cancel names the date Vikunja has, or the one before the
  // move (`was`).
  due: {
    text: (a, title, r) => `${movedTo(dayName(a.due))}: ${row(title, r)}`,
    refused: (a, title) => 'Moving' + (title ? ` “${title}”` : ' a task'),
    dropped(a, title, copy = () => undefined) {
      // Taking a repeating template's date off turns its repeat off first, and puts it back last (`rep`, ops/dates.js).
      // Stopped after its first request, the template has no repeat. A move whose answer is unknown names the new date,
      // or, when the request in doubt is about the repeat, both changes.
      const rep = a.fixed?.seen?.rep,
        d = copy(a.task)?.due_date ?? a.was;
      if (rep && a.stage === 1 && unsure(a))
        return `${it(title)} no longer repeats. ${still(title, 'be ' + dueWords(a.due))} Set its repeat again in its sheet.`;
      if (rep && (a.stage === 1 || (a.stage === 2 && !unsure(a))))
        return (
          (a.stage === 1
            ? `${it(title)} no longer repeats. ${isSet(d) ? 'Its' : 'It'} ${dueStays(d)}.`
            : `${it(title)} has no due date and no longer repeats.`) + ' Set its repeat again in its sheet.'
        );
      if (unsure(a)) return still(title, rep ? 'be without a due date or a repeat' : 'be ' + dueWords(a.due));
      return `${it(title)} ${dueStays(d)}.`;
    },
  },
  // How a task repeats, in the words of the sheet's Repeats list. Cancel names the repeat Vikunja has, or the one before
  // the change (`was`).
  repeat: {
    text: (a, title, r) => `${repeatText(a.set || {})}: ${row(title, r)}`,
    refused: (a, title) => `Changing how ${title ? `“${named(title)}”` : 'a task'} repeats`,
    dropped: keeps(
      (a, title, copy) => {
        const every = everyText(copy(a.task) ?? a.was ?? {});
        if (every) return `${it(title)} repeat ${is(a)} ${every}.`;
        return a.stage > 0 ? `${it(title)} has no repeat.` : `${it(title)} stays without a repeat.`;
      },
      (a, title) => still(title, everyText(a.set || {}) ? 'repeat ' + everyText(a.set || {}) : 'have no repeat'),
    ),
  },
  edit: {
    text: (a, title) => edited(a).text(a, title),
    refused: (a, title) => edited(a).refused(title),
    dropped: keeps(
      (a, title, copy) => edited(a).dropped(a, title, copy(a.task)),
      (a, title) => edited(a).maybe(a, title),
    ),
  },
  // A move to another project, named by the projects' titles (`into`, `from`), with the subtasks it moves (`subs`).
  project: {
    saved: "it's moved",
    text: (a, title) => {
      const n = Object.keys(a.subs || {}).length;
      return (
        `Moving ${task(title)} to ${a.into || 'another project'}` +
        (!n ? '' : n === 1 ? ', with its subtask' : `, with its ${n} subtasks`)
      );
    },
    refused: (a, title) => `Moving ${task(title)} to ${a.into || 'another project'}`,
    // Stopped partway, the task is moved, and the subtasks after the refused one are not.
    dropped: keeps(
      (a, title, copy) => {
        const from = a.from || 'its project',
          into = a.into || 'the other project';
        if (a.stage > 0)
          return (
            `${it(title)} is in ${into}.` +
            (a.subs && Object.keys(a.subs).length ? ` Some of its subtasks stay in ${from}.` : '')
          );
        const t = copy(a.task),
          now = !t || t.project_id === a.was?.[a.task] ? from : t.project_id === a.pid ? into : 'its project';
        return `${it(title)} stays in ${now}.`;
      },
      (a, title) => still(title, `be in ${a.into || 'the other project'}`),
    ),
  },
  // A subtask and its parent (`over`).
  link: {
    saved: "it's a subtask",
    text: (a, title) => `Making ${task(title)} a subtask of ${over(a, 'another task')}`,
    refused: (a, title) => `Making ${task(title)} a subtask of ${over(a, 'another task')}`,
    dropped: subWords(true),
  },
  unlink: {
    saved: "it's no longer a subtask",
    text: (a, title) => `Taking ${task(title)} out of ${over(a, 'its parent')}`,
    refused: (a, title) => `Taking ${task(title)} out of ${over(a, 'its parent')}`,
    dropped: subWords(false),
  },
  // An add's line, under what it goes under (`a.over`). Only a line whose task is made (`taskId`) is cancelled in the
  // Outbox with these words. Before that, its Cancel gives the lines back (cancelOf).
  add: {
    saved: "it's added",
    text: (a, title) =>
      a.taskId
        ? `Finishing “${named(title)}”`
        : a.over
          ? `Subtask of “${named(a.over)}”: ${title}`
          : `New task: ${title}`,
    refused: (a, title) => 'Adding' + (title ? ` “${title}”` : ' a task'),
    dropped: keeps(
      (a, title) => (a.taskId ? `${it(title)} is added.` : ''),
      (a, title) => (a.taskId ? `${it(title)} is added.` : `${it(title)} may already be added in Vikunja.`),
    ),
  },
  /* A checklist started from a template (`a.template`), and a step added to a checklist (`a.runTitle`). Cancel deletes
     what each made, so it says only "Cancelled." (dropped). A task whose answer was unknown can't be found, so the
     words say it may still be in Vikunja. `gone` is what Cancel says once the op was sent in full. */
  startRun: {
    text: a => `${a.cancelled ? 'Cancelling the start of' : 'Starting'} “${a.template.title}”`,
    refused: a => `${a.cancelled ? 'Cancelling the start of' : 'Starting'} “${a.template.title}”`,
    dropped: keeps(
      () => '',
      a => `The checklist started from “${a.template.title}”, or one of its steps, may still be in Vikunja.`,
    ),
    gone: "The checklist had already started. Delete it from its ⋯ menu if you don't need it.",
  },
  /* A task made a template, and a step added to a template (`a.p`, as quick add parsed its line). Cancel takes back
     what each made, a change whose answer was unknown too, so it says only "Cancelled." (dropped). A step whose task
     Vikunja may or may not have made can't be found, so the words say it may still be there. */
  makeTemplate: {
    text: (a, title) =>
      a.cancelled ? `Cancelling Make template on ${task(title)}` : `Making ${task(title)} a template`,
    refused: (a, title) =>
      a.cancelled ? `Cancelling Make template on ${task(title)}` : `Making ${task(title)} a template`,
    dropped: () => '',
  },
  templateStep: {
    text: (a, title) =>
      a.cancelled
        ? `Removing “${named(a.p.title)}”, because adding it was cancelled`
        : `Adding “${named(a.p.title)}” to ${task(title)}`,
    refused: a => `${a.cancelled ? 'Removing' : 'Adding'} “${named(a.p.title)}”`,
    dropped: keeps(
      () => '',
      (a, title) => (a.taskId ? '' : `“${named(a.p.title)}” may still be in ${task(title)} in Vikunja.`),
    ),
  },
  addStep: {
    text: a =>
      a.cancelled
        ? `Removing “${named(a.title)}”, because adding it was cancelled`
        : `${a.from || a.tpl != null ? 'Repeated' : 'Inserted'} in “${a.runTitle}”: “${named(a.title)}”`,
    refused: a =>
      a.cancelled
        ? `Removing “${named(a.title)}”`
        : `${a.from || a.tpl != null ? 'Repeating' : 'Inserting'} “${named(a.title)}”`,
    dropped: keeps(
      () => '',
      a => (a.taskId ? '' : `“${named(a.title)}” may still be in “${a.runTitle}” in Vikunja.`),
    ),
    gone: "It was already sent. Delete it from the checklist if you don't need it.",
  },
};
// Why a claim or an untick is dropped. Another person was assigned first, or someone finished the checklist.
export const assignedJustNow = names =>
  `${andList(names)} ${names.length === 1 ? 'was' : 'were'} assigned to it just now`;
export const FINISHED_MEANWHILE = 'the checklist was finished in the meantime, so the step stays done';
/* The plugin's relay answers 409 with Idempotency-Unknown when it can't tell whether Vikunja made a change. Pocket
   can't tell either, and only the user can check. So the change waits in the Outbox, and Try again sends it as a new
   request. UNKNOWN is the note on its row in the Outbox, and the reason the entry keeps. notKnown(what) is the message,
   with the change named as its refusal names it. */
const CHECK = " Check, then tap Try again if it's missing.";
export const UNKNOWN = 'May not have reached Vikunja.' + CHECK;
export const notKnown = what => `${what} may not have reached Vikunja.` + CHECK;
/* What went wrong with a file sent with a change, as a clause of the message's "but …": the relay can't vouch for its
   upload, and Pocket doesn't keep it to try again, so there is nothing to tap. Or Vikunja refused it (`why`), or the
   phone lost it. */
export const fileNotKnown = name => `${name} may not have reached Vikunja`;
export const notUploaded = (name, why) => `${name} didn't upload: ${why}`;
export const fileLost = name => `${name} was lost on this device before it uploaded`;
// The button on a message about a change kept in the Outbox. It only opens the Outbox, because after an unknown answer
// the user checks Vikunja before the change is sent again.
export const toOutbox = app => ({ label: 'Outbox', fn: () => app.openOutbox() });

/* What a screen reader announces (this.said) after a change that shows on screen without a message, and the message
   beside it when it has one. */
// A message and its button: "Moved 6 to today. Undo is beside it."
export const besideIt = (text, action) => text + (action ? `. ${action.label} is beside it.` : '');
// A tick (`done`) or an untick of task `title`.
export const tickSaid = (done, title) => (done ? 'Done: ' : 'Not done: ') + title;
// A tick of a repeating task, with its next date (`next`, "next Tue, Oct 20") when Pocket knows it.
export const doneRepeats = (title, next = '') => `Done: ${title}. It repeats${next ? ', ' + next : ''}`;
// The same in a task's sheet, where the title is on screen already.
export const repeatsNext = next => (next ? 'Repeats · ' + next : 'Done — repeats');
// A checklist finished, named by `title` where nothing else on screen names it. `wait` is sendActs' result when the
// finish waits (sentLater).
export const finishedText = (title = '', wait = null) => {
  const said = title ? 'Finished ' + title : 'Finished';
  return wait ? sentLater(said, wait.reached) : said;
};
// A step ticked while it waits (sentLater), named by `title` where nothing else on screen names it.
export const doneLater = (title = '', reached = false) => sentLater(title ? tickSaid(true, title) : 'Done', reached);
// Progress set with a swipe, on task `title`, or in the task's own sheet without one.
export const progressSaid = (pct, title = '') =>
  title ? `Progress of ${title} set to ${pct}%` : `Progress set to ${pct}%`;
// A task moved among its siblings, as its place in the list: "Buy milk is now 2 of 5".
export const placeSaid = (title, at, of) => `${title} is now ${at} of ${of}`;
// Undo of a move to another project put the task back in `project`.
export const movedBack = project => 'Moved back to ' + (project || 'its project');
// A task taken out of `n` parents, the first named `first`.
export const noLongerSub = (n, first) => `No longer a subtask of ${n === 1 ? `“${first}”` : n + ' tasks'}`;
// A task deleted from its row, which shows a gap with Restore.
export const deletedSaid = title => `Deleted ${title}. Restore is where the row was.`;
// A task deleted where it has no row, with `n` subtasks. A long title is shortened.
export const deletedText = (title, n = 0) =>
  `Deleted “${title.length > 40 ? title.slice(0, 38) + '…' : title}”` + (n ? ` + ${plural(n, 'subtask')}` : '');
// A template deleted with `n` steps, after its sheet closed.
export const deletedSteps = n => (n ? `Deleted, with ${plural(n, 'step')}` : 'Deleted');
// Undo of a repeated step.
export const notRepeated = title => `Not repeated: ${title}`;
// A step repeated in a checklist, with Undo beside it.
export const repeatedStep = title => `Repeated “${title}”`;
// A project made, in its own screen, or as a checklists project on Checklists.
export const createdProject = (title, checklists = false) =>
  checklists ? `Created ${title}, for checklists.` : `Created ${title}`;
// A timed step's countdown reached zero.
export const dueNow = title => `“${title}” is due now`;
// The tasks whose due time (`due`) or reminder (`reminded`) just passed, by `titles`, as a screen reader hears them.
export const dueSaid = (titles, due, reminded) =>
  titles.length === 1
    ? due
      ? dueNow(titles[0])
      : `Reminder: “${titles[0]}”`
    : `${titles.length} tasks are due ${reminded ? 'or have a reminder ' : ''}now: “${titles[0]}” and ${titles.length - 1} more`;
// Who a checklist is for, after a change (forText, "For Sam and you").
export const nowFor = forText => forText.replace(/^For/, 'Now for');

/* What the add boxes say when only part of what was typed was added: `k` of `n` lines, with `but`, what didn't go as
   asked (", but …"). */
export const addedPart = (k, n, but = '') => `Added ${k} of ${n}${but}.`;
/* What an add box says when Vikunja refused line `title` for `why`, after `k` of `n` lines were added, with `but`. The
   lines from it on go back to the box. */
export const lineRefused = (k, n, but, title, why) =>
  (k ? addedPart(k, n, but) + ' ' : '') + notSaved(title && `“${title}”`, why);
// Subtasks added from a task's sheet, with `but`.
export const addedSubs = (n, but = '') => `Added ${n === 1 ? '1 subtask' : n + ' subtasks'}${but}`;
// Photos sent with a task that reached Vikunja, while the photos wait: for a busy Vikunja (`reached`), or offline.
export const photosLater = (project, n, reached = false) =>
  `Added to ${project || 'its project'}. ` +
  (reached ? BUSY : `${n === 1 ? 'The photo goes' : 'The photos go'} to Vikunja when you're back online.`);
// Lines added offline under a task, which Vikunja wouldn't put under it (`why`). `loose` are the titles made as tasks
// of their own, and `unsent` the text of the lines not added.
export const subsNotUnder = (parent, why, loose, unsent) =>
  `Subtasks of “${parent}” added offline couldn't be added under it: ${why.replace(/\.$/, '')}.` +
  (loose.length
    ? ` ${loose.map(t => `“${t}”`).join(', ')} ${loose.length === 1 ? 'is now its own task' : 'are now their own tasks'}.`
    : '') +
  (unsent.length ? ` Not added: ${unsent.join('; ')}.` : '');
// What the sender found wrong with changes that reached Vikunja.
export const sentBut = problems => 'Sent what was waiting, but ' + problems.join('; ');
// A line cancelled in the add box. `back` is its title when its text went back to the box. `rest` lines were under it,
// which now go under `over`, or become tasks of their own.
export const lineCancelled = (back, rest, over) =>
  [
    'Cancelled.',
    back && `“${back}” is back where you typed it.`,
    rest &&
      `The ${rest} line${rest === 1 ? '' : 's'} under it ${rest === 1 ? 'is' : 'are'} now ` +
        (over ? `under “${over}”.` : `${rest === 1 ? 'its own task' : 'their own tasks'}.`),
  ]
    .filter(Boolean)
    .join(' ');
// Cancel in the Outbox. `words` say what Vikunja keeps (OP_WORDS' dropped). `back` is how the text went back to its box:
// 'lines' for the lines under a line, 'text' for an op's own text, or '' for none.
export const cancelled = (words, back = '') =>
  [
    'Cancelled.',
    words,
    back === 'lines'
      ? 'The lines under it are back where you typed them.'
      : back && 'Its text is back where you typed it.',
  ]
    .filter(Boolean)
    .join(' ');
// Cancel tapped once the change was sent (SENT_FIRST), as a waiting row's line was, or with its requests on their way.
export const SENT_FIRST = 'It was sent before it could be cancelled.';
export const notStopped = gone => (gone ? SENT_FIRST : "It is being sent and can't be stopped now.");

// Quick add's project, `project`, which the user can't write to.
export const readOnly = project => `${project || 'That project'} is read only. Type +project to pick another project.`;
// No user has the name typed after @ in a task's sheet.
export const noUser = name => `No user @${name}`;
// The date Pocket picked for a task given a repeat with no date, as `when` ("Tomorrow 9:00 AM").
export const repeatDate = when =>
  `Pocket set the due date to ${when}, because a repeat needs one. Change the date above if that's wrong.`;
// Files Vikunja won't take, each named with its size, and the largest size it takes.
export const tooBigText = (files, max) =>
  `${files.join(', ')} ${files.length === 1 ? 'is' : 'are'} too big. Your Vikunja accepts files up to ${max}.`;
// A template's steps changed, with what Pocket couldn't apply.
export const changedBut = problems => 'Changed, but ' + problems.join('; ');
// A template made from a task. `schedule` says when it is due (scheduleText), and `repeats` whether starting it moves it
// on to its next date.
export const templateMade = (schedule = '', repeats = false) =>
  !schedule
    ? 'Template created. Start it here or under Checklists.'
    : `Template created. ${schedule}. Starting it on or after the due day ` +
      (repeats ? 'moves it to its next date.' : "marks it done, because it doesn't repeat.");
// A template made in New template, named `title`.
export const templateCreated = title => `Created ${title}. Start it here.`;
// Set up checklists made the Checklists project. `example` is false when Vikunja refused the example template.
// `wait` is what the example says while it waits (waitText), or ''.
export const setUpText = (example, wait = '') =>
  !example
    ? "Created the Checklists project. The example template couldn't be created. Tap New template to add one."
    : 'Created the Checklists project, with an example template to try.' + (wait ? ' ' + wait : '');
// A project marked for checklists (`on`), or unmarked.
export const checklistsOn = on =>
  on
    ? 'This project is now used for checklists. Its templates and checklists are under Checklists.'
    : 'This project is no longer used for checklists.';
// A project archived or deleted, named `title`, on Projects.
export const archivedText = title => 'Archived ' + title;
export const deletedProject = title => 'Deleted ' + title;
// The sentences that never change, by situation.
export const SAID = {
  renamed: 'Renamed',
  started: 'Started',
  notesSaved: 'Notes saved',
  stepRemoved: 'Step removed',
  stepDeleted: 'Step deleted',
  checklistRemoved: 'Checklist removed',
  checklistDeleted: 'Checklist deleted',
  checklistGone: 'That checklist no longer exists.',
  projectGone: 'That project no longer exists.',
  noProject: 'Create a project in Vikunja first',
  onePerson: 'A checklist needs at least one person. Tap someone else first.',
  asksSaved: 'Asks saved. Checklists started from now on ask them.',
  notYours: 'Not changed. Only the person who made this template or a project admin can change it.',
  swipeHint: 'Tip: swipe a task to the right to start working on it.',
  notesConflict:
    'Not saved. Someone changed the notes while you were writing. Both versions are shown. Save again to replace theirs with yours.',
  notesConflictRow:
    'Notes not saved. Someone changed them while you were writing. Your version is kept. Open the task to see both.',
};
// A failed read of the done tasks, a search or a refresh: what failed, and `why`.
export const couldnt = (what, why) => `Couldn't ${what}: ${why}`;

/* The questions Pocket asks before a change it can't undo (confirm). */
// Deleting a task with subtasks: `direct` under it, and `deeper` under those.
export const deleteAsk = (title, direct, deeper = 0) =>
  `Delete “${title}” and its ${plural(direct, 'subtask')}` +
  (deeper ? `, ${deeper} more under ${direct === 1 ? 'it' : 'them'}` : '') +
  '?';
// Deleting a template with `n` steps.
export const deleteTemplateAsk = (title, n) =>
  `Delete the template “${title}”` +
  (n ? ` and its ${plural(n, 'step')}? Checklists already started keep their steps.` : '?') +
  " This can't be undone in Pocket.";
// Deleting a checklist with `n` steps.
export const deleteRunAsk = (title, n) =>
  `Delete “${title}” and its ${plural(n, 'step')} for everyone? Their comments and photos are deleted too. This can't be undone.`;
// Deleting a step added to a checklist.
export const deleteStepAsk = title =>
  `Delete “${title}”? This step was added to this checklist only. The template doesn't change.`;
// Removing a step from a template.
export const removeStepAsk = title => `Remove “${title}” from the template? Checklists already started keep it.`;
// Unticking a step that `others` ticked, whose ✅ only they can remove.
export const othersDoneAsk = (others, title) =>
  `${others.join(' and ')} marked “${title}” done. Only they can remove their ✅ in Vikunja, so it stays. Mark the step not done anyway?`;
// Archiving a project.
export const archiveAsk = title =>
  `Archive “${title}”? Pocket and Vikunja hide the project and its tasks until you unarchive it in Vikunja's web app.`;
// Deleting a project with `tasks` tasks (null when unknown) and `kids` projects inside it.
export const deleteProjectAsk = (title, tasks, kids) => {
  const what = [tasks == null ? 'tasks' : plural(tasks, 'task'), kids && plural(kids, 'project') + ' inside it'];
  return `Delete “${title}” and its ${what.filter(Boolean).join(' and ')}? This can't be undone.`;
};
/* Signing out with changes that haven't reached Vikunja: `tasks` lines not made yet, `files` photos or files (`photos`
   says they are all photos), and `changes`, every other waiting op. */
export const signOutAsk = ({ tasks = 0, files = 0, photos = false, changes = 0 }) => {
  const n = tasks + files + changes,
    count = (k, word) => (k === 1 ? 'a ' + word : `${k} ${word}s`),
    kinds = [
      tasks && count(tasks, 'task'),
      files && count(files, photos ? 'photo' : 'file'),
      changes && count(changes, 'change'),
    ].filter(Boolean),
    what = andList(kinds);
  return `${what[0].toUpperCase() + what.slice(1)} ${n === 1 ? "hasn't" : "haven't"} reached Vikunja yet. Sign out anyway and discard ${n === 1 ? 'it' : 'them'}?`;
};

/* Who started a checklist, and when. A finished checklist's summary shows "Started by <name> at 6:02 AM", or for
   another day "Started by <name>, Oct 8, 6:02 AM". The top of the checklist's ⋯ sheet always includes the day (`day`).
   `who` is the person's name or "you". Returns '' when `who` is unknown, and only the name when the time is unknown. */
export function startedText(who, at, { now = new Date(), day = false } = {}) {
  if (!who) return '';
  const d = at ? new Date(at) : null;
  if (!d || !(d.getTime() > 0)) return `Started by ${who}`;
  const today = d.toDateString() === new Date(now).toDateString();
  return (
    `Started by ${who}` +
    (today && !day
      ? ' at ' + fmtTime(d)
      : ', ' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  );
}

// The message shown after the user copies something, by what was copied: progress as text (where there is no share
// sheet), a Markdown list (pasting it into Pocket's add box makes the same tasks), a task's notes, or a comment.
// `failed` is for when the browser didn't allow the copy.
export const COPIED = {
  text: 'Copied. Paste it into a message',
  markdown: "Copied as a Markdown list. Paste it into your notes, or into Pocket's add box to make the same tasks",
  notes: 'Copied the notes',
  comment: 'Copied the comment',
  failed: "Not copied. This browser didn't allow it",
};

// Names in a sentence: "A", "A and B", "A, B and C". Past `most` names, it lists the first `most` and counts the rest:
// "A, B, C and 2 more".
export function namesText(names, most = 3) {
  const shown = names.length > most ? [...names.slice(0, most), `${names.length - most} more`] : names;
  return shown.length < 2 ? shown.join('') : shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1);
}
/* The question a parent's ring asks (sheet/complete.html). Returns {head, body, yes}, where `yes` is the button's
   label. For a task, the question is whether to complete it together with the open subtasks in `names`. `stay` is how
   many subtasks repeat and stay as they are. For a checklist (`run`), the question is whether to finish it and leave
   the steps in `names` not done. The names are written into a sentence, not a list, so they aren't mistaken for boxes
   to pick from. */
export function completeAsk({ title, run = false, names = [], stay = 0 }) {
  const n = names.length,
    which = namesText(names);
  if (run)
    return {
      head: `Finish this checklist with ${plural(n, 'step')} not done?`,
      yes: 'Finish checklist',
      body: `${n === 1 ? 'This step stays' : `These ${n} steps stay`} not done: ${which}.`,
    };
  const stays = !stay
    ? ''
    : stay === 1
      ? 'The one that repeats stays as it is.'
      : `The ${stay} that repeat stay as they are.`;
  const goes = !n
    ? ''
    : n === 1
      ? `Its open subtask will be marked done too: ${which}.`
      : `Its ${n} open subtasks will be marked done too: ${which}.`;
  return {
    head: `Complete “${title}”?`,
    body: [goes, stays].filter(Boolean).join(' '),
    yes: n ? `Complete all ${n + 1}` : 'Complete it',
  };
}
