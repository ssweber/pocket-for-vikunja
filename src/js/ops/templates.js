/* Making a task a template (makeTemplate), and adding a step to a template (templateStep). A template is a task with
   the "template" label, done unless it has a due date, whose subtasks are its steps. The steps are done, so none of
   them is a to-do anywhere. Every request has a key. Cancel takes back what the op made, with the same op marked
   `cancelled`, in stages that come after the ones it sent (cancelledStages). */
import { allPages } from '../api.js';
import { isSet } from '../dates.js';
import { OP_WORDS } from '../messages.js';
import { ALREADY } from '../sync.js';
import { ZERO } from '../util.js';
import { isTemplateLabel, templateTitle } from '../checklists.js';
import { opsId, MOVED, TASK } from '../app/tasks.js';
import { LINE } from './add.js';
import { cancelledStages, notFound, patch, place, unadd, unplace } from './stages.js';

/* Mark task `id` done or not done, and put Vikunja's answer into its copy. Vikunja moves a repeating task marked done on
   to its next date instead, and Pocket's copy may not know that it repeats, so only the reply says what a tick left. A
   task deleted in the meantime is skipped. */
async function setDone(c, id, done) {
  const body = { done },
    sure = done ? {} : body,
    t = await c.send('/tasks/' + id, { method: 'PATCH', body, on: { [id]: sure } }).catch(e => {
      notFound(e);
      return false;
    });
  if (t !== false)
    c.app.change(w => {
      w.made(id, c.from(t), sure);
      if (t) w.answer([t], TASK, c.from(t));
    });
}

/* ---------- making a task a template ---------- */

/* The "template" label Vikunja has, read once: the user's own, or else anyone's. If Vikunja has none, one is made, with
   a key, so it is made once. */
async function find(a, c) {
  if (a.labelId) return;
  const found = await c.once('found', async () => {
    const all = (await allPages('/labels?' + new URLSearchParams({ s: 'template' }))).filter(isTemplateLabel);
    return (all.find(l => l.created_by?.id === a.user) ?? all[0])?.id ?? null;
  });
  if (found) a.labelId = found;
  else {
    const made = await c.send('/labels', { method: 'POST', body: { title: 'template' } });
    if (c.app.labels && !c.app.labels.some(l => l.id === made.id)) c.app.labels.push(made);
    a.labelId = made.id;
  }
}
// The label goes on first. Until the task is marked done last, it is a template Make template didn't finish, which
// Checklists doesn't list (readyTemplate). Whether this op put the label on is read once, for Cancel.
async function label(a, c) {
  const adds = await c.once(
    'labeled',
    async () => !((await c.read('/tasks/' + a.task)).labels || []).some(l => l.id === a.labelId),
  );
  if (adds)
    await c.send(`/tasks/${a.task}/labels`, { method: 'POST', body: { label_id: a.labelId } }).catch(e => {
      if (e.code !== ALREADY.label) throw e;
    });
}
// Each step the sheet showed open (`steps`) is marked done, one stage each, so Cancel knows which it reached.
const tickStep = i => (a, c) => setDone(c, a.steps[i], true);
/* A "copied from" link, made when the task was duplicated in the web app, would make the template look like a
   checklist being set up, so it is deleted. The links are read once, for Cancel. */
async function uncopy(a, c) {
  const ids = await c.once('copies', async () =>
    ((await c.read('/tasks/' + a.task)).related_tasks?.copiedfrom || []).map(x => x.id),
  );
  for (const id of ids)
    await c.send(`/tasks/${a.task}/relations/copiedfrom/${id}`, { method: 'DELETE', on: { [id]: {} } }).catch(notFound);
}
/* Last, the task is marked done, unless it has a due date, so a template with a date stays due. Its title gets the
   "TEMPLATE: " prefix. Both come from Vikunja's copy, read once. */
async function finish(a, c) {
  const body = await c.once('finish', async () => {
    const t = await c.read('/tasks/' + a.task);
    return { done: !isSet(t.due_date), title: templateTitle(t.title) };
  });
  await patch(a, c, body);
}
const MAKES = a => [find, label, ...(a.steps || []).map((_, i) => tickStep(i)), uncopy, finish];

// What Cancel takes back, each part only once the stage that made it is done (`cut`).
const unlabel = (a, c) =>
  c.send(`/tasks/${a.task}/labels/${a.labelId}`, { method: 'DELETE', on: { [a.task]: {} } }).catch(notFound);
const untickStep = i => (a, c) => setDone(c, a.steps[i], false);
async function recopy(a, c) {
  for (const id of a.fixed.copies)
    await c
      .send(`/tasks/${a.task}/relations`, {
        method: 'POST',
        body: { other_task_id: id, relation_kind: 'copiedfrom' },
        on: { [id]: {} },
      })
      .catch(e => {
        if (e.code !== ALREADY.link) throw e;
      });
}
const UNMAKES = a => {
  const done = k => (a.cut || 0) > k,
    n = (a.steps || []).length;
  return [
    ...(done(1) && a.fixed?.labeled ? [unlabel] : []),
    ...(a.steps || []).flatMap((_, i) => (done(2 + i) ? [untickStep(i)] : [])),
    ...(done(2 + n) && a.fixed?.copies?.length ? [recopy] : []),
  ];
};

/* The template as it will be: labelled, done unless it has a due date, and named with the prefix. The label is known
   by its title, as a label op shows one not yet made, because which label the op finds is only known once it is sent. */
const asTemplate = t => ({
  ...t,
  labels: (t.labels || []).some(isTemplateLabel)
    ? t.labels
    : [...(t.labels || []), { id: 'new:template', title: 'template' }],
  done: !isSet(t.due_date),
  title: templateTitle(t.title),
});

/* Task `task` becomes a template, and the open steps its sheet showed (`steps`) are marked done. New template makes the
   task and its steps first, with an add op and templateStep ops, and this op waits for those steps (`lines`). It is
   all or nothing: a refused op waits in the Outbox for Try again or Cancel, and Cancel takes back what it made. The
   task shows as a template while it waits. Vikunja's copy takes what its reply says, since it is built from the copy
   Vikunja has as it is sent. */
export const makeTemplate = {
  apply: (t, a) => (a.cancelled ? { ...t } : asTemplate(t)),
  stages: cancelledStages(MAKES, UNMAKES),
  keepReads: true,
  refusal: a => (a.cancelled ? 'dropped' : 'kept'),
  cancel: a => (a.cancelled ? 'undo' : 'unmade'),
  sheetPlace: 'sheet:top',
  waitsOn: a => [a.task, ...(a.lines || [])],
  replyOnly: () => ['labels', 'title', 'related_tasks', ...MOVED],
  ...OP_WORDS.makeTemplate,
  asks: ['steps', 'lines', 'cancelled'],
  saw: ['label'],
  on: null,
  invert: null,
  merge: null,
  waiting: null,
  answered: null,
  putBack: null,
  holds: null,
  row: null,
  files: null,
  deletes: null,
};

/* ---------- adding a step to a template ---------- */

const [prepare, made, labels, people, link] = LINE;
// A step is made under its template as an add box's line is made (LINE), then marked done.
const tick = (a, c) => setDone(c, a.taskId, true);
const ADDS = a => [prepare, made, labels, people, link, tick, ...(a.after != null ? [place] : [])];

/* A step added to template `task`: a line typed in the box under the template's steps, or in New template, as quick
   add parsed it (`p`). It is made under the template (`under`), in its project (`pid`). In New template the template is
   still being made, and both name it by its waiting id. A step goes after step `after`, which may be a step still
   being added ('pending-<entry>'), or last when that is null.

   A refused step waits in the Outbox for Try again or Cancel, and Cancel deletes the part that reached Vikunja, as for
   a step added to a checklist (addStep). It waits as a row in the template's sheet until it is made. The template shows
   it while it waits, since its order line and its subtasks change, which only Vikunja's reply can say. */
export const templateStep = {
  apply: t => ({ ...t }),
  stages: cancelledStages(ADDS, [unadd, unplace]),
  refusal: a => (a.cancelled ? 'dropped' : 'kept'),
  cancel: a => (a.cancelled ? 'undo' : 'unmade'),
  holds: a => ['pending-' + a.id, ...(a.taskId ? [a.taskId] : [])],
  waitsOn: a => [a.task, ...(typeof a.after === 'string' ? [a.after] : [])],
  // The step's waiting row has no project, so it shows only in its template's sheet, never in a project's list.
  row: a =>
    a.taskId || a.cancelled
      ? null
      : {
          id: 'pending-' + a.id,
          pending: true,
          entry: a.id,
          sent: !!a.sent,
          child: true,
          parent: opsId(a.task),
          title: a.p.title,
          done: true,
          percent_done: 0,
          priority: 0,
          position: 0,
          due_date: ZERO,
          project_id: null,
          labels: [],
          assignees: [],
          repeat_after: 0,
          repeat_mode: 0,
          waiting: 0,
        },
  deletes: a => (a.cancelled && a.taskId ? [a.taskId] : []),
  replyOnly: () => ['related_tasks', 'description'],
  ...OP_WORDS.templateStep,
  asks: ['p', 'pid', 'under', 'after', 'cancelled'],
  saw: ['label'],
  on: null,
  keepReads: null,
  invert: null,
  merge: null,
  waiting: null,
  sheetPlace: null,
  answered: null,
  putBack: null,
  files: null,
};
