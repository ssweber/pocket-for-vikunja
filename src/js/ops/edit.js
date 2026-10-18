/* Changing a task's own fields: a title or a priority, set as it is (`set`), or notes, reminders or a template's step
   order, which are made on the copy Vikunja has when the edit is sent (`rebase`). An outbox entry is stored in
   IndexedDB, which can't hold a function, so `rebase` names one of REBASES, which holds the code for it. */
import { ApiError } from '../api.js';
import { plainReminders, reminderKey } from '../dates.js';
import { htmlToText, textToHtml } from '../html.js';
import { notesOnly, problemText, stepProblems, stepsOf, withLinesOf, withOrder } from '../checklists.js';
import { OP_WORDS } from '../messages.js';
import { backOf, changed, patch } from './stages.js';

// The notes as the sheet edits them, without Pocket's own lines, and the description that holds `text` in their place.
export const notesText = t => htmlToText(notesOnly(t?.description)).trim();
export const notesHtml = (t, text) => withLinesOf(text.trim() ? textToHtml(text) : '', t?.description);

/* The steps in their order once step `m.step` moves: by `m.dir` places, or, dragged, to just after step `m.after`
   (first when null), or to place `m.to` when that step is gone. Null when nothing moves. Throws for a problem the move
   gives the template that it didn't have, such as a step counting from a later step. A move that fixes a problem is
   allowed. */
export function movedSteps(steps, m) {
  const k = steps.findIndex(s => s.id === m.step),
    others = steps.filter(s => s.id !== m.step);
  if (k < 0) return null;
  const at = m.after === null ? 0 : others.findIndex(s => s.id === m.after) + 1;
  const place = !m.dragged ? k + m.dir : at > 0 || m.after === null ? at : Math.min(m.to, others.length);
  if (place === k || place < 0 || place > others.length) return null;
  const out = [...others.slice(0, place), steps[k], ...others.slice(place)],
    titles = list => list.map(s => s.title || '');
  const before = stepProblems(titles(steps)),
    fresh = stepProblems(titles(out)).filter(p => !before.some(b => b.text === p.text && b.title === p.title));
  if (fresh.length) throw new Error(problemText(fresh.map(p => ({ ...p, i: steps.indexOf(out[p.i]) }))));
  return out;
}
// The order line after each move in `moves`, or null when none moves.
const orderOf = (t, moves) => {
  let steps = stepsOf(t),
    moved = false;
  for (const m of moves) {
    const out = movedSteps(steps, m);
    if (out) [steps, moved] = [out, true];
  }
  return moved
    ? withOrder(
        t.description,
        steps.map(s => s.id),
      )
    : null;
};
const remindersOf = (t, a) => {
  const skip = new Set([...a.add, ...a.drop].map(reminderKey));
  return [...plainReminders(t).filter(r => !skip.has(reminderKey(r))), ...a.add];
};

/* What each rebase does: `field` is the field it writes, `apply` shows it on a task, `body` builds the request from
   Vikunja's copy `t`, or null when Vikunja has it already, `merge` joins an unsent edit and the newer one that
   replaces it, and `invert` gives the fields of its Undo. */
const REBASES = {
  /* The user's notes (`text`) in place of Vikunja's, keeping Pocket's own lines. Notes changed in Vikunja since the
     user began editing (`base`) aren't overwritten unseen. The edit is refused with Vikunja's notes, and the sheet
     shows both (notesRefused). A draft an older Pocket kept has no base, and isn't checked. The Undo puts back the
     notes before, only while Vikunja has the edit's. */
  notes: {
    field: 'description',
    apply: (t, a) => ({ ...t, description: notesHtml(t, a.text) }),
    body(t, a) {
      const has = notesText(t);
      if (has === a.text.trim()) return null;
      if (a.base != null && has !== a.base.trim()) {
        if (a.undo) throw changed('its notes have');
        throw Object.assign(new ApiError(409, 'someone changed the notes while you were writing'), { notes: has });
      }
      return { description: notesHtml(t, a.text) };
    },
    merge: (older, newer) => ({ ...newer, base: older.base }),
    invert: a => (a.base == null ? null : { text: a.base, base: a.text }),
  },
  // Reminders added (`add`) and removed (`drop`), on the list Vikunja has, so a reminder changed elsewhere stays.
  reminders: {
    field: 'reminders',
    apply: (t, a) => ({ ...t, reminders: remindersOf(t, a) }),
    body: (t, a) => ({ reminders: remindersOf(t, a) }),
    merge(older, newer) {
      const later = new Set([...newer.add, ...newer.drop].map(reminderKey)),
        drop = [...older.drop, ...newer.drop];
      return {
        ...newer,
        add: [...older.add.filter(r => !later.has(reminderKey(r))), ...newer.add],
        drop: drop.filter((r, i) => drop.findIndex(x => reminderKey(x) === reminderKey(r)) === i),
      };
    },
    invert: a => ({ add: a.drop, drop: a.add }),
  },
  /* A template's steps moved (`moves`), each on the order Vikunja has, so a step moved elsewhere stays moved. A move
     that would give the template a new problem leaves the outbox, and the sheet says why. Each move records where its
     step was (`from`, the step before it, and `at`), for its Undo. */
  order: {
    field: 'description',
    apply(t, a) {
      try {
        const d = orderOf(t, a.moves);
        return d === null ? { ...t } : { ...t, description: d };
      } catch {
        return { ...t };
      }
    },
    body(t, a) {
      try {
        const d = orderOf(t, a.moves);
        return d === null ? null : { description: d };
      } catch (e) {
        throw Object.assign(new ApiError(409, e.message), { drop: true, said: () => 'Not moved: ' + e.message });
      }
    },
    merge: (older, newer) => ({ ...newer, moves: [...older.moves, ...newer.moves] }),
    invert: a => ({
      moves: a.moves
        .map(m => ({ step: m.step, dir: -m.dir, after: m.from, to: m.at, dragged: true, from: m.after, at: m.to }))
        .reverse(),
    }),
  },
};

// The fields an edit changes, which two edits must share for the later to replace the earlier.
export const editedFields = a => [...Object.keys(a.set || {}), ...(a.rebase ? [a.rebase] : [])];
/* The edit's one request. A field set as it is goes as it is. A rebase is built once from Vikunja's copy (c.once), so
   a retry sends the same body. An Undo of a field set as it is sends it only while Vikunja has the value the edit
   stored (`check`), and ends as changed since for a field changed since. */
async function save(a, c) {
  if (a.check) {
    const { body, left } = await backOf(a, c, a.set, a.check);
    if (Object.keys(body).length) await patch(a, c, body);
    if (left)
      throw changed(`its ${Object.keys(a.set).join(' and ')} ${Object.keys(a.set).length > 1 ? 'have' : 'has'}`);
    return;
  }
  const kind = REBASES[a.rebase],
    body = !kind
      ? a.set
      : await c.once('body', async () => {
          const t = await c.read('/tasks/' + a.task);
          c.task = t;
          const out = kind.body(t, a);
          return out && { ...a.set, ...out };
        });
  if (body) await patch(a, c, body);
}

/* A later edit of the same fields of a task replaces one not sent yet, and keeps its fields before (`was`), so Undo
   goes back to where the first began. A task deleted in Vikunja since drops the edit, as it drops a tick. Notes that
   changed under the user's go back to the sheet (notesRefused). */
export const edit = {
  apply: (t, a) => {
    const out = { ...t, ...a.set };
    return a.rebase ? REBASES[a.rebase].apply(out, a) : out;
  },
  stages: [save],
  invert(a) {
    if (a.rebase) {
      const back = REBASES[a.rebase].invert(a);
      return back && { op: 'edit', task: a.task, rebase: a.rebase, ...back };
    }
    if (!a.was) return null;
    const stored = Object.fromEntries(Object.keys(a.set).map(k => [k, a.got?.task?.[k] ?? a.set[k]]));
    return { op: 'edit', task: a.task, set: a.was, was: stored, check: stored };
  },
  merge(older, newer) {
    if (older.op !== 'edit' || editedFields(older).join() !== editedFields(newer).join()) return null;
    const m = newer.rebase ? REBASES[newer.rebase].merge(older, newer) : { ...newer };
    return older.was ? { ...m, was: { ...newer.was, ...older.was } } : m;
  },
  refusal: (a, e) => (e?.status === 404 ? 'dropped' : e?.notes !== undefined ? 'undone' : 'kept'),
  putBack: (app, a, e) => {
    if (e.notes !== undefined) app.notesRefused(a, e);
  },
  sheetPlace: a => ({ notes: 'sheet:notes', order: 'sheet:subtasks' })[a.rebase] ?? 'sheet:top',
  ...OP_WORDS.edit,
  asks: ['set', 'check', 'rebase', 'text', 'base', 'add', 'drop', 'moves'],
  saw: ['label', 'was'],
  on: null,
  keepReads: null,
  waiting: null,
  cancel: null,
  answered: null,
  holds: null,
  waitsOn: null,
  row: null,
  files: null,
  deletes: null,
  // A rebase is built on Vikunja's copy as it is sent, so only Vikunja's reply says what its field became.
  replyOnly: a => (REBASES[a.rebase] ? [REBASES[a.rebase].field] : []),
};
