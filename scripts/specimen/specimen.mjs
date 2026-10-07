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
  {id: 3, title: 'Head office', hex_color: '6a5acd'}, {id: 4, title: 'Upkeep', hex_color: '3d85c6'}];

// The sections of the page: each a list of rows, as `g` is to a row in the app (its depth under the task above it,
// and whether it's in a task's sheet).
function sections(){
  const top = task({title: 'Set up the new till'}), d1 = task({title: 'Unbox it', related_tasks: {parenttask: [{id: top.id}]}});
  const d2 = task({title: 'Find the receipt roll', related_tasks: {parenttask: [{id: d1.id}]}});
  const d3 = task({title: 'Ask Priya where it went', related_tasks: {parenttask: [{id: d2.id}]}, done: true});
  const steps = [{id: 901, title: 'Turn on the espresso machine', done: true}, {id: 902, title: 'Put the croissants in the oven', done: true},
    {id: 903, title: 'Take the croissants out', done: false}, {id: 904, title: 'Wipe down the tables', done: false}];
  const run = task({title: 'Opening up · Oct 7', project_id: 2, related_tasks: {copiedfrom: [{id: 900}], subtask: steps}, assignees: [me, priya]});
  const parent = task({title: 'Deep clean', related_tasks: {subtask: [
    task({id: 801, title: 'Nobody yet: + me claims it'}), task({id: 802, title: 'Yours: tap to let it go', due_date: at(3 * HOUR)}),
    task({id: 803, title: 'Someone else\'s', due_date: at(-2 * HOUR), priority: 3}), task({id: 804, title: 'Done, by two people', done: true})]}});
  return {parent, list: [
    {title: 'Open, done, and waiting to send', depth: {}, tasks: [task({title: 'Order oat milk'}), task({title: 'Wipe the counters', done: true}),
      {...task({title: 'Call the plumber tomorrow'}), id: 'pending-specimen-0', pending: true, entry: 'specimen', index: 0}]},
    {title: 'Progress', depth: {}, tasks: [task({title: 'Repaint the sign', percent_done: .3}), task({title: 'Train the new barista', percent_done: .7})]},
    {title: 'Subtasks, at depth 1 to 3', depth: {[top.id]: 0, [d1.id]: 1, [d2.id]: 2, [d3.id]: 3}, tasks: [top, d1, d2, d3]},
    {title: 'Due, priority, labels, people, comments', depth: {}, tasks: [
      task({title: 'Pay the milk invoice', due_date: at(-26 * HOUR), priority: 4}),
      task({title: 'Prep the specials board', due_date: at(2 * HOUR), labels: [label(1, 'Front', 'e07a5f'), label(2, 'Daily', '3d85c6')]}),
      task({title: 'Check the fridge temperatures', due_date: at(50 * HOUR), assignees: [me, priya], comment_count: 3, repeat_after: 86400}),
      task({title: 'Book the window cleaner', project_id: 4, priority: 2, attachments: [{id: 1}], reminders: [{reminder: at(5 * HOUR)}], assignees: [sam]})]},
    {title: 'A checklist run', depth: {}, tasks: [run]},
    {title: 'Read only: a project shared with you to read', depth: {}, tasks: [task({title: 'Quarterly stock count', project_id: 3})]},
    // Held and slid (progress.js), swiped to its Delete, and a line in a row's place (lines.js): shown by `state`.
    {title: 'Held at 50%, held at 100%, swiped to its Delete, and past half the row', depth: {}, tasks: [
      task({title: 'Restock the napkins', percent_done: .5, state: {held: 50}}), task({title: 'Clean the grinder', percent_done: .75, state: {held: 100}}),
      task({title: 'Order more cups', state: {swiped: true}}), task({title: 'Return the crates', state: {full: true}})]},
    {title: 'A line in a row\'s place: ticked off, deleted, a repeating task ticked, and a tick not saved', depth: {}, tasks: [
      task({title: 'Pack the van', state: {line: {text: 'Done:', more: '+ 4 subtasks'}}}), task({title: 'Load chairs', state: {line: {text: 'Deleted'}}}),
      task({title: 'Water the plants', state: {line: {text: 'Repeats · next Friday 9:00 AM', title: '', stays: true}}}),
      task({title: 'Call the plumber', state: {line: {text: 'Not saved: no connection', title: '', stays: true, cls: 'failed', action: {label: 'Try again', fn(){}}}}})]},
    // Lit up as its time passes, moving to Overdue (alerts.js), and just added (the page holds both at their start).
    {title: 'Just come due, and just added', depth: {}, tasks: [task({title: 'Collect the cake order', due_date: at(-60e3), state: {flash: 'due'}}),
      task({title: 'Order more cups', state: {flash: 'fresh'}})]},
  ]};
}

document.addEventListener('alpine:init', () => directives(Alpine));
document.addEventListener('alpine:init', () => Alpine.data('specimen', () => {
  const c = pocket();
  c.specimen = [];
  // A message in its place (lines.js: sayAt), each as the app shows it.
  const undo = {label: 'Undo', fn(){}};
  c.specimenLines = [{key: 1, place: 'overdue', text: 'Moved 6 to today', action: undo},
    {key: 2, place: 'cap', text: 'Added to Head office, due Friday', action: {label: 'Open', fn(){}}},
    {key: 3, place: 'sheet:top', text: 'Not saved: no connection', cls: 'failed', action: {label: 'Try again', fn(){}}},
    {key: 4, place: 'sheet:subtasks', text: 'Done: Deep clean, with 3 subtasks', action: undo},
    {key: 5, place: 'step', text: 'Done: Take the croissants out', action: undo}];
  // In place of signing in and loading: you, your projects, what you can change in each, and the tasks.
  c.init = function(){
    setApp(this);
    const s = sections(), subs = s.parent.related_tasks.subtask;
    Object.assign(this, {signedIn: true, screen: 'app', user: me, route: {name: 'today'}, perms: {1: 2, 2: 2, 3: 0, 4: 1},
      avatars: Object.fromEntries([me, priya, sam].map(u => [u.username, {url: '', at: Date.now()}])), labelsLoaded: true});
    this.setProjects(projects);
    // A task's sheet, open on a task with subtasks, for its rows' slots: who's doing each.
    this.sheet = {...blankSheet('task'), task: s.parent, subPeople: {801: [], 802: [me], 803: [priya], 804: [priya, sam]}};
    this.specimen = [...s.list, {title: 'In a task\'s sheet: its subtasks, with who\'s doing each', depth: {}, sheet: true, tasks: subs}];
    // The states a finger makes, put on the rows as the app does.
    const all = s.list.flatMap(g => g.tasks).filter(t => t.state);
    for (const t of all) if (t.state.line) this.lines[t.id] = {id: t.id, title: t.title, more: '', hide: [], action: {label: 'Undo', fn(){}}, ...t.state.line};
    for (const t of all) if (t.state.flash) this.flashed[t.state.flash].push(t.id);
    this.$nextTick(() => {
      for (const t of all) for (const row of document.querySelectorAll(`.row[data-id="${t.id}"]`)) {
        if (t.state.held) { row.classList.add('held'); this.showSlide(row, t.state.held, 0); }
        if (t.state.swiped) { row.classList.add('swiped'); row.style.setProperty('--swipe', '-88px'); }
        if (t.state.full) { row.classList.add('swiping', 'swipe-full'); row.style.setProperty('--swipe', '-240px'); }
      }
    });
  };
  c.loadPerms = () => {};                                  // nothing to ask Vikunja
  return c;
}));
Object.assign(window, globals);
