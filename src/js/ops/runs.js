/* Starting a checklist from a template (startRun), and adding a step to a checklist (addStep). Each makes tasks in
   Vikunja a stage at a time, and keeps in its entry what it made. Every request has a key, so a request sent again
   after a lost reply makes nothing twice. Cancel, and a start's Undo, delete what it made with the same op, marked
   `cancelled`, in stages that come after the ones it sent. */
import { OP_WORDS, UNKNOWN } from '../messages.js';
import { ALREADY, runTitle, sync, uuid7 } from '../sync.js';
import { ZERO } from '../util.js';
import { repeats } from '../dates.js';
import {
  copiedNotes,
  isTemplateLabel,
  nextAfter,
  notesOnly,
  vikunjaNext,
  withAdded,
  withOrder,
  withRunMark,
  withStepLine,
} from '../checklists.js';
import { TASK } from '../tasks.js';
import { LINE } from './add.js';
import { cancelledStages, figureOf, notFound, now, patch, place, remove, unadd, unplace } from './stages.js';

const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
// Copy task `from` with Vikunja's duplicate, which copies its notes, labels, people and files.
const duplicate = async (c, from) => (await c.send(`/tasks/${from}/duplicate`, { method: 'POST' })).duplicated_task;

/* ---------- starting a checklist ---------- */

/* Copy the template, which becomes the checklist. Its notes come with the copy, but its order line does not, because
   that line holds the ids of the template's steps. A line is added that marks the copy as a checklist, so it stays
   one if its template is deleted. */
async function copyRun(a, c) {
  if (a.taskId) return;
  const t = await duplicate(c, a.template.id);
  sync.claim(t.id, a.id);
  Object.assign(a, { taskId: t.id, notes: withRunMark(notesOnly(t.description)) });
}
/* The checklist is named after its template, the day, and the name typed when it was started. Without a typed name it
   gets its number among the template's checklists: "Startup · Oct 3 · Night shift" or "Startup · Oct 3 · #3".

   It gets no due date, because its steps have their own. The exception is a start that ticks the template (`tick`).
   Then the checklist gets the time the template was due, so a checklist left open shows on Today. It doesn't repeat
   or remind. The template does, and the copy would otherwise inherit that. */
async function name(a, c) {
  const title = await c.once('title', async () => {
    if (a.name) return runTitle(a.template.title, a.name, new Date(a.at));
    const runs = ((await c.read('/tasks/' + a.template.id)).related_tasks?.copiedto || [])
      .map(x => x.id)
      .sort((x, y) => x - y);
    return runTitle(a.template.title, '#' + (runs.indexOf(a.taskId) + 1 || runs.length), new Date(a.at));
  });
  const body = {
    title,
    done: false,
    due_date: a.tick || ZERO,
    repeat_after: 0,
    repeat_mode: 0,
    reminders: [],
    ...(a.notes && { description: a.notes }),
  };
  await c.send('/tasks/' + a.taskId, { method: 'PATCH', body, on: { [a.taskId]: {} } });
}
/* Each step of the template is copied in the template's order, linked under the checklist, and made ready: T# and
   {#name} leave its title, and a step that counts from the start gets its due time. A timed step gets a reminder at
   its due time, which Vikunja emails to whoever started the checklist and anyone on the step. Pocket's plugin moves
   the reminder with the due date it sets. A step due less than a minute after the step it waits on gets none, because
   Vikunja checks for reminders once a minute and this one would already be past. */
const copyStep = i => async (a, c) => {
  if ((a.copied ||= [])[i]) return;
  const t = await duplicate(c, a.steps[i].from);
  sync.claim(t.id, a.id);
  a.copied[i] = { id: t.id, notes: t.description || '' };
};
const linkStep = i => (a, c) =>
  c.app.linkSubtask(a.taskId, a.copied[i].id, c.send).catch(e => {
    if (e.code !== ALREADY.link) throw e;
  });
// The title is the template step's title, which the step's time was read from. A change to the template later reaches
// only the checklists started after it.
const readyStep = i => (a, c) => {
  const s = a.steps[i],
    { id, notes } = a.copied[i];
  const body = {
    title: s.title,
    done: false,
    due_date: s.due || ZERO,
    repeat_after: 0,
    repeat_mode: 0,
    ...((s.remind ?? s.timed) && { reminders: [{ relative_to: 'due_date', relative_period: 0 }] }),
    ...(s.tpl != null && { description: withStepLine(copiedNotes(notes), s.tpl) }),
  };
  return c.send('/tasks/' + id, { method: 'PATCH', body, on: { [id]: {} } });
};
// The checklist's own order line, holding the ids of its steps. From now on it never reads its template's order, and
// a step added to it goes in this line.
const order = (a, c) =>
  c.send('/tasks/' + a.taskId, {
    method: 'PATCH',
    body: {
      description: withOrder(
        a.notes ?? '',
        a.copied.map(s => s.id),
      ),
    },
    on: { [a.taskId]: {} },
  });
// Only the checklist is assigned to the people it is for, so Vikunja notifies them once and not once per step. A step
// assigned in the template, say to QA, keeps its person, because the copy keeps it.
const assign = (a, c) =>
  c.send(`/tasks/${a.taskId}/assignees/bulk`, {
    method: 'PUT',
    body: { assignees: a.for.map(u => ({ id: u.id })) },
    on: { [a.taskId]: {} },
  });
/* The copy has the template's labels, including "template". That label is removed last. Until then the copy is not a
   checklist anywhere (roleOf), so teammates can't start on it before it is complete. The labels are read once, because
   Vikunja refuses to remove a label that isn't there. */
async function unlabel(a, c) {
  const ids = await c.once('labels', async () =>
    ((await c.read('/tasks/' + a.taskId)).labels || []).filter(isTemplateLabel).map(l => l.id),
  );
  for (const id of ids)
    await c.send(`/tasks/${a.taskId}/labels/${id}`, { method: 'DELETE', on: { [a.taskId]: {} } }).catch(notFound);
}
/* This stage comes last, so a cancelled start ticks nothing. When the start is for the time the template was due
   (`tick`), the template is ticked, but only while it is not done at that time, as Vikunja had it when this stage was
   first sent. So a start sent again after a lost reply doesn't tick it twice.

   Vikunja moves a repeating template to its next date. A template that doesn't repeat becomes done and loses its date,
   because its schedule is over. A template that repeats every month moves forward one month only. If it was left for
   months, it is moved on again to the first time after now on its schedule. That count starts from where this tick
   put it, so a change made since then stays. `ticked` records where the template went, for Undo. */
async function tick(a, c) {
  if (!a.tick) return;
  const { body } =
    (await c.once('ticking', async () => {
      const t = await now(a, c);
      return t && !t.done && sameTime(t.due_date, a.tick)
        ? { body: { done: true, ...(!repeats(t) && { due_date: ZERO }) }, goes: tickTo(t, a.tick) }
        : null;
    })) || {};
  if (!body) return;
  const went = t => (a.ticked = { from: a.tick, to: t.due_date, done: !!t.done }),
    t = await patch(a, c, body),
    due = Date.parse(went(t).to);
  if (!t.done && t.repeat_mode === 1 && due <= Date.now() && due === vikunjaNext({ ...t, due_date: a.tick }))
    went(await patch(a, c, { due_date: new Date(nextAfter(t, due)).toISOString() }));
}
// Where the tick moves template `t`, due at `from`, as the tick stage would leave it.
function tickTo(t, from) {
  if (!repeats(t)) return { to: ZERO, done: true };
  const next = vikunjaNext({ ...t, due_date: from }),
    due = t.repeat_mode === 1 && next <= Date.now() ? nextAfter(t, next) : next;
  return { to: new Date(due).toISOString(), done: false };
}
/* Where the start moved its template: as Vikunja answered, or else, as when the answer was unknown, where the tick would
   move it. Undo and Cancel check that Vikunja still has it there, so a tick never made changes nothing. */
const tickedOf = a => a.ticked ?? (a.fixed?.ticking && { from: a.tick, ...a.fixed.ticking.goes });
const STARTS = a => [
  copyRun,
  name,
  ...(a.steps || []).flatMap((s, i) => [copyStep(i), linkStep(i), readyStep(i)]),
  order,
  assign,
  unlabel,
  tick,
];

// The tasks a start made, its steps first: those its stages recorded, or those an Undo is queued with (`ids`).
const startMade = a => a.ids ?? [...(a.copied || []).filter(Boolean).map(s => s.id), ...(a.taskId ? [a.taskId] : [])];
const unstart = async (a, c) => {
  for (const id of startMade(a)) await remove(c, id);
};
// The template goes back to the date before its tick, only while Vikunja still has it where the tick left it.
async function untick(a, c) {
  const was = a.back ?? tickedOf(a);
  if (!was) return;
  const back = await c.once('back', async () => {
    const t = await now(a, c);
    return !!t && !!t.done === was.done && sameTime(t.due_date, was.to);
  });
  if (back) await patch(a, c, { due_date: was.from, done: false });
}

/* `template` is the template as the Start sheet showed it, `steps` its steps with their titles and times, `name` the
   name typed, `for` the people it is for, and `tick` the template's due date when this start ticks it (tickOf).

   The checklist's tasks are made a request at a time, so a start can be cancelled at any point. Cancel and Undo send
   it marked `cancelled`: it deletes the copies, and puts back the template's date, as `ids` and `back` say for an Undo,
   or as its own stages recorded. Its Undo is that op. A refused start waits in the Outbox, where Try again carries on
   and Cancel deletes what it made. The template and the template steps it copies show it while it waits, since their
   copies gain a "copied to" link only Vikunja's reply can say. */
export const startRun = {
  apply: t => ({ ...t }),
  on: a => [a.task, ...(a.steps || []).map(s => s.from), ...(a.cancelled ? startMade(a) : [])],
  stages: cancelledStages(STARTS, [unstart, untick]),
  invert: a => ({
    op: 'startRun',
    task: a.task,
    template: a.template,
    steps: a.steps,
    cancelled: true,
    ids: startMade(a),
    ...(tickedOf(a) && { back: tickedOf(a) }),
  }),
  refusal: a => (a.cancelled ? 'dropped' : 'kept'),
  cancel: a => (a.cancelled ? 'undo' : 'unmade'),
  answered: () => {},
  deletes: a => (a.cancelled ? startMade(a) : []),
  replyOnly: () => ['related_tasks'],
  ...OP_WORDS.startRun,
  asks: ['template', 'name', 'for', 'steps', 'tick', 'cancelled', 'ids', 'back'],
  saw: ['label'],
  keepReads: null,
  merge: null,
  waiting: null,
  sheetPlace: null,
  putBack: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
};

/* ---------- adding a step to a checklist ---------- */

// A repeated step is a copy of the template step it repeats (`from`), with that step's notes and photos.
async function copy(a, c) {
  if (a.taskId) return;
  const t = await duplicate(c, a.from);
  sync.claim(t.id, a.id);
  Object.assign(a, { taskId: t.id, notes: t.description || '' });
}
/* The step starts not done, with no due date, and doesn't repeat or remind. It is done when someone does it. It is
   marked "pocket:added", and a repeated step also keeps the "pocket:step" line of the step it repeats (`tpl`). A
   repeated step's title is its template step's title without T#. An inserted step's title is the one quick add sent,
   without @people, and it keeps the notes quick add sent. */
async function mark(a, c) {
  const notes = copiedNotes(a.notes ?? a.body?.description ?? ''),
    body = {
      ...((a.from || a.tpl != null) && { title: a.title }),
      done: false,
      due_date: ZERO,
      repeat_after: 0,
      repeat_mode: 0,
      reminders: [],
      description: withAdded(a.tpl != null ? withStepLine(notes, a.tpl) : notes),
    };
  const t = await c.send('/tasks/' + a.taskId, { method: 'PATCH', body, on: { [a.taskId]: body } });
  c.app.change(w => {
    w.made(a.taskId, c.from(t), body);
    if (t) w.answer([t], TASK, c.from(t));
  });
}
// A new step at 0% lowers the checklist's progress, which is written once the step is in it.
const figure = (a, c) => figureOf(c, a.task);
const [prepare, made, label, people, link] = LINE;
const ADDS = a =>
  a.from ? [copy, link, mark, place, figure] : [prepare, made, label, people, link, mark, place, figure];

// Once the step is gone, the checklist's progress is written without it.
const refigure = (a, c) => figureOf(c, a.task, 'refigure');

/* A step added to checklist `task`: inserted from the checklist's add box, with what quick add parsed (`p`), or
   repeated from template step `from` (with `tpl`, the "pocket:step" line of the step it repeats). It goes before
   `before`, or after `after`, which may be a step still being added ('pending-<entry>'). It is made under the checklist
   (`under`), in its project (`pid`), as an add's line is made (LINE).

   The ops on the new step name it by its waiting id until Vikunja has made it, and wait for it. A refused add holds
   them back, and waits in the Outbox for Try again or Cancel. Cancel deletes the part that reached Vikunja, with the
   same op marked `cancelled`, and the ops on the step leave with it. The checklist shows it while it waits, since its
   order line and its subtasks change, which only Vikunja's reply can say. A cancelled one shows on the step too, which
   hides the step until it is deleted. */
export const addStep = {
  apply: t => ({ ...t }),
  on: a => [a.task, ...(a.from ? [a.from] : []), ...addStep.deletes(a)],
  stages: cancelledStages(ADDS, [unadd, unplace, refigure]),
  refusal: a => (a.cancelled ? 'dropped' : 'kept'),
  cancel: a => (a.cancelled ? 'undo' : 'unmade'),
  answered: (app, a) => {
    if (app.view.shownRun?.id === a.run) app.render();
  },
  holds: a => ['pending-' + a.id, ...(a.taskId ? [a.taskId] : [])],
  waitsOn: a => (typeof a.after === 'string' ? [a.after] : []),
  deletes: a => (a.cancelled && a.taskId ? [a.taskId] : []),
  replyOnly: () => ['related_tasks', 'description'],
  ...OP_WORDS.addStep,
  asks: ['title', 'p', 'pid', 'under', 'from', 'tpl', 'before', 'after', 'cancelled'],
  saw: ['label', 'runTitle'],
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  sheetPlace: null,
  putBack: null,
  row: null,
  files: null,
};

/* Entry `e` as Cancel leaves it once it has sent a request: marked cancelled, it deletes what it made, in stages after
   the ones it sent. Cut off partway, the stage it stopped in runs again first, with its keys, so a task made there
   whose reply was lost is found. A refused stage made nothing, and the stages after it take a new key, since the relay
   keeps the refusal under the old one. A stage whose answer was unknown may have been made (`unsure`), and an op whose
   Cancel can check Vikunja's copy takes it back too. */
export const cancelling = ({ failed, ...e }) =>
  failed
    ? {
        ...e,
        cancelled: true,
        cut: e.stage,
        key: uuid7(),
        fails: 0,
        ...(failed.message === UNKNOWN && { unsure: true }),
      }
    : { ...e, cancelled: true, cut: e.stage + 1, fails: 0 };
// The starts waiting to be sent among the outbox's `entries`, in project `pid`, as Checklists shows them.
export const startsIn = (entries, pid) =>
  entries.filter(e => e.kind === 'act' && e.op === 'startRun' && !e.cancelled && e.template.project_id === pid);
// The steps waiting to be added to checklist `run` among the outbox's `entries`, as its screen shows them.
export const stepsAdding = (entries, run) =>
  entries.filter(e => e.kind === 'act' && e.op === 'addStep' && !e.cancelled && e.run === run);
