// The specimen page's code. It runs Pocket's own Alpine component with made-up tasks instead of signing in, so the task
// row can be seen in every state. Nothing is sent anywhere, and the rows can't be tapped (inert).
import { directives, globals, pocket } from '../../src/js/component.js';
import { setApp } from '../../src/js/util.js';
import { CHECKLIST_MARK, plainRun } from '../../src/js/checklists.js';
import { blankSheet } from '../../src/js/app/core.js';
import { listItems, nestSubtasks } from '../../src/js/lists.js';
import { positionOrder } from '../../src/js/order.js';
import { revealOf, swipeOf } from '../../src/js/app/progress.js';
import { swipeAt } from '../../src/js/progress.js';
import { completeAsk, moreDone, movedGap } from '../../src/js/messages.js';
import { throwLayout, throwTargets } from '../../src/js/throw.js';
import { chipsEl, chipsLight, chipsOpen } from '../../src/js/app/throw.js';

const ZERO = '0001-01-01T00:00:00Z',
  HOUR = 36e5;
const at = ms => new Date(Date.now() + ms).toISOString();
const me = { id: 1, username: 'alex', name: 'Alex' },
  jamie = { id: 2, username: 'jamie', name: 'Jamie' },
  sam = { id: 3, username: 'sam', name: '' };
const label = (id, title, hex_color) => ({ id, title, hex_color });
let n = 100;
// A task as Vikunja returns it, with only the fields a row reads.
const task = fields => ({
  id: ++n,
  title: 'A task',
  done: false,
  priority: 0,
  due_date: ZERO,
  project_id: 1,
  labels: null,
  assignees: null,
  percent_done: 0,
  comment_count: 0,
  attachments: null,
  reminders: null,
  repeat_after: 0,
  repeat_mode: 0,
  description: '',
  related_tasks: {},
  created_by: me,
  ...fields,
});

const projects = [
  { id: 1, title: 'Café', hex_color: '1d6b52' },
  { id: 2, title: 'Checklists', hex_color: 'b8860b', description: `<p>${CHECKLIST_MARK}</p>` },
  { id: 3, title: 'Head office', hex_color: '6a5acd' },
  { id: 4, title: 'Upkeep', hex_color: '3d85c6' },
  { id: 5, title: 'My own', hex_color: 'c0504d' },
];

// The sections of the page. Each section is a list of rows with a `g` object, the same object the app gives a row. `g`
// holds each row's depth under the task above it, and whether the row is in a task's sheet.
function sections() {
  const top = task({ title: 'Set up the new till' }),
    d1 = task({ title: 'Unbox it', related_tasks: { parenttask: [{ id: top.id }] } });
  const d2 = task({ title: 'Find the receipt roll', related_tasks: { parenttask: [{ id: d1.id }] } });
  const d3 = task({ title: 'Ask Jamie where it went', related_tasks: { parenttask: [{ id: d2.id }] }, done: true });
  const steps = [
    { id: 901, title: 'Turn on the espresso machine', done: true },
    { id: 902, title: 'Put the croissants in the oven', done: true },
    { id: 903, title: 'Take the croissants out', done: false },
    { id: 904, title: 'Wipe down the tables', done: false },
  ];
  const tables = task({ title: 'Set out the tables', state: { drag: 70 } });
  const hall = task({ title: 'Book the hall', state: { aimed: true } }),
    van = task({ title: 'Pack the van' });
  const load = task({ title: 'Load chairs', state: { aimed: true }, related_tasks: { parenttask: [{ id: van.id }] } });
  // Subtasks added from the add box (quickadd.js: aimAdded). The most recently added one is highlighted, and the parent's row is not.
  const crates = task({ title: 'Pack the crates' }),
    under = (title, more) => ({ ...task({ title, related_tasks: { parenttask: [{ id: crates.id }] } }), ...more });
  const added = [
    under('Rope', { id: 'pending-specimen-2', pending: true, waits: true, entry: 'specimen', index: 1 }),
    under('Straps', {
      id: 'pending-specimen-3',
      pending: true,
      waits: true,
      entry: 'specimen',
      index: 2,
      state: { aimed: true },
    }),
    under('Tarp', { id: 'pending-specimen-4', pending: true, entry: 'specimen', index: 3, state: { aimed: true } }),
    under('Hooks', { state: { aimed: true, flash: 'fresh' } }),
  ];
  const chairs = task({
    title: 'Wipe the chairs',
    state: { drag: 70, with: true },
    related_tasks: { parenttask: [{ id: tables.id }] },
  });
  // A task marked done while it still has open subtasks (done in the web app, say). In a project's list its title is struck through, above its subtasks.
  const party = task({ title: 'Plan the staff party', done: true }),
    cake = task({ title: 'Order the cake', related_tasks: { parenttask: [{ id: party.id }] } });
  const mover = task({ title: 'Pack the van', done: true, assignees: [me], state: { leaving: 'done' } });
  const moverKid = task({
    title: 'Load chairs',
    done: true,
    related_tasks: { parenttask: [{ id: mover.id }] },
    state: { leaving: 'done' },
  });
  const tent = task({ title: 'Put up the tent' }),
    pegs = task({
      title: 'Hammer in the pegs',
      percent_done: 0.5,
      state: { reveal: 0.3 },
      related_tasks: { parenttask: [{ id: tent.id }] },
    });
  const poles = task({
    title: 'Tie down the poles',
    related_tasks: { parenttask: [{ id: tent.id }] },
    done: true,
    state: { swept: true },
  });
  const room = task({
    title: 'Book the back room',
    due_date: at(30 * HOUR),
    related_tasks: { parenttask: [{ id: party.id }] },
  });
  const run = task({
    title: 'Opening up · Oct 7',
    project_id: 2,
    related_tasks: { copiedfrom: [{ id: 900 }], subtask: steps },
    assignees: [me, jamie],
  });
  // A checklist with 16 steps. Its ring works the same as any checklist's.
  const long = task({
    title: 'Deep clean · Oct 5',
    project_id: 2,
    assignees: [jamie],
    related_tasks: {
      copiedfrom: [{ id: 899 }],
      subtask: Array.from({ length: 16 }, (_, i) => ({ id: 950 + i, title: 'Step ' + (i + 1), done: i < 5 })),
    },
  });
  // A step of a checklist you've claimed, on Today, next to a task. The step's box is square and the task's is round.
  const stepRow = task({
    title: 'Take the croissants out',
    project_id: 2,
    assignees: [me],
    related_tasks: { parenttask: [{ id: run.id, title: run.title }], copiedfrom: [{ id: 903 }] },
  });
  const subRow = task({ title: 'Book the back room', assignees: [me] });
  // A checklist step counting down, with the reminder Pocket gave it for that. It shows no 🔔 because the countdown already says it, while a task's reminder shows one.
  const timed = task({
    title: 'Take the croissants out',
    project_id: 2,
    due_date: at(18 * 6e4),
    reminders: [{ reminder: at(18 * 6e4) }],
    related_tasks: { parenttask: [{ id: run.id, title: run.title }], copiedfrom: [{ id: 903 }] },
  });
  const parent = task({
    title: 'Deep clean',
    related_tasks: {
      subtask: [
        task({ id: 801, title: 'Nobody yet: + me claims it' }),
        task({ id: 802, title: 'Yours: tap to let it go', due_date: at(3 * HOUR), assignees: [me] }),
        task({ id: 803, title: "Someone else's", due_date: at(-2 * HOUR), priority: 3, assignees: [jamie] }),
        task({ id: 804, title: 'Done, by two people', done: true, assignees: [jamie, sam] }),
      ],
    },
  });
  // Today's stacked cards (cards.js). The cards are:
  // - a high-priority task with five subtasks, one done and four open (one of them yours), opened with its footer's More
  // - a checklist with a step counting down
  // - a checklist due at 6 PM, started from a template that was due again
  // - a task with one open subtask, so it has no footer
  // - a low-priority task with 14 subtasks, twelve done (its ring's "12/14" is set smaller to fit)
  // - a done task with a repeating subtask still open, its title struck through over the line that says so
  // Plain rows sit between the cards, two after the opened card and one after the checklist's tab. Each group of rows is
  // its own block, with rounded corners where a card's gap or footer cuts the list. The cards' subtasks are in the store,
  // as Today keeps them. A checklist's heading reads like a task's. It shows the name without the day the checklist
  // was started (runWithoutDay), and the due time at the right.
  const now = new Date(),
    day = now.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    six = new Date(now);
  six.setHours(18, 0, 0, 0);
  const dayAt = (days, h, m = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const kid = (id, f) => task({ id, related_tasks: { parenttask: [{ id: f.under }] }, ...f });
  const van2 = task({
    title: 'Pack the van',
    due_date: at(5 * HOUR),
    priority: 3,
    related_tasks: { subtask: [{ id: 701, done: true }, { id: 702 }, { id: 703 }, { id: 704 }, { id: 705 }] },
  });
  const opening = task({
    title: `Opening up · ${day} · #2`,
    created: now.toISOString(),
    project_id: 2,
    assignees: [me],
    related_tasks: { copiedfrom: [{ id: 898 }], subtask: [{ id: 711, done: true }, { id: 712 }, { id: 713 }] },
  });
  const closing = task({
    title: `Closing up · ${day} · #5`,
    created: now.toISOString(),
    due_date: six.toISOString(),
    project_id: 2,
    assignees: [me, jamie],
    related_tasks: { copiedfrom: [{ id: 897 }], subtask: [{ id: 751 }, { id: 752 }] },
  });
  const sign = task({
    title: 'Repaint the sign',
    related_tasks: { subtask: [{ id: 721, done: true }, { id: 722, done: true }, { id: 723 }] },
  });
  const shelves = task({
    title: 'Stock the new shelves in the back room before the delivery comes',
    priority: 1,
    related_tasks: { subtask: Array.from({ length: 14 }, (_, i) => ({ id: 731 + i, done: i < 12 })) },
  });
  // A task closed over a subtask that repeats, which keeps it on Today as that subtask's card.
  const fridges = task({
    title: 'Clean the fridges',
    done: true,
    related_tasks: { subtask: [{ id: 1501, done: true }, { id: 1502 }] },
  });
  /* An opened card whose rows show the most at their right end: a priority and a time before "+ me" ("10:30a"), noon
     ("12p"), a whole hour ("3p"), and a subtask in another project. That subtask keeps its own project dot, while the
     other rows leave the dot to the card's header. One row has nothing at its right end, so its title fills the row. */
  const tasting = task({
    title: 'Get ready for the tasting evening',
    due_date: dayAt(0, 18, 30),
    priority: 2,
    related_tasks: { subtask: [{ id: 1401 }, { id: 1402 }, { id: 1403 }, { id: 1404 }] },
  });
  const cardSubs = [
    kid(1401, { under: tasting.id, title: 'Print the tasting notes', due_date: dayAt(0, 10, 30), priority: 3 }),
    kid(1402, {
      under: tasting.id,
      title: 'Borrow glasses from next door',
      project_id: 4,
      due_date: dayAt(0, 12),
      priority: 1,
    }),
    kid(1403, { under: tasting.id, title: 'Chill the white wine', due_date: dayAt(0, 15), assignees: [jamie] }),
    kid(1404, { under: tasting.id, title: 'Set out the tables' }),
    kid(701, { under: van2.id, title: 'Load chairs', done: true }),
    kid(702, { under: van2.id, title: 'Load tables', assignees: [jamie] }),
    kid(703, { under: van2.id, title: 'Sound system', assignees: [me], percent_done: 0.5 }),
    kid(704, { under: van2.id, title: 'Lights' }),
    kid(705, { under: van2.id, title: 'The extension leads' }),
    kid(711, {
      under: opening.id,
      project_id: 2,
      title: 'Turn on the espresso machine',
      done: true,
      related_tasks: { parenttask: [{ id: opening.id }], copiedfrom: [{ id: 1 }] },
    }),
    kid(712, {
      under: opening.id,
      project_id: 2,
      title: 'Take the croissants out',
      due_date: at(18 * 6e4),
      related_tasks: { parenttask: [{ id: opening.id }], copiedfrom: [{ id: 2 }] },
    }),
    kid(713, {
      under: opening.id,
      project_id: 2,
      title: 'Unlock the door',
      related_tasks: { parenttask: [{ id: opening.id }], copiedfrom: [{ id: 3 }] },
    }),
    kid(751, {
      under: closing.id,
      project_id: 2,
      title: 'Stack the chairs',
      related_tasks: { parenttask: [{ id: closing.id }], copiedfrom: [{ id: 4 }] },
    }),
    kid(752, {
      under: closing.id,
      project_id: 2,
      title: 'Lock the door',
      related_tasks: { parenttask: [{ id: closing.id }], copiedfrom: [{ id: 5 }] },
    }),
    kid(723, { under: sign.id, title: 'Varnish it', assignees: [sam] }),
    ...Array.from({ length: 14 }, (_, i) =>
      kid(731 + i, { under: shelves.id, title: 'Shelf ' + (i + 1), done: i < 12 }),
    ),
    kid(1501, { under: fridges.id, title: 'Empty the drinks fridge', done: true }),
    kid(1502, { under: fridges.id, title: 'Wipe the seals', due_date: dayAt(1, 9), repeat_after: 7 * 86400 }),
  ];
  // Today's rows, each on one line. The title is cut short. At the right are small priority bars (from none to do now),
  // a short due time, and the project's dot. The due time is a time today ("10:30a" where the browser writes
  // "10:30 AM"), a weekday this week, or a date beyond that, and it is red when late.
  const today = [
    task({ title: 'Post next week’s rota', due_date: dayAt(0, 10, 30), priority: 3 }),
    task({
      title: 'Call the plumber about the dishwasher that leaks under the sink again',
      due_date: dayAt(0, 15, 30),
      priority: 1,
      assignees: [jamie],
    }),
    task({ title: 'Pay the milk invoice', due_date: dayAt(-2, 9), priority: 4, project_id: 4 }),
    task({ title: 'Order the cups', due_date: dayAt(2, 0), priority: 2 }),
    task({ title: 'Book the window cleaner', due_date: dayAt(12, 0) }),
    task({ title: 'Fix the till drawer', due_date: dayAt(0, 9), priority: 5, assignees: [me] }),
  ];
  /* A project's open list (cards 'list'). A task with open subtasks shows them on its card, which stays open, in the
     order of Vikunja's List view. One of those subtasks has a subtask of its own, shown as a row that opens its sheet.
     Another is waiting to be sent after being added from the add box. A task with no subtasks is a plain row. A done
     task with an open subtask has its title struck through. A checklist in progress shows its open steps on its card,
     in their order. */
  const launch = task({
    title: 'Plan the launch party',
    related_tasks: { subtask: [{ id: 761 }, { id: 762, done: true }, { id: 763 }, { id: 764 }] },
  });
  const plain = task({ title: 'Water the plants' });
  const staff = task({ title: 'Plan the staff party', done: true, related_tasks: { subtask: [{ id: 771 }] } });
  const closing2 = task({
    title: `Closing up · ${day} · #6`,
    created: now.toISOString(),
    project_id: 2,
    assignees: [jamie],
    related_tasks: { copiedfrom: [{ id: 896 }], subtask: [{ id: 781, done: true }, { id: 782 }, { id: 783 }] },
  });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(17, 0, 0, 0);
  const projectSubs = [
    kid(761, { under: launch.id, title: 'Book the band', assignees: [jamie] }),
    kid(763, {
      under: launch.id,
      title: 'Order the cake',
      percent_done: 0.5,
      related_tasks: { parenttask: [{ id: launch.id }], subtask: [{ id: 765 }] },
    }),
    kid(765, { under: 763, title: 'Pick a flavour' }),
    kid(764, { under: launch.id, title: 'Print the flyers', due_date: tomorrow.toISOString() }),
    {
      ...task({ title: 'Hang the bunting' }),
      id: 'pending-specimen-1',
      pending: true,
      parent: launch.id,
      position: 2.5,
      entry: 'specimen-sub',
      index: 0,
    },
    kid(771, { under: staff.id, title: 'Book the back room', due_date: at(30 * HOUR) }),
    kid(782, {
      under: closing2.id,
      project_id: 2,
      title: 'Stack the chairs',
      related_tasks: { parenttask: [{ id: closing2.id }], copiedfrom: [{ id: 6 }] },
    }),
    kid(783, {
      under: closing2.id,
      project_id: 2,
      title: 'Lock the door',
      related_tasks: { parenttask: [{ id: closing2.id }], copiedfrom: [{ id: 7 }] },
    }),
  ];
  const project = {
    list: [plain, launch, staff, closing2, ...projectSubs],
    heads: [staff.id],
    positions: {
      [launch.id]: 10,
      [plain.id]: 20,
      [staff.id]: 30,
      [closing2.id]: 40,
      761: 1,
      763: 2,
      764: 3,
      765: 1,
      771: 1,
    },
  };
  /* A parent's ring on Today's cards, in these states: one subtask of four at 50%, so 13%. Two of four done, so 50%.
     None of three done. Every subtask done, waiting for Close. Closed by the ring, which leaves a gap with Undo. A
     header swiped right part way, which springs back because a parent has no progress of its own. A header swiped left
     onto its Delete. */
  const wall = task({
    title: 'Paint the back wall',
    related_tasks: { subtask: [{ id: 1101 }, { id: 1102 }, { id: 1103 }, { id: 1104 }] },
  });
  const menu = task({
    title: 'Print the new menus',
    priority: 2,
    related_tasks: { subtask: [{ id: 1111, done: true }, { id: 1112, done: true }, { id: 1113 }, { id: 1114 }] },
  });
  const rota = task({
    title: 'Write the summer rota',
    related_tasks: { subtask: [{ id: 1121 }, { id: 1122 }, { id: 1123 }] },
  });
  const till = task({
    title: 'Set up the new till',
    related_tasks: {
      subtask: [
        { id: 1131, done: true },
        { id: 1132, done: true },
        { id: 1133, done: true },
      ],
    },
  });
  const bins = task({
    title: 'Empty the bins',
    related_tasks: {
      subtask: [
        { id: 1141, done: true },
        { id: 1142, done: true },
      ],
    },
    state: { swept: true },
  });
  const floor = task({
    title: 'Mop the floor',
    related_tasks: { subtask: [{ id: 1151 }, { id: 1152 }] },
    state: { head: 0.3 },
  });
  const sink = task({
    title: 'Fix the sink',
    related_tasks: { subtask: [{ id: 1161 }, { id: 1162 }] },
    state: { head: 'delete' },
  });
  const parentSubs = [
    kid(1101, { under: wall.id, title: 'Sand it', percent_done: 0.5 }),
    kid(1102, { under: wall.id, title: 'Tape the edges' }),
    kid(1103, { under: wall.id, title: 'First coat' }),
    kid(1104, { under: wall.id, title: 'Second coat' }),
    kid(1111, { under: menu.id, title: 'Write them', done: true }),
    kid(1112, { under: menu.id, title: 'Check the prices', done: true }),
    kid(1113, { under: menu.id, title: 'Send to the printer' }),
    kid(1114, { under: menu.id, title: 'Pick them up' }),
    kid(1121, { under: rota.id, title: 'Ask for holidays' }),
    kid(1122, { under: rota.id, title: 'Draft it' }),
    kid(1123, { under: rota.id, title: 'Post it' }),
    kid(1131, { under: till.id, title: 'Unbox it', done: true }),
    kid(1132, { under: till.id, title: 'Plug it in', done: true }),
    kid(1133, { under: till.id, title: 'Test a sale', done: true }),
    kid(1141, { under: bins.id, title: 'Kitchen', done: true }),
    kid(1142, { under: bins.id, title: 'Yard', done: true }),
    kid(1151, { under: floor.id, title: 'Sweep first' }),
    kid(1152, { under: floor.id, title: 'Mop' }),
    kid(1161, { under: sink.id, title: 'Buy a washer' }),
    kid(1162, { under: sink.id, title: 'Fit it' }),
  ];
  /* A task's sheet that starts with the task's row. The sheets are:
     - a task at 50% with notes and two photos, assigned to Jamie, with the rest of the sheet below it
     - a subtask with no notes or photos, with its parent in the path above
     - a parent with its ring at 13% (one subtask of four at 50%) and its subtasks below
     - the card's row swiped right from 25% to 50% and still held
     - a title tapped, which opens a box to edit it
     - notes tapped, where short notes sit in a box at its minimum height and long notes in a box as tall as the text
     - a done task
     `parts` lists which parts of the rest of the sheet are drawn under the card. */
  const photo = (id, name, size) => ({ id, file: { name, size } });
  const notes =
    '<p>Use the green from the shed: <strong>two coats</strong>, a day apart.</p><ul><li>Sand the old paint off first</li><li>Tape round the letterbox</li></ul>';
  const fence = task({
    title: 'Paint the side fence',
    related_tasks: {
      subtask: [
        task({
          id: 1201,
          title: 'Sand it',
          percent_done: 0.5,
          assignees: [me],
          related_tasks: { parenttask: [{ id: 1200 }] },
        }),
        task({ id: 1202, title: 'Tape the edges', assignees: [jamie], related_tasks: { parenttask: [{ id: 1200 }] } }),
        task({ id: 1203, title: 'First coat', due_date: dayAt(1, 0), related_tasks: { parenttask: [{ id: 1200 }] } }),
        task({ id: 1204, title: 'Second coat', related_tasks: { parenttask: [{ id: 1200 }] } }),
      ],
    },
    description: '<p>The side facing the car park.</p>',
  });
  fence.id = 1200;
  const gate = task({
    title: 'Fix the side gate',
    related_tasks: {
      subtask: [
        task({ id: 1301, title: 'Oil the hinges', percent_done: 0.5, related_tasks: { parenttask: [{ id: 1300 }] } }),
        task({ id: 1302, title: 'Tighten the latch', related_tasks: { parenttask: [{ id: 1300 }] } }),
        task({ id: 1303, title: 'Paint it', related_tasks: { parenttask: [{ id: 1300 }] } }),
      ],
    },
  });
  gate.id = 1300;
  const sheets = [
    {
      spec: 'A task’s sheet led by its row: at 50%, with notes and two photos, Jamie on it; under the card, what stays: Due and Reminders, Subtasks, Comments (stand-ins), and Details (a stand-in, but its Progress line, as the sheet has it)',
      parts: ['due', 'subtasks', 'comments', 'details'],
      task: task({
        title: 'Repaint the front door',
        percent_done: 0.5,
        due_date: dayAt(1, 9),
        priority: 2,
        assignees: [jamie],
        comment_count: 1,
        labels: [label(1, 'Front', 'e07a5f')],
        description: notes,
        attachments: [photo(1, 'door-before.jpg', 2.4e6), photo(2, 'paint-tin-label.jpg', 1.1e6)],
      }),
    },
    {
      spec: 'A subtask’s sheet with no notes or photos: its parent in the path over the card; the card is its row, “Add notes”, and “Add a photo or file”',
      parts: [],
      task: task({
        title: 'Buy masking tape',
        related_tasks: { parenttask: [{ id: 1200, title: 'Paint the side fence' }] },
      }),
    },
    {
      spec: 'A parent’s sheet: its ring for a tick (one subtask of four at 50%, so 13%), and its subtasks below, the real rows; no Progress line in Details, as its progress is worked out',
      parts: ['subtasks', 'details'],
      task: fence,
    },
    {
      spec: 'The card’s row swiped right from 25%, still held at 50%: only the row moves; its notes and photo stay',
      parts: [],
      state: { reveal: 0.22 },
      task: task({
        title: 'Restock the napkins',
        percent_done: 0.25,
        assignees: [me],
        description: '<p>The big packs, from the cash and carry.</p>',
        attachments: [photo(3, 'shelf.jpg', 0.9e6)],
      }),
    },
    {
      spec: 'A parent’s sheet with its subtasks swiped, still held: the first right from 50% to 75%, the last left onto its Delete; what each uncovers lies under its row, inside the card’s rounded corners',
      parts: ['subtasks'],
      subSwipes: { 1301: { reveal: 0.3 }, 1303: { swiped: true } },
      task: gate,
    },
    {
      spec: 'Its title tapped: a box to change it in, in the row’s place, saved once it’s left',
      parts: [],
      titleEdit: true,
      title: 'Restock the napkins and the straws',
      task: task({ title: 'Restock the napkins', due_date: dayAt(1, 0), description: '<p>The big packs.</p>' }),
    },
    {
      spec: 'Its notes tapped, short ones: the box to change them in keeps its least height, with Cancel and Save notes under it',
      parts: [],
      editingDesc: true,
      descDraft: 'The big packs.',
      task: task({ title: 'Restock the napkins', description: '<p>The big packs.</p>' }),
    },
    {
      spec: 'Long notes being changed: the box is as tall as its text, so they scroll with the sheet, never inside the box',
      parts: [],
      editingDesc: true,
      descDraft: [
        'Closing the café, in order:',
        '',
        ...[
          'Last orders at half past four',
          'Empty and wipe the coffee machine',
          'Cakes into the fridge, labelled with today’s date',
          'Stack the chairs, sweep, then mop',
          'Bins out to the yard: glass on Tuesdays only',
          'Count the till and write it in the book',
          'Lights, heating, alarm, then both locks',
        ].map((line, i) => `${i + 1}. ${line}`),
        '',
        'If the alarm won’t set, the back door isn’t shut: push it until it clicks.',
      ].join('\n'),
      task: task({ title: 'Close up', due_date: dayAt(0, 17), description: '<p>Closing the café, in order:</p>' }),
    },
    {
      spec: 'A done task: its row as a done row in a list; Details’ Progress line has no quarter pressed',
      parts: ['details'],
      task: task({
        title: 'Clean the grinder',
        done: true,
        percent_done: 0.5,
        due_date: dayAt(-1, 17),
        description: '<p>Burrs out, brush, then rice through it.</p>',
        attachments: [photo(4, 'burrs.jpg', 1.6e6)],
      }),
    },
  ];
  /* A task held on Today, with four date chips around the touch (app/throw.js). Each still is a small Today screen 360px
     wide (390px with `wide`), showing a hold on a fixed day (`now`). `held` is the row being held, at index `row`
     among the screen's rows (the third unless given). `x` is where the touch is held, measured from the screen's left.
     `to` is the date the touch has dragged towards, which is highlighted. `why` is the reason a task can't be moved by
     a hold. `card` means the task is held by its card header. `open` means the touch was released without moving, so
     the date chips stay open to tap. */
  const on = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);
  const others = () => [
    task({ title: 'Fix the other fridge', due_date: dayAt(-1, 15), assignees: [me] }),
    task({ title: 'Count the stock', percent_done: 0.25, assignees: [me] }),
    task({ title: 'Order the cups', due_date: dayAt(1, 0), priority: 2 }),
    task({ title: 'Book the window cleaner', due_date: dayAt(3, 0) }),
    task({ title: 'Collect the new aprons', due_date: dayAt(5, 11) }),
  ];
  const ring = (spec, now, held, more = {}) => {
    const rows = others();
    rows.splice(more.row ?? 2, 0, held);
    return { spec, now, held, rows, x: 180, ...more };
  };
  const milk = () => task({ title: 'Pay the milk invoice', due_date: on(8, 9).toISOString(), priority: 4 });
  const heldCard = task({
    title: 'Set up the hall',
    due_date: on(9, 15).toISOString(),
    related_tasks: { subtask: [{ id: 761 }, { id: 762 }] },
  });
  const ringSubs = [
    kid(761, { under: heldCard.id, title: 'Put out the chairs' }),
    kid(762, { under: heldCard.id, title: 'Test the microphone' }),
  ];
  const rings = [
    ring(
      'Held mid-screen, on a Friday, an overdue row: it lifts where it is, with its outline, and nothing covers the screen. Today at the left, Tomorrow at the right, Next week (Monday) above and No date, dashed, below, over the rows next to it. The dot is the finger',
      on(9),
      milk(),
    ),
    ring(
      'The first row, held near its right end: the whole set moves down and left onto the screen, and the directions still count from the finger',
      on(9),
      milk(),
      { row: 0, x: 310 },
    ),
    ring('The last row, held near its left end: the whole set moves up and right', on(9), milk(), { row: 5, x: 44 }),
    ring('The finger gone right, past 24px: Tomorrow lit', on(9), milk(), { to: 'tomorrow' }),
    ring('The finger gone down, the same short way: No date lit, still dashed', on(9), milk(), { to: 'none' }),
    ring(
      'On a 390px screen, due later today: Today dimmed, never moved or hidden; the finger gone up, Next week lit',
      on(9),
      task({ title: 'Post next week’s rota', due_date: on(9, 16, 30).toISOString() }),
      { to: 'week', wide: true, x: 250 },
    ),
    ring('A Sunday: next Monday is tomorrow, so up and right show the same day', on(11), milk()),
    ring(
      'A repeating task: every date dimmed, and the line saying why over them',
      on(9),
      task({ title: 'Water the plants', due_date: on(9).toISOString(), repeat_after: 86400 }),
      { why: 'repeats' },
    ),
    ring(
      'Let go without a move: the four stay open, to tap, where they were, with Pick a date… in the middle, where the finger was, the screen behind dimmed very lightly; a tap anywhere else closes them',
      on(9),
      milk(),
      { open: true },
    ),
    ring(
      'A repeating task’s, open to tap: still dimmed, Pick a date… too, with its line',
      on(9),
      task({ title: 'Water the plants', due_date: on(9).toISOString(), repeat_after: 86400 }),
      { why: 'repeats', open: true },
    ),
    ring('A card held by its header: the card lifts whole, and only its task’s date moves', on(9), heldCard, {
      card: true,
      row: 1,
    }),
    // The same cases on a 390px screen: the first row, the last row, and chips open to tap.
    ring('On a 390px screen, the first row held near its right end', on(9), milk(), { row: 0, x: 340, wide: true }),
    ring(
      'On a 390px screen, the last row held near its left end, the finger gone down: No date lit, though the set moved up',
      on(9),
      milk(),
      { row: 5, x: 44, to: 'none', wide: true },
    ),
    ring('On a 390px screen, open to tap, held right of the middle', on(9), milk(), { open: true, x: 230, wide: true }),
  ];
  return {
    parent,
    steps: runSteps(),
    sheets,
    rings,
    cards: [
      van2,
      task({ title: 'Fix the other fridge', due_date: at(-20 * HOUR), assignees: [me] }),
      task({ title: 'Count the stock', percent_done: 0.25, assignees: [me] }),
      opening,
      task({ title: 'Order the milk', priority: 2 }),
      closing,
      sign,
      shelves,
      fridges,
      tasting,
    ],
    cardSubs: [...cardSubs, ...ringSubs],
    parents: [wall, menu, rota, till, bins, floor, sink],
    parentSubs,
    project,
    list: [
      {
        title: 'Today, on one line, priority as bars before the time: high, low, urgent, medium, none, do now',
        depth: {},
        line: true,
        delete: true,
        tasks: today,
      },
      // Under the Today heading (the group's key). A task due today with no time shows no time, and one with a time shows the time.
      {
        title: 'Under the Today heading: due today with no time shows no time (“Today” elsewhere)',
        key: 'today',
        depth: {},
        line: true,
        tasks: [
          task({ title: 'Order the cups', due_date: dayAt(0, 0), priority: 2 }),
          task({ title: 'Post next week’s rota', due_date: dayAt(0, 16, 30) }),
        ],
      },
      // A project only the user can see (seenBy 0). Rows show no "+ me" and no picture of the user. A task assigned to someone in a shared project before it was moved here still shows that person.
      {
        title:
          'A project only you can see: no “+ me”, nor your picture; someone given it elsewhere, before it was moved there, still shows',
        depth: {},
        tasks: [
          task({ title: 'Renew the car insurance', project_id: 5 }),
          task({ title: 'Book the dentist', project_id: 5, assignees: [me] }),
          task({ title: 'Fix the shed door', project_id: 5, assignees: [jamie] }),
        ],
      },
      {
        title: 'Open, done, and waiting to send',
        depth: {},
        tasks: [
          task({ title: 'Order oat milk' }),
          task({ title: 'Wipe the counters', done: true }),
          {
            ...task({ title: 'Call the plumber tomorrow' }),
            id: 'pending-specimen-0',
            pending: true,
            waits: true,
            entry: 'specimen',
            index: 0,
          },
        ],
      },
      // Progress is drawn in the tick, a quarter at a time, with no line under the row.
      {
        title: 'Progress in the tick, a quarter at a time: none, 25%, 50%, 75%, done; and 30%, set on the web',
        depth: {},
        tasks: [
          task({ title: 'Order oat milk' }),
          task({ title: 'Repaint the sign', percent_done: 0.25 }),
          task({ title: 'Train the new barista', percent_done: 0.5 }),
          task({ title: 'Deep clean the fridge', percent_done: 0.75 }),
          task({ title: 'Wipe the counters', done: true, percent_done: 0.5 }),
          task({ title: 'Fix the till drawer', percent_done: 0.3 }),
        ],
      },
      {
        title: 'Subtasks, at depth 1 to 3',
        depth: { [top.id]: 0, [d1.id]: 1, [d2.id]: 2, [d3.id]: 3 },
        tasks: [top, d1, d2, d3],
      },
      {
        title: 'Due, priority, labels, people, comments',
        depth: {},
        tasks: [
          task({ title: 'Pay the milk invoice', due_date: at(-26 * HOUR), priority: 4 }),
          task({
            title: 'Prep the specials board',
            due_date: at(2 * HOUR),
            labels: [label(1, 'Front', 'e07a5f'), label(2, 'Daily', '3d85c6')],
          }),
          task({
            title: 'Check the fridge temperatures',
            due_date: at(50 * HOUR),
            assignees: [me, jamie],
            comment_count: 3,
            repeat_after: 86400,
          }),
          task({
            title: 'Book the window cleaner',
            project_id: 4,
            priority: 2,
            attachments: [{ id: 1 }],
            reminders: [{ reminder: at(5 * HOUR) }],
            assignees: [sam],
          }),
        ],
      },
      {
        title: 'A done task over its subtasks still open',
        depth: { [party.id]: 0, [cake.id]: 1, [room.id]: 1 },
        heads: [party.id],
        tasks: [party, cake, room],
      },
      {
        title:
          'Checklist runs, as under Checklists, on a project’s list and in search: one row, its ring for a tick, its steps done of all inside it (past 12 steps too), who it’s for as pictures in its slot, no line under it',
        depth: {},
        tasks: [run, long],
      },
      {
        title:
          'A run’s step counting down, with no 🔔 for the reminder Pocket gave it; a task’s reminder still to come has one',
        depth: {},
        tasks: [timed, task({ title: 'Call the plumber', reminders: [{ reminder: at(5 * HOUR) }] })],
      },
      {
        title: 'A checklist’s step has a square box (a step you’ve claimed, on Today), a task or a subtask a round one',
        depth: {},
        tasks: [stepRow, subRow],
      },
      {
        title: 'Read only: a project shared with you to read',
        depth: {},
        tasks: [task({ title: 'Quarterly stock count', project_id: 3 })],
      },
      // Swipes that are still held (progress.js: swipeAt, revealOf). The row's content moves by `reveal` times its width,
      // and the space it uncovers shows what releasing there would do. Some rows are swiped to their Delete (only a
      // project's list has one, set by `delete`). Another row shows a message in place of the row (lines.js). `state`
      // sets each of these.
      {
        title:
          'Swiped right, still held: the ring in the space uncovered says what letting go sets, 25%, 50%, 75%, and past half the row, done; the row itself unchanged',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Restock the napkins', state: { reveal: 0.15 } }),
          task({ title: 'Restock the napkins', state: { reveal: 0.27 } }),
          task({ title: 'Restock the napkins', state: { reveal: 0.4 } }),
          task({ title: 'Clean the grinder', percent_done: 0.75, state: { reveal: 0.55 } }),
        ],
      },
      {
        title:
          'Let go past half: done, the row carrying on off to the right, leaving a gap with Done and Undo until the batch clears',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Clean the grinder', state: { sweepRight: 0.8 } }),
          task({ title: 'Clean the grinder', done: true, state: { swept: true } }),
        ],
      },
      {
        title:
          'Swiped left from 75%, still held: the ring empties to 50% and 25%, and stops at 0% however far it’s pulled, with no Delete; let go, its progress is set and the row springs back',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Order more cups', percent_done: 0.75, state: { reveal: -0.2 } }),
          task({ title: 'Order more cups', percent_done: 0.75, state: { reveal: -0.38 } }),
          task({ title: 'Order more cups', percent_done: 0.75, state: { reveal: -0.7 } }),
        ],
      },
      {
        title:
          'Then, at 0%, a second swipe left: its Delete, a light red while it’s held; let go there, the row rests open on its button, solid red; and held past half the row, solid red, its word where it was: let go there, it’s deleted',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Order more cups', state: { swiped: true } }),
          task({ title: 'Order more cups', state: { swiped: true, rest: true } }),
          task({ title: 'Return the crates', state: { full: true } }),
        ],
      },
      {
        title: 'A done row swiped left: the ring a done tick, then 75% (open again), on down to 0%',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Sweep the yard', done: true, state: { reveal: -0.09 } }),
          task({ title: 'Sweep the yard', done: true, state: { reveal: -0.15 } }),
        ],
      },
      {
        title: 'A full swipe left, or Delete tapped: the row carries on off the screen, leaving a gap with Restore',
        depth: {},
        delete: true,
        tasks: [
          task({ title: 'Wipe the menus', state: { sweep: 0.8 } }),
          task({ title: 'Wipe the menus', state: { leaving: 'deleted' } }),
        ],
      },
      // Ticked and deleted rows stay in place until the batch clears (leaving.js). Shown here are a parent with its subtask
      // closed along with it, the gap a deleted row leaves with Restore, and a ticked repeating task. Then comes the batch
      // clearing, with its rows partway folded.
      {
        title:
          'Ticked and deleted, in place: a parent with its subtask, a deleted row’s gap with Restore, a repeating task',
        depth: { [mover.id]: 0, [moverKid.id]: 1 },
        tasks: [
          mover,
          moverKid,
          task({
            title: 'Return the crates',
            due_date: at(4 * HOUR),
            assignees: [jamie],
            state: { leaving: 'deleted' },
          }),
          task({
            title: 'Water the plants',
            done: true,
            due_date: at(-HOUR),
            repeat_after: 86400,
            state: { leaving: 'done' },
          }),
          task({ title: 'Order oat milk' }),
        ],
      },
      {
        title: 'The batch clearing: the rows ticked and deleted fold together, and the row below closes up once',
        depth: {},
        tasks: [
          task({ title: 'Sweep the yard', done: true, state: { leaving: 'done', folding: 0.45 } }),
          task({ title: 'Wipe the menus', state: { leaving: 'deleted', folding: 0.45 } }),
          task({ title: 'Light the heaters' }),
        ],
      },
      // Releasing a swipe on a task nobody is doing makes it yours, because the swipe set its progress (claimOnSlide).
      {
        title: "Let go at 25% on a task no one was doing: it's yours, its tick a quarter",
        depth: {},
        tasks: [task({ title: 'Restock the napkins', percent_done: 0.25, state: { claim: true } })],
      },
      {
        title:
          "A subtask swiped from 50% to 75%, and one done by a full swipe: what's uncovered, and the gap, span the whole row, not from its indent",
        delete: true,
        depth: { [tent.id]: 0, [pegs.id]: 1, [poles.id]: 1 },
        tasks: [tent, pegs, poles],
      },
      {
        title: "A line in a row's place: a tick not saved",
        depth: {},
        tasks: [
          task({
            title: 'Call the plumber',
            state: {
              line: {
                text: 'Not saved: no connection',
                title: '',
                stays: true,
                cls: 'failed',
                action: { label: 'Try again', fn() {} },
              },
            },
          }),
        ],
      },
      // The task that the quick add box adds subtasks to (quickadd.js: the cursor) is highlighted. Shown for a task and for a subtask.
      {
        title: 'What the add box adds subtasks to, lit up: a task, and a subtask',
        depth: { [van.id]: 0, [load.id]: 1 },
        tasks: [hall, van, load],
      },
      // The highlight follows the most recently added subtask. Here it is shown while that subtask waits to be sent (an
      // earlier waiting subtask is not highlighted), before the subtask looks like it is waiting, and just after it is
      // sent, when its flash fades to the highlight colour.
      {
        title:
          'A subtask just added from the add box is the lit row, its task dark: waiting to send, after one that waits unlit; not yet looking it; and just sent',
        depth: { [crates.id]: 0, ...Object.fromEntries(added.map(t => [t.id, 1])) },
        tasks: [crates, ...added],
      },
      // A row held and dragged down (progress.js: dragOf). It follows the touch together with its subtask, and the row it
      // has passed the middle of moves up to make space.
      {
        title: 'Held and moved down, with its subtask, past the row below',
        depth: { [tables.id]: 0, [chairs.id]: 1 },
        tasks: [
          task({ title: 'Sweep the yard' }),
          tables,
          chairs,
          task({ title: 'Light the heaters', state: { shift: -148 } }),
        ],
      },
      // A project's done tasks, in a section under the open tasks, with the most recently done first.
      {
        title: 'A project’s done tasks, folded, then open',
        depth: {},
        fold: true,
        tasks: [task({ title: 'Order the milk', done: true }), task({ title: 'Clean the grinder', done: true })],
      },
      // Only the latest 100 done tasks are shown (here, the last two of them), followed by a row for loading more tasks
      // that were done earlier. One case has 2,900 left, and the other has fewer than 100 left.
      {
        title: 'A project’s Done with 3,000: its latest 100 shown (the last two here), and the row for 100 more',
        key: 'more-many',
        depth: {},
        count: 3000,
        more: moreDone(2900, 100),
        tasks: [
          task({ title: 'Restock the price labels', done: true }),
          task({ title: 'Pack invoice #2,892', done: true }),
        ],
      },
      {
        title: 'A project’s Done with 112: the row for the last 12',
        key: 'more-last',
        depth: {},
        count: 112,
        more: moreDone(12, 100),
        tasks: [task({ title: 'Sweep the yard', done: true }), task({ title: 'Fix the till roll', done: true })],
      },
      // A row highlighted when its due time passes and it moves to Overdue (alerts.js), and a row highlighted when it is just added. The page holds both animations at their start.
      {
        title: 'Just come due, and just added',
        depth: {},
        tasks: [
          task({ title: 'Collect the cake order', due_date: at(-60e3), state: { flash: 'due' } }),
          task({ title: 'Order more cups', state: { flash: 'fresh' } }),
        ],
      },
    ],
  };
}

/* A checklist's steps as Vikunja returns them. They cover: done by you, done by Jamie, skipped by Sam, a step assigned to
   you with notes, a step inserted and a step repeated while the checklist runs, progress, assigned people, and timed
   steps. The timed steps are one counting down from the step before it, one late, and one waiting on a step that isn't
   done. A step's title in the template (`tpl`) is the title of the template's step it was copied from. A step added
   while the checklist runs is marked in its notes, and a repeated one names its template step there too (plainStep). */
function runSteps() {
  const MIN = 6e4;
  const step = ({ tpl, added, ...f }) => {
    const id = ++n,
      was = tpl === undefined ? f.title : tpl;
    return {
      id,
      title: 'A step',
      done: false,
      done_at: ZERO,
      due_date: ZERO,
      updated: at(-HOUR),
      percent_done: 0,
      assignees: [],
      attachments: [],
      reactions: {},
      comments: [],
      ...f,
      description:
        (f.description || '') +
        (added ? '<p>pocket:added</p>' : '') +
        (added === 'Repeated' ? `<p>pocket:step ${was}</p>` : ''),
      related_tasks: { copiedfrom: added ? [] : [{ id: id + 5000, title: was }] },
    };
  };
  const doneBy = (u, mins) => ({ done: true, done_at: at(-mins * MIN), reactions: { '✅': [u] } });
  const note = (id, author, mins, text) => ({ id, author, created: at(-mins * MIN), comment: `<p>${text}</p>` });
  const list = [
    step({ title: 'Turn on the espresso machine', tpl: 'Turn on the espresso machine {#machine}', ...doneBy(me, 40) }),
    step({ title: 'Grind the beans', assignees: [jamie], ...doneBy(jamie, 30) }),
    step({
      title: 'Wipe the steam wand',
      done: true,
      done_at: at(-20 * MIN),
      reactions: { '⏭️': [sam] },
      comments: [note(1, sam, 19, 'Skipped: no milk yet')],
    }),
    step({
      title: 'Put the croissants in',
      tpl: 'Put the croissants in {#oven}',
      ...doneBy(me, 2),
      attachments: [
        { id: 41, file: { name: 'tray.jpg', size: 9e5 } },
        { id: 42, file: { name: 'oven.jpg', size: 8e5 } },
      ],
    }),
    step({
      title: 'Take the croissants out',
      tpl: 'Take the croissants out T#18m:oven',
      assignees: [me],
      comments: [note(2, jamie, 50, 'Use the top shelf')],
    }),
    step({ title: 'Check the milk', added: 'Inserted', tpl: null }),
    step({ title: 'Wipe the steam wand', added: 'Repeated' }),
    step({ title: 'Restock the cups', assignees: [jamie], percent_done: 0.5 }),
    step({ title: 'Unlock the door', tpl: 'Unlock the door T#30m:machine' }),
    step({ title: 'Sweep the floor', tpl: 'Sweep the floor T#10m' }), // waits for Unlock the door, as the checklist waits for step times
    step({
      title: 'Check the walk-in cooler',
      tpl: 'Check the walk-in cooler',
      description:
        '<p>Read the probe on the top shelf.</p><p>pocket:ask Temp: number °C 0..5</p>' +
        '<p>pocket:ask Seal intact: yes-no</p><p>pocket:ask Belt: choice Good | Worn | Replace</p><p>pocket:ask Shelf: choice Top | Second | Third | Fourth | Floor</p><p>pocket:ask Notes: text</p>',
    }),
    step({
      title: 'Check the freezer',
      tpl: 'Check the freezer',
      description: '<p>pocket:ask number °C -18..-15</p>',
      ...doneBy(me, 3),
      comments: [note(3, me, 3, '-17 °C</p><p>pocket:answer')],
    }),
    step({ title: 'Count the till', assignees: [jamie, sam] }),
  ];
  list[6].related_tasks = { copiedfrom: [{ id: list[2].id, title: list[2].title }] };
  return list;
}

/* State objects for the add boxes. Each is the x-data around the app's own markup (add-bar.html, list-box.html). It
   supplies what that markup reads, in place of the app component's values, so every state shows at once. The
   component's methods still work out the marks, chips and hint from the box object passed in here (box()). Each
   object is created afresh for its element, because Alpine stores its own properties on it, from the {spec, f} listed
   for that state.
   specBar is quick add's bar. `inset` seats it in a list, indented by that amount, as seatBox does. `place` shows only
   the dashed placeholder the bar leaves behind. `before` and `after` are the rows around it, in a list `g`.
   specFoot is the box at the end of a list. `fb` is what footBox() returns in the app (position under a row, hint
   text, Repeat). `time` is a step's time line under the box. `said` is the message about what was just done from the
   box. `end` is the last row nudged, with the box at the bottom already under it. */
// The row directly above a box seated among a list's rows.
const rowOver = box =>
  [...box.parentElement.querySelectorAll(':scope > .row')]
    .filter(r => r.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)
    .at(-1);
const blankBox = f => ({ text: '', caret: 0, focus: false, busy: false, ignore: {}, remind: false, ...f });
const specBar = (spec, f = {}) => ({
  spec,
  capW: 'cap',
  canLevel: false,
  boxOut: false,
  canIn: true,
  boxInList: false,
  capTarget: null,
  capPlaceholder: 'Add a task to Café',
  capHomeSays: 'Add a task to Café',
  boxBackLabel: 'Add a task to Café instead',
  capPhotos: [],
  attachmentsOn: true,
  said: null,
  inset: '',
  place: false,
  before: [],
  after: [],
  g: { depth: {} },
  ...f,
  capBox: blankBox(f.box),
  get cap() {
    return this.capBox;
  },
  box() {
    return this.capBox;
  },
  placeLines() {
    return this.said ? [this.said] : [];
  },
  // Seat the bar as seatBox does, and highlight the row above it, as the app highlights the cursor's row.
  init() {
    this.$nextTick(() => {
      const bar = this.$el.querySelector('#capture');
      if (bar && this.inset) {
        bar.classList.add('inline');
        bar.classList.toggle('out', this.boxOut);
        bar.style.paddingLeft = this.inset;
        rowOver(bar)?.classList.add('aimed');
      }
    });
  },
});
const specFoot = (spec, f = {}) => ({
  spec,
  where: f.g?.run ? 'run' : 'sheet',
  said: null,
  time: null,
  before: [],
  after: [],
  g: { depth: {}, sheet: true, delete: true, reorder: true },
  ...f,
  fb: {
    w: 'sub',
    id: 'd-subbox',
    in: 'd-subin',
    under: false,
    steps: false,
    can: false,
    repeat: null,
    says: 'Add subtasks, or paste a list',
    rest: 'Add subtasks, or paste a list',
    add: 'Add subtasks',
    home: 'Add after the last subtask instead',
    ...f.fb,
  },
  b: blankBox(f.box),
  footBox() {
    return this.fb;
  },
  box(w) {
    return (w === 'edit' && this.sheet.stepEdit) || this.b;
  },
  placeLines() {
    return this.said ? [this.said] : [];
  },
  // Stand-ins for a step's time line, and for a template's steps shown as rows with their numbers, when each is due, and the first line of its notes.
  draft() {
    return { info: new Map([['+', this.time]]) };
  },
  draftShown(d) {
    return d ? [d] : [];
  },
  stepEditDraft() {
    return this.time;
  },
  passFocus() {},
  stepNo(t) {
    return [...this.before, ...this.after].findIndex(x => x.id === t.id) + 1;
  },
  stepAt(t) {
    return this.stepNo(t) - 1;
  },
  stepShown(t) {
    return { title: t.title, text: t.when || '', problem: '' };
  },
  stepNote(t) {
    return t.note || '';
  },
  // Seat the box under a row as seatFoot does, and give that row the class that highlights it.
  init() {
    this.$nextTick(() => {
      const box = this.$el.querySelector('.foot-box');
      if (box && this.fb.under) {
        box.classList.add('inline');
        rowOver(box)?.classList.add('sub-boxed');
      }
      if (box && this.end) rowOver(box)?.classList.add('sub-boxed', 'at-end');
    });
  },
});
const specName = (spec, f = {}) => ({
  spec,
  bw: 'tname',
  b: blankBox(f.box),
  box() {
    return this.b;
  },
});

document.addEventListener('alpine:init', () => directives(Alpine));
document.addEventListener('alpine:init', () =>
  Alpine.data('specimen', () => {
    const c = pocket();
    c.specimenSheets = [];
    c.specimen = [];
    c.specimenCards = [];
    c.specimenEnds = [];
    c.specimenMoved = [];
    c.specimenParents = [];
    c.specimenComplete = [];
    c.specimenProject = { items: [] };
    c.specimenCarry = [];
    c.specimenRunCards = [];
    c.specimenRunTops = [];
    c.specimenAdding = { steps: [], at: null };
    c.specimenBars = [];
    c.specimenSeated = [];
    c.specimenFeet = [];
    c.specimenNames = [];
    // Messages, each in the place where the app shows it (lines.js: sayAt).
    const undo = { label: 'Undo', fn() {} };
    c.specimenLines = [
      { key: 1, place: 'overdue', text: 'Moved 6 to today', action: undo },
      { key: 2, place: 'cap', text: 'Added to Head office, due Friday', action: { label: 'Open', fn() {} } },
      {
        key: 3,
        place: 'sheet:top',
        text: 'Not saved: no connection',
        cls: 'failed',
        action: { label: 'Try again', fn() {} },
      },
      { key: 4, place: 'sheet:subtasks', text: 'Closed Deep clean + 3 subtasks', action: undo },
      { key: 5, place: 'step', text: 'Done: Take the croissants out', action: undo },
    ];
    // The row that loads more done tasks (more-row.html) reads the made-up numbers from its section.
    c.moreOf = function (key) {
      return (key && this.specimen.find(g => g.key === key)?.more) || null;
    };
    // Replaces signing in and loading with the user, their projects, what the user can change in each project, and the tasks.
    c.init = function () {
      setApp(this);
      const s = sections(),
        subs = s.parent.related_tasks.subtask;
      // How many people can see each project besides the user (loadPeople). All are shared except the last, which only the user can see.
      Object.assign(this, {
        signedIn: true,
        screen: 'app',
        user: me,
        route: { name: 'today' },
        perms: { 1: 2, 2: 2, 3: 0, 4: 1, 5: 2 },
        seenBy: { 1: 2, 2: 2, 3: 4, 4: 1, 5: 0 },
        avatars: Object.fromEntries([me, jamie, sam].map(u => [u.username, { url: '', at: Date.now() }])),
        labelsLoaded: true,
      });
      this.setProjects(projects);
      // A task's sheet open on a task with subtasks, so the subtask rows can show who is doing each.
      this.row(s.parent);
      this.sheet = { ...blankSheet('task'), id: s.parent.id };
      // A checklist's screen open on its fifth step, with a tick on the last step waiting to be sent. The steps use the
      // task row too (g.run), each as the screen works it out (runView).
      const run = {
        id: ++n,
        title: 'Opening up · Oct 7',
        done: false,
        project_id: 2,
        assignees: [me, jamie],
        created_by: me,
        comments: [],
        description: '<p>pocket:run</p><p>pocket:wait</p>',
        related_tasks: { copiedfrom: [{ id: 900 }], subtask: s.steps.map(x => ({ id: x.id, title: x.title })) },
      };
      this.pending = [
        {
          kind: 'act',
          id: 'specimen-tick',
          run: run.id,
          task: s.steps.at(-1).id,
          op: 'done',
          user: me.id,
          who: me,
          at: new Date().toISOString(),
          items: [],
        },
      ];
      this.slow = ['specimen-tick'];
      // The screen holds ids and reads the checklist and its steps from tasks. The tick shows on its step through its op.
      for (const t of [run, ...s.steps]) this.row(t);
      this.change(w => w.keyOps());
      const screen = (steps, at) => {
        this.view.shownRun = { id: run.id, steps: steps.map(x => x.id), at, last: null };
        return this.runView;
      };
      this.tasks[run.id].done = true;
      const finished = screen(s.steps, null).steps;
      this.tasks[run.id].done = false;
      // The step card for three steps: one of yours counting down, one Jamie is on that is half done, and one done by
      // Jamie (tapped in the list). Each is the runView value at that point, used to draw step-card.html.
      // Then a step that asks to record five things, two typed in and not yet sent, the temperature outside its range, and
      // a done step whose one answer was sent.
      const [cooler, freezer] = s.steps.filter(x => /^Check the (walk-in|freezer)/.test(x.title));
      Object.assign(this.runDrafts, { [cooler.id + ':temp']: '7.5', [cooler.id + ':seal intact']: 'Yes' });
      this.specimenRunCards = [7, 1, 4, s.steps.indexOf(cooler), s.steps.indexOf(freezer)].map(at =>
        screen(s.steps, at),
      );
      // A photo added to the first of those steps and still uploading. The card shows a line for it, with a × that cancels the upload.
      this.pending.push({
        id: 'specimen-photo',
        taskId: s.steps[7].id,
        at: new Date().toISOString(),
        items: [],
        files: [{ key: 'specimen-photo-1', name: 'oven-dial.jpg', type: 'image/jpeg', size: 48213 }],
      });
      const steps = this.runView.steps;
      steps[7] = { ...steps[7], state: { reveal: 0.4 } };
      steps[5] = { ...steps[5], state: { swiped: true } }; // inserted while the checklist runs, so it has a Delete
      /* Steps added from the box under a checklist's steps, one after another, after the step on the card. Two are sent
       and the third is waiting to be sent. */
      const mk = title => ({ ...s.steps[5], id: ++n, title, comments: [], assignees: [] });
      const inRow = [...s.steps.slice(0, 5), mk('Fill the water jug'), mk('Wipe the counter'), ...s.steps.slice(5)];
      this.pending.push({
        kind: 'act',
        op: 'addStep',
        id: 'specimen-step',
        task: run.id,
        run: run.id,
        title: 'Stack the trays',
        before: s.steps[5].id,
        after: inRow[6].id,
        at: new Date().toISOString(),
        tpl: null,
        from: null,
        items: [],
        files: [],
      });
      this.slow.push('specimen-step');
      for (const t of inRow) this.row(t);
      screen(inRow, 4);
      // These run from the step before the card's step to the checklist's next steps. They get different ids, so the states above apply only to their own rows.
      this.specimenAdding = {
        steps: this.runView.steps.slice(3, 10).map(x => (x.pending ? x : { ...x, id: x.id + 2000 })),
        at: 4,
      };
      /* The top of a checklist's screen (app.html). The checklist's own row sits between Back and ⋯ (RUN_ROW). Its ring
       is the screen's ring (runRing, for the checklist above). The assignee slot shows who the checklist is for. The
       cases are: you, you and Jamie, and a project only you can see, which has no slot. */
      const top = plainRun(this.runTask);
      this.specimenRunTops = [
        { spec: 'For you', run: { ...top, id: ++n, assignees: [me] } },
        {
          spec: 'Swiped right part way, still held (it springs back, as a parent’s header does): what it uncovers stays between Back and ⋯',
          run: { ...top, id: ++n, assignees: [me] },
          reveal: 0.3,
        },
        {
          spec: 'For you and Jamie, with a name on two lines',
          run: { ...top, id: ++n, title: 'Opening up · Oct 7 · Front counter and the till' },
        },
        { spec: 'On a project only you can see: no slot', run: { ...top, id: ++n, project_id: 5, assignees: [me] } },
      ];
      // Today's cards. Their subtasks are in the store. The van's card and the last card are open.
      for (const x of s.cardSubs) this.row(x);
      this.specimenCards = s.cards.map(t => this.row(t));
      this.view.cards = Object.fromEntries(s.cards.map(t => [t.id, { when: null, made: null, focus: null }]));
      this.cardOpen = { [s.cards[0].id]: true, [s.cards.at(-1).id]: true };
      // A screen's headings, each under the end of the list before it. The lists end with a collapsed card's tab, an
      // opened card's ⌃, a card with no footer, or a row.
      const [van, , , opening, milk, , sign] = this.specimenCards;
      this.specimenEnds = [[milk, opening], [van], [sign], [milk], []];
      // A row moved to tomorrow leaves a gap between the rows that were around it (leaveGap, actions.js).
      const plumber = task({ title: 'Call the plumber' });
      this.specimenMoved = [
        this.row(task({ title: 'Order oat milk', due_date: at(2 * HOUR) })),
        { id: 'moved-specimen', gapOf: plumber.id, title: plumber.title, text: movedGap('Tomorrow') },
        this.row(task({ title: 'Light the heaters', due_date: at(3 * HOUR) })),
      ];
      // The parents' rings on Today's cards, and the question the ring asks (sheet/complete.html), for a task and for a checklist.
      for (const x of s.parentSubs) this.row(x);
      this.specimenParents = s.parents.map(t => this.row(t));
      Object.assign(
        this.view.cards,
        Object.fromEntries(s.parents.map(t => [t.id, { when: null, made: null, focus: null }])),
      );
      // Each question has its sentence (completeAsk). The first is a task with 3 open subtasks. The second is a task with 5,
      // one of them repeating, which stays open and isn't named. The third is a checklist with 2 steps not done.
      const ask = (title, run, open) => {
        const names = open.filter(o => !o.stays).map(o => o.title),
          stay = open.length - names.length;
        return {
          kind: 'complete',
          complete: {
            id: 0,
            run,
            title,
            n: run ? open.length : names.length,
            stay,
            open: open.map((o, i) => ({ id: i + 1, ...o })),
            ask: completeAsk({ title, run, names, stay }),
          },
        };
      };
      const titles = (...xs) => xs.map(title => (typeof title === 'string' ? { title } : title));
      this.specimenComplete = [
        ask(s.parents[2].title, false, titles('Ask for holidays', 'Draft it', 'Post it')),
        ask(
          s.parents[0].title,
          false,
          titles('Sand it', 'Tape the edges', 'First coat', 'Second coat', { title: 'Water the plants', stays: true }),
        ),
        ask('Closing up', true, titles('Stack the chairs', 'Lock the door')),
      ];
      // A task's sheet that starts with the task's row. Each sheet is separate, as the app's is for one task.
      for (const x of s.sheets.flatMap(sh => sh.task.related_tasks.subtask || [])) this.row(x);
      this.specimenSheets = s.sheets.map(sh => ({
        ...blankSheet('task'),
        ...sh,
        id: sh.task.id,
        task: this.row(sh.task),
      }));
      // A task held on Today. Each still gets its rows as Today has them (screenRows('today')), including the held one.
      Object.assign(
        this.view.cards,
        Object.fromEntries(s.rings.filter(r => r.card).map(r => [r.held.id, { when: null, made: null, focus: null }])),
      );
      this.specimenRings = s.rings.map((r, i) => ({
        ...r,
        id: i,
        g: {
          key: 'today',
          cards: 'today',
          line: true,
          depth: {},
          delete: true,
          reschedule: true,
          items: r.rows.map(t => this.row(t)),
          tasks: r.rows,
        },
      }));
      // A project's open list, as listGroups makes it, with each subtask under its parent.
      Object.assign(this.positions, s.project.positions);
      const list = s.project.list.map(t => (t.pending ? t : this.row(t))),
        g = {
          key: 'open',
          cards: 'list',
          delete: true,
          reorder: true,
          heads: s.project.heads,
          ...nestSubtasks(list, positionOrder(this.positions), t => this.hasOwnOrder(t)),
        };
      this.specimenProject = { ...g, items: listItems(g.tasks, g.depth, t => !!this.cardOf(t, g)) };
      this.specimen = [
        ...s.list,
        {
          title: "In a task's sheet: its subtasks, with who's doing each",
          depth: {},
          sheet: true,
          delete: true,
          reorder: true,
          tasks: subs,
        },
        {
          title:
            "A run's steps on its screen: done by you, by Jamie, skipped, the step on its card (counting down), inserted (swiped to its Delete), repeated, swiped right to 75%, late, waiting on another step, and a tick waiting to send",
          depth: {},
          run: true,
          at: 4,
          locked: false,
          tasks: steps,
        },
        {
          title:
            'A run’s step done by a full swipe: a gap with Undo, which unticks it, until the batch clears; then done in its place',
          depth: {},
          run: true,
          at: null,
          locked: false,
          tasks: [{ ...steps[3], id: steps[3].id + 3000, state: { swept: true } }],
        },
        // (different ids, so the states above apply only to their own rows)
        {
          title: 'The same steps in a run finished, or shared with you to read only',
          depth: {},
          run: true,
          at: null,
          locked: true,
          tasks: finished.map(x => ({ ...x, id: x.id + 1000 })),
        },
      ];
      /* The add boxes, one entry per state. They are quick add's bar at the bottom, the bar seated in a project's list
       (one level in under a task, one level in under a subtask, one level out, and on Today), the box at the end of a
       list (for a task's subtasks, a template's steps and a checklist's steps), and New template's name. */
      const barBox = (spec, f = {}) => ({ spec, f }),
        footBox = barBox;
      const list3 = 'Buy milk\nBuy the oat milk too, for Jamie\nWipe the fridge shelves';
      this.specimenBars = [
        barBox('The add box, the bar at the bottom of Today and a project’s list: empty'),
        barBox('Focused and empty: what it reads, under it', { box: { focus: true } }),
        barBox('Typed, with what it read as chips, and marked in its words', {
          box: { text: 'Buy milk tomorrow !3 *front', focus: true },
        }),
        barBox('A pasted list: three lines, the button on the last', { box: { text: list3, focus: true } }),
        barBox('With a photo: the camera lit, the photo a chip', {
          capPhotos: [{ name: 'receipt.jpg' }],
          capPlaceholder: 'What’s this photo for?',
        }),
        barBox('Where what was just added went, over it', {
          said: { n: 1, place: 'cap', text: 'Added to Head office, due Friday', action: { label: 'Open', fn() {} } },
        }),
        barBox(
          'The place it leaves at the bottom while it’s in the list: dashed, at its height, saying what the box says there; a tap brings it back',
          { place: true, boxInList: true },
        ),
      ];
      const fuelT = task({ title: 'Buy fuel' }),
        vanT = task({ title: 'Pack the van' }),
        kidOf = title => task({ title, related_tasks: { parenttask: [{ id: vanT.id }] } });
      const tablesT = kidOf('Tables'),
        chairsT = kidOf('Chairs'),
        waterT = task({ title: 'Water the plants' }),
        inList = { depth: { [tablesT.id]: 1, [chairsT.id]: 1 }, delete: true, reorder: true };
      const seated = (spec, f) =>
        barBox(spec, { g: inList, boxInList: true, capW: 'under', capPlaceholder: 'Subtask', inset: '44px', ...f });
      this.specimenSeated = [
        seated(
          'Seated in a project’s list under a task, a level in, where its first subtask’s tick will be: ⇤ moves it out a level',
          { canLevel: true, before: [fuelT], after: [waterT] },
        ),
        seated('Under a subtask, at its level: a pasted list', {
          canLevel: true,
          before: [vanT, tablesT],
          after: [chairsT, waterT],
          box: { text: list3, focus: true },
        }),
        seated('Out a level, after the task and all under it: a task again, so the camera is back, and ⇥ moves it in', {
          canLevel: true,
          boxOut: true,
          capW: 'cap',
          capPlaceholder: 'Task',
          inset: '14px',
          before: [vanT, tablesT, chairsT],
          after: [waterT],
        }),
        seated('Out a level, typed', {
          canLevel: true,
          boxOut: true,
          capW: 'cap',
          capPlaceholder: 'Task',
          inset: '14px',
          before: [vanT, tablesT, chairsT],
          after: [waterT],
          box: { text: 'Strap it down tomorrow', focus: true },
        }),
        seated('On Today, which adds subtasks only: no ⇤', { before: [fuelT], after: [waterT] }),
      ];
      const tplStep = (title, when = '', note = '') => ({ ...task({ title, done: true }), when, note });
      const tplSteps = [
        tplStep('Turn on the espresso machine', 'Named “machine”'),
        tplStep('Put the croissants in', 'Named “oven”'),
        tplStep('Take the croissants out', 'Due 18m after “oven”', 'Top shelf first: it runs hot.'),
        tplStep('Unlock the door', 'Due 30m after “machine”'),
      ];
      const stepList = { depth: {}, sheet: true, delete: true, reorder: true, step: true };
      const stepFb = {
        w: 'add:+',
        steps: true,
        says: 'Add steps, or paste a list',
        rest: 'Add steps, or paste a list',
        add: 'Add steps',
        home: 'Add after the last step instead',
      };
      const runList = { depth: {}, run: true, at: this.specimenAdding.at, locked: false },
        runSteps = this.specimenAdding.steps;
      const runFb = {
        w: 'ins',
        id: 'run-box',
        in: 'run-in',
        says: 'Add steps, or paste a list',
        rest: 'Add steps, or paste a list',
        add: 'Add steps',
        home: 'Add after the last step instead',
        repeat: { title: runSteps.at(-1).title, can: true },
      };
      this.specimenFeet = [
        footBox('The box at the foot of a task’s subtasks, focused and empty: what it reads under it', {
          before: subs,
          box: { focus: true },
        }),
        footBox('Typed: what it read as chips', {
          before: subs,
          fb: { can: true },
          box: { text: 'Order the paint tomorrow !2', focus: true },
        }),
        footBox('A pasted list: its button on the last line', {
          before: subs,
          fb: { can: true },
          box: { text: list3, focus: true },
        }),
        footBox(
          'Under a row nudged, to add after it: its place at the foot is kept, dashed, saying what the box says there, and a tap there brings it back',
          { before: subs.slice(0, 1), after: subs.slice(1), fb: { under: true, says: 'Subtask' } },
        ),
        footBox(
          'A template’s steps (New template’s are the same list): plain numbers, when each is due, its notes’ first line, and the box at their foot',
          { g: stepList, before: tplSteps, fb: stepFb },
        ),
        footBox('A step being written with a time: its time line under the box, then its chips', {
          g: stepList,
          before: tplSteps,
          fb: { ...stepFb, can: true },
          box: { text: 'Lock up in 20 min !2', focus: true },
          time: {
            problem: '',
            offset: 12e5,
            i: 4,
            lost: false,
            from: '',
            choices: tplSteps.slice(0, 3).map((x, i) => ({ key: 'k' + i, title: x.title })),
            phrase: 'in 20 min',
            kept: false,
            name: '',
          },
        }),
        footBox('Under a step nudged', {
          g: stepList,
          before: tplSteps.slice(0, 2),
          after: tplSteps.slice(2),
          fb: { ...stepFb, under: true, says: 'Step' },
        }),
        footBox('A step tapped: quick add’s box in its words’ place, and its notes’ link', {
          g: stepList,
          before: tplSteps,
          fb: stepFb,
          chips() {
            return [];
          },
          sheet: {
            ...blankSheet('task'),
            id: s.parent.id,
            stepEdit: { id: tplSteps[1].id, text: tplSteps[1].title, caret: 0, focus: true, ignore: {} },
          },
        }),
        footBox(
          'A checklist’s steps on its screen: the box at their foot, with Repeat (the step above the box, again)',
          { g: runList, before: runSteps, fb: runFb },
        ),
        footBox('Typed there', {
          g: runList,
          before: runSteps.slice(-3),
          fb: { ...runFb, can: true },
          box: { text: 'Sweep outside !2', focus: true },
        }),
        footBox('Under a step nudged, which Repeat then copies. The step on the card keeps its bold title', {
          g: runList,
          before: runSteps.slice(0, 3),
          after: runSteps.slice(3),
          fb: { ...runFb, under: true, says: 'Step', repeat: { title: runSteps[2].title, can: true } },
        }),
        footBox('The last step nudged: highlighted, with the box at the foot already under it', {
          g: runList,
          before: runSteps.slice(-3),
          fb: runFb,
          end: true,
        }),
        footBox('What Repeat just did, said in the box; and Repeat off, for a step still waiting to be sent', {
          g: runList,
          before: runSteps.slice(-2),
          fb: { ...runFb, repeat: { title: 'Stack the trays', can: false } },
          said: { n: 2, place: 'cap', text: 'Repeated “Take the croissants out”', action: { label: 'Undo', fn() {} } },
        }),
      ];
      this.specimenNames = [
        barBox('New template’s name: quick add’s box with nothing beside it, empty'),
        barBox('Typed, focused, with its priority as a chip', { box: { text: 'Opening up !2', focus: true } }),
      ];
      // Apply the states that touch gestures cause to the rows, as the app does.
      const all = this.specimen.flatMap(g => g.tasks).filter(t => t.state);
      for (const t of all)
        if (t.state.line)
          this.lines[t.id] = {
            id: t.id,
            title: t.title,
            more: '',
            action: { label: 'Undo', fn() {} },
            ...t.state.line,
          };
      for (const t of all) if (t.state.leaving) this.leaving[t.id] = t.state.leaving;
      for (const t of all) if (t.state.swept) this.leaving[t.id] = 'done';
      for (const t of all) if (t.state.flash) this.flashed[t.state.flash][t.id] = true;
      for (const t of all) if (t.state.claim) this.slideClaim[t.id] = true;
      for (const t of s.parents)
        if (t.state?.swept) {
          t.done = true;
          this.leaving[t.id] = 'done';
        }
      // Show a row swiped left onto its Delete, moved `off` px aside. Releasing there does `to` (swipeOf, as a swipe uses it).
      const redUnder = (row, name, off, to) => {
        const s = swipeOf(row, () => {}, name);
        s.begin();
        s.move({ off, to });
      };
      this.$nextTick(() => {
        // A parent's header swiped. Part way right shows the empty ring, because the header springs back when released short of the full point. Left shows its Delete.
        for (const t of s.parents)
          for (const head of document.querySelectorAll(`.day-card[data-id="${t.id}"] > .card-head`)) {
            if (t.state?.head === 'delete') redUnder(head, t.title, -88, 'open');
            else if (t.state?.head) {
              const w = head.clientWidth;
              revealOf(head).move(
                swipeAt({ start: 0, dx: t.state.head * w, x: w / 2, width: w, screen: 1e4, one: true }),
              );
            }
          }
        /* A task held on Today (app/throw.js). The app's own code (throwTargets, throwLayout, chipsEl) draws the date
         chips for the task's due day around the point where the touch is held, at the height of the task's row (or a
         card's header), which lifts in place. A date is highlighted the way it is when the touch points at it
         (chipsLight), or the chips are left open to tap (chipsOpen). The dot is the touch. The hollow dot is where it
         was held, and the filled dot is where it has moved to. */
        for (const r of this.specimenRings)
          for (const frame of document.querySelectorAll(`[data-ring="${r.id}"]`)) {
            const held = frame.querySelector(`.item[data-id="${r.held.id}"] > :is(.row, .day-card)`),
              f = frame.getBoundingClientRect();
            const strip = (held.querySelector('.card-head') || held).getBoundingClientRect(),
              x = r.x,
              y = strip.top - f.top + strip.height / 2;
            const lay = throwLayout(throwTargets(r.held.due_date, r.now), {
              x,
              y,
              width: f.width,
              height: f.height,
              why: !!r.why,
            });
            const el = chipsEl(lay, r.why || null),
              p = lay.targets.find(t => t.id === r.to);
            held.classList.add('throw-from');
            frame.append(el);
            chipsLight(el, p);
            if (r.open) {
              chipsOpen(el, r.held.title);
              continue;
            }
            const dot = (cls, dx, dy) => {
              const d = document.createElement('i');
              d.className = cls;
              Object.assign(d.style, { left: x + dx + 'px', top: y + dy + 'px' });
              frame.append(d);
            };
            if (p) dot('spec-finger was', 0, 0);
            dot('spec-finger', p ? Math.sign(p.x) * 30 : 0, p ? Math.sign(p.y) * 30 : 0);
          }
        // A sheet's subtasks swiped and still held. The progress stops, or the Delete, are laid under the row inside the subtasks' card.
        for (const sh of this.specimenSheets)
          for (const [id, st] of Object.entries(sh.subSwipes || {}))
            for (const row of document.querySelectorAll(`.spec-task-sheet .row[data-id="${id}"]`)) {
              const w = row.clientWidth,
                sub = sh.task.related_tasks.subtask.find(x => x.id === +id);
              if (st.reveal)
                revealOf(row).move(
                  swipeAt({
                    start: Math.round((sub.percent_done || 0) * 100),
                    dx: st.reveal * w,
                    x: w / 2,
                    width: w,
                    screen: 1e4,
                  }),
                );
              if (st.swiped) redUnder(row, sub.title, -88, 'open');
            }
        // A checklist's own row at the top of its screen, swiped right part way and still held. It behaves like a parent's row, which has only the full point.
        for (const top of this.specimenRunTops)
          if (top.reveal)
            for (const row of document.querySelectorAll(`#run-own > .row[data-id="${top.run.id}"]`)) {
              const w = row.clientWidth;
              revealOf(row).move(swipeAt({ start: 0, dx: top.reveal * w, x: w / 2, width: w, screen: 1e4, one: true }));
            }
        // The sheet's own row swiped and still held, the same as a list's row below.
        for (const sh of this.specimenSheets)
          if (sh.state?.reveal)
            for (const row of document.querySelectorAll(`.task-card > .row[data-id="${sh.task.id}"]`)) {
              const w = row.clientWidth;
              revealOf(row).move(
                swipeAt({
                  start: Math.round(sh.task.percent_done * 100),
                  dx: sh.state.reveal * w,
                  x: w / 2,
                  width: w,
                  screen: 1e4,
                }),
              );
            }
        for (const t of all)
          for (const row of document.querySelectorAll(`.row[data-id="${t.id}"]`)) {
            // A swipe that is still held (progress.js: revealOf, swipeAt). A left swipe starts at the row's right edge and a right swipe at its middle, so the screen's edge doesn't cut the swipe short.
            if (t.state.reveal) {
              const w = row.clientWidth;
              revealOf(row).move(
                swipeAt({
                  start: t.done ? 100 : (t.pct ?? Math.round(t.percent_done * 100)),
                  dx: t.state.reveal * w,
                  x: t.state.reveal < 0 ? w : w / 2,
                  width: w,
                  screen: 1e4,
                }),
              );
            }
            if (t.state.sweepRight)
              revealOf(row).move({ off: row.clientWidth * t.state.sweepRight, pct: 100, to: 'done' });
            // The Delete (progress.js: swipeOf) laid under the row as the app lays it. The cases are resting open on its
            // button, dragged past half the row, and following through (sweep) partway off the screen with the red still under the row.
            if (t.state.swiped) redUnder(row, t.title, -88, 'open');
            if (t.state.rest) row.offsetParent.querySelector(':scope > .row-red').classList.add('open'); // the red layer just added is the first match
            if (t.state.full) redUnder(row, t.title, -240, 'delete');
            if (t.state.sweep) redUnder(row, t.title, -row.clientWidth * t.state.sweep, 'delete');
            if (t.state.drag) {
              row.classList.add('dragged', ...(t.state.with ? [] : ['held']));
              row.style.transform = `translateY(${t.state.drag}px)`;
              row.parentElement.classList.add('reordering');
            }
            if (t.state.shift) row.style.transform = `translateY(${t.state.shift}px)`;
            if (t.state.aimed) row.classList.add('aimed');
            // A row partway through leaving (leaving.js). Each row folds at once, and the rows below close up with them.
            if (t.state.folding) {
              const h = row.offsetHeight,
                f = t.state.folding;
              Object.assign(row.style, {
                overflow: 'hidden',
                minHeight: '0',
                height: h * f + 'px',
                opacity: f,
                paddingTop: 12 * f + 'px',
                paddingBottom: 12 * f + 'px',
              });
            }
          }
      });
    };
    c.loadPerms = () => {}; // there is no Vikunja to ask
    c.watchCard = () => {}; // an opened card stays open when it is off screen
    return c;
  }),
);
Object.assign(window, globals, { specBar, specFoot, specName });
