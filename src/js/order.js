/* Task order within a project. Vikunja's List view gives each task a position (a number, smaller first). Pocket reads
   and writes the project's first List view, so moving a task in Pocket also moves it in Vikunja's web app. Template
   and checklist steps are ordered another way (checklists.js): the List view hides done tasks, and templates are
   stored as done tasks. */

// A project's first List view, or null.
export const listViewOf = p =>
  [...(p?.views || [])]
    .filter(v => v.view_kind === 'list')
    .sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id)[0] || null;
export const SPACING = 2 ** 16; // the gap Vikunja's web app leaves after the last task
/* A position between two neighbours, computed the way Vikunja's web app does (calculateItemPosition). Vikunja
   renumbers the view once a position drops below 0.01, so Pocket never has to. */
export function between(before, after) {
  if (before !== null && after !== null && before === after) return after + 0.01;
  if (before === null) return after === null ? 0 : after / 2;
  if (after === null) return before + SPACING;
  return before + (after - before) / 2;
}
/* Move the sibling at index `from` to index `to`. Returns the [id, position] pairs to write, the moved one last.
   Siblings with position 0 (moved in from another project) sort last. If the move lands next to one, those get
   positions first, so the moved task has two neighbours to go between. */
export function placeMove(sibs, from, to) {
  let rest = sibs.filter((_, i) => i !== from);
  const writes = [];
  if ([rest[to - 1], rest[to]].some(s => s && !s.pos)) {
    let last = Math.max(0, ...rest.map(s => s.pos || 0));
    rest = rest.map(s => (s.pos ? s : (writes.push([s.id, (last += SPACING)]), { ...s, pos: last })));
  }
  writes.push([sibs[from].id, between(rest[to - 1]?.pos ?? null, rest[to]?.pos ?? null)]);
  return writes;
}
/* Positions for `n` new subtasks after position `after`, or after the last sibling when `after` is null. Siblings with
   no position sort last, so "after" one of them means after the last sibling that has a position. */
export function placeAfter(sibs, after, n = 1) {
  const known = sibs.filter(p => p > 0);
  let prev = after > 0 ? after : Math.max(0, ...known);
  const next = Math.min(...known.filter(p => p > prev)),
    out = [];
  for (let k = 0; k < n; k++) out.push((prev = between(prev, next === Infinity ? null : next)));
  return out;
}
/* Positions for `n` new subtasks ahead of every sibling. They go first because the add box sits directly under the
   parent. If no sibling has a position, this calls placeAfter, because a position of 0 would sort after the next task
   added. */
export function placeFirst(sibs, n = 1) {
  const known = sibs.filter(p => p > 0),
    out = [];
  if (!known.length) return placeAfter(sibs, null, n);
  const next = Math.min(...known);
  let prev = null;
  for (let k = 0; k < n; k++) out.push((prev = between(prev, next)));
  return out;
}
/* Make sure no new task gets a position another task already has. `places` are the positions chosen for new tasks,
   `taken` the positions in use. Without this, a new project's first task and a task's first subtask both land on
   65536, Vikunja pushes them apart, and a row the user never touched moves. A clashing position moves halfway towards
   the next one, or towards `end`. */
export function clearOf(places, taken, end = null) {
  const out = [...places];
  for (let k = out.length - 1; k >= 0; k--) {
    const next = out[k + 1] ?? end ?? out[k] + SPACING;
    while (taken.has(out[k])) out[k] += (next - out[k]) / 2;
  }
  return out;
}
/* Sort siblings by List view position (`pos`: id → position), unpositioned ones last by id, as Vikunja does. A task
   not yet sent sorts by its own position if it has one, else first, which is where Vikunja puts a new task, so it
   doesn't jump once sent. */
export const positionOrder = pos => (a, b) => {
  const p = (a.pending ? a.position : pos[a.id]) || 0,
    q = (b.pending ? b.position : pos[b.id]) || 0;
  const first = t => !!t.pending && !t.position;
  return first(b) - first(a) || !p - !q || p - q || (a.pending || b.pending ? 0 : a.id - b.id);
};
/* The siblings of task `id` in a nested list (`tasks` in order, `depth` by id), each with the ids of its subtasks, so
   a drag moves the whole block. A subtask only moves among its parent's subtasks. */
export function siblingBlocks(tasks, depth, id) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) return [];
  const d = depth[id] || 0,
    dep = t => depth[t.id] || 0;
  let start = i,
    end = i;
  while (start > 0 && dep(tasks[start - 1]) >= d) start--; // back to the parent, or the top
  while (end + 1 < tasks.length && dep(tasks[end + 1]) >= d) end++; // on to the parent's next sibling, or the end
  const out = [];
  for (let k = start; k <= end; k++)
    if (dep(tasks[k]) === d) out.push({ id: tasks[k].id, task: tasks[k], ids: [tasks[k].id] });
    else out.at(-1)?.ids.push(tasks[k].id);
  return out;
}
/* Drag geometry. `blocks` are the siblings' {top, height} on the page, `k` is the index of the dragged block, and `dy`
   is how far it has moved. Returns `dy` clamped to the list, `shifts` (px each other block moves aside) and `at`, the
   index the dragged block would land on. */
export function dragPlace(blocks, k, dy) {
  const me = blocks[k],
    last = blocks.at(-1),
    h = me.height,
    end = last.top + last.height;
  const mid = Math.max(blocks[0].top, Math.min(end, me.top + dy + h / 2)); // a taller row still gets past a short one
  dy = Math.max(blocks[0].top - me.top, Math.min(end - me.top - h, dy));
  const shifts = blocks.map((b, i) =>
    i > k && mid > b.top + b.height / 2 ? -h : i < k && mid < b.top + b.height / 2 ? h : 0,
  );
  return {
    dy,
    shifts,
    at: k + shifts.filter((s, i) => i > k && s).length - shifts.filter((s, i) => i < k && s).length,
  };
}
