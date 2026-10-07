// The small helpers used all over Pocket: the address (routing.js), util.js, and what's waiting to send (sync.js).
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf } from '../../src/js/routing.js';
import { andList, colorOf, esc, fmtSize, sizeLimit, taskDrafts } from '../../src/js/util.js';
import { entryDone, heldTasks, isChild, itemDone, packParsed, unpackParsed } from '../../src/js/sync.js';

test('the screen in the address', () => {
  assert.deepEqual(routeOf(''), { name: 'today' });
  assert.deepEqual(routeOf('#/project/12?done=1'), { name: 'project', id: 12, showDone: true });
  assert.deepEqual(routeOf('#/run/7?step=9'), { name: 'run', id: 7, step: 9 });
  assert.deepEqual(routeOf('#/run/7'), { name: 'run', id: 7, step: null });
  assert.deepEqual(routeOf('#/add?title=Milk'), { name: 'add', text: 'Milk' });
  assert.deepEqual(routeOf('#/nowhere'), { name: 'today' });
});

test('words in a list as a sentence has them', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['you']), 'you');
  assert.equal(andList(['you', 'Jo']), 'you and Jo');
  assert.equal(andList(['you', 'Jo', 'Priya']), 'you, Jo and Priya');
});

test('Vikunja\'s upload limit, and a file\'s size', () => {
  assert.equal(sizeLimit('20MB'), 20 * 1048576);
  assert.equal(sizeLimit('512 kb'), 512 * 1024);
  assert.equal(sizeLimit('1.5G'), 1.5 * 1073741824);
  assert.equal(sizeLimit('lots'), null);
  assert.equal(fmtSize(0), '');
  assert.equal(fmtSize(900), '900 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3 * 1048576), '3.0 MB');
});

test('a label\'s colour only if it is one, and text made safe for HTML', () => {
  assert.equal(colorOf('e8445a'), '#e8445a');
  assert.equal(colorOf('#abc'), '#abc');
  assert.equal(colorOf('red;background:url(x)'), 'var(--muted)');
  assert.equal(colorOf(''), 'var(--muted)');
  assert.equal(esc(`<a href="x">Tom's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom&#39;s&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('drafts are kept until they\'re empty', () => {
  taskDrafts.clear();
  taskDrafts.set('comment:1', 'Half a thought');
  taskDrafts.set('run', { 5: 'a note' });
  assert.equal(taskDrafts.get('comment:1'), 'Half a thought');
  taskDrafts.set('comment:1', '   ');
  taskDrafts.set('run', { 5: '' });
  assert.deepEqual(taskDrafts.all(), {});
});

test('what\'s waiting: a line is done once its task is made, and a subtask once it\'s linked too', () => {
  assert.equal(itemDone({ taskId: 4 }, false), true);
  assert.equal(itemDone({ taskId: 4 }, true), false);
  assert.equal(itemDone({ taskId: 4, linked: true }, true), true);
  assert.equal(itemDone({ done: false, taskId: 4 }, false), false, 'what it says of itself wins');
  // A pasted list "nested" under its first line: the lines after it are subtasks.
  const entry = { nest: true, items: [{ taskId: 1 }, { taskId: 2, linked: true }], files: [{ sent: true }] };
  assert.deepEqual([isChild(entry, 0), isChild(entry, 1)], [false, true]);
  assert.equal(entryDone(entry), true);
  assert.equal(entryDone({ ...entry, files: [{ sent: false }] }), false, 'a file still to go');
  assert.equal(isChild({ parent: { id: 3 }, items: [] }, 0), true, 'added from a task\'s sheet');
});

test('a step whose act Vikunja turned down holds the acts behind it', () => {
  const held = heldTasks([{ kind: 'act', task: 5, failed: true }, { kind: 'act', task: 6 }, { kind: 'capture', task: 7, failed: true }]);
  assert.deepEqual([...held], [5]);
});

test('a parsed line kept on the phone keeps its date', () => {
  const p = { title: 'Call Jo', due: new Date('2026-10-08T09:00:00Z'), priority: 2, repeat: null, labels: ['work'], assignees: [], project: null };
  const back = unpackParsed(JSON.parse(JSON.stringify(packParsed(p))));
  assert.equal(+back.due, +p.due);
  assert.equal(back.title, 'Call Jo');
  assert.equal(back.priority, 2);
});
