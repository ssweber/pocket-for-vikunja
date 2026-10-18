/* Putting a label on a task, or taking it off. A label Vikunja doesn't have yet is made first, in a stage of its own,
   so the set sent after it has its id. */
import { allPages } from '../api.js';
import { OP_WORDS } from '../messages.js';
import { CANCEL } from '../sync.js';
import { setOne } from './stages.js';

// A label as an entry keeps it. A label not yet made, shown with an id from its title, has none.
export const tagOf = l => ({
  id: typeof l.id === 'number' ? l.id : null,
  title: l.title || '',
  ...(l.hex_color && { hex_color: l.hex_color }),
});
// A label not yet made has no id, so it is known by its title until Vikunja has made it.
const sameLabel = (x, y) =>
  typeof x.id === 'number' && typeof y.id === 'number'
    ? x.id === y.id
    : x.title.trim().toLowerCase() === y.title.trim().toLowerCase();
// The label as a row shows it. A label not yet made gets an id from its title, for the lists keyed by id.
const shown = l => ({ ...l, id: l.id ?? 'new:' + l.title.trim().toLowerCase() });
const withLabel = (list, l, add) => [...(list || []).filter(x => !sameLabel(x, l)), ...(add ? [shown(l)] : [])];
// The label's id: the one it was queued with, or the one Vikunja gave it when the op found or made it (`labelId`).
const idOf = a => (typeof a.tag.id === 'number' ? a.tag.id : (a.labelId ?? null));

/* Find a label queued by its title among the labels Vikunja has when the op is sent, read once. So a label made since,
   by an earlier op or in the web app, isn't made twice. A label to put on that Vikunja doesn't have is made, with a
   key, and the stage ends there, since the read decided on it. */
async function find(a, c) {
  if (idOf(a) != null) return;
  const title = a.tag.title.trim(),
    found = await c.once('found', async () => {
      const all = await allPages('/labels?' + new URLSearchParams({ s: title }));
      return all.find(l => sameLabel(l, { title })) ?? null;
    });
  if (found) a.labelId = found.id;
  else if (a.add) {
    const made = await c.send('/labels', { method: 'POST', body: { title } });
    if (c.app.labels && !c.app.labels.some(l => l.id === made.id)) c.app.labels.push(made);
    a.labelId = made.id;
  }
}

/* `tag` is the label ({id, title, hex_color}, with no id for one Vikunja doesn't have yet), put on (`add`) or taken
   off, on the labels Vikunja has when it is sent (setOne). `was` is the labels the row showed, for Cancel's words when
   Pocket has no copy. Putting a label on and taking it off cancel out while neither is sent. Each is the other's Undo.
   A task deleted in Vikunja since drops the op. */
export const label = {
  apply: (t, a) => ({ ...t, labels: withLabel(t.labels, a.tag, a.add) }),
  stages: [find, setOne('labels', idOf)],
  invert: a => ({
    op: 'label',
    task: a.task,
    tag: { ...a.tag, id: idOf(a) },
    add: !a.add,
    was: a.got?.task?.labels ?? withLabel(a.was, a.tag, a.add),
  }),
  merge: (older, newer) =>
    older.op === 'label' && sameLabel(older.tag, newer.tag) && older.add !== newer.add ? CANCEL : null,
  refusal: (a, e) => (e?.status === 404 ? 'dropped' : 'kept'),
  sheetPlace: 'sheet:props',
  replyOnly: () => ['labels'],
  ...OP_WORDS.label,
  asks: ['tag', 'add'],
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
  putBack: null,
  deletes: null,
};
