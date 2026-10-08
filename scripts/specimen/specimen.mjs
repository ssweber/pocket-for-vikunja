// The specimen page's code: Pocket's own Alpine component, as the app has it, given made-up tasks instead of signing in,
// so the task row can be seen in every state. Nothing here is sent anywhere: the rows can't be tapped (inert).
import {directives, globals, pocket} from '../../src/js/component.js';
import {setApp} from '../../src/js/util.js';
import {CHECKLIST_MARK} from '../../src/js/checklists.js';
import {blankSheet} from '../../src/js/app/core.js';

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
  const tent = task({title: 'Put up the tent'}), pegs = task({title: 'Hammer in the pegs', percent_done: .5, state: {held: 50}, related_tasks: {parenttask: [{id: tent.id}]}});
  const room = task({title: 'Book the back room', due_date: at(30 * HOUR), related_tasks: {parenttask: [{id: party.id}]}});
  const run = task({title: 'Opening up · Oct 7', project_id: 2, related_tasks: {copiedfrom: [{id: 900}], subtask: steps}, assignees: [me, priya]});
  // A long run: past 12 steps, its line is one, with a tick at each step (runLine).
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
  // Today's cards (cards.js): a task of high priority with one subtask of five done and four open (one of them yours),
  // paged to the second open one, 3 of 5; a run with a step counting down; a task with one subtask open; and one of 14,
  // past MANY_STEPS, five done, paged to 8 of 14, of low priority. Their subtasks are in the store, as Today keeps them.
  const kid = (id, f) => task({id, related_tasks: {parenttask: [{id: f.under}]}, ...f});
  const van2 = task({title: 'Pack the van', due_date: at(5 * HOUR), priority: 3, related_tasks: {subtask: [{id: 701, done: true}, {id: 702}, {id: 703}, {id: 704}, {id: 705}]}});
  const opening = task({title: 'Opening up · Oct 8', project_id: 2, assignees: [me], related_tasks: {copiedfrom: [{id: 898}], subtask: [{id: 711, done: true}, {id: 712}, {id: 713}]}});
  const sign = task({title: 'Repaint the sign', related_tasks: {subtask: [{id: 721, done: true}, {id: 722, done: true}, {id: 723}]}});
  const shelves = task({title: 'Stock the new shelves in the back room before the delivery comes', priority: 1, related_tasks: {subtask: Array.from({length: 14}, (_, i) => ({id: 731 + i, done: i < 5}))}});
  const cardSubs = [kid(701, {under: van2.id, title: 'Load chairs', done: true}), kid(702, {under: van2.id, title: 'Load tables', assignees: [priya]}),
    kid(703, {under: van2.id, title: 'Sound system', assignees: [me], percent_done: .5}), kid(704, {under: van2.id, title: 'Lights'}), kid(705, {under: van2.id, title: 'The extension leads'}),
    kid(711, {under: opening.id, project_id: 2, title: 'Turn on the espresso machine', done: true, related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 1}]}}),
    kid(712, {under: opening.id, project_id: 2, title: 'Take the croissants out', due_date: at(18 * 6e4), related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 2}]}}),
    kid(713, {under: opening.id, project_id: 2, title: 'Unlock the door', related_tasks: {parenttask: [{id: opening.id}], copiedfrom: [{id: 3}]}}),
    kid(723, {under: sign.id, title: 'Varnish it', assignees: [sam]}),
    ...Array.from({length: 14}, (_, i) => kid(731 + i, {under: shelves.id, title: 'Shelf ' + (i + 1), done: i < 5}))];
  // Today's rows, on one line (line: section 9): the title cut short; and at the right its priority's bars, small, from
  // none to do now (one-concept-plan, part 4), when it's due, short (a time today, a weekday this week, a date beyond,
  // red when late), and the project's dot.
  const dayAt = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const today = [task({title: 'Post next week’s rota', due_date: dayAt(0, 10, 30), priority: 3}),
    task({title: 'Call the plumber about the dishwasher that leaks under the sink again', due_date: dayAt(0, 15, 30), priority: 1, assignees: [priya]}),
    task({title: 'Pay the milk invoice', due_date: dayAt(-2, 9), priority: 4, project_id: 4}),
    task({title: 'Order the cups', due_date: dayAt(2, 0), priority: 2}), task({title: 'Book the window cleaner', due_date: dayAt(12, 0)}),
    task({title: 'Fix the till drawer', due_date: dayAt(0, 9), priority: 5, assignees: [me]})];
  return {parent, steps: runSteps(), cards: [van2, opening, sign, shelves], cardSubs, list: [
    {title: 'Today, on one line, priority as bars before the time: high, low, urgent, medium, none, do now', depth: {}, line: true, tasks: today},
    // Under Today's heading (its group's key): due today with no time says no time; with a time, its time.
    {title: 'Under the Today heading: due today with no time shows no time (“Today” elsewhere)', key: 'today', depth: {}, line: true, tasks: [
      task({title: 'Order the cups', due_date: dayAt(0, 0), priority: 2}), task({title: 'Post next week’s rota', due_date: dayAt(0, 16, 30)})]},
    // A project no one else can see (seenBy 0): no "+ me", nor your picture; someone given it in a shared project before it was moved here, still.
    {title: 'A project only you can see: no “+ me”, nor your picture; someone given it elsewhere, before it was moved there, still shows', depth: {}, tasks: [
      task({title: 'Renew the car insurance', project_id: 5}), task({title: 'Book the dentist', project_id: 5, assignees: [me]}),
      task({title: 'Fix the shed door', project_id: 5, assignees: [priya]})]},
    {title: 'Open, done, and waiting to send', depth: {}, tasks: [task({title: 'Order oat milk'}), task({title: 'Wipe the counters', done: true}),
      {...task({title: 'Call the plumber tomorrow'}), id: 'pending-specimen-0', pending: true, waits: true, entry: 'specimen', index: 0}]},
    {title: 'Progress', depth: {}, tasks: [task({title: 'Repaint the sign', percent_done: .3}), task({title: 'Train the new barista', percent_done: .7})]},
    {title: 'Subtasks, at depth 1 to 3', depth: {[top.id]: 0, [d1.id]: 1, [d2.id]: 2, [d3.id]: 3}, tasks: [top, d1, d2, d3]},
    {title: 'Due, priority, labels, people, comments', depth: {}, tasks: [
      task({title: 'Pay the milk invoice', due_date: at(-26 * HOUR), priority: 4}),
      task({title: 'Prep the specials board', due_date: at(2 * HOUR), labels: [label(1, 'Front', 'e07a5f'), label(2, 'Daily', '3d85c6')]}),
      task({title: 'Check the fridge temperatures', due_date: at(50 * HOUR), assignees: [me, priya], comment_count: 3, repeat_after: 86400}),
      task({title: 'Book the window cleaner', project_id: 4, priority: 2, attachments: [{id: 1}], reminders: [{reminder: at(5 * HOUR)}], assignees: [sam]})]},
    {title: 'A done task over its subtasks still open', depth: {[party.id]: 0, [cake.id]: 1, [room.id]: 1}, heads: [party.id], tasks: [party, cake, room]},
    {title: 'Checklist runs, as under Checklists, on a project’s list and in search: one row, who it’s for, and a line in segments, a step each (past 12 steps, one line with a tick at each), with no count of its steps or the next', depth: {}, tasks: [run, long]},
    {title: 'A run’s step counting down, with no 🔔 for the reminder Pocket gave it; a task’s reminder still to come has one', depth: {}, tasks: [timed,
      task({title: 'Call the plumber', reminders: [{reminder: at(5 * HOUR)}]})]},
    {title: 'A checklist’s step has a square box (a step you’ve claimed, on Today), a task or a subtask a round one', depth: {}, tasks: [stepRow, subRow]},
    {title: 'Read only: a project shared with you to read', depth: {}, tasks: [task({title: 'Quarterly stock count', project_id: 3})]},
    // Held and slid (progress.js), swiped to its Delete (a project's list, which has one: delete), and a line in a
    // row's place (lines.js): shown by `state`.
    {title: 'Held at 50%, held at 100%, swiped to its Delete, and past half the row', depth: {}, delete: true, tasks: [
      task({title: 'Restock the napkins', percent_done: .5, state: {held: 50}}), task({title: 'Clean the grinder', percent_done: .75, state: {held: 100}}),
      task({title: 'Order more cups', state: {swiped: true}}), task({title: 'Return the crates', state: {full: true}})]},
    {title: 'A full swipe let go, or Delete tapped: the row carries on off the screen, leaving a gap with Restore', depth: {}, delete: true,
      tasks: [task({title: 'Wipe the menus', state: {sweep: .8}}), task({title: 'Wipe the menus', state: {leaving: 'deleted'}})]},
    // Ticked and deleted, where they were until the batch clears (leaving.js): a parent with the subtask closed with it,
    // a deleted row's gap with Restore, and a repeating task ticked; then the batch clearing, its rows partway folded.
    {title: 'Ticked and deleted, in place: a parent with its subtask, a deleted row’s gap with Restore, a repeating task', depth: {[mover.id]: 0, [moverKid.id]: 1}, tasks: [
      mover, moverKid, task({title: 'Return the crates', due_date: at(4 * HOUR), assignees: [priya], state: {leaving: 'deleted'}}),
      task({title: 'Water the plants', done: true, due_date: at(-HOUR), repeat_after: 86400, state: {leaving: 'done'}}), task({title: 'Order oat milk'})]},
    {title: 'The batch clearing: the rows ticked and deleted fold together, and the row below closes up once', depth: {}, tasks: [
      task({title: 'Sweep the yard', done: true, state: {leaving: 'done', folding: .45}}), task({title: 'Wipe the menus', state: {leaving: 'deleted', folding: .45}}),
      task({title: 'Light the heaters'})]},
    // Slid on a task no one was doing: your initials in place of "+ me" as the slide starts (claimOnSlide).
    {title: 'Slid on a task no one was doing: yours as the slide starts', depth: {}, tasks: [task({title: 'Restock the napkins', state: {held: 25, claim: true}})]},
    {title: 'A subtask held at 50%: its fill starts where its progress line does', depth: {[tent.id]: 0, [pegs.id]: 1}, tasks: [tent, pegs]},
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
  c.specimen = []; c.specimenCards = []; c.specimenRunCards = []; c.specimenAdding = {steps: [], at: null, target: {}};
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
    steps[7] = {...steps[7], state: {held: 75}};
    /* Steps added from the bottom box, one after another, after the step on the card: two sent, the third waiting to
       be sent, and the line above the box naming it (runAim). */
    const mk = title => ({...s.steps[5], id: ++n, title, comments: [], assignees: []});
    const inRow = [...s.steps.slice(0, 5), mk('Fill the water jug'), mk('Wipe the counter'), ...s.steps.slice(5)];
    this.pending.push({kind: 'step', id: 'specimen-step', run: run.id, title: 'Stack the trays', before: s.steps[5].id, after: inRow[6].id, at: new Date().toISOString(), tpl: null, from: null, items: [], files: []});
    this.slow.push('specimen-step');
    this.view.run = {run, steps: inRow, at: 4, last: null};
    // (from the step before the card's to the run's next steps; other ids, so the held state above stays on its own row)
    this.specimenAdding = {steps: this.runView.steps.slice(3, 10).map(x => x.pending ? x : {...x, id: x.id + 2000}), at: 4, target: {step: true, after: 'Stack the trays', repeat: this.runView.step.title, canRepeat: true}};
    // Today's cards: their subtasks in the store, the van's paged to its second open step, the shelves' to their third.
    for (const x of s.cardSubs) this.keep(x);
    this.specimenCards = s.cards.map(t => this.keep(t));
    this.view.cards = Object.fromEntries(s.cards.map(t => [t.id, {when: null, made: null, focus: null}]));
    this.cardPage = {[s.cards[0].id]: {id: 703, i: 1}, [s.cards[3].id]: {id: 738, i: 2}};
    this.specimen = [...s.list, {title: 'In a task\'s sheet: its subtasks, with who\'s doing each', depth: {}, sheet: true, delete: true, reorder: true, tasks: subs},
      {title: 'A run\'s steps on its screen: done by you, by Priya, skipped, the step on its card (counting down), inserted, repeated, held at 75%, late, waiting on another step, and a tick waiting to send',
        depth: {}, run: true, at: 4, locked: false, tasks: steps},
      // (other ids, so the held state above stays on its own row)
      {title: 'The same steps in a run finished, or shared with you to read only', depth: {}, run: true, at: null, locked: true,
        tasks: finished.map(x => ({...x, id: x.id + 1000}))}];
    // The states a finger makes, put on the rows as the app does.
    const all = this.specimen.flatMap(g => g.tasks).filter(t => t.state);
    for (const t of all) if (t.state.line) this.lines[t.id] = {id: t.id, title: t.title, more: '', action: {label: 'Undo', fn(){}}, ...t.state.line};
    for (const t of all) if (t.state.leaving) this.leaving[t.id] = t.state.leaving;
    for (const t of all) if (t.state.flash) this.flashed[t.state.flash].push(t.id);
    for (const t of all) if (t.state.claim) this.slideClaim = t.id;
    this.$nextTick(() => {
      for (const t of all) for (const row of document.querySelectorAll(`.row[data-id="${t.id}"]`)) {
        if (t.state.held) { row.classList.add('held'); this.showSlide(row, t.state.held, 0); }
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
  return c;
}));
Object.assign(window, globals);
