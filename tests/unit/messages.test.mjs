// The messages Pocket shows (src/js/messages.js), and where each one appears on a screen or in a sheet (src/js/app/lines.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedPart,
  addedSubs,
  addedWhere,
  archiveAsk,
  archivedText,
  besideIt,
  cancelled,
  cancelName,
  changedBut,
  changedSince,
  checklistsOn,
  COMMENTS_OFFLINE,
  completeAsk,
  COPIED,
  couldnt,
  createdProject,
  dayWord,
  deleteAsk,
  deletedProject,
  deletedSaid,
  deletedSteps,
  deletedText,
  deleteProjectAsk,
  deleteRunAsk,
  deleteStepAsk,
  deleteTemplateAsk,
  directFailed,
  doneLater,
  doneLine,
  doneRepeats,
  doneText,
  dueNow,
  dueRowSaid,
  dueSaid,
  fileLost,
  fileNotKnown,
  finishedText,
  headText,
  KEPT,
  lineCancelled,
  lineNotSaved,
  lineRefused,
  moreDone,
  movedBack,
  movedText,
  movedTo,
  movedToProject,
  namesText,
  noLongerSub,
  NOT_KEPT,
  notDone,
  notExpected,
  notKnown,
  notMovedBack,
  notReordered,
  notRepeated,
  notSaved,
  notStopped,
  notUploaded,
  noUser,
  nowFor,
  offlineFor,
  OP_WORDS,
  othersDoneAsk,
  OUTBOX,
  outboxLabel,
  photosLater,
  placeSaid,
  progressSaid,
  projectNotSaved,
  readOnly,
  refusedEarlier,
  refusedNote,
  removeStepAsk,
  repeatDate,
  repeatedStep,
  repeatsNext,
  ringSaid,
  rowLineSaid,
  SAID,
  savedOffline,
  SENT_FIRST,
  sentBut,
  sentLater,
  setUpText,
  SIGNED_OUT,
  signOutAsk,
  startedText,
  startMarksDone,
  STILL_OFFLINE,
  subsNotUnder,
  templateCreated,
  templateMade,
  templateNotSaved,
  templateProblem,
  textBack,
  tickSaid,
  tooBigText,
  toOutbox,
  TOTP_NEEDED,
  UNDO,
  UNKNOWN,
  unmarkedSaid,
  waitingWords,
  waitText,
} from '../../src/js/messages.js';
import { ZERO as ZERO_DATE } from '../../src/js/util.js';
import { NetError } from '../../src/js/api.js';
import lines from '../../src/js/app/lines.js';
import leaving from '../../src/js/app/leaving.js';
import { blankSheet } from '../../src/js/app/core.js';
import toastPart, { UNDO_MS } from '../../src/js/app/toast.js';

/* The row at the end of a list of done tasks that is shown a part at a time. It offers the next part and says how many
   tasks are left. When fewer than a full part are left, it offers the last of them. When none are left, there is no
   row. */
test('the row for more done tasks names what a tap shows and how many tasks are left', () => {
  assert.deepEqual(moreDone(2900, 100), {
    title: 'Show 100 done earlier',
    note: `${(2900).toLocaleString()} more not shown`,
  });
  assert.deepEqual(moreDone(101, 100), { title: 'Show 100 done earlier', note: '101 more not shown' });
  assert.deepEqual(
    moreDone(100, 100),
    { title: 'Show the last 100', note: '' },
    'when exactly one part is left, the row offers the last of them',
  );
  assert.deepEqual(moreDone(12, 100), { title: 'Show the last 12', note: '' });
  assert.deepEqual(moreDone(1, 50), { title: 'Show the last one', note: '' });
  assert.deepEqual(
    moreDone(60, 50),
    { title: 'Show 50 done earlier', note: '60 more not shown' },
    'search loads 50 at a time',
  );
  assert.equal(moreDone(0, 100), null, 'with no tasks left, there is no row');
  assert.equal(
    moreDone(-3, 100),
    null,
    'with more tasks shown than counted, because tasks were done since, there is no row',
  );
});

/* A change that waits while Pocket is offline ends with when it goes to Vikunja. "Saved offline" is said only while
   Pocket is offline. A busy Vikunja has its own words (waitText). */
test('a change that waits offline says it goes to Vikunja when you are back online, for one change or several', () => {
  assert.equal(savedOffline(), "Saved offline. It goes to Vikunja when you're back online.");
  assert.equal(savedOffline(3), "Saved offline. They go to Vikunja when you're back online.");
  assert.equal(savedOffline(1, 2), "Saved offline, with 2 photos. They go to Vikunja when you're back online.");
  assert.equal(savedOffline(1, 1), "Saved offline, with the photo. They go to Vikunja when you're back online.");
  assert.equal(
    sentLater(finishedText('Wipe the counter')),
    "Finished Wipe the counter. It goes to Vikunja when you're back online.",
  );
  assert.equal(finishedText('', {}), "Finished. It goes to Vikunja when you're back online.");
  assert.equal(finishedText('Closing', {}), "Finished Closing. It goes to Vikunja when you're back online.");
  assert.equal(doneLater(), "Done. It goes to Vikunja when you're back online.");
  assert.equal(doneLater('Mop'), "Done: Mop. It goes to Vikunja when you're back online.");
  assert.equal(OUTBOX.offline, "No connection. These go to Vikunja when you're back online.");
  assert.equal(STILL_OFFLINE, "Still offline. These go to Vikunja when you're back online.");
  assert.equal(photosLater('Orders', 1), "Added to Orders. The photo goes to Vikunja when you're back online.");
  assert.equal(photosLater(undefined, 2), "Added to its project. The photos go to Vikunja when you're back online.");
});

/* A request whose reply was lost puts Pocket offline, as one that never left the phone does. Pocket sends either again
   by itself, so neither says to tap Try again. */
test('a change that waits says why: offline, or a busy Vikunja', () => {
  assert.equal(waitText({}, 2), "Saved offline. They go to Vikunja when you're back online.");
  assert.equal(waitText({ reached: true }), 'Waiting for Vikunja. Pocket tries again every 30 seconds.');
  assert.equal(waitText({ reached: true }), OUTBOX.busy, 'the busy words are the Outbox’s');
  assert.equal(
    finishedText('Closing', { reached: true }),
    'Finished Closing. Waiting for Vikunja. Pocket tries again every 30 seconds.',
  );
  assert.equal(doneLater('', true), 'Done. Waiting for Vikunja. Pocket tries again every 30 seconds.');
  assert.equal(
    photosLater('Orders', 2, true),
    'Added to Orders. Waiting for Vikunja. Pocket tries again every 30 seconds.',
  );
});

test('an action that needs Vikunja at once says what to do once back online, or why Vikunja refused it', () => {
  assert.equal(offlineFor('create the project'), "Offline. You can create the project once you're back online.");
  assert.equal(
    directFailed(new NetError('Failed to fetch'), 'rename the project', 'Renaming the project'),
    "Offline. You can rename the project once you're back online.",
  );
  assert.equal(
    directFailed(new Error('Forbidden'), 'rename the project', 'Renaming the project'),
    "Renaming the project couldn't be saved: Forbidden.",
  );
  assert.equal(
    notDone('started', 'step 2, “Mop”: no step is named “x”'),
    'Not started: step 2, “Mop”: no step is named “x”.',
  );
  assert.equal(notDone('deleted', 'Not found.'), 'Not deleted: Not found.', 'one full stop');
  assert.equal(templateProblem('step 1, “Mop”: x'), 'Template not created: step 1, “Mop”: x');
});

/* Vikunja refused a change: what couldn't be saved, Vikunja's reason, then what happens next. */
test('a refused change names it, gives Vikunja’s reason, and says what happens next', () => {
  assert.equal(
    notSaved('“Buy milk”', 'Forbidden', { next: KEPT }),
    "“Buy milk” couldn't be saved: Forbidden. It's kept to try again.",
  );
  assert.equal(
    notSaved('A tick on “Mop”', 'Forbidden.'),
    "A tick on “Mop” couldn't be saved: Forbidden.",
    'one full stop',
  );
  assert.equal(
    notSaved('Moving “Mop”', 'Gone', { saved: "it's moved" }),
    "Moving “Mop” couldn't be saved in full (it's moved): Gone.",
  );
  assert.equal(notSaved('', 'Forbidden'), "It couldn't be saved: Forbidden.");
  assert.equal(
    notSaved('A comment on “Mop”', 'Forbidden', { next: textBack({ back: true }) }),
    "A comment on “Mop” couldn't be saved: Forbidden. Its text is back in the box.",
  );
  assert.equal(textBack({ words: 'Wiped' }), ' It said: “Wiped”');
  assert.equal(textBack({}), '');
  assert.equal(
    notReordered(Object.assign(new Error('Forbidden'), { status: 403 })),
    "The new order couldn't be saved: Forbidden.",
  );
  assert.equal(notReordered(null), "The new order couldn't be saved: Vikunja refused it.");
  assert.equal(projectNotSaved(new Error('Forbidden')), "The new project couldn't be saved: Forbidden.");
  assert.equal(templateNotSaved('Forbidden'), "The new template couldn't be saved: Forbidden.");
  assert.equal(
    lineNotSaved(false, 'Forbidden.'),
    "A task you added offline couldn't be saved: Forbidden. Its text is back in the add box.",
  );
  assert.equal(
    lineNotSaved(true, 'Forbidden'),
    "A subtask you added offline couldn't be saved: Forbidden. Its text is back in the add box.",
  );
  assert.equal(refusedEarlier('Mop'), 'Not sent. Vikunja refused an earlier change to “Mop”.');
  assert.equal(refusedNote('Forbidden'), 'Vikunja refused it: Forbidden');
  assert.equal(refusedNote(UNKNOWN), UNKNOWN);
  assert.equal(OUTBOX.refused, 'Vikunja refused these. Fix what its message says, then tap Try again. Or tap Cancel.');
});

/* A message about a change kept in the Outbox names the change and has an Outbox button. The button opens the Outbox
   and sends nothing. The message and the Outbox's row both tell the user to check, then tap Try again. */
test('a change with an unknown answer says to check Vikunja, and its button opens the Outbox', () => {
  assert.equal(
    notKnown(OP_WORDS.done.refused({ op: 'done' }, 'Buy milk')),
    "A tick on “Buy milk” may not have reached Vikunja. Check, then tap Try again if it's missing.",
  );
  assert.equal(
    notKnown(OP_WORDS.add.refused({ op: 'add' }, 'Buy milk')),
    "Adding “Buy milk” may not have reached Vikunja. Check, then tap Try again if it's missing.",
  );
  assert.equal(UNKNOWN, "May not have reached Vikunja. Check, then tap Try again if it's missing.");
  assert.equal(fileNotKnown('a.jpg'), 'a.jpg may not have reached Vikunja', 'a clause, with nothing to tap');
  assert.equal(notUploaded('a.jpg', 'Too big'), "a.jpg didn't upload: Too big");
  assert.equal(fileLost('a.jpg'), 'a.jpg was lost on this device before it uploaded');
  let opened = 0;
  const b = toOutbox({ openOutbox: () => opened++ });
  b.fn();
  assert.deepEqual([b.label, opened], ['Outbox', 1]);
});

/* After an unknown answer, Cancel says what may still be in Vikunja, unless its stages take the change back. */
test('Cancel after an unknown answer says what may still be in Vikunja, or only Cancelled where it takes the change back', () => {
  const failed = { message: UNKNOWN },
    words = (op, a, title = 'Mop the floor') =>
      cancelled(OP_WORDS[op].dropped({ op, task: 7, user: 1, failed, ...a }, title));
  assert.deepEqual(
    [
      words('edit', { set: { priority: 3 } }),
      words('edit', { set: { priority: 0 } }),
      words('edit', { set: { title: 'Mop' } }),
      words('edit', { rebase: 'notes', set: {} }),
      words('done', {}),
      words('undone', {}),
      words('progress', { pct: 40 }),
      words('delete', { ids: [7] }),
      words('due', { due: ZERO_DATE }),
      words('assign', { add: true, person: { id: 2, username: 'sam' } }),
      words('assign', { add: false, person: { id: 1, username: 'me' } }),
      words('label', { add: true, tag: { title: 'floor' } }),
      words('project', { into: 'Errands' }),
      words('unlink', { over: 'Closing' }),
      words('makeTemplate', {}),
      words('templateStep', { p: { title: 'Wipe the till' } }, 'Closing'),
      words('templateStep', { p: { title: 'Wipe the till' }, taskId: 9 }, 'Closing'),
      words('addStep', { title: 'Sweep up', runTitle: 'Closing' }),
      words('startRun', { template: { title: 'Closing' } }),
      words('due', { stage: 1, fixed: { seen: { rep: { repeat_after: 86400 } } } }),
    ],
    [
      'Cancelled. “Mop the floor” may still have priority High in Vikunja.',
      'Cancelled. “Mop the floor” may still have no priority in Vikunja.',
      'Cancelled. “Mop the floor” may still have the title “Mop” in Vikunja.',
      'Cancelled. “Mop the floor” may still have your new notes in Vikunja.',
      'Cancelled. “Mop the floor” may still be done in Vikunja.',
      'Cancelled. “Mop the floor” may still be open in Vikunja.',
      'Cancelled. “Mop the floor” may still have progress 40% in Vikunja.',
      'Cancelled. “Mop the floor” may already be deleted in Vikunja.',
      'Cancelled. “Mop the floor” may still be without a date in Vikunja.',
      'Cancelled. “Mop the floor” may still be assigned to sam in Vikunja.',
      'Cancelled. You may still be unassigned from “Mop the floor” in Vikunja.',
      'Cancelled. “Mop the floor” may still have label floor in Vikunja.',
      'Cancelled. “Mop the floor” may still be in Errands in Vikunja.',
      'Cancelled. “Mop the floor” may no longer be a subtask of “Closing” in Vikunja.',
      'Cancelled.',
      'Cancelled. “Wipe the till” may still be in “Closing” in Vikunja.',
      'Cancelled.',
      'Cancelled. “Sweep up” may still be in “Closing” in Vikunja.',
      'Cancelled. The checklist started from “Closing”, or one of its steps, may still be in Vikunja.',
      // The repeat came off, and the request in doubt took the date off.
      'Cancelled. “Mop the floor” no longer repeats. “Mop the floor” may still be without a date in Vikunja. Set its repeat again in its sheet.',
    ],
  );
});

test('an Undo that finds a task changed since names it, or counts the tasks, and says where they stay', () => {
  assert.equal(changedSince('Mop'), 'Not undone: “Mop” has changed since then.');
  assert.equal(notMovedBack(3, 'today'), 'Not undone: 3 tasks have changed since then. They stay due today.');
  assert.equal(notMovedBack(3, null), 'Not undone: 3 tasks have changed since then. They stay without a date.');
  assert.equal(notMovedBack(1, 'today'), 'Not undone: 1 task has changed since then. It stays due today.');
  assert.equal(notMovedBack(1, 'Friday', 'Mop'), 'Not undone: “Mop” has changed since then. It stays due Friday.');
  assert.equal(notMovedBack(1, null, 'Mop'), 'Not undone: “Mop” has changed since then. It stays without a date.');
});

test('signing out names what hasn’t reached Vikunja, counting every waiting op that isn’t a line or a file as a change', () => {
  assert.equal(
    signOutAsk({ tasks: 2, changes: 3 }),
    "2 tasks and 3 changes haven't reached Vikunja yet. Sign out anyway and discard them?",
  );
  assert.equal(signOutAsk({ changes: 1 }), "A change hasn't reached Vikunja yet. Sign out anyway and discard it?");
  assert.equal(
    signOutAsk({ tasks: 1, files: 2, photos: true }),
    "A task and 2 photos haven't reached Vikunja yet. Sign out anyway and discard them?",
  );
  assert.equal(signOutAsk({ files: 1 }), "A file hasn't reached Vikunja yet. Sign out anyway and discard it?");
  assert.equal(
    signOutAsk({ tasks: 1, files: 2, changes: 3 }),
    "A task, 2 files and 3 changes haven't reached Vikunja yet. Sign out anyway and discard them?",
  );
});

test('the Outbox button, a waiting change and comments that load later say why in words of their own', () => {
  assert.deepEqual(
    [outboxLabel(1, 2), outboxLabel(0, 1), outboxLabel(2, 0), outboxLabel(0, 0)],
    [
      "Outbox, 1 couldn't be saved, 2 waiting to send",
      'Outbox, 1 waiting to send',
      "Outbox, 2 couldn't be saved",
      'Outbox, nothing waiting to send',
    ],
  );
  assert.deepEqual([waitingWords(true), waitingWords(false)], ['Waiting for a connection', 'Sending…']);
  assert.equal(
    COMMENTS_OFFLINE,
    "Offline. Comments load once you're back online. A comment you write now goes to Vikunja then.",
  );
});

test('the sign-in screen says why Pocket signed out, and what Vikunja asked for', () => {
  assert.deepEqual(
    [SIGNED_OUT.ended, SIGNED_OUT.there, TOTP_NEEDED, notExpected('Bad Gateway')],
    [
      'Your session ended. Sign in again.',
      'You signed out in Vikunja.',
      'Enter your two-factor code.',
      "Vikunja didn't answer as expected (Bad Gateway).",
    ],
  );
});

test('a change the phone had no room for says so in one sentence', () => {
  assert.equal(NOT_KEPT, "Pocket couldn't save this on the phone. Keep Pocket open until it's sent.");
});

test('a screen reader hears a message on a row with its button, and a mark taken back', () => {
  assert.deepEqual(
    [
      rowLineSaid('Done: Mop', { label: 'Undo' }, true),
      rowLineSaid('Deleted', { label: 'Restore' }, false),
      rowLineSaid('Done: Mop', null, true),
    ],
    ['Done: Mop. Undo is on its row.', 'Deleted. Restore is where it was.', 'Done: Mop'],
  );
  assert.deepEqual(
    ['deleted', 'done', 'open'].map(k => unmarkedSaid(k, 'Mop')),
    ['Restored: Mop', 'Not done: Mop', 'Done: Mop'],
  );
});

test("a screen reader hears a ring's progress and a row's due date", () => {
  assert.deepEqual(
    [ringSaid(1, 1, 'step', 100), ringSaid(2, 5, 'subtask', 40)],
    ['1 of 1 step done, 100%', '2 of 5 subtasks done, 40%'],
  );
  assert.deepEqual([dueRowSaid(true, 'Mon'), dueRowSaid(false, '9:00 AM')], ['Late: Mon', 'Due 9:00 AM']);
});

test('a screen reader hears what a tick, a progress, a move or a delete did, and what is beside a message', () => {
  assert.equal(besideIt('Moved 6 to today', { label: UNDO }), 'Moved 6 to today. Undo is beside it.');
  assert.equal(besideIt('Renamed', null), 'Renamed');
  assert.deepEqual([tickSaid(true, 'Mop'), tickSaid(false, 'Mop')], ['Done: Mop', 'Not done: Mop']);
  assert.equal(doneRepeats('Water the plants'), 'Done: Water the plants. It repeats');
  assert.equal(doneRepeats('Water the plants', 'next Tue'), 'Done: Water the plants. It repeats, next Tue');
  assert.deepEqual([repeatsNext('next Tue'), repeatsNext('')], ['Repeats · next Tue', 'Done — repeats']);
  assert.deepEqual([finishedText(), finishedText('Closing')], ['Finished', 'Finished Closing']);
  assert.deepEqual([progressSaid(40, 'Mop'), progressSaid(40)], ['Progress of Mop set to 40%', 'Progress set to 40%']);
  assert.equal(placeSaid('Mop', 2, 5), 'Mop is now 2 of 5');
  assert.deepEqual([movedBack('Home'), movedBack()], ['Moved back to Home', 'Moved back to its project']);
  assert.deepEqual(
    [noLongerSub(1, 'Closing'), noLongerSub(2, 'Closing')],
    ['No longer a subtask of “Closing”', 'No longer a subtask of 2 tasks'],
  );
  assert.equal(deletedSaid('Mop'), 'Deleted Mop. Restore is where the row was.');
  assert.deepEqual(
    [deletedText('Mop'), deletedText('Mop', 1), deletedText('Mop', 3), deletedText('x'.repeat(50))],
    ['Deleted “Mop”', 'Deleted “Mop” + 1 subtask', 'Deleted “Mop” + 3 subtasks', `Deleted “${'x'.repeat(38)}…”`],
  );
  assert.deepEqual(
    [deletedSteps(0), deletedSteps(1), deletedSteps(4)],
    ['Deleted', 'Deleted, with 1 step', 'Deleted, with 4 steps'],
  );
  assert.deepEqual([notRepeated('Mop'), repeatedStep('Mop')], ['Not repeated: Mop', 'Repeated “Mop”']);
  assert.deepEqual(
    [createdProject('Home'), createdProject('Cafe', true)],
    ['Created Home', 'Created Cafe, for checklists.'],
  );
  assert.equal(nowFor('For Sam and you'), 'Now for Sam and you');
});

test('a task coming due is announced by name, alone, or counted with the others', () => {
  assert.equal(dueNow('Mop'), '“Mop” is due now');
  assert.equal(dueSaid(['Mop'], true, false), '“Mop” is due now');
  assert.equal(dueSaid(['Mop'], false, true), 'Reminder: “Mop”');
  assert.equal(dueSaid(['Mop', 'Sweep', 'Lock'], true, false), '3 tasks are due now: “Mop” and 2 more');
  assert.equal(dueSaid(['Mop', 'Sweep'], true, true), '2 tasks are due or have a reminder now: “Mop” and 1 more');
});

test('the add boxes say what part of a list was added, and what a cancelled line left behind', () => {
  assert.equal(addedPart(1, 3), 'Added 1 of 3.');
  assert.equal(
    lineRefused(2, 3, ", but @sam can't see Orders", 'Buy milk', 'Forbidden'),
    "Added 2 of 3, but @sam can't see Orders. “Buy milk” couldn't be saved: Forbidden.",
  );
  assert.equal(lineRefused(0, 1, '', 'Buy milk', 'Forbidden.'), "“Buy milk” couldn't be saved: Forbidden.");
  assert.deepEqual([addedSubs(1), addedSubs(3, ', but x')], ['Added 1 subtask', 'Added 3 subtasks, but x']);
  assert.equal(
    subsNotUnder('Pack', 'Forbidden.', ['Rope'], []),
    "Subtasks of “Pack” added offline couldn't be added under it: Forbidden. “Rope” is now its own task.",
  );
  assert.equal(
    subsNotUnder('Pack', 'Forbidden', ['Rope', 'Tape'], ['Straps']),
    "Subtasks of “Pack” added offline couldn't be added under it: Forbidden. “Rope”, “Tape” are now their own tasks. Not added: Straps.",
  );
  assert.equal(sentBut(['a', 'b']), 'Sent what was waiting, but a; b');
  assert.equal(lineCancelled('Rope', 0, ''), 'Cancelled. “Rope” is back where you typed it.');
  assert.equal(lineCancelled('', 1, ''), 'Cancelled. The 1 line under it is now its own task.');
  assert.equal(
    lineCancelled('Rope', 2, 'Pack'),
    'Cancelled. “Rope” is back where you typed it. The 2 lines under it are now under “Pack”.',
  );
  assert.equal(lineCancelled('', 2, ''), 'Cancelled. The 2 lines under it are now their own tasks.');
  assert.deepEqual(
    [cancelled(''), cancelled('“Mop” stays done.'), cancelled('', 'lines'), cancelled('x.', 'text')],
    [
      'Cancelled.',
      'Cancelled. “Mop” stays done.',
      'Cancelled. The lines under it are back where you typed them.',
      'Cancelled. x. Its text is back where you typed it.',
    ],
  );
  assert.deepEqual(
    [notStopped(true), notStopped(false), SENT_FIRST],
    [
      'It was sent before it could be cancelled.',
      "It is being sent and can't be stopped now.",
      'It was sent before it could be cancelled.',
    ],
  );
});

test('the sheets and checklists say what was made, changed or found wrong', () => {
  assert.equal(readOnly('Home'), 'Home is read only. Type +project to pick another project.');
  assert.equal(readOnly(), 'That project is read only. Type +project to pick another project.');
  assert.equal(noUser('sam'), 'No user @sam');
  assert.equal(
    repeatDate('Tomorrow 9:00 AM'),
    "Pocket set the due date to Tomorrow 9:00 AM, because a repeat needs one. Change the date above if that's wrong.",
  );
  assert.equal(tooBigText(['a.jpg (9 MB)'], '5 MB'), 'a.jpg (9 MB) is too big. Your Vikunja accepts files up to 5 MB.');
  assert.equal(tooBigText(['a', 'b'], '5 MB'), 'a, b are too big. Your Vikunja accepts files up to 5 MB.');
  assert.equal(changedBut(['x', 'y']), 'Changed, but x; y');
  assert.equal(templateMade(), 'Template created. Start it here or under Checklists.');
  assert.equal(
    templateMade('Due daily at 8:00 AM', true),
    'Template created. Due daily at 8:00 AM. Starting it on or after the due day moves it to its next date.',
  );
  assert.equal(
    templateMade('Due Fri', false, 'Closing'),
    "Template created. Due Fri. Starting a checklist marks “Closing” done, because it doesn't repeat.",
  );
  assert.equal(startMarksDone('Closing'), "Starting a checklist marks “Closing” done, because it doesn't repeat.");
  assert.equal(templateCreated('Closing'), 'Created Closing. Start it here.');
  assert.equal(setUpText(true), 'Created the Checklists project, with an example template to try.');
  assert.equal(
    setUpText(true, savedOffline()),
    "Created the Checklists project, with an example template to try. Saved offline. It goes to Vikunja when you're back online.",
  );
  assert.equal(
    setUpText(false),
    "Created the Checklists project. The example template couldn't be created. Tap New template to add one.",
  );
  assert.deepEqual(
    [checklistsOn(true), checklistsOn(false)],
    [
      'This project is now used for checklists. Its templates and checklists are under Checklists.',
      'This project is no longer used for checklists.',
    ],
  );
  assert.deepEqual([archivedText('Home'), deletedProject('Home')], ['Archived Home', 'Deleted Home']);
  assert.equal(
    couldnt('load the done tasks', 'no connection to Vikunja'),
    "Couldn't load the done tasks: no connection to Vikunja",
  );
  assert.equal(SAID.onePerson, 'A checklist needs at least one person. Tap someone else first.');
});

test('a question before a change Pocket cannot undo counts what goes with it', () => {
  assert.equal(deleteAsk('Pack', 1), 'Delete “Pack” and its 1 subtask?');
  assert.equal(deleteAsk('Pack', 2, 3), 'Delete “Pack” and its 2 subtasks, 3 more under them?');
  assert.equal(deleteAsk('Pack', 1, 1), 'Delete “Pack” and its 1 subtask, 1 more under it?');
  assert.equal(deleteTemplateAsk('Closing', 0), "Delete the template “Closing”? This can't be undone in Pocket.");
  assert.equal(
    deleteTemplateAsk('Closing', 1),
    "Delete the template “Closing” and its 1 step? Checklists already started keep their steps. This can't be undone in Pocket.",
  );
  assert.equal(
    deleteRunAsk('Closing', 3),
    "Delete “Closing” and its 3 steps for everyone? Their comments and photos are deleted too. This can't be undone.",
  );
  assert.equal(
    deleteRunAsk('Closing', 1),
    "Delete “Closing” and its 1 step for everyone? Their comments and photos are deleted too. This can't be undone.",
  );
  assert.equal(
    deleteStepAsk('Mop'),
    "Delete “Mop”? This step was added to this checklist only. The template doesn't change.",
  );
  assert.equal(removeStepAsk('Mop'), 'Remove “Mop” from the template? Checklists already started keep it.');
  assert.equal(
    othersDoneAsk(['Sam', 'Ana'], 'Mop'),
    'Sam and Ana marked “Mop” done. Only they can remove their ✅ in Vikunja, so it stays. Mark the step not done anyway?',
  );
  assert.equal(
    archiveAsk('Home'),
    "Archive “Home”? Pocket and Vikunja hide the project and its tasks until you unarchive it in Vikunja's web app.",
  );
  assert.equal(deleteProjectAsk('Home', 1, 0), "Delete “Home” and its 1 task? This can't be undone.");
  assert.equal(
    deleteProjectAsk('Home', 4, 2),
    "Delete “Home” and its 4 tasks and 2 projects inside it? This can't be undone.",
  );
  assert.equal(
    deleteProjectAsk('Home', null, 1),
    "Delete “Home” and its tasks and 1 project inside it? This can't be undone.",
  );
});

test('a tick message says "Closed" with a count when a parent closed its open subtasks, and "Done:" otherwise', () => {
  assert.equal(doneText(0, 0, 'Call Jo'), 'Done: Call Jo');
  assert.equal(doneText(4, 4, 'Pack the van'), 'Closed Pack the van + 4 subtasks');
  assert.equal(doneText(1, 1, 'Pack the van'), 'Closed Pack the van + 1 subtask');
  assert.equal(doneText(1, 3, 'Pack'), "Closed Pack + 1 of 3 subtasks: the rest couldn't be closed");
  assert.equal(doneText(0, 2, 'Pack'), "Done: Pack — its 2 subtasks couldn't be closed");
  assert.equal(doneText(0, 0, 'x'.repeat(50)), 'Done: ' + 'x'.repeat(38) + '…', 'a long title is cut short');
  // On the row, the title is shown struck through, with the text before it and after it separate.
  assert.deepEqual(doneLine(2, 2, 'Pack the van'), { text: 'Closed', title: 'Pack the van', more: '+ 2 subtasks' });
  assert.deepEqual(doneLine(0, 0, 'Pack the van'), { text: 'Done:', title: 'Pack the van', more: '' });
});

test('a done task with open subtasks shows why it is on the open list', () => {
  assert.equal(headText(1), 'Done, but 1 subtask is still open');
  assert.equal(headText(3), 'Done, but 3 subtasks are still open');
  assert.equal(headText(0), 'Done');
});

test('the add box says where the tasks just added went', () => {
  assert.equal(addedWhere({ n: 1, project: 'Orders' }), 'Added to Orders');
  assert.match(
    addedWhere({ n: 1, project: 'Orders', due: new Date(Date.now() + 30 * 864e5).toISOString() }),
    /^Added to Orders, due (\w+ \d+|\d+ \w+)/,
  );
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  assert.equal(
    addedWhere({ n: 1, project: 'Orders', due: tomorrow.toISOString() }),
    'Added to Orders, due tomorrow',
    'a due day is written as a word in the middle of the sentence',
  );
  assert.equal(addedWhere({ n: 3, project: 'Orders' }), 'Added 3 tasks to Orders');
  assert.equal(addedWhere({ n: 3, subs: 2, project: 'Orders' }), 'Added 1 task with 2 subtasks to Orders');
  assert.equal(
    addedWhere({ n: 9, subs: 7, project: 'Orders' }),
    'Added 2 tasks with 7 subtasks to Orders',
    'a list with several parent tasks',
  );
  assert.equal(
    addedWhere({ n: 1, project: 'Orders', photos: 2, but: ", but @sam can't see Orders" }),
    "Added to Orders, with 2 photos, but @sam can't see Orders",
  );
  assert.equal(addedWhere({ n: 2 }), 'Added 2 tasks to its project');
});

test('Move all to today reports how many tasks moved and which tasks stayed', () => {
  assert.equal(movedText(6, ''), 'Moved 6 to today');
  assert.equal(movedText(2, '1 repeating task stays: tick it.'), 'Moved 2 to today. 1 repeating task stays: tick it.');
  assert.equal(movedText(0, '1 repeating task stays: tick it.'), 'Nothing moved. 1 repeating task stays: tick it.');
});

// A fake component with the methods from lines.js and leaving.js, a screen (route) and a sheet. Messages appear at a `place` on the screen or in the sheet.
const app = (route = 'today', sheet = blankSheet('')) => {
  const a = {
    route: { name: route },
    sheet,
    places: {},
    lines: {},
    leaving: {},
    said: '',
    toasts: [],
    runView: null,
    notify(msg, action) {
      this.toasts.push({ msg, action });
    },
  };
  for (const part of [lines, leaving]) Object.defineProperties(a, Object.getOwnPropertyDescriptors(part));
  return a;
};

test('a message appears at its place when that place is on screen, and in the toast when it is not', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const today = app('today'),
    undo = { label: 'Undo', fn() {} };
  assert.equal(today.say('Moved 6 to today', { place: 'overdue', action: undo }), 'place');
  assert.deepEqual(
    today.placeLines('overdue').map(l => [l.text, l.action.label]),
    [['Moved 6 to today', 'Undo']],
  );
  assert.equal(
    today.said,
    'Moved 6 to today. Undo is beside it.',
    'a screen reader announces the message and its Undo',
  );
  t.mock.timers.tick(5000);
  assert.deepEqual(today.placeLines('overdue'), [], 'the message disappears when the time for its Undo ends');

  const search = app('search');
  assert.equal(search.say('Moved 6 to today', { place: 'overdue' }), 'toast', 'Overdue is only on Today');
  assert.equal(search.toasts[0].msg, 'Moved 6 to today');
  assert.equal(app('project').say('Added to Orders', { place: 'cap' }), 'place', 'the add box is on a project');
  assert.equal(
    app('run').say('x', { place: ['sheet:files', 'step', 'run'] }),
    'place',
    'the first place in the list that is on screen is used',
  );
});

/* In the page, anything put in the component's data comes back as Alpine's copy of it (a Proxy), never as the original
   object. This test uses a store that does the same. The timer that ends a message must remove the copy that the store
   returns. */
test("a message disappears when its time is up, even if the store returns a copy of it, as Alpine's does", t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copies = new WeakMap(),
    copy = o => copies.get(o) || (copies.set(o, new Proxy(o, {})), copies.get(o));
  const today = app('today');
  let gone = 0;
  today.places = new Proxy(
    {},
    { get: (store, k) => (store[k] && typeof store[k] === 'object' ? copy(store[k]) : store[k]) },
  );
  today.sayAt('cap', { text: 'Moved to tomorrow', action: { label: 'Undo', fn() {} }, gone: () => gone++ });
  assert.equal(today.placeLines('cap').length, 1);
  t.mock.timers.tick(4999);
  assert.equal(today.placeLines('cap').length, 1, 'the message stays for the time of its Undo');
  t.mock.timers.tick(1);
  assert.deepEqual([today.placeLines('cap').length, gone], [0, 1], 'the message is then removed');
  today.sayAt('cap', { text: 'Not added', cls: 'failed' });
  t.mock.timers.tick(4000);
  assert.equal(today.placeLines('cap').length, 0, 'a message with nothing to tap is removed after a shorter time');
  today.sayAt('cap', { text: 'Stays', ms: null });
  t.mock.timers.tick(60000);
  assert.equal(today.placeLines('cap').length, 1, 'a message with no time limit stays until the screen is left');
});

test("a sheet's messages appear in the sheet, under the part each is about, and go away with the sheet", () => {
  const task = app('today', { ...blankSheet('task'), open: true, task: { id: 1 } });
  task.say('Not saved: no connection', { place: 'sheet:notes', cls: 'failed' });
  assert.equal(task.sheet.lines.notes.text, 'Not saved: no connection');
  assert.equal(task.sheet.lines.notes.cls, 'failed');
  // Another kind of sheet shows the message at its top.
  const proj = app('projects', { ...blankSheet('project'), open: true });
  proj.say('Renamed', { place: 'sheet:notes' });
  assert.deepEqual(Object.keys(proj.sheet.lines), ['top']);
  // The New template sheet has its own place for the list of steps. A message for the steps appears there, and the sheet's top message does not appear in it as well.
  const tpl = app('checklists', { ...blankSheet('newtpl'), open: true });
  tpl.say('Not finished', { place: 'sheet:top', cls: 'failed' });
  tpl.say('Not moved', { place: 'sheet:subtasks', cls: 'failed' });
  assert.deepEqual(
    [tpl.placeLines('sheet:top').map(l => l.text), tpl.placeLines('sheet:subtasks').map(l => l.text)],
    [['Not finished'], ['Not moved']],
  );
  // With no sheet open, the message goes to a toast instead.
  const closed = app('today');
  assert.equal(closed.say('Renamed', { place: 'sheet:top' }), 'toast');
  // A save that failed and then succeeded removes its failure message.
  task.unsay('sheet:notes');
  assert.deepEqual(task.placeLines('sheet:notes'), []);
});

test('a tapped action runs once, and its message is removed without calling its gone callback', () => {
  let ran = 0,
    gone = 0;
  const a = app('today');
  a.sayAt('overdue', { text: 'Moved 2 to today', action: { label: 'Undo', fn: () => ran++ }, gone: () => gone++ });
  const [l] = a.placeLines('overdue');
  a.runPlaceAction(l);
  a.runPlaceAction(l);
  assert.deepEqual([ran, gone, a.placeLines('overdue').length], [1, 0, 0]);
  // Leaving the screen folds away the remaining messages and calls `gone` for each.
  a.sayAt('overdue', { text: 'Nothing moved', gone: () => gone++ });
  a.foldLines();
  assert.deepEqual([gone, a.placeLines('overdue').length], [1, 0]);
});

// A toast's Undo keeps something until the toast ends: a held delete waits to be sent, and Cancel keeps the entry.
test('a toast with an Undo calls its gone once when it times out, and never after its Undo is tapped', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = Object.defineProperties({ toast: { show: false } }, Object.getOwnPropertyDescriptors(toastPart));
  let ran = 0,
    gone = 0;
  a.notify('Deleted', { label: 'Undo', fn: () => ran++, gone: () => gone++ });
  t.mock.timers.tick(UNDO_MS);
  assert.deepEqual([a.toast.show, ran, gone], [false, 0, 1]);
  a.toastGone(a.toast); // as the watch on toast.show does next
  assert.equal(gone, 1);
  a.notify('Deleted', { label: 'Undo', fn: () => ran++, gone: () => gone++ });
  a.runToastAction();
  t.mock.timers.tick(UNDO_MS);
  assert.deepEqual([ran, gone], [1, 1]);
});

test('on a checklist, a note on a step or the checklist is called a comment, as in Vikunja, in the Outbox and its messages', () => {
  const t = 'Unlock the door';
  assert.equal(OP_WORDS.note.text({ op: 'note' }, t), 'A comment on “Unlock the door”');
  assert.equal(OP_WORDS.doneNote.text({ op: 'doneNote' }, t), 'Done, with a comment: Unlock the door');
  assert.equal(OP_WORDS.note.dropped({ op: 'note' }, t), 'Your comment is back where you typed it.');
  assert.equal(OP_WORDS.note.refused({ op: 'note' }, t), 'A comment on “Unlock the door”');
  assert.equal(OP_WORDS.doneNote.refused({ op: 'doneNote' }, t), 'Marking “Unlock the door” done, with its comment');
});

test('dropping a finish or a reopen says what Vikunja has, also when only its first part was sent', () => {
  assert.deepEqual(
    [0, 1].map(stage => OP_WORDS.finish.dropped({ op: 'finish', stage }, 'Closing up')),
    ['“Closing up” stays open.', '“Closing up” is finished.'],
  );
  assert.deepEqual(
    [0, 1].map(stage => OP_WORDS.reopen.dropped({ op: 'reopen', stage }, 'Closing up')),
    ['“Closing up” stays finished.', '“Closing up” is open.'],
  );
});

test('a cancelled start, Make template or added step names what is being cancelled, in its row and its refusal', () => {
  const start = { op: 'startRun', cancelled: true, template: { title: 'Closing' } },
    make = { op: 'makeTemplate', cancelled: true },
    step = { op: 'templateStep', cancelled: true, p: { title: 'Wipe the till' } },
    insert = { op: 'addStep', cancelled: true, title: 'Sweep up' };
  assert.deepEqual(
    [OP_WORDS.startRun.text(start), OP_WORDS.startRun.refused(start)],
    ['Cancelling the start of “Closing”', 'Cancelling the start of “Closing”'],
  );
  assert.deepEqual(
    [OP_WORDS.makeTemplate.text(make, 'Closing'), OP_WORDS.makeTemplate.refused(make, 'Closing')],
    ['Cancelling Make template on “Closing”', 'Cancelling Make template on “Closing”'],
  );
  assert.deepEqual(
    [OP_WORDS.templateStep.text(step, 'Closing'), OP_WORDS.addStep.text(insert)],
    [
      'Removing “Wipe the till”, because adding it was cancelled',
      'Removing “Sweep up”, because adding it was cancelled',
    ],
  );
});

/* Pocket's copy of each task holds Vikunja's values. Task 7 is a subtask of 1. Without a copy, the words name the
   value before the change. */
test("Cancel's words name each value as Pocket's copy of the task has it, and a partly sent op first says what Vikunja has", () => {
  const COPIES = {
      1: { id: 1, title: 'Groceries', percent_done: 0.6 },
      7: {
        id: 7,
        title: 'Buy mlk',
        priority: 1,
        percent_done: 0.4,
        due_date: new Date(2031, 9, 20, 9).toISOString(),
        assignees: [{ id: 1 }, { id: 2, username: 'sam' }],
        related_tasks: { parenttask: [{ id: 1 }] },
        project_id: 5,
      },
    },
    copy = id => COPIES[id],
    words = (op, a, c = copy) => OP_WORDS[op].dropped({ op, task: 7, user: 1, stage: 0, ...a }, 'Buy milk', c);
  assert.deepEqual(
    [
      words('edit', { set: { title: 'Buy milk' }, was: { title: 'Buy mk' } }),
      words('edit', { set: { priority: 3 }, was: { priority: 0 } }),
      words('edit', { set: { priority: 3 }, was: { priority: 0 } }, () => undefined),
      words('progress', { pct: 80, up: 1 }),
      words('progress', { pct: 40, up: 1, stage: 1 }),
      words('due', { due: '0001-01-01T00:00:00Z' }),
      words('delete', { ids: [7], up: 1 }),
      words('delete', { ids: [7], up: 1, stage: 1 }),
      words('done', { up: 1 }),
      words('claim', {}),
      words('unlink', { up: 1, over: 'Groceries' }),
      words('link', { up: 1, over: 'Groceries', stage: 1 }),
      words('project', { pid: 6, was: { 7: 5 }, into: 'Errands', from: 'Home' }),
      words('repeat', { set: { repeat_after: 86400 }, was: { repeat_after: 604800 } }, () => undefined),
    ],
    [
      '“Buy milk” title stays “Buy mlk”.',
      '“Buy milk” priority stays Low.',
      '“Buy milk” stays without a priority.',
      '“Buy milk” progress stays 40%.',
      '“Buy milk” progress is 40%. “Groceries” progress stays 60%.',
      '“Buy milk” due date stays Mon, Oct 20, 2031.',
      '“Buy milk” stays in Vikunja.',
      '“Buy milk” is deleted. “Groceries” progress stays 60%.',
      '“Buy milk” stays not done.',
      '“Buy milk” stays assigned to you and sam.',
      '“Buy milk” stays a subtask of “Groceries”.',
      '“Buy milk” is a subtask of “Groceries”. “Groceries” progress stays 60%.',
      '“Buy milk” stays in Home.',
      '“Buy milk” repeat stays every week.',
    ],
  );
});

test("the question a parent's ring asks lists the tasks that close with it, naming the first three and counting the rest", () => {
  assert.equal(namesText(['Load chairs']), 'Load chairs');
  assert.equal(namesText(['Load chairs', 'Book the hall']), 'Load chairs and Book the hall');
  assert.equal(
    namesText(['Load chairs', 'Book the hall', 'Wipe the tables']),
    'Load chairs, Book the hall and Wipe the tables',
  );
  assert.equal(
    namesText(['Load chairs', 'Book the hall', 'Wipe the tables', 'Stack cups', 'Sweep']),
    'Load chairs, Book the hall, Wipe the tables and 2 more',
  );
  assert.deepEqual(completeAsk({ title: 'Pack the van', names: ['Load chairs'] }), {
    head: 'Complete “Pack the van”?',
    body: 'Its open subtask will be marked done too: Load chairs.',
    yes: 'Complete all 2',
  });
  assert.deepEqual(completeAsk({ title: 'Pack the van', names: ['Load chairs', 'Book the hall', 'Wipe the tables'] }), {
    head: 'Complete “Pack the van”?',
    body: 'Its 3 open subtasks will be marked done too: Load chairs, Book the hall and Wipe the tables.',
    yes: 'Complete all 4',
  });
  assert.equal(
    completeAsk({ title: 'Pack the van', names: ['A', 'B', 'C', 'D', 'E'], stay: 1 }).body,
    'Its 5 open subtasks will be marked done too: A, B, C and 2 more. The one that repeats stays as it is.',
  );
  assert.deepEqual(completeAsk({ title: 'Closing up', run: true, names: ['Mop', 'Lock up'] }), {
    head: 'Finish this checklist with 2 steps not done?',
    body: 'These 2 steps stay not done: Mop and Lock up.',
    yes: 'Finish checklist',
  });
  assert.equal(completeAsk({ title: 'Closing up', run: true, names: ['Mop'] }).body, 'This step stays not done: Mop.');
});

test('moving a task to another project names the project and counts the subtasks that went with it', () => {
  assert.equal(movedToProject('Errands'), 'Moved to Errands');
  assert.equal(movedToProject('Errands', 1), 'Moved to Errands, with its subtask');
  assert.equal(movedToProject('Errands', 3), 'Moved to Errands, with its 3 subtasks');
  assert.equal(
    movedToProject(undefined, 2),
    'Moved to the other project, with its 2 subtasks',
    'a project Pocket has not loaded yet',
  );
});

test('moving a task held on Today names where it went, and explains a card kept by its subtask', () => {
  assert.equal(movedTo('Friday'), 'Moved to Friday');
  assert.equal(movedTo('Today'), 'Moved to today');
  assert.equal(movedTo('Mon 12'), 'Moved to Mon 12');
  assert.equal(movedTo(null), 'Removed its due date');
  assert.equal(
    movedTo('Tomorrow', 'Buy paint'),
    'Moved to tomorrow. Its subtask “Buy paint” is due sooner, so it stays here.',
  );
  assert.equal(
    movedTo(null, 'Buy paint'),
    'Removed its due date. Its subtask “Buy paint” has a date, so it stays here.',
  );
  assert.equal(dayWord('Friday'), 'Friday');
});

// Who started a checklist, shown in its history. The summary shows only the time when the checklist started today. The
// ⋯ menu always shows the day. When the time is unknown, only the name is shown. When the name is unknown, nothing is shown.
test('a checklist shows who started it and when, with the day if it started on another day or in the ⋯ menu', () => {
  const now = new Date(2026, 9, 9, 14, 0),
    at = new Date(2026, 9, 9, 6, 2),
    before = new Date(2026, 9, 8, 6, 2);
  const time = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    full = d => d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.equal(startedText('Priya', at.toISOString(), { now }), 'Started by Priya at ' + time(at));
  assert.equal(startedText('you', before.toISOString(), { now }), 'Started by you, ' + full(before));
  assert.equal(startedText('Priya', at.toISOString(), { now, day: true }), 'Started by Priya, ' + full(at));
  assert.equal(startedText('Priya', null, { now }), 'Started by Priya');
  assert.equal(startedText(null, at.toISOString(), { now }), '');
});

test('Cancel on a waiting row names what happens to the lines waiting under it', () => {
  assert.equal(cancelName('Pack the van'), 'Cancel Pack the van');
  assert.equal(cancelName('Pack the van', 2), 'Cancel Pack the van. The lines under it become their own tasks.');
  assert.equal(cancelName('Pack the van', 1), 'Cancel Pack the van. The line under it becomes its own task.');
  assert.equal(
    cancelName('Load chairs', 1, 'Pack the van'),
    'Cancel Load chairs. The line under it moves under “Pack the van”.',
  );
  assert.equal(
    cancelName('Load chairs', 3, 'Pack the van'),
    'Cancel Load chairs. The lines under it move under “Pack the van”.',
  );
});

test("the Markdown copy message names both uses: pasting into notes, and pasting into Pocket's add box to make the same tasks", () => {
  assert.equal(
    COPIED.markdown,
    "Copied as a Markdown list. Paste it into your notes, or into Pocket's add box to make the same tasks",
  );
});
