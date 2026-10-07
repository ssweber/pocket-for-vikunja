// Checklist steps that need no HTML (src/js/checklists.js): their order, times and what's shown of them. Reading and
// writing Pocket's lines in a description, and steps as they're typed, are in tests/parse.mjs, which has a browser.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durText, inOrder, isRun, isRunStepTask, placeBefore, plainStep, problemText, stepFrom, stepInfos, stepProblems, stepsOf, stepWords, parseStep } from '../../src/js/checklists.js';

const ids = list => list.map(s => s.id);

test('steps in their order line, then the rest by id; ids no longer steps are skipped', () => {
  const steps = [{ id: 5 }, { id: 2 }, { id: 9 }, { id: 7 }];
  assert.deepEqual(ids(inOrder(steps, [9, 44, 5])), [9, 5, 2, 7]);
  assert.deepEqual(ids(inOrder(steps, null)), [2, 5, 7, 9]);
  assert.deepEqual(ids(steps), [5, 2, 9, 7], 'the list given is left as it was');
});

test('a step inserted in a run: before the one it was put before, else after the one above it, else at the end', () => {
  assert.deepEqual(placeBefore([1, 2, 3], 9, 2, 1), [1, 9, 2, 3]);
  assert.deepEqual(placeBefore([1, 3], 9, 2, 1), [1, 9, 3]);
  assert.deepEqual(placeBefore([3], 9, 2, 1), [3, 9]);
  assert.deepEqual(placeBefore([1, 9, 2], 9, 2, 1), [1, 9, 2], 'there already');
});

test('a template\'s steps are in order; any other task\'s subtasks as Vikunja gives them', () => {
  const subtask = [{ id: 8 }, { id: 3 }];
  assert.deepEqual(ids(stepsOf({ labels: [{ title: 'Template' }], related_tasks: { subtask } })), [3, 8]);
  assert.deepEqual(ids(stepsOf({ related_tasks: { subtask, copiedfrom: [{ id: 1 }] } })), [3, 8], 'a run');
  assert.deepEqual(ids(stepsOf({ related_tasks: { subtask } })), [8, 3]);
  assert.deepEqual(stepsOf(null), []);
});

test('a countdown in its two largest parts', () => {
  assert.equal(durText(5400000), '1h 30m');
  assert.equal(durText(90061000), '1d 1h');
  assert.equal(durText(59000), '59s');
  assert.equal(durText(400), '0s');
  assert.equal(durText(0), '0s');
});

test('the step a timed step counts from: the one before, a named earlier one, or the start', () => {
  const steps = ['Heat the oven {#oven}', 'Roast T#40m:oven', 'Rest T#10m', 'Plate', 'Serve T#5m:later {#later}'].map(parseStep);
  assert.deepEqual([0, 1, 2, 3, 4].map(i => stepFrom(steps, i)), [null, 0, 1, null, null]);
  assert.equal(stepFrom([parseStep('First T#5m')], 0), -1, 'the first step counts from the start of the run');
});

test('a template\'s steps as shown: when each is due, its name, and what\'s wrong', () => {
  const shown = stepInfos(['Heat the oven T#0m {#oven}', 'Roast T#40m:oven', 'Baste T#20m:gravy', 'Plate']);
  assert.deepEqual(shown, [
    { title: 'Heat the oven', text: 'Due at the start · named “oven”', problem: '' },
    { title: 'Roast', text: 'Due 40m after “Heat the oven”', problem: '' },
    { title: 'Baste', text: '', problem: 'no step is named “gravy”' },
    { title: 'Plate', text: '', problem: '' },
  ]);
  assert.equal(problemText(stepProblems(['A T#5m:b', 'B {#b}', 'C T#x'])), 'step 1, “A”: its time counts from “b”, which has to be an earlier step (and 1 more)');
});

test('a step\'s time in words, as it\'s written in Pocket', () => {
  const titles = ['Put the roast in {#roast}', 'Baste T#40m:roast', 'Peel T#1h30m', 'Lost T#5m:nobody'];
  assert.equal(stepWords(titles[1], titles), 'Baste 40m after Put the roast in');
  assert.equal(stepWords(titles[2], titles), 'Peel in 1h 30m');
  assert.equal(stepWords(titles[3], titles), titles[3], 'counted from a step that isn\'t there: as it is');
  assert.equal(stepWords('Plate', titles), 'Plate');
});

test('a run, and a run\'s step, by their links', () => {
  assert.equal(isRun({ done: false, related_tasks: { copiedfrom: [{ id: 1 }] } }), true);
  assert.equal(isRun({ done: true, related_tasks: { copiedfrom: [{ id: 1 }] } }), false, 'finished');
  assert.equal(isRun({ done: false, labels: [{ title: 'template' }], related_tasks: { copiedfrom: [{ id: 1 }] } }), false, 'still being set up');
  assert.equal(isRun({ done: false, related_tasks: { copiedfrom: [{ id: 1 }], parenttask: [{ id: 2 }] } }), false, 'a step');
  assert.equal(isRunStepTask({ related_tasks: { parenttask: [{ id: 2 }], copiedfrom: [{ id: 1 }] } }), true);
  assert.equal(isRunStepTask({ related_tasks: { parenttask: [{ id: 2 }] } }), false, 'a subtask of any other task');
});

test('what a run\'s screen keeps of a step: its title in the template, from what it was copied from', () => {
  const s = plainStep({ id: 4, title: 'Roast', done: false, related_tasks: { copiedfrom: [{ id: 2, title: 'Roast T#40m:oven' }] } });
  assert.equal(s.tpl, 'Roast T#40m:oven');
  assert.equal(s.from, 2);
  assert.equal(s.added, '');
  assert.equal(s.percent_done, 0);
});
