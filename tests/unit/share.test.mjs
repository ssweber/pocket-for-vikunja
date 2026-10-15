// Sharing progress as plain text, and sharing a task or a project as a Markdown list that quick add can read back
// (src/js/share.js). The tests set the clock to Wednesday 7 October 2026, 14:20. Quick add (src/js/quickadd.js) reads
// the copy back using the same chrono library as the page, so it reads a date's time as well.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { bar, doneTodayText, dueStamp, dueWords, firstName, markdownText, progress, repeatPhrase, shareText } from '../../src/js/share.js';
import { parseCapture, QUICK_ADD_PREFIXES, readList, removeAssignee } from '../../src/js/quickadd.js';
import { component } from './fake.mjs';
import sharing from '../../src/js/app/sharing.js';
import cards from '../../src/js/app/cards.js';
import runs from '../../src/js/app/runs.js';
import claims from '../../src/js/app/claims.js';
import checklists from '../../src/js/app/checklists.js';
import views from '../../src/js/app/views.js';
import sending from '../../src/js/app/sending.js';
import tasks from '../../src/js/app/tasks.js';
import { todayGroups } from '../../src/js/lists.js';

const NOW = new Date(2026, 9, 7, 14, 20);
const on = (d, h = 0) => new Date(2026, 9, d, h).toISOString();
const day = d => new Date(2026, 9, d).toLocaleDateString([], { weekday: 'short' });
const date = d => new Date(2026, 9, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
const priya = { username: 'priya', name: 'Priya Shah' }, sam = { username: 'sam', name: '' }, jo = { username: 'jo', name: 'Jo' };
const item = (title, more = {}) => ({ title, done: false, pct: 0, items: [], ...more });
const text = doc => shareText(doc, NOW), md = (doc, opts) => markdownText(doc, opts);
globalThis.chrono = await import('../../pocket/app/' + readdirSync(new URL('../../pocket/app/', import.meta.url)).find(f => /^chrono-.*\.js$/.test(f)));
// The task "Pack the van" has its own progress of 60%. One subtask is done, one is at 50%, one has Priya assigned, and one is not started.
const van = { kind: 'task', ...item('Pack the van', { pct: 60 }), items: [
  item('Load chairs', { done: true }), item('Tables', { pct: 50 }), item('Sound system', { people: [priya] }), item('Lights')] };

test('the bar has five segments, the first fills once work begins, and the fifth fills only when all is done', () => {
  assert.equal(bar(0), '▱▱▱▱▱');
  assert.equal(bar(3), '▰▱▱▱▱');
  assert.equal(bar(50), '▰▰▰▱▱');
  assert.equal(bar(60), '▰▰▰▱▱');
  assert.equal(bar(99), '▰▰▰▰▱');
  assert.equal(bar(100), '▰▰▰▰▰');
});

test('a person is shown by the first word of their name, or by their username if they have no name', () => {
  assert.equal(firstName(priya), 'Priya');
  assert.equal(firstName(sam), 'sam');
  assert.equal(firstName({ username: 'al', name: '  Alex  Kim ' }), 'Alex');
  assert.equal(firstName(null), '');
});

test('a task is shared as plain text with a bar, a mark for each subtask and the people assigned', () => {
  assert.equal(text(van), ['Pack the van  ▰▰▰▱▱ 60%', '✓ Load chairs', '◐ Tables 50%', '○ Sound system · Priya', '○ Lights'].join('\n'));
});

test('progress is the task\'s own percentage, else the share of its subtasks that are done, else none', () => {
  assert.deepEqual(progress(item('a', { pct: 40, items: [item('b', { done: true })] })), { pct: 40, words: '40%' }, 'the task\'s own percentage comes first');
  const parent = item('Pack the van', { items: [item('a', { done: true }), item('b'), item('c'), item('d')] });
  assert.deepEqual(progress(parent), { pct: 25, words: '1 of 4 done' });
  assert.equal(text({ kind: 'task', ...parent }).split('\n')[0], 'Pack the van  ▰▱▱▱▱ 1 of 4 done');
  assert.deepEqual(progress(item('x', { done: true })), { pct: 100, words: 'done' });
  assert.deepEqual(progress(item('x', { done: true, pct: 40 })), { pct: 100, words: 'done' }, 'a done task is 100%, whatever percentage was set');
  assert.equal(text({ kind: 'task', ...item('Order milk') }), 'Order milk', 'a task with no progress has no bar');
  // A project's task lists only its open subtasks, but its progress counts all of its subtasks (`subs`).
  assert.deepEqual(progress(item('x', { items: [item('a')], subs: { done: 3, total: 4 } })), { pct: 75, words: '3 of 4 done' });
});

test('subtasks of a subtask are indented two more spaces at each level', () => {
  const doc = { kind: 'task', ...item('Event'), items: [
    item('Stage', { items: [item('Lights', { done: true }), item('Cables', { items: [item('Long one', { pct: 25 })] })] }), item('Food')] };
  assert.equal(text(doc), ['Event  ▱▱▱▱▱ 0 of 2 done', '◐ Stage (1 of 2 done)', '  ✓ Lights', '  ○ Cables (0 of 1 done)', '    ◐ Long one 25%', '○ Food'].join('\n'));
  // A task with subtasks has no percentage of its own in the copy, because its progress is calculated from the subtasks.
  assert.equal(md(doc), ['## Event', '- [ ] Stage', '  - [x] Lights', '  - [ ] Cables', '    - [ ] Long one (25%)', '- [ ] Food'].join('\n'));
});

test('assigned people are listed once each by name, and due dates are written in a few words', () => {
  const doc = { kind: 'task', ...item('Opening', { due: on(9, 17), people: [priya, sam] }), items: [
    item('Chairs', { people: [priya, sam, { username: 'priya2', name: 'Priya' }] }), item('Float', { due: on(7, 18) }), item('Keys', { due: on(8) }),
    item('Sign', { due: on(20) }), item('Bins', { due: on(5) }), item('Mop', { due: on(6), done: true })] };
  assert.equal(text(doc), [`Opening  ▰▱▱▱▱ 1 of 6 done · due ${day(9)} · Priya, sam`, '○ Chairs · Priya, sam', '○ Float · due today', '○ Keys · due tomorrow',
    `○ Sign · due ${date(20)}`, `○ Bins · overdue since ${day(5)}`, '✓ Mop'].join('\n'));
  assert.equal(dueWords(on(6), NOW), 'overdue since yesterday');
  assert.equal(dueWords('0001-01-01T00:00:00Z', NOW), '');
  assert.match(dueWords(new Date(2027, 0, 5).toISOString(), NOW), /2027/, 'a date in another year shows the year');
});

test('a long list collapses its done tasks into one line, at the position of the first done task', () => {
  const done = n => Array.from({ length: n }, (_, i) => item('Done ' + (i + 1), { done: true }));
  const open = n => Array.from({ length: n }, (_, i) => item('Open ' + (i + 1)));
  const long = { kind: 'task', ...item('Inventory'), items: [item('First'), ...done(7), ...open(4)] };
  assert.equal(text(long), ['Inventory  ▰▰▰▱▱ 7 of 12 done', '○ First', '✓ 7 done', ...open(4).map(o => '○ ' + o.title)].join('\n'));
  // 5 done tasks are few enough to list one by one, and a list of 10 lines is short enough to show in full.
  assert.equal(text({ kind: 'task', ...item('A'), items: [...done(5), ...open(7)] }).split('\n').length, 13);
  assert.equal(text({ kind: 'task', ...item('B'), items: [...done(6), ...open(4)] }).split('\n').length, 11);
  // A Markdown list is a full copy, so it collapses nothing.
  assert.equal(md(long).split('\n').filter(l => l.startsWith('- [x]')).length, 7);
});

test('a checklist shows who did each step, who skipped one, and who is assigned to the rest', () => {
  const run = { kind: 'run', ...item('Startup · Oct 7'), items: [
    item('Check the guards', { done: true, by: [priya] }), item('Warm up the press', { done: true, skipped: true, by: [sam] }),
    item('First article check', { pct: 50, people: [jo] }), item('Sweep up', { people: [priya, jo] })] };
  assert.equal(text(run), ['Startup · Oct 7  ▰▰▰▱▱ 1 of 4 done · 1 skipped', '✓ Check the guards · Priya', '– Warm up the press · skipped by sam',
    '◐ First article check 50% · Jo', '○ Sweep up · Priya, Jo'].join('\n'));
  // When the done steps are collapsed into one line, the line still names who did them.
  const many = { kind: 'run', ...item('Close · Oct 7'), items: [...['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => item(t, { done: true, by: [i % 2 ? sam : priya] })),
    item('g', { done: true, skipped: true, by: [jo] }), ...['h', 'i', 'j', 'k'].map(t => item(t))] };
  assert.deepEqual(text(many).split('\n').slice(0, 2), ['Close · Oct 7  ▰▰▰▱▱ 6 of 11 done · 1 skipped', '✓ 6 done, 1 skipped · Priya, sam, Jo']);
});

test('a project shows its counts, its open tasks with a bar where there is progress, and a count of done tasks', () => {
  const doc = { kind: 'project', title: 'Café', open: 6, doneCount: 5, items: [
    item('Order milk', { due: on(9) }),
    { ...item('Pack the van', { pct: 60, people: [priya] }), items: [item('Tables', { pct: 50 }), item('Sound system', { people: [sam] })], subs: { done: 1, total: 3 } },
    { ...item('Deep clean'), items: [item('Fridge')], subs: { done: 2, total: 3 } },
    { ...item('Old menu', { done: true }), items: [item('Reprint')], subs: { done: 0, total: 1 } }] };
  assert.equal(text(doc), ['Café  6 open · 5 done', `○ Order milk · due ${day(9)}`, '◐ Pack the van  ▰▰▰▱▱ 60% · Priya', '  ◐ Tables 50%', '  ○ Sound system · sam',
    '◐ Deep clean  ▰▰▰▱▱ 2 of 3 done', '  ○ Fridge', '✓ Old menu', '  ○ Reprint', '✓ 5 done'].join('\n'));
  // The copy starts with one heading that has the project's name and counts. Pasting leaves the heading out. The open tasks follow in quick add's syntax.
  assert.equal(md(doc), ['# Café · 6 open · 5 done', '- [ ] Order milk 2026-10-09 at 00:00', '- [ ] Pack the van @priya', '  - [ ] Tables (50%)',
    '  - [ ] Sound system @sam', '- [ ] Deep clean', '  - [ ] Fridge', '- [x] Old menu', '  - [ ] Reprint'].join('\n'));
  assert.deepEqual(pasted(md(doc)), doc.items.map(same), 'pasted into quick add, the copy makes the same tasks and leaves out the heading');
  assert.deepEqual(readList(md(doc)).names, ['Café · 6 open · 5 done']);
  assert.equal(md({ kind: 'project', title: 'Empty', open: 0, doneCount: 0, items: [] }), '# Empty · 0 open');
  assert.equal(text({ kind: 'project', title: 'Empty', open: 0, doneCount: 0, items: [] }), 'Empty  0 open');
  // The project's Done shows its latest 100 tasks but counts all of them. The text uses that full count, formatted the same way as the project's heading.
  const big = { kind: 'project', title: 'Big', open: 1200, doneCount: 3000, items: [] }, n = x => x.toLocaleString();
  assert.equal(text(big), [`Big  ${n(1200)} open · ${n(3000)} done`, `✓ ${n(3000)} done`].join('\n'));
  assert.equal(md(big), `# Big · ${n(1200)} open · ${n(3000)} done`);
});

/* A Markdown copy can be read back. It uses quick add's syntax, so pasting it into Pocket's add box creates the same
   tasks. */
// The same task "Pack the van", now with everything a line can express. The task is assigned to Priya, has priority 3
// and is due on the 16th at the default due time. One subtask has its own subtask. Another subtask is assigned to Sam,
// has a label, repeats every week and is due at 15:30.
const packed = { kind: 'task', ...item('Pack the van', { pct: 60, due: on(16, 12), people: [priya], priority: 3 }), items: [
  item('Load chairs', { done: true }), item('Tables', { pct: 50, items: [item('Legs')] }), item('Lights', { pct: 50 }),
  item('Sound system', { people: [sam], labels: ['hire'], repeat: { after: 604800, mode: 0 }, due: new Date(2026, 9, 15, 15, 30).toISOString() })] };
test('a task is copied as a Markdown list in quick add\'s syntax, with a heading, a line per subtask and the date last', () => {
  assert.equal(md(packed), ['## Pack the van @priya !3 2026-10-16', '- [x] Load chairs', '- [ ] Tables', '  - [ ] Legs', '- [ ] Lights (50%)',
    '- [ ] Sound system @sam *hire every week 2026-10-15 at 15:30'].join('\n'));
  assert.equal(md({ kind: 'task', ...item('Order milk', { pct: 25 }) }), '## Order milk (25%)', 'a task with no subtasks shows its own progress');
  assert.equal(md({ kind: 'task', ...item('Order milk', { done: true, pct: 25 }) }), '## [x] Order milk', 'a done task is marked [x]');
  assert.equal(md(van), ['## Pack the van', '- [x] Load chairs', '- [ ] Tables (50%)', '- [ ] Sound system @priya', '- [ ] Lights'].join('\n'));
});

test('the copy uses the user\'s prefixes, quotes a name with a space, and uses none when quick add is turned off', () => {
  const doc = { kind: 'task', ...item('Call the hire shop', { people: [priya, sam, priya], priority: 5, labels: ['call back', 'hire'], due: on(16, 12) }), items: [item('Ask for a quote', { pct: 50, people: [sam] })] };
  assert.equal(md(doc), '## Call the hire shop @priya @sam !5 *"call back" *hire 2026-10-16\n- [ ] Ask for a quote (50%) @sam');
  assert.equal(md(doc, { mode: 'todoist' }), '## Call the hire shop +priya +sam !5 @"call back" @hire 2026-10-16\n- [ ] Ask for a quote (50%) +sam');
  assert.equal(md(doc, { mode: 'disabled' }), '## Call the hire shop\n- [ ] Ask for a quote (50%)', 'only the title is written when quick add is turned off');
  assert.equal(md({ kind: 'task', ...item('x', { priority: 9 }) }), '## x', 'a priority that Vikunja does not have is not written');
});

test('a due date is written in numbers with its year, and with its time only when it is not the default due time', () => {
  assert.equal(dueStamp(on(16, 12)), '2026-10-16');
  assert.equal(dueStamp(new Date(2026, 9, 5, 15, 30).toISOString()), '2026-10-05 at 15:30', 'the same format applies whether or not the date is overdue');
  assert.equal(dueStamp(new Date(2027, 0, 3, 5, 5).toISOString()), '2027-01-03 at 05:05', 'the time has two digits, so "at 05:05" is not read as the afternoon');
  assert.equal(dueStamp(new Date(2026, 9, 16, 9, 0).toISOString(), '9:00'), '2026-10-16', 'the user\'s default due time leaves out the time');
  assert.equal(dueStamp(on(16, 12), '09:00'), '2026-10-16 at 12:00');
  assert.equal(dueStamp('0001-01-01T00:00:00Z'), '');
  assert.equal(dueStamp(null), '');
});

test('a repeat is written in quick add\'s syntax and reads back as the same repeat', () => {
  const H = 3600, D = 86400;
  const cases = [[{ mode: 1 }, 'every month'], [{ after: D, mode: 0 }, 'every day'], [{ after: 3 * D, mode: 0 }, 'every 3 days'], [{ after: 7 * D, mode: 0 }, 'every week'],
    [{ after: 14 * D, mode: 0 }, 'every 2 weeks'], [{ after: 30 * D, mode: 0 }, 'every 30 days'], [{ after: 365 * D, mode: 0 }, 'every year'], [{ after: 730 * D, mode: 0 }, 'every 2 years'],
    [{ after: 6 * H, mode: 0 }, 'every 6 hours'], [{ after: H, mode: 0 }, 'every hour']];
  for (const [r, words] of cases) {
    assert.equal(repeatPhrase(r), words);
    const back = parseCapture('Water the plants ' + words, [], { now: NOW }).repeat;
    assert.deepEqual([back.after, back.mode], [r.after || 0, r.mode], words + ' reads back as the same repeat');
  }
  assert.equal(repeatPhrase({ after: 0, mode: 0 }), '');
  assert.equal(repeatPhrase({ after: 5400, mode: 0 }), '', 'an hour and a half has no repeat text');
  assert.equal(repeatPhrase(undefined), '');
});

/* The tests below check that a copy pasted into quick add's box makes the same tasks. `pasted` turns text into the
   items quick add would create. `same` reduces an item to what a paste can bring back. A paste can't restore a
   parent's progress, because that is calculated. It also can't restore a done task's progress, or a time's seconds. */
const NO_REPEAT = { after: 0, mode: 0 };
function pasted(text, { mode = 'vikunja', dueTime = '12:00' } = {}){
  const list = readList(text, { colon: true }), P = QUICK_ADD_PREFIXES[mode];
  const nodes = list.lines.map(l => {
    const p = parseCapture(l.text, [], { mode, dueTime, now: NOW });
    // Assigning a person removes their name from the title, as createTask does (sync.js).
    return { title: p.assignees.reduce((t, n) => removeAssignee(t, P.assignee, n), p.title), done: l.done, pct: p.pct, due: p.due ? p.due.toISOString() : null, people: p.assignees,
      priority: p.priority, labels: p.labels, repeat: p.repeat ? { after: p.repeat.after, mode: p.repeat.mode } : NO_REPEAT, items: [] };
  });
  const top = [];
  list.lines.forEach((l, i) => (l.under === null ? top : nodes[l.under].items).push(nodes[i]));
  for (const n of nodes) if (n.items.length) n.pct = 0;                        // a parent's progress is dropped, as boxParsedLines drops it
  return top;
}
const same = it => ({ title: it.title, done: !!it.done, pct: it.done || (it.items || []).length || it.subs?.total ? 0 : it.pct || 0, due: it.due || null, people: [...new Set((it.people || []).map(u => u.username))],
  priority: it.priority || 0, labels: it.labels || [], repeat: it.repeat || NO_REPEAT, items: (it.items || []).map(same) });

test('a task\'s copy pasted into quick add makes the same tasks, with their nesting, people, labels, dates and progress', () => {
  assert.deepEqual(pasted(md(packed)), [same(packed)]);
  assert.deepEqual(pasted(md(van)), [same(van)]);
  // The same check in Todoist mode, which uses different prefixes, and with a different default due time.
  assert.deepEqual(pasted(md(packed, { mode: 'todoist' }), { mode: 'todoist' }), [same(packed)]);
  assert.deepEqual(pasted(md(packed, { dueTime: '15:30' }), { dueTime: '15:30' }), [same(packed)]);
  // The next cases are subtasks of subtasks, a done task, and a task with no subtasks that has its own progress.
  const deep = { kind: 'task', ...item('Event', { done: true }), items: [item('Stage', { items: [item('Lights', { done: true }), item('Cables', { items: [item('Long one', { pct: 25, priority: 2 })] })] }), item('Food')] };
  assert.deepEqual(pasted(md(deep)), [same(deep)]);
  const one = { kind: 'task', ...item('Order milk', { pct: 75, due: new Date(2025, 0, 2, 8, 5).toISOString(), repeat: { mode: 1, after: 0 }, labels: ['call back'] }) };
  assert.equal(md(one), '## Order milk (75%) *"call back" every month 2025-01-02 at 08:05');
  assert.deepEqual(pasted(md(one)), [same(one)], 'a date long past reads back as that date');
});

/* A title that contains text quick add would read as a date, person, label or similar is put in quotes, so quick add
   doesn't read it that way. Only titles that need quotes get them, and most titles don't. */
test('a title that quick add would read as syntax is quoted, with single quotes if it contains a ", and any other title is not', () => {
  const line = (title, more = {}, opts) => md({ kind: 'task', ...item('Event'), items: [item(title, more)] }, opts).split('\n')[1];
  const head = (title, more = {}) => md({ kind: 'task', ...item(title, more), items: [item('a')] }).split('\n')[0];
  assert.equal(line('Lunch friday', { people: [sam], due: on(16, 12) }), '- [ ] "Lunch friday" @sam 2026-10-16', 'a title containing a day is quoted');
  assert.equal(line('Lunch with the team'), '- [ ] Lunch with the team', 'a title with nothing to read has no quotes');
  assert.equal(line('Call "Bob" tomorrow'), '- [ ] \'Call "Bob" tomorrow\'');
  assert.equal(line('"Hamlet" rehearsal'), '- [ ] \'"Hamlet" rehearsal\'', 'double quotes at the start of a title would hold only that word, so single quotes are used');
  assert.equal(line('Don\'t forget the keys'), '- [ ] Don\'t forget the keys');
  assert.equal(line('Ask @sam about the *hire'), '- [ ] "Ask @sam about the *hire"', 'a title containing a person and a label is quoted');
  assert.equal(line('Discount 50%'), '- [ ] "Discount 50%"', 'a title ending in a percentage is quoted');
  assert.equal(line('Order 50% more cups'), '- [ ] Order 50% more cups');
  assert.equal(line('Standup every week'), '- [ ] "Standup every week"');
  assert.equal(line('Paint !2 coats'), '- [ ] "Paint !2 coats"');
  // The rest of the line matters. "in" before a date would be read as part of the date.
  assert.equal(line('Sign in'), '- [ ] Sign in');
  assert.equal(line('Sign in', { due: on(16, 12) }), '- [ ] "Sign in" 2026-10-16');
  // The user's prefix settings decide what is read. #3 is a project only in Todoist mode.
  assert.equal(line('Use #3 screws'), '- [ ] Use #3 screws');
  assert.equal(line('Use #3 screws', {}, { mode: 'todoist' }), '- [ ] "Use #3 screws"');
  assert.equal(line('Lunch friday', {}, { mode: 'disabled' }), '- [ ] Lunch friday', 'with quick add turned off, nothing is read, so no quotes');
  // After the bullet and checkbox, the start of a line is plain text. The start of a heading can mark the task as done, or be read as the first line of a list.
  assert.equal(line('x marks the spot'), '- [ ] x marks the spot');
  assert.equal(head('x marks the spot'), '## "x marks the spot"');
  assert.equal(head('X marks the spot'), '## "X marks the spot"', 'a capital X also marks a task done');
  assert.equal(head('- [x] a box in its name'), '## "- [x] a box in its name"');
  assert.equal(head('Groceries:'), '## "Groceries:"', 'a colon at the end of a first line would make it a parent and be removed');
  assert.equal(line('Groceries:'), '- [ ] Groceries:');
  assert.equal(head('Pack the van'), '## Pack the van');
});

test('a copy with quoted titles reads back as the same tasks', () => {
  const titles = ['Lunch friday', 'Call "Bob" tomorrow', '"Hamlet" rehearsal', 'Don\'t forget the keys', 'Ask @sam about the *hire', 'Discount 50%', 'Standup every week', 'Paint !2 coats',
    'Sign in', 'x marks the spot', '2026-10-16', 'Pay rent by the 17th', 'Order 3/4 inch screws', '+Garden shed', 'Tables (50%)'];
  const doc = { kind: 'task', ...item('x marks the spot:', { people: [priya], priority: 2 }), items: titles.map((t, i) => item(t, { people: i % 2 ? [sam] : [], due: i % 3 ? on(16, 12) : null,
    done: i % 5 === 0, pct: i % 4 === 1 ? 25 : 0, labels: i % 7 === 2 ? ['call back'] : [], items: i === 3 ? [item('every day at 5'), item('- [x] not a box')] : [] })) };
  assert.deepEqual(pasted(md(doc)), [same(doc)]);
  assert.deepEqual(pasted(md(doc, { mode: 'todoist' }), { mode: 'todoist' }), [same(doc)]);
});

/* A parent's progress is the percentage its ring shows. That is the average of its subtasks' progress, and a done
   subtask counts as 100%. The bar has one segment per subtask, filled for each subtask that is done. */
test('a parent shows its ring\'s percentage, and a bar with a segment per subtask, filled for each done subtask', () => {
  const doc = { kind: 'task', ...item('A test task', { due: on(7, 18), people: [sam], ring: { pct: 13, done: 0, total: 4 } }), items: [
    item('One subtask', { pct: 50, due: on(7, 18), people: [sam] }), item('Another'), item('And another'), item('And another')] };
  assert.equal(text(doc), ['A test task  ▱▱▱▱ 13% · due today · sam', '◐ One subtask 50% · due today · sam', '○ Another', '○ And another', '○ And another'].join('\n'));
  assert.equal(md(doc).split('\n')[0], '## A test task @sam 2026-10-07 at 18:00', 'the copy leaves out a parent\'s percentage, because it is calculated again');
  assert.equal(bar(60, { pct: 60, done: 2, total: 3 }), '▰▰▱');
  assert.deepEqual(progress(item('x', { pct: 40, ring: { pct: 70, done: 1, total: 2 } })).pct, 70, 'the ring\'s percentage is used, not the task\'s own');
  // A checklist counts skipped steps as done in its ring, and the text reports them separately.
  const run = { kind: 'run', ...item('Close'), ring: { pct: 67, done: 2, total: 3 }, items: [item('a', { done: true }), item('b', { done: true, skipped: true }), item('c')] };
  assert.equal(text(run).split('\n')[0], 'Close  ▰▰▱ 67% · 1 skipped');
  // For a parent task in a project, the bar on its line shows the ring's percentage.
  const project = { kind: 'project', title: 'Café', open: 1, doneCount: 0, items: [{ ...item('Deep clean'), items: [item('Fridge', { pct: 50 })], subs: { done: 2, total: 3 }, ring: { pct: 83, done: 2, total: 3 } }] };
  assert.equal(text(project).split('\n')[1], '◐ Deep clean  ▰▰▱ 83%');
});

// The text shared from a task's sheet and from a checklist's screen must match the ring the same task shows on screen.
const NONE = '0001-01-01T00:00:00Z';
const shared = () => {
  const app = component(tasks, sharing, cards, runs, claims, checklists, views);
  Object.assign(app, { user: { id: 1 }, pending: [], failed: [], slow: [], perms: {}, positions: {}, projects: [], checklistIds: new Set(), pendingTasks: [], clock: Date.now(), runNow: Date.now(), actTask: a => a.task });
  return app;
};
test('the text shared from a task\'s sheet matches its ring, with a segment per subtask and each done one filled', () => {
  const app = shared();
  const sub = (id, f = {}) => ({ id, title: 'Sub ' + id, done: false, percent_done: 0, due_date: NONE, project_id: 5, assignees: [], related_tasks: {}, ...f });
  const subs = [sub(2, { percent_done: .5 }), sub(3), sub(4, { done: true }), sub(5, { percent_done: .25 })];
  const t = { id: 1, title: 'Paint the back wall', done: false, percent_done: 0, due_date: NONE, project_id: 5, assignees: [], related_tasks: { subtask: subs } };
  for (const x of [t, ...subs]) app.tasks[x.id] = x;
  Object.assign(app, { sheet: { id: 1, subPeople: {} }, subtasks: subs, pendingSubtasks: [] });
  const ring = app.ringOf(t), head = shareText(app.shareDoc('task'), NOW).split('\n')[0];
  assert.deepEqual([ring.pct, ring.done, ring.total], [44, 1, 4], '(50 + 0 + 100 + 25) / 4');
  assert.equal(head, `Paint the back wall  ${'▰'.repeat(ring.done)}${'▱'.repeat(ring.total - ring.done)} ${ring.pct}%`);
  assert.equal(markdownText(app.shareDoc('task')).split('\n')[0], '## Paint the back wall');
  // A subtask that has its own subtasks shows its ring's percentage on its line.
  subs[1].related_tasks = { subtask: [sub(6, { done: true }), sub(7)] }; app.tasks[6] = sub(6, { done: true }); app.tasks[7] = sub(7);
  assert.equal(shareText(app.shareDoc('task'), NOW).split('\n')[2], `◐ Sub 3 ${app.ringOf(subs[1]).pct}%`);
});

test('the text shared from a checklist\'s screen matches its ring, counting a tick waiting to be sent as the ring does', () => {
  const app = shared(), now = Date.now();
  const step = (id, title, f = {}) => ({ id, title, done: false, done_at: NONE, due_date: NONE, updated: new Date(now - 36e5).toISOString(), percent_done: 0, description: '',
    project_id: 5, assignees: [], attachments: [], reactions: {}, comments: [], related_tasks: {}, ...f });
  const steps = [step(51, 'Mop', { done: true, done_at: new Date(now - 6e4).toISOString(), reactions: { '✅': [{ id: 1 }] } }), step(52, 'Wipe', { percent_done: .5 }), step(53, 'Lock up'), step(54, 'Lights')];
  const run = { id: 50, title: 'Closing up', done: false, project_id: 5, assignees: [], created_by: { id: 1 }, comments: [], description: '', related_tasks: { subtask: steps } };
  app.isRunTask = t => t.id === 50;
  for (const x of [run, ...steps]) app.row(x);
  app.view = { groups: [], shownRun: { id: 50, steps: steps.map(s => s.id), at: null, last: null } };
  app.pending = [{ kind: 'act', id: 9, run: 50, task: 53, op: 'done', at: new Date().toISOString() }];   // "Lock up" was ticked and the tick is not sent yet
  app.change(w => w.keyOps());
  const ring = app.ringOf(run), head = shareText(app.shareDoc('run'), NOW).split('\n')[0];
  assert.deepEqual([ring.pct, ring.done, ring.total], [63, 2, 4], '(100 + 50 + 100 + 0) / 4');
  assert.equal(head, `Closing up  ▰▰▱▱ ${ring.pct}%`);
});

test('Done today\'s Copy leaves out a task done yesterday, in a copy of Today saved then, as the screen does', () => {
  const app = component(sending, sharing), yesterday = new Date(Date.now() - 864e5).toISOString();
  Object.assign(app, { route: { name: 'today' }, pending: [], projById: new Map(), view: { groups: todayGroups(), cards: {} }, shareTitle: t => t.title, shareRing: () => null, copyOut: text => text });
  app.view.groups.find(g => g.key === 'donetoday').tasks.push({ id: 1, title: 'Fix the till', done: true, done_at: yesterday }, { id: 2, title: 'Order the cups', done: true, done_at: new Date().toISOString() });
  assert.deepEqual(app.copyDoneToday().split('\n').slice(1), ['✓ Order the cups']);
});

test('Done today\'s Copy gives the day, then each done task with its project, and a checklist with its steps done of all', () => {
  const text = doneTodayText([{ title: 'Fix the till drawer', project: 'Café' }, { title: 'Opening up · Oct 14', project: 'Checklists', ring: { done: 9, total: 11, pct: 82 } }, { title: 'No project' }],
    new Date(2026, 9, 14, 15));
  assert.equal(text, ['Done today · Wed, Oct 14', '✓ Fix the till drawer · Café', '✓ Opening up · Oct 14 · Checklists · 9 of 11 done', '✓ No project'].join('\n'));
});
