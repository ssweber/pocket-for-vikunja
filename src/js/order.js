/* The order of a project's tasks: Vikunja's List view, where each task has a position (a number, smaller first) in each
   of its project's views. Pocket reads and writes the project's first List view, so a move shows on the web too, and
   sets positions the way Vikunja's web app does. A template's and a run's steps keep their order line instead
   (checklists.js): Vikunja's List view leaves out tasks that are done, as a template and its steps always are. */

// The List view Pocket uses: a project's first, by its place among the views, then id. Null if it has none.
export const listViewOf = p => [...(p?.views || [])].filter(v => v.view_kind === 'list').sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id)[0] || null;
export const SPACING = 2 ** 16;                         // the room the web app leaves after the last task
/* A position between two neighbours' (null: none on that side), as Vikunja's web app works it out
   (calculateItemPosition): half way between them; first, half the next one's; last, the room after the one before; two
   neighbours with the same position, a little after them. Vikunja renumbers the whole view itself once one falls below
   0.01, so Pocket never has to. */
export function between(before, after){
  if (before !== null && after !== null && before === after) return after + 0.01;
  if (before === null) return after === null ? 0 : after / 2;
  if (after === null) return before + SPACING;
  return before + (after - before) / 2;
}
/* A move of the sibling at `from` to `to`, among siblings [{id, pos}] in their order: the [id, position] pairs to
   write, the moved one last. A sibling with no position (0: moved in from another project, which leaves it none) is
   after the others; landing next to one, those are given positions after the last that has one first, in their order,
   so the move has neighbours to go between. */
export function placeMove(sibs, from, to){
  let rest = sibs.filter((_, i) => i !== from);
  const writes = [];
  if ([rest[to - 1], rest[to]].some(s => s && !s.pos)) {
    let last = Math.max(0, ...rest.map(s => s.pos || 0));
    rest = rest.map(s => s.pos ? s : (writes.push([s.id, last += SPACING]), {...s, pos: last}));
  }
  writes.push([sibs[from].id, between(rest[to - 1]?.pos ?? null, rest[to]?.pos ?? null)]);
  return writes;
}
/* Where `n` new subtasks go, one after another: after the sibling at position `after` (null: after the last of them),
   and before the sibling after that. `sibs` are the siblings' positions. One with none (0) is after the others, so
   after one of those they go after the last that has one. */
export function placeAfter(sibs, after, n = 1){
  const known = sibs.filter(p => p > 0);
  let prev = after > 0 ? after : Math.max(0, ...known);
  const next = Math.min(...known.filter(p => p > prev)), out = [];
  for (let k = 0; k < n; k++) out.push(prev = between(prev, next === Infinity ? null : next));
  return out;
}
/* Siblings in their List view order (`pos`: id -> position): smaller first, and those with none (0) after the others,
   by id, as Vikunja sorts them. A task still waiting to be sent goes where its position says, if it was given one (a
   subtask added after another), else after all of those. */
export const positionOrder = pos => (a, b) => {
  const p = (a.pending ? a.position : pos[a.id]) || 0, q = (b.pending ? b.position : pos[b.id]) || 0;
  const last = t => !!t.pending && !t.position;
  return last(a) - last(b) || (!p) - (!q) || p - q || (a.pending || b.pending ? 0 : a.id - b.id);
};
/* A task's siblings in a list with each subtask under its parent (nestSubtasks: `tasks` in order, `depth` by id): the
   tasks under the same parent, at the same depth, each with the rows that go with it when it moves (its subtasks, all
   the way down). Only those: a subtask moves among its parent's subtasks, never to another parent. */
export function siblingBlocks(tasks, depth, id){
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) return [];
  const d = depth[id] || 0, dep = t => depth[t.id] || 0;
  let start = i, end = i;
  while (start > 0 && dep(tasks[start - 1]) >= d) start--;          // back to the parent, or the top
  while (end + 1 < tasks.length && dep(tasks[end + 1]) >= d) end++;  // on to the parent's next sibling, or the end
  const out = [];
  for (let k = start; k <= end; k++) if (dep(tasks[k]) === d) out.push({id: tasks[k].id, task: tasks[k], ids: [tasks[k].id]});
    else out.at(-1)?.ids.push(tasks[k].id);
  return out;
}
/* Where a row being dragged is: blocks [{top, height}] (the siblings, in order, where they are on the page), the one
   dragged `k`, moved `dy` from where it was. It's drawn between the first and the last of them. A sibling whose middle
   its middle has passed moves aside, by its height (shifts: px for each block), and `at` is where it would land. */
export function dragPlace(blocks, k, dy){
  const me = blocks[k], last = blocks.at(-1), h = me.height, end = last.top + last.height;
  const mid = Math.max(blocks[0].top, Math.min(end, me.top + dy + h / 2));   // a taller row still gets past a short one
  dy = Math.max(blocks[0].top - me.top, Math.min(end - me.top - h, dy));
  const shifts = blocks.map((b, i) => i > k && mid > b.top + b.height / 2 ? -h : i < k && mid < b.top + b.height / 2 ? h : 0);
  return {dy, shifts, at: k + shifts.filter((s, i) => i > k && s).length - shifts.filter((s, i) => i < k && s).length};
}
