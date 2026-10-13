// The floating add box follows its row, even when Alpine renders the form a frame later or renders it again.
import './browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seatUnder} from '../../src/js/app/seat.js';

test('a box waits for its form and then positions a replacement form of the same height', () => {
  const frames = new Map(); let n = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++n, fn); return n; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const classes = new Set(), row = {classList: {add: c => classes.add(c), remove: c => classes.delete(c)}, getBoundingClientRect: () => ({top: 10, bottom: 50})};
  const form = () => ({offsetHeight: 44, classList: {toggle(){}}, contains: () => false});
  let box = null, placed = [], heights = [];
  const s = {el: null, box: null, h: 0, at: '', missed: 0};
  const opts = {box: () => box, row: () => row, cls: 'boxed', prop: () => [{style: {setProperty: (...args) => heights.push(args)}}, '--height'],
    place: () => '50px', apply: b => placed.push(b), unplace(){}};
  const frame = () => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); };
  seatUnder(s, opts);
  assert.equal(frames.size, 1); assert.equal(classes.has('boxed'), false);
  const first = box = form(); frame();
  assert.equal(classes.has('boxed'), true); assert.deepEqual(placed, [box]);
  box = form(); frame();
  assert.deepEqual(placed, [first, box]);
  assert.deepEqual(heights, [['--height', '44px'], ['--height', '44px']]);
  cancelAnimationFrame(s.raf);
});

test('under the last row the box stays at the bottom, and the row is highlighted without space reserved', () => {
  const frames = new Map(); let n = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++n, fn); return n; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const rowEl = () => { const classes = new Set(); return {classes, classList: {add: c => classes.add(c), remove: c => classes.delete(c)}, getBoundingClientRect: () => ({top: 10, bottom: 50})}; };
  const last = rowEl(), mid = rowEl(), inline = [], placed = [], heights = [];
  const box = {offsetHeight: 44, classList: {toggle: (c, on) => inline.push(on)}, contains: () => false};
  let row = last;
  const s = {el: null, box: null, h: 0, at: '', missed: 0};
  const opts = {box: () => box, row: () => row, cls: 'boxed', atEnd: el => el === last, prop: () => [{style: {setProperty: (...args) => heights.push(args)}}, '--height'],
    place: () => '50px', apply: b => placed.push(b), unplace(){}};
  seatUnder(s, opts);
  assert.deepEqual([[...last.classes], inline.at(-1), placed.length, heights.length], [['boxed', 'at-end'], false, 0, 0], 'the last row is highlighted and the box is left where it is');
  row = mid; seatUnder(s, opts);
  assert.deepEqual([[...last.classes], [...mid.classes], inline.at(-1), placed.length], [[], ['boxed'], true, 1], 'another row takes the box');
  cancelAnimationFrame(s.raf);
});
