// What several ops do to a task as it will be (each op's `apply`).
import { DONE_MARK, SKIP_MARK } from '../checklists.js';

// The user who made the change, as /user gave them. An entry queued before Pocket kept that has only their id.
export const whoOf = a => a.who || { id: a.user };
/* The task with the user's ✅ or ⏭️ (`mark`), or with neither, in place of the ones they had. Only a task whose
   reactions were read gets them. Elsewhere the user's ✅ would read as the only one. */
export const marked = (t, a, mark) => {
  if (!('reactions' in t)) return t;
  const rs = { ...t.reactions },
    me = whoOf(a);
  for (const m of [DONE_MARK, SKIP_MARK]) rs[m] = (rs[m] || []).filter(u => u.id !== me.id);
  if (mark) rs[mark] = [...rs[mark], me];
  return { ...t, reactions: rs };
};
// The task with the op's comment last, marked waiting until Vikunja has it. Only a task whose comments were read gets it.
export const said = (t, a) =>
  'comments' in t
    ? {
        ...t,
        comments: [
          ...(t.comments || []),
          { id: a.id, comment: a.html, author: whoOf(a), created: a.at, waiting: true },
        ],
      }
    : t;
