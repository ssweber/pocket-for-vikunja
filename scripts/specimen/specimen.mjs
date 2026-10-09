// The specimen page's code: Pocket's own Alpine component, as the app has it, given made-up tasks instead of signing in,
// so the task row can be seen in every state. Nothing here is sent anywhere: the rows can't be tapped (inert).
import {directives, globals, pocket} from '../../src/js/component.js';
import {setApp} from '../../src/js/util.js';
import {CHECKLIST_MARK} from '../../src/js/checklists.js';
import {blankSheet} from '../../src/js/app/core.js';
import {listItems, nestSubtasks} from '../../src/js/lists.js';
import {positionOrder} from '../../src/js/order.js';
import {revealOf} from '../../src/js/app/progress.js';
import {swipeAt} from '../../src/js/progress.js';
import {completeAsk, dayWord, movedTo, STAYS} from '../../src/js/messages.js';
import {dueInfo, startOfDay} from '../../src/js/dates.js';

const ZERO = '0001-01-01T00:00:00Z', HOUR = 36e5;
const at = ms => new Date(Date.now() + ms).toISOString();
const me = {id: 1, username: 'alex', name: 'Alex'}, priya = {id: 2, username: 'priya', name: 'Priya'}, sam = {id: 3, username: 'sam', name: ''};
const label = (id, title, hex_color) => ({id, title, hex_color});
let n = 100;
// A task as Vikunja gives it, with only what a row reads.
const task = fields => ({id: ++n, title: 'A task', done: false, priority: 0, due_date: ZERO, project_id: 1, labels: null, assignees: null, percent_done: 0,
  comment_count: 0, attachments: null, reminders: null, repeat_after: 0, repeat_mode: 0, description: '', related_tasks: {}, created_by: me, ...fields});

const projects = [{id: 1, title: 'Café', hex_color: '1d6b52'}, {id: 2, title: 'Checklists', hex_color: 'b8860b', description: `<p>${CHECKLIST_MARK}</p>`},
  {id: 3, title: 'Head office', hex_color: '6a5acd'}, {id: 4, title: 'Upkeep', hex_color: '3d85c6'}, {id: 5, title: 'My own', hex_color: 'c0504d'}];

// The sections of the page: each a list of rows, as `g` is to a row in the app (its depth under the task above it,
// and whether it's in a task's sheet).
function sections(){
  const top = task({title: 'Set up the new till'}), d1 = task({title: 'Unbox it', related_tasks: {parenttask: [{id: top.id}]}});
  const d2 = task({title: 'Find the receipt roll', related_tasks: {parenttask: [{id: d1.id}]}});
  const d3 = task({title: 'Ask Priya where it went', related_tasks: {parenttask: [{id: d2.id}]}, done: true});
  const steps = [{id: 901, title: 'Turn on the espresso machine', done: true}, {id: 902, title: 'Put the croissants in the oven', done: true},
    {id: 903, title: 'Take the croissants out', done: false}, {id: 904, title: 'Wipe down the tables', done: false}];
  const tables = task({title: 'Set out the tables', state: {drag: 70}});
  const hall = task({title: 'Book the hall', state: {aimed: true}}), van = task({title: 'Pack the van'});
  const load = task({title: 'Load chairs', state: {aimed: true}, related_tasks: {parenttask: [{id: van.id}]}});
  const chairs = task({title: 'Wipe the chairs', state: {drag: 70, with: true}, related_tasks: {parenttask: [{id: tables.id}]}});
  // A done task with subtasks still open (ticked done on the web, say): over them, struck through, on a project's list.
  const party = task({title: 'Plan the staff party', done: true}), cake = task({title: 'Order the cake', related_tasks: {parenttask: [{id: party.id}]}});
  const mover = task({title: 'Pack the van', done: true, assignees: [me], state: {leaving: 'done'}});
  const moverKid = task({title: 'Load chairs', done: true, related_tasks: {parenttask: [{id: mover.id}]}, state: {leaving: 'done'}});
  const tent = task({title: 'Put up the tent'}), pegs = task({title: 'Hammer in the pegs', percent_done: .5, state: {reveal: .3}, related_tasks: {parenttask: [{id: tent.id}]}});
  const poles = task({title: 'Tie down the poles', related_tasks: {parenttask: [{id: tent.id}]}, done: true, state: {swept: true}});
  const room = task({title: 'Book the back room', due_date: at(30 * HOUR), related_tasks: {parenttask: [{id: party.id}]}});
  const run = task({title: 'Opening up · Oct 7', project_id: 2, related_tasks: {copiedfrom: [{id: 900}], subtask: steps}, assignees: [me, priya]});
  // A long run, of 16 steps: its ring, as any run's.
  const long = task({title: 'Deep clean · Oct 5', project_id: 2, assignees: [priya], related_tasks: {copiedfrom: [{id: 899}],
    subtask: Array.from({length: 16}, (_, i) => ({id: 950 + i, title: 'Step ' + (i + 1), done: i < 5}))}});
  // A step of a run you've claimed, on Today, beside a task: square and round.
  const stepRow = task({title: 'Take the croissants out', project_id: 2, assignees: [me], related_tasks: {parenttask: [{id: run.id, title: run.title}], copiedfrom: [{id: 903}]}});
  const subRow = task({title: 'Book the back room', assignees: [me]});
  // A run's step counting down, with the reminder Pocket gave it for that: no 🔔, the countdown says it; a task's has one.
  const timed = task({title: 'Take the croissants out', project_id: 2, due_date: at(18 * 6e4), reminders: [{reminder: at(18 * 6e4)}], related_tasks: {parenttask: [{id: run.id, title: run.title}], copiedfrom: [{id: 903}]}});
  const parent = task({title: 'Deep clean', related_tasks: {subtask: [
    task({id: 801, title: 'Nobody yet: + me claims it'}), task({id: 802, title: 'Yours: tap to let it go', due_date: at(3 * HOUR)}),
    task({id: 803, title: 'Someone else\'s', due_date: at(-2 * HOUR), priority: 3}), task({id: 804, title: 'Done, by two people', done: true})]}});
  // Today's stacked cards (cards.js): a task of high priority with one subtask of five done and four open (one of them
  // yours), opened by its footer's More; a run with a step counting down; a run started from a template that came round, due
  // when it was; a task with one subtask open, so no footer; and one of 14, twelve done, of low priority
  // (its ring's 12/14 set smaller, to fit). Their subtasks are in
  // the store, as Today keeps them. A run's heading reads as a task's: its name without the day it was started
  // (runWithoutDay), and when it's due at the right.
  const now = new Date(), day = now.toLocaleDateString([], {month: 'short', day: 'numeric'}), six = new Date(now); six.setHours(18, 0, 0, 0);
  const kid = (id, f) => task({id, related_tasks: {parenttask: [{id: f.under}]}, ...f});
  const van2 = task({title: 'Pack the van', due_date: at(5 * HOUR), priority: 3, related_tasks: {subtask: [{id: 701, done: true}, {id: 702}, {id: 703}, {id: 704}, {id: 705}]}});
  const opening = task({title: `Opening up · run 2 · ${day}`, created: now.toISOString(), project_id: 2, assignees: [me], related_tasks: {copiedfrom: [{id: 898}], subtask: [{id: 711, done: true}, {id: 712}, {id: 713}]}});
  const closing = task({title: `Closing up · run 5 · ${day}`, created: now.toISOString(), due_date: six.toISOString(), project_id: 2, assignees: [me, priya], related_tasks: {copiedfrom: [{id: 897}], subtask: [{id: 751}, {id: 752}]}});
  const sign = task({title: 'Repaint the sign', related_tasks: {subtask: [{id: 721, done: true}, {id: 722, done: true}, {id: 723}]}});
  const shelves = task({title: 'Stock the new shelves in the back room before the delivery comes', priority: 1, related_tasks: {subtask: Array.from({length: 14}, (_, i) => ({id: 731 + i, done: i < 12}))}});
  const cardSubs = [kid(701, {under: van2.id, title: 'Load chairs', done: true}), kid(702, {under: van2.id, title: 'Load tables', assignees: [priya]}),
    kid(703, {under: van2.id, title: 'Sound system', assignees: [me], percent_done: .5}), kid(704, {under: van2.id, title: 'Lights'}), kid(705, {under: van2.id, title: 'The extension leads'}),
    kid(711, {under: opening.id, project_id: 2, title: 'Turn on the espresso machine', done: true, related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 1}]}}),
    kid(712, {under: opening.id, project_id: 2, title: 'Take the croissants out', due_date: at(18 * 6e4), related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 2}]}}),
    kid(713, {under: opening.id, project_id: 2, title: 'Unlock the door', related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 3}]}}),
    kid(751, {under: closing.id, project_id: 2, title: 'Stack the chairs', related_tasks: {parenttask: [{id: closing.id}], copiedfrom: [{id: 4}]}}),
    kid(752, {under: closing.id, project_id: 2, title: 'Lock the door', related_tasks: {parenttask: [{id: closing.id}], copiedfrom: [{id: 5}]}}),
    kid(723, {under: sign.id, title: 'Varnish it', assignees: [sam]}),
    ...Array.from({length: 14}, (_, i) => kid(731 + i, {under: shelves.id, title: 'Shelf ' + (i + 1), done: i < 12}))];
  // Today's rows, on one line (line: section 9): the title cut short; and at the right its priority's bars, small, from
  // none to do now (one-concept-plan, part 4), when it's due, short (a time today, a weekday this week, a date beyond,
  // red when late), and the project's dot.
  const dayAt = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const today = [task({title: 'Post next week’s rota', due_date: dayAt(0, 10, 30), priority: 3}),
    task({title: 'Call the plumber about the dishwasher that leaks under the sink again', due_date: dayAt(0, 15, 30), priority: 1, assignees: [priya]}),
    task({title: 'Pay the milk invoice', due_date: dayAt(-2, 9), priority: 4, project_id: 4}),
    task({title: 'Order the cups', due_date: dayAt(2, 0), priority: 2}), task({title: 'Book the window cleaner', due_date: dayAt(12, 0)}),
    task({title: 'Fix the till drawer', due_date: dayAt(0, 9), priority: 5, assignees: [me]})];
  /* A project's open list (cards 'list'): a task whose open subtasks are on its card, open for good, in its List view's
     order (one with a subtask of its own, a row that opens its sheet; one waiting to be sent, added from the add box);
     a task with none, a row; a task done over a subtask still open, its title struck through; and a run in progress,
     its open steps on it in its order. */
  const launch = task({title: 'Plan the launch party', related_tasks: {subtask: [{id: 761}, {id: 762, done: true}, {id: 763}, {id: 764}]}});
  const plain = task({title: 'Water the plants'});
  const staff = task({title: 'Plan the staff party', done: true, related_tasks: {subtask: [{id: 771}]}});
  const closing2 = task({title: `Closing up · run 6 · ${day}`, created: now.toISOString(), project_id: 2, assignees: [priya], related_tasks: {copiedfrom: [{id: 896}], subtask: [{id: 781, done: true}, {id: 782}, {id: 783}]}});
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(17, 0, 0, 0);
  const projectSubs = [kid(761, {under: launch.id, title: 'Book the band', assignees: [priya]}),
    kid(763, {under: launch.id, title: 'Order the cake', percent_done: .5, related_tasks: {parenttask: [{id: launch.id}], subtask: [{id: 765}]}}),
    kid(765, {under: 763, title: 'Pick a flavour'}), kid(764, {under: launch.id, title: 'Print the flyers', due_date: tomorrow.toISOString()}),
    {...task({title: 'Hang the bunting'}), id: 'pending-specimen-1', pending: true, parent: launch.id, position: 2.5, entry: 'specimen-sub', index: 0},
    kid(771, {under: staff.id, title: 'Book the back room', due_date: at(30 * HOUR)}),
    kid(782, {under: closing2.id, project_id: 2, title: 'Stack the chairs', related_tasks: {parenttask: [{id: closing2.id}], copiedfrom: [{id: 6}]}}),
    kid(783, {under: closing2.id, project_id: 2, title: 'Lock the door', related_tasks: {parenttask: [{id: closing2.id}], copiedfrom: [{id: 7}]}})];
  const project = {list: [plain, launch, staff, closing2, ...projectSubs], heads: [staff.id],
    positions: {[launch.id]: 10, [plain.id]: 20, [staff.id]: 30, [closing2.id]: 40, 761: 1, 763: 2, 764: 3, 765: 1, 771: 1}};
  /* A parent's ring (parent-tasks-plan, part 3), on Today's cards: one subtask of four at 50%, so 13%; two of four done,
     50%; none of three; every one done, waiting for Close; one closed by its ring, a gap with Undo; a header swiped right
     part way (it springs back: no progress of its own), and one swiped left onto its Delete. */
  const wall = task({title: 'Paint the back wall', related_tasks: {subtask: [{id: 1101}, {id: 1102}, {id: 1103}, {id: 1104}]}});
  const menu = task({title: 'Print the new menus', priority: 2, related_tasks: {subtask: [{id: 1111, done: true}, {id: 1112, done: true}, {id: 1113}, {id: 1114}]}});
  const rota = task({title: 'Write the summer rota', related_tasks: {subtask: [{id: 1121}, {id: 1122}, {id: 1123}]}});
  const till = task({title: 'Set up the new till', related_tasks: {subtask: [{id: 1131, done: true}, {id: 1132, done: true}, {id: 1133, done: true}]}});
  const bins = task({title: 'Empty the bins', related_tasks: {subtask: [{id: 1141, done: true}, {id: 1142, done: true}]}, state: {swept: true}});
  const floor = task({title: 'Mop the floor', related_tasks: {subtask: [{id: 1151}, {id: 1152}]}, state: {head: .3}});
  const sink = task({title: 'Fix the sink', related_tasks: {subtask: [{id: 1161}, {id: 1162}]}, state: {head: 'delete'}});
  const parentSubs = [kid(1101, {under: wall.id, title: 'Sand it', percent_done: .5}), kid(1102, {under: wall.id, title: 'Tape the edges'}), kid(1103, {under: wall.id, title: 'First coat'}), kid(1104, {under: wall.id, title: 'Second coat'}),
    kid(1111, {under: menu.id, title: 'Write them', done: true}), kid(1112, {under: menu.id, title: 'Check the prices', done: true}), kid(1113, {under: menu.id, title: 'Send to the printer'}), kid(1114, {under: menu.id, title: 'Pick them up'}),
    kid(1121, {under: rota.id, title: 'Ask for holidays'}), kid(1122, {under: rota.id, title: 'Draft it'}), kid(1123, {under: rota.id, title: 'Post it'}),
    kid(1131, {under: till.id, title: 'Unbox it', done: true}), kid(1132, {under: till.id, title: 'Plug it in', done: true}), kid(1133, {under: till.id, title: 'Test a sale', done: true}),
    kid(1141, {under: bins.id, title: 'Kitchen', done: true}), kid(1142, {under: bins.id, title: 'Yard', done: true}),
    kid(1151, {under: floor.id, title: 'Sweep first'}), kid(1152, {under: floor.id, title: 'Mop'}), kid(1161, {under: sink.id, title: 'Buy a washer'}), kid(1162, {under: sink.id, title: 'Fit it'})];
  /* A task's sheet led by its row (parent-tasks-plan, 6b): a task at 50% with notes and two photos, Priya on it, the
     whole sheet under it; a subtask with no notes or photos, its parent in the path; a parent, its ring at 13% (one
     subtask of four at 50%), its subtasks below; the card's row swiped right from 25% to 50%, still held; its title
     tapped, a box to change it in; and a done task. `parts`: what of the rest of the sheet is drawn under the card. */
  const photo = (id, name, size) => ({id, file: {name, size}});
  const notes = '<p>Use the green from the shed: <strong>two coats</strong>, a day apart.</p><ul><li>Sand the old paint off first</li><li>Tape round the letterbox</li></ul>';
  const fence = task({title: 'Paint the side fence', related_tasks: {subtask: [task({id: 1201, title: 'Sand it', percent_done: .5, related_tasks: {parenttask: [{id: 1200}]}}),
    task({id: 1202, title: 'Tape the edges', assignees: [priya], related_tasks: {parenttask: [{id: 1200}]}}), task({id: 1203, title: 'First coat', due_date: dayAt(1, 0), related_tasks: {parenttask: [{id: 1200}]}}),
    task({id: 1204, title: 'Second coat', related_tasks: {parenttask: [{id: 1200}]}})]}, description: '<p>The side facing the car park.</p>'});
  fence.id = 1200;
  const sheets = [
    {spec: 'A task’s sheet led by its row: at 50%, with notes and two photos, Priya on it; under the card, what stays: Due and Reminders, Subtasks, Comments (stand-ins), and Details (a stand-in, but its Progress line, as the sheet has it)',
      parts: ['due', 'subtasks', 'comments', 'details'], task: task({title: 'Repaint the front door', percent_done: .5, due_date: dayAt(1, 9), priority: 2, assignees: [priya], comment_count: 1,
        labels: [label(1, 'Front', 'e07a5f')], description: notes, attachments: [photo(1, 'door-before.jpg', 2.4e6), photo(2, 'paint-tin-label.jpg', 1.1e6)]})},
    {spec: 'A subtask’s sheet with no notes or photos: its parent in the path over the card; the card is its row, “Add notes”, and “Add a photo or file”', parts: [],
      task: task({title: 'Buy masking tape', related_tasks: {parenttask: [{id: 1200, title: 'Paint the side fence'}]}})},
    {spec: 'A parent’s sheet: its ring for a tick (one subtask of four at 50%, so 13%), and its subtasks below, the real rows; no Progress line in Details, as its progress is worked out',
      parts: ['subtasks', 'details'], subPeople: {1201: [me], 1202: [priya]}, task: fence},
    {spec: 'The card’s row swiped right from 25%, still held at 50%: only the row moves; its notes and photo stay', parts: [], state: {reveal: .22},
      task: task({title: 'Restock the napkins', percent_done: .25, assignees: [me], description: '<p>The big packs, from the cash and carry.</p>', attachments: [photo(3, 'shelf.jpg', 0.9e6)]})},
    {spec: 'Its title tapped: a box to change it in, in the row’s place, saved once it’s left', parts: [], titleEdit: true, title: 'Restock the napkins and the straws',
      task: task({title: 'Restock the napkins', due_date: dayAt(1, 0), description: '<p>The big packs.</p>'})},
    {spec: 'A done task: its row as a done row in a list; Details’ Progress line has no quarter pressed', parts: ['details'],
      task: task({title: 'Clean the grinder', done: true, percent_done: .5, due_date: dayAt(-1, 17), description: '<p>Burrs out, brush, then rice through it.</p>', attachments: [photo(4, 'burrs.jpg', 1.6e6)]})},
  ];
  /* Holding to reschedule on Today (parent-tasks-plan, part 4): small Todays, each a still of a carry. `held`: what's
     carried (a row, or a card); `at`: where the finger is (a row whose day it'd take, or a section's heading); `lit`:
     the section it'd go to (none: it would spring back); `over`: in Next 7 days, the row or card whose day it'd take.
     And what's said in its place after: moved, with Undo; and a hold on a repeating task, which stays. */
  const carry = (key, title, items) => ({key, title, items});
  const late = () => task({title: 'Pay the milk invoice', due_date: dayAt(-2, 9), priority: 4});
  const soon = () => task({title: 'Post next week’s rota', due_date: dayAt(0, 16, 30)});
  const week = () => [task({title: 'Order the cups', due_date: dayAt(1, 0), priority: 2}), task({title: 'Book the window cleaner', due_date: dayAt(3, 0)}),
    task({title: 'Collect the new aprons', due_date: dayAt(5, 11)})];
  const carries = [];
  { const a = late(), w = week(); carries.push({spec: 'Held on Overdue and carried down over Next 7 days: the section lit, the row whose day it’d take marked, and the tag on what’s carried naming the day',
    groups: [carry('overdue', 'Overdue', [a, late()]), carry('today', 'Today', [soon()]), carry('week', 'Next 7 days', w)], held: a.id, at: {item: w[1].id}, lit: 'week', over: w[1].id, day: w[1].due_date}); }
  { const w = week(); carries.push({spec: 'Carried up from Next 7 days over Today’s heading: Today lit, “Move to today”',
    groups: [carry('overdue', 'Overdue', [late()]), carry('today', 'Today', [soon()]), carry('week', 'Next 7 days', w)], held: w[2].id, at: {sec: 'today'}, lit: 'today', day: dayAt(0, 0)}); }
  { const d = soon(); carries.push({spec: 'Carried from Today over Overdue: nothing lit and no tag; let go there, it springs back into its place',
    groups: [carry('overdue', 'Overdue', [late(), late()]), carry('today', 'Today', [d, soon()]), carry('week', 'Next 7 days', week().slice(0, 1))], held: d.id, at: {sec: 'overdue'}}); }
  { const a = late(); carries.push({spec: 'Nothing due today: as the carry starts, Today shows anyway, an empty slot a row tall, to drop on',
    groups: [carry('overdue', 'Overdue', [a]), carry('today', 'Today', []), carry('week', 'Next 7 days', week().slice(0, 2))], held: a.id, at: {sec: 'today'}, lit: 'today', day: dayAt(0, 0)}); }
  const shed = task({title: 'Tidy the shed', due_date: dayAt(0, 0), related_tasks: {subtask: [{id: 1301}, {id: 1302}, {id: 1303}]}});
  const shedSubs = [kid(1301, {under: shed.id, title: 'Sort the paint tins'}), kid(1302, {under: shed.id, title: 'Sweep it out'}), kid(1303, {under: shed.id, title: 'Fix the shelf', done: true})];
  { const w = week(); carries.push({spec: 'A card carried, held by its header or any of its rows: the whole card lifts, and its task’s date is what moves',
    groups: [carry('today', 'Today', [shed, soon()]), carry('week', 'Next 7 days', w)], held: shed.id, at: {item: w[1].id}, lit: 'week', over: w[1].id, day: w[1].due_date}); }
  const moved = task({title: 'Order the cups', due_date: dayAt(3, 0), priority: 2}), water = task({title: 'Water the plants', due_date: dayAt(0, 0), repeat_after: 86400});
  carries.push({spec: 'Said in its place: dropped on a day, “Moved to <day>” with Undo; a repeating task held, why it stays',
    groups: [carry('today', 'Today', [water, soon()]), carry('week', 'Next 7 days', [moved])], said: [[moved.id, 'moved'], [water.id, 'repeats']]});
  return {parent, steps: runSteps(), sheets, carries, carrySubs: shedSubs, cards: [van2, opening, closing, sign, shelves], cardSubs, parents: [wall, menu, rota, till, bins, floor, sink], parentSubs, project, list: [
    {title: 'Today, on one line, priority as bars before the time: high, low, urgent, medium, none, do now', depth: {}, line: true, delete: true, tasks: today},
    // Under Today's heading (its group's key): due today with no time says no time; with a time, its time.
    {title: 'Under the Today heading: due today with no time shows no time (“Today” elsewhere)', key: 'today', depth: {}, line: true, tasks: [
      task({title: 'Order the cups', due_date: dayAt(0, 0), priority: 2}), task({title: 'Post next week’s rota', due_date: dayAt(0, 16, 30)})]},
    // A project no one else can see (seenBy 0): no "+ me", nor your picture; someone given it in a shared project before it was moved here, still.
    {title: 'A project only you can see: no “+ me”, nor your picture; someone given it elsewhere, before it was moved there, still shows', depth: {}, tasks: [
      task({title: 'Renew the car insurance', project_id: 5}), task({title: 'Book the dentist', project_id: 5, assignees: [me]}),
      task({title: 'Fix the shed door', project_id: 5, assignees: [priya]})]},
    {title: 'Open, done, and waiting to send', depth: {}, tasks: [task({title: 'Order oat milk'}), task({title: 'Wipe the counters', done: true}),
      {...task({title: 'Call the plumber tomorrow'}), id: 'pending-specimen-0', pending: true, waits: true, entry: 'specimen', index: 0}]},
    // Progress is drawn in the tick (parent-tasks-plan, part 1), a quarter at a time, with no line under the row.
    {title: 'Progress in the tick, a quarter at a time: none, 25%, 50%, 75%, done; and 30%, set on the web', depth: {}, tasks: [task({title: 'Order oat milk'}),
      task({title: 'Repaint the sign', percent_done: .25}), task({title: 'Train the new barista', percent_done: .5}), task({title: 'Deep clean the fridge', percent_done: .75}),
      task({title: 'Wipe the counters', done: true, percent_done: .5}), task({title: 'Fix the till drawer', percent_done: .3})]},
    {title: 'Subtasks, at depth 1 to 3', depth: {[top.id]: 0, [d1.id]: 1, [d2.id]: 2, [d3.id]: 3}, tasks: [top, d1, d2, d3]},
    {title: 'Due, priority, labels, people, comments', depth: {}, tasks: [
      task({title: 'Pay the milk invoice', due_date: at(-26 * HOUR), priority: 4}),
      task({title: 'Prep the specials board', due_date: at(2 * HOUR), labels: [label(1, 'Front', 'e07a5f'), label(2, 'Daily', '3d85c6')]}),
      task({title: 'Check the fridge temperatures', due_date: at(50 * HOUR), assignees: [me, priya], comment_count: 3, repeat_after: 86400}),
      task({title: 'Book the window cleaner', project_id: 4, priority: 2, attachments: [{id: 1}], reminders: [{reminder: at(5 * HOUR)}], assignees: [sam]})]},
    {title: 'A done task over its subtasks still open', depth: {[party.id]: 0, [cake.id]: 1, [room.id]: 1}, heads: [party.id], tasks: [party, cake, room]},
    {title: 'Checklist runs, as under Checklists, on a project’s list and in search: one row, its ring for a tick, its steps done of all inside it (past 12 steps too), who it’s for as pictures in its slot, no line under it', depth: {}, tasks: [run, long]},
    {title: 'A run’s step counting down, with no 🔔 for the reminder Pocket gave it; a task’s reminder still to come has one', depth: {}, tasks: [timed,
      task({title: 'Call the plumber', reminders: [{reminder: at(5 * HOUR)}]})]},
    {title: 'A checklist’s step has a square box (a step you’ve claimed, on Today), a task or a subtask a round one', depth: {}, tasks: [stepRow, subRow]},
    {title: 'Read only: a project shared with you to read', depth: {}, tasks: [task({title: 'Quarterly stock count', project_id: 3})]},
    // Swiped (progress.js: swipeAt, revealOf), still held: the row's content moved by `reveal` of its width, and what's
    // uncovered says what letting go there does. Swiped to its Delete (a project's list, which has one: delete), and a
    // line in a row's place (lines.js): shown by `state`.
    {title: 'Swiped right, still held: the ring in the space uncovered says what letting go sets, 25%, 50%, 75%, and past half the row, done; the row itself unchanged', depth: {}, delete: true, tasks: [
      task({title: 'Restock the napkins', state: {reveal: .15}}), task({title: 'Restock the napkins', state: {reveal: .27}}),
      task({title: 'Restock the napkins', state: {reveal: .4}}), task({title: 'Clean the grinder', percent_done: .75, state: {reveal: .55}})]},
    {title: 'Let go past half: done, the row carrying on off to the right, leaving a gap with Done and Undo until the batch clears', depth: {}, delete: true,
      tasks: [task({title: 'Clean the grinder', state: {sweepRight: .8}}), task({title: 'Clean the grinder', done: true, state: {swept: true}})]},
    {title: 'Swiped left from 75%, still held: the ring empties to 50% and 25%, and stops at 0% however far it’s pulled, with no Delete; let go, its progress is set and the row springs back', depth: {}, delete: true, tasks: [
      task({title: 'Order more cups', percent_done: .75, state: {reveal: -.2}}), task({title: 'Order more cups', percent_done: .75, state: {reveal: -.38}}),
      task({title: 'Order more cups', percent_done: .75, state: {reveal: -.7}})]},
    {title: 'Then, at 0%, a second swipe left: its Delete, open on its button if let go, and past half the row, deleted', depth: {}, delete: true, tasks: [
      task({title: 'Order more cups', state: {swiped: true}}), task({title: 'Return the crates', state: {full: true}})]},
    {title: 'A done row swiped left: the ring a done tick, then 75% (open again), on down to 0%', depth: {}, delete: true, tasks: [
      task({title: 'Sweep the yard', done: true, state: {reveal: -.09}}), task({title: 'Sweep the yard', done: true, state: {reveal: -.15}})]},
    {title: 'A full swipe left, or Delete tapped: the row carries on off the screen, leaving a gap with Restore', depth: {}, delete: true,
      tasks: [task({title: 'Wipe the menus', state: {sweep: .8}}), task({title: 'Wipe the menus', state: {leaving: 'deleted'}})]},
    // Ticked and deleted, where they were until the batch clears (leaving.js): a parent with the subtask closed with it,
    // a deleted row's gap with Restore, and a repeating task ticked; then the batch clearing, its rows partway folded.
    {title: 'Ticked and deleted, in place: a parent with its subtask, a deleted row’s gap with Restore, a repeating task', depth: {[mover.id]: 0, [moverKid.id]: 1}, tasks: [
      mover, moverKid, task({title: 'Return the crates', due_date: at(4 * HOUR), assignees: [priya], state: {leaving: 'deleted'}}),
      task({title: 'Water the plants', done: true, due_date: at(-HOUR), repeat_after: 86400, state: {leaving: 'done'}}), task({title: 'Order oat milk'})]},
    {title: 'The batch clearing: the rows ticked and deleted fold together, and the row below closes up once', depth: {}, tasks: [
      task({title: 'Sweep the yard', done: true, state: {leaving: 'done', folding: .45}}), task({title: 'Wipe the menus', state: {leaving: 'deleted', folding: .45}}),
      task({title: 'Light the heaters'})]},
    // Let go on a task no one was doing: yours, as the swipe set its progress (claimOnSlide).
    {title: 'Let go at 25% on a task no one was doing: it\'s yours, its tick a quarter', depth: {}, tasks: [task({title: 'Restock the napkins', percent_done: .25, state: {claim: true}})]},
    {title: 'A subtask swiped from 50% to 75%, and one done by a full swipe: what\'s uncovered, and the gap, span the whole row, not from its indent', delete: true, depth: {[tent.id]: 0, [pegs.id]: 1, [poles.id]: 1}, tasks: [tent, pegs, poles]},
    {title: 'A line in a row\'s place: a tick not saved', depth: {}, tasks: [
      task({title: 'Call the plumber', state: {line: {text: 'Not saved: no connection', title: '', stays: true, cls: 'failed', action: {label: 'Try again', fn(){}}}}})]},
    // The task quick add's box adds subtasks to (quickadd.js: the cursor), lit up: a task, and a subtask.
    {title: 'What the add box adds subtasks to, lit up: a task, and a subtask', depth: {[van.id]: 0, [load.id]: 1}, tasks: [hall, van, load]},
    // Held and moved down (progress.js: dragOf): it follows the finger, with its subtask, and the row it has passed the
    // middle of has moved up to make room.
    {title: 'Held and moved down, with its subtask, past the row below', depth: {[tables.id]: 0, [chairs.id]: 1}, tasks: [task({title: 'Sweep the yard'}),
      tables, chairs, task({title: 'Light the heaters', state: {shift: -148}})]},
    // A project's done tasks, in their section under the open ones, the most recently done first.
    {title: 'A project’s done tasks, folded, then open', depth: {}, fold: true, tasks: [task({title: 'Order the milk', done: true}), task({title: 'Clean the grinder', done: true})]},
    // Lit up as its time passes, moving to Overdue (alerts.js), and just added (the page holds both at their start).
    {title: 'Just come due, and just added', depth: {}, tasks: [task({title: 'Collect the cake order', due_date: at(-60e3), state: {flash: 'due'}}),
      task({title: 'Order more cups', state: {flash: 'fresh'}})]},
  ]};
}

/* A run's steps as Vikunja gives them, with only what its screen keeps (plainStep): done by you, by Priya, skipped by
   Sam, a step with notes on you, one inserted and one repeated during the run, progress, people on them, and timed
   steps: one counting down from the step before it, one late, and one waiting on a step not done. */
function runSteps(){
  const MIN = 6e4;
  const step = f => ({id: ++n, title: 'A step', done: false, done_at: ZERO, due_date: ZERO, updated: at(-HOUR), percent_done: 0, description: '', assignees: [],
    attachments: [], reactions: {}, comments: [], added: '', from: null, ...f, tpl: f.tpl === undefined ? f.title : f.tpl});
  const doneBy = (u, mins) => ({done: true, done_at: at(-mins * MIN), reactions: {'✅': [u]}});
  const note = (id, author, mins, text) => ({id, author, created: at(-mins * MIN), comment: `<p>${text}</p>`});
  const list = [
    step({title: 'Turn on the espresso machine', tpl: 'Turn on the espresso machine {#machine}', ...doneBy(me, 40)}),
    step({title: 'Grind the beans', assignees: [priya], ...doneBy(priya, 30)}),
    step({title: 'Wipe the steam wand', done: true, done_at: at(-20 * MIN), reactions: {'⏭️': [sam]}, comments: [note(1, sam, 19, 'Skipped: no milk yet')]}),
    step({title: 'Put the croissants in', tpl: 'Put the croissants in {#oven}', ...doneBy(me, 2)}),
    step({title: 'Take the croissants out', tpl: 'Take the croissants out T#18m:oven', assignees: [me], comments: [note(2, priya, 50, 'Use the top shelf')]}),
    step({title: 'Check the milk', added: 'Inserted', tpl: null}),
    step({title: 'Wipe the steam wand', added: 'Repeated'}),
    step({title: 'Restock the cups', assignees: [priya], percent_done: .5}),
    step({title: 'Unlock the door', tpl: 'Unlock the door T#30m:machine'}),
    step({title: 'Sweep the floor', tpl: 'Sweep the floor T#10m'}),
    step({title: 'Count the till', assignees: [priya, sam]}),
  ];
  list[6].from = list[2].id;
  return list;
}

document.addEventListener('alpine:init', () => directives(Alpine));
document.addEventListener('alpine:init', () => Alpine.data('specimen', () => {
  const c = pocket();
  c.specimenTemplate = [{title: 'Turn on the espresso machine', text: 'Named “machine”'}, {title: 'Put the croissants in', text: 'Named “oven”'},
    {title: 'Take the croissants out', text: 'Due 18m after “oven”', note: 'Top shelf first: it runs hot.'}, {title: 'Unlock the door', text: 'Due 30m after “machine”'}];
  c.specimenSheets = [];
  c.specimen = []; c.specimenCards = []; c.specimenParents = []; c.specimenComplete = []; c.specimenProject = {items: []}; c.specimenCarry = []; c.specimenRunCards = []; c.specimenRunTops = []; c.specimenAdding = {steps: [], at: null, target: {}};
  // A message in its place (lines.js: sayAt), each as the app shows it.
  const undo = {label: 'Undo', fn(){}};
  c.specimenLines = [{key: 1, place: 'overdue', text: 'Moved 6 to today', action: undo},
    {key: 2, place: 'cap', text: 'Added to Head office, due Friday', action: {label: 'Open', fn(){}}},
    {key: 3, place: 'sheet:top', text: 'Not saved: no connection', cls: 'failed', action: {label: 'Try again', fn(){}}},
    {key: 4, place: 'sheet:subtasks', text: 'Closed Deep clean + 3 subtasks', action: undo},
    {key: 5, place: 'step', text: 'Done: Take the croissants out', action: undo}];
  // And on a run's screen: the step a step goes after, with Repeat (off for a step still waiting to be sent).
  c.specimenTargets = [{to: 'Pack the van', after: ''}, {to: 'Pack the van', after: 'Load chairs'},
    {step: true, after: 'Unlock the door', repeat: 'Unlock the door', canRepeat: true}, {step: true, after: 'Check the milk', repeat: 'Check the milk', canRepeat: false}];
  // In place of signing in and loading: you, your projects, what you can change in each, and the tasks.
  c.init = function(){
    setApp(this);
    const s = sections(), subs = s.parent.related_tasks.subtask;
    // Who can see each project besides you (loadPeople): all shared but the last, yours alone.
    Object.assign(this, {signedIn: true, screen: 'app', user: me, route: {name: 'today'}, perms: {1: 2, 2: 2, 3: 0, 4: 1, 5: 2}, seenBy: {1: 2, 2: 2, 3: 4, 4: 1, 5: 0},
      avatars: Object.fromEntries([me, priya, sam].map(u => [u.username, {url: '', at: Date.now()}])), labelsLoaded: true});
    this.setProjects(projects);
    // A task's sheet, open on a task with subtasks, for its rows' slots: who's doing each.
    this.sheet = {...blankSheet('task'), task: s.parent, subPeople: {801: [], 802: [me], 803: [priya], 804: [priya, sam]}};
    // A run's screen, open on its fifth step, with a tick on the last waiting to be sent: its steps are the task row
    // too (g.run), each as the screen works it out (runView).
    const run = {id: ++n, title: 'Opening up · Oct 7', done: false, project_id: 2, assignees: [me, priya], created_by: me, comments: [], from: 900, steps: s.steps.map(x => x.id)};
    this.pending = [{kind: 'act', id: 'specimen-tick', run: run.id, task: s.steps.at(-1).id, op: 'done', at: new Date().toISOString(), items: []}];
    this.slow = ['specimen-tick'];
    this.view.run = {run: {...run, done: true}, steps: s.steps, at: null, last: null};
    const finished = this.runView.steps;
    // Its step card, on a step of yours counting down, one Priya is on, half done, and one done by Priya (tapped in the
    // list): each as runView has it then, to draw step-card.html with.
    this.specimenRunCards = [7, 1, 4].map(at => { this.view.run = {run, steps: s.steps, at, last: null}; return this.runView; });
    const steps = this.runView.steps;
    steps[7] = {...steps[7], state: {reveal: .4}};
    steps[5] = {...steps[5], state: {swiped: true}};                 // inserted during the run: it has a Delete
    /* Steps added from the bottom box, one after another, after the step on the card: two sent, the third waiting to
       be sent, and the line above the box naming it (runAim). */
    const mk = title => ({...s.steps[5], id: ++n, title, comments: [], assignees: []});
    const inRow = [...s.steps.slice(0, 5), mk('Fill the water jug'), mk('Wipe the counter'), ...s.steps.slice(5)];
    this.pending.push({kind: 'step', id: 'specimen-step', run: run.id, title: 'Stack the trays', before: s.steps[5].id, after: inRow[6].id, at: new Date().toISOString(), tpl: null, from: null, items: [], files: []});
    this.slow.push('specimen-step');
    this.view.run = {run, steps: inRow, at: 4, last: null};
    // (from the step before the card's to the run's next steps; other ids, so the states above stay on their own rows)
    this.specimenAdding = {steps: this.runView.steps.slice(3, 10).map(x => x.pending ? x : {...x, id: x.id + 2000}), at: 4, target: {step: true, after: 'Stack the trays', repeat: this.runView.step.title, canRepeat: true}};
    /* A run's screen's top (app.html): its own row between Back and ⋯ (RUN_ROW), its ring the screen's (runRing, the run
       above), who it's for in its slot: you; you and Priya; on a project only you can see, no slot. */
    const top = this.view.run.run;
    this.specimenRunTops = [{spec: 'For you', run: {...top, id: ++n, assignees: [me]}},
      {spec: 'For you and Priya, with a name on two lines', run: {...top, id: ++n, title: 'Opening up · Front counter and the till · Oct 7'}},
      {spec: 'On a project only you can see: no slot', run: {...top, id: ++n, project_id: 5, assignees: [me]}}];
    // Today's cards: their subtasks in the store, the van's opened by its footer's More.
    for (const x of s.cardSubs) this.keep(x);
    this.specimenCards = s.cards.map(t => this.keep(t));
    this.view.cards = Object.fromEntries(s.cards.map(t => [t.id, {when: null, made: null, focus: null}]));
    this.cardOpen = {[s.cards[0].id]: true};
    // The parents' rings, on Today's cards; and the question their ring asks (sheet/complete.html), for a task's and a run's.
    for (const x of s.parentSubs) this.keep(x);
    this.specimenParents = s.parents.map(t => this.keep(t));
    Object.assign(this.view.cards, Object.fromEntries(s.parents.map(t => [t.id, {when: null, made: null, focus: null}])));
    // Each with its sentence (completeAsk): a task with 3 open subtasks; one with 5, one of them repeating (it stays, and
    // isn't named); a run with 2 steps not done.
    const ask = (title, run, open) => {
      const names = open.filter(o => !o.stays).map(o => o.title), stay = open.length - names.length;
      return {kind: 'complete', complete: {id: 0, run, title, n: run ? open.length : names.length, stay, open: open.map((o, i) => ({id: i + 1, ...o})), ask: completeAsk({title, run, names, stay})}};
    };
    const titles = (...xs) => xs.map(title => typeof title === 'string' ? {title} : title);
    this.specimenComplete = [ask(s.parents[2].title, false, titles('Ask for holidays', 'Draft it', 'Post it')),
      ask(s.parents[0].title, false, titles('Sand it', 'Tape the edges', 'First coat', 'Second coat', {title: 'Water the plants', stays: true})),
      ask('Closing up', true, titles('Stack the chairs', 'Lock the door'))];
    // A task's sheet led by its row (parent-tasks-plan, 6b): each its own sheet, as the app's is for one task.
    for (const x of s.sheets.flatMap(sh => sh.task.related_tasks.subtask || [])) this.keep(x);
    this.specimenSheets = s.sheets.map(sh => ({...blankSheet('task'), ...sh, task: this.keep(sh.task)}));
    /* Holding to reschedule on Today: each still's sections as Today's are, with data-group (screens/lists.html), and
       its rows and cards as Today has them (screenRows('today')). */
    for (const x of s.carrySubs) this.keep(x);
    const carryG = (key, title, items) => ({key, title, cls: {overdue: 'overdue', today: 'today'}[key] || '', cards: 'today', line: true, depth: {}, delete: true, reschedule: true,
      items: items.map(t => this.keep(t)), tasks: items});
    this.specimenCarry = s.carries.map((cv, i) => ({...cv, id: i, groups: cv.groups.map(g => carryG(g.key, g.title, g.items))}));
    for (const cv of s.carries) for (const g of cv.groups) for (const t of g.items) if (t.related_tasks?.subtask?.length) this.view.cards[t.id] = {when: t.due_date, made: null, focus: null};
    const dayOf = due => dueInfo(startOfDay(new Date(due)).toISOString()).label;
    for (const cv of s.carries) for (const [id, what] of cv.said || []) {
      const t = this.tasks[id];
      this.lines[id] = what === 'moved' ? {id, title: '', more: '', text: movedTo(dayOf(t.due_date)), action: undo, stays: true} : {id, title: '', more: '', text: STAYS.repeats, action: null, stays: true};
    }
    // A project's open list, as listGroups makes it: each subtask under its parent there, and what it shows.
    Object.assign(this.positions, s.project.positions);
    const list = s.project.list.map(t => t.pending ? t : this.keep(t)), g = {key: 'open', cards: 'list', delete: true, reorder: true, heads: s.project.heads, ...nestSubtasks(list, positionOrder(this.positions))};
    this.specimenProject = {...g, items: listItems(g.tasks, g.depth, t => !!this.cardOf(t, g))};
    this.specimen = [...s.list, {title: 'In a task\'s sheet: its subtasks, with who\'s doing each', depth: {}, sheet: true, delete: true, reorder: true, tasks: subs},
      {title: 'A run\'s steps on its screen: done by you, by Priya, skipped, the step on its card (counting down), inserted (swiped to its Delete), repeated, swiped right to 75%, late, waiting on another step, and a tick waiting to send',
        depth: {}, run: true, at: 4, locked: false, tasks: steps},
      {title: 'A run’s step done by a full swipe: a gap with Undo, which unticks it, until the batch clears; then done in its place', depth: {}, run: true, at: null, locked: false,
        tasks: [{...steps[3], id: steps[3].id + 3000, state: {swept: true}}]},
      // (other ids, so the states above stay on their own rows)
      {title: 'The same steps in a run finished, or shared with you to read only', depth: {}, run: true, at: null, locked: true,
        tasks: finished.map(x => ({...x, id: x.id + 1000}))}];
    // The states a finger makes, put on the rows as the app does.
    const all = this.specimen.flatMap(g => g.tasks).filter(t => t.state);
    for (const t of all) if (t.state.line) this.lines[t.id] = {id: t.id, title: t.title, more: '', action: {label: 'Undo', fn(){}}, ...t.state.line};
    for (const t of all) if (t.state.leaving) this.leaving[t.id] = t.state.leaving;
    for (const t of all) if (t.state.swept) { this.leaving[t.id] = 'done'; this.swept[t.id] = true; }
    for (const t of all) if (t.state.flash) this.flashed[t.state.flash].push(t.id);
    for (const t of all) if (t.state.claim) this.slideClaim = t.id;
    for (const t of s.parents) if (t.state?.swept) { t.done = true; this.leaving[t.id] = 'done'; this.swept[t.id] = true; }
    this.$nextTick(() => {
      // A parent's header swiped: part way right (the empty ring, as it springs back short of the full point), or left onto its Delete.
      for (const t of s.parents) for (const head of document.querySelectorAll(`.day-card[data-id="${t.id}"] > .card-head`)) {
        if (t.state?.head === 'delete') { head.classList.add('swiped'); head.style.setProperty('--swipe', '-88px'); }
        else if (t.state?.head) { const w = head.clientWidth; revealOf(head).move(swipeAt({start: 0, dx: t.state.head * w, x: w / 2, width: w, screen: 1e4, one: true})); }
      }
      /* A carry, still held (progress.js: carryOf): what's lifted follows the finger out of its list, over `at`; the
         section it'd go to lit (.drop-on), in Next 7 days the row or card whose day it'd take marked (.drop-day), and on
         what's carried the tag naming the day. */
      for (const cv of this.specimenCarry) if (cv.held) for (const box of document.querySelectorAll(`[data-carry="${cv.id}"]`)) {
        const item = box.querySelector(`.item[data-id="${cv.held}"]`), lifted = item.querySelector(':scope > .day-card') || item.querySelector(':scope > .row');
        const to = cv.at.item ? box.querySelector(`.item[data-id="${cv.at.item}"]`) : box.querySelector(`[data-group="${cv.at.sec}"] > .sec`);
        const a = item.getBoundingClientRect(), b = to.getBoundingClientRect();
        item.parentElement.classList.add('carrying'); item.classList.add('dragged'); lifted.classList.add('held');
        item.style.transform = `translateY(${Math.round(b.top + b.height / 2 - (a.top + Math.min(a.height, 56) / 2))}px)`;
        if (cv.lit) box.querySelector(`[data-group="${cv.lit}"]`).classList.add('drop-on');
        if (cv.over) box.querySelector(`.item[data-id="${cv.over}"]`).classList.add('drop-day');
        if (cv.lit) { const tag = document.createElement('span'); tag.className = 'drop-tag'; tag.textContent = 'Move to ' + dayWord(dayOf(cv.day)); item.append(tag); }
      }
      // The sheet's own row swiped, still held, as a list's row is (below).
      for (const sh of this.specimenSheets) if (sh.state?.reveal) for (const row of document.querySelectorAll(`.task-card > .row[data-id="${sh.task.id}"]`)) {
        const w = row.clientWidth; revealOf(row).move(swipeAt({start: Math.round(sh.task.percent_done * 100), dx: sh.state.reveal * w, x: w / 2, width: w, screen: 1e4}));
      }
      for (const t of all) for (const row of document.querySelectorAll(`.row[data-id="${t.id}"]`)) {
        // A still of a swipe, held (progress.js: revealOf, swipeAt), put down where its room isn't cut short by the edge.
        if (t.state.reveal) { const w = row.clientWidth; revealOf(row).move(swipeAt({start: t.done ? 100 : t.pct ?? Math.round(t.percent_done * 100), dx: t.state.reveal * w, x: t.state.reveal < 0 ? w : w / 2, width: w, screen: 1e4})); }
        if (t.state.sweepRight) revealOf(row).move({off: row.clientWidth * t.state.sweepRight, pct: 100, to: 'done'});
        if (t.state.swiped) { row.classList.add('swiped'); row.style.setProperty('--swipe', '-88px'); }
        if (t.state.full) { row.classList.add('swiping', 'swipe-full'); row.style.setProperty('--swipe', '-240px'); }
        // A still of a delete following through (progress.js: sweep), partway off the screen, the red filling behind it.
        if (t.state.sweep) { row.classList.add('swiping', 'swipe-full'); row.style.setProperty('--swipe', -row.clientWidth * t.state.sweep + 'px'); }
        if (t.state.drag) { row.classList.add('dragged', ...t.state.with ? [] : ['held']); row.style.transform = `translateY(${t.state.drag}px)`; row.parentElement.classList.add('reordering'); }
        if (t.state.shift) row.style.transform = `translateY(${t.state.shift}px)`;
        if (t.state.aimed) row.classList.add('aimed');
        // A still of the exit (leaving.js), partway: each row folding at once, the rows below closing up with them.
        if (t.state.folding) { const h = row.offsetHeight, f = t.state.folding; Object.assign(row.style, {overflow: 'hidden', minHeight: '0', height: h * f + 'px', opacity: f, paddingTop: 12 * f + 'px', paddingBottom: 12 * f + 'px'}); }
      }
    });
  };
  c.loadPerms = () => {};                                  // nothing to ask Vikunja
  c.watchCard = () => {};                                  // an opened card stays open, off the screen too
  return c;
}));
Object.assign(window, globals);
