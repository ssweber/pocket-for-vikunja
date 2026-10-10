// An add box's own directive, x-box, and x-grow beside it (src/js/component.js): what every add box does, written
// once. Run here on a pretend element and a pretend Alpine, which keeps each directive as it's registered, runs an
// effect once as it's made, and keeps what's asked for the next tick.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directives } from '../../src/js/component.js';

// The directives, as Alpine is given them; `ticks`: what waits for the next tick; `effects`: each effect, to run again;
// `gone()`: the element taken off the page, as Alpine does it (what each directive asked to have cleaned up).
function alpine(app){
  const made = {}, ticks = [], effects = [], cleanups = [];
  directives({ directive: (name, fn) => { made[name] = fn; }, $data: () => app, nextTick: fn => ticks.push(fn) });
  const evaluate = x => { if (!(x in app.names)) throw new ReferenceError(x + ' is not defined'); return app.names[x]; };
  const on = (name, el, expression, modifiers = []) => made[name](el, { expression, modifiers },
    { evaluate, effect: fn => { effects.push(fn); fn(); }, evaluateLater: () => () => {}, cleanup: fn => cleanups.push(fn) });
  return { on, ticks, effects, names: Object.keys(made), gone(){ for (const fn of cleanups.splice(0)) fn(); } };
}
// A text box, with what the directive listens for; fire(type, event) is the browser telling it.
function textarea(){
  const heard = {};
  return { heard, style: {}, selectionStart: 0, scrollTop: 0, scrollHeight: 60, offsetHeight: 62, clientHeight: 60, previousElementSibling: { scrollTop: 0 }, closest: () => null,
    addEventListener(type, fn){ (heard[type] ||= []).push(fn); }, removeEventListener(type, fn){ heard[type] = (heard[type] || []).filter(x => x !== fn); },
    fire(type, e = {}){ for (const fn of heard[type] || []) fn(e); } };
}
// The component, as far as a box asks it: its boxes by name, what Enter did, and what was loaded.
const component = () => {
  const app = { boxes: { cap: { text: '', focus: false, caret: 0 }, ins: { text: '', focus: false, caret: 0 }, tname: { text: '', focus: false, caret: 0 } }, entered: [], loaded: [],
    names: { capW: 'cap', "'tname'": 'tname' }, box(w){ return this.boxes[w]; }, boxEnter(w){ this.entered.push(w); },
    loadPeople(){ this.loaded.push('people'); return Promise.resolve(); }, loadLabels(){ this.loaded.push('labels'); return Promise.resolve(); } };
  return app;
};
const key = (key, more = {}) => ({ key, shiftKey: false, isComposing: false, prevented: false, preventDefault(){ this.prevented = true; }, ...more });

test('the markup\'s own directives are x-style, x-grow and x-box', () => {
  assert.deepEqual(alpine(component()).names, ['style', 'grow', 'box']);
});

test('an add box keeps where its cursor is, scrolls its marks with it, and is as tall as its text', () => {
  const app = component(), a = alpine(app), el = textarea();
  a.on('box', el, 'capW', ['lines']);
  for (const [type, at] of [['input', 3], ['click', 1], ['keyup', 7]]) { el.selectionStart = at; el.fire(type); assert.equal(app.boxes.cap.caret, at, type); }
  el.scrollTop = 24; el.fire('scroll');
  assert.equal(el.previousElementSibling.scrollTop, 24, 'the marks behind its words');
  assert.equal(a.ticks.length, 1, 'fitted once, as it\'s drawn, on the next tick');
  a.ticks.shift()();
  assert.equal(el.style.height, '62px', 'as tall as its text and its borders');
  a.effects[0]();
  assert.equal(a.ticks.length, 1, 'and again when its text changes');
});

test('Enter sends an add box, not while a word is being composed; Shift+Enter breaks the line only in a box that takes a list', () => {
  const app = component(), a = alpine(app), list = textarea(), line = textarea();
  a.on('box', list, 'capW', ['lines']);
  a.on('box', line, "'tname'", ['loads']);
  const press = (el, more) => { const e = key('Enter', more); el.fire('keydown', e); return e.prevented; };
  assert.deepEqual([press(list), app.entered], [true, ['cap']], 'Enter: sent, and no line break');
  assert.deepEqual([press(list, { shiftKey: true }), app.entered], [false, ['cap']], 'Shift+Enter in a box that takes a list: the line breaks, nothing sent');
  assert.deepEqual([press(list, { isComposing: true }), app.entered], [false, ['cap']], 'an Enter that picks a word being composed is the keyboard\'s');
  assert.deepEqual([press(line), press(line, { shiftKey: true }), app.entered], [true, true, ['cap', 'tname', 'tname']], 'a box that holds one line: Shift+Enter is Enter');
  assert.equal(press(line, { isComposing: true, shiftKey: true }), false);
  const other = key('a'); list.fire('keydown', other);
  assert.deepEqual([other.prevented, app.entered.length], [false, 3], 'any other key is the box\'s');
  // Whichever box it is now: quick add's box is the run's on a run's screen.
  app.names.capW = 'ins';
  press(list);
  assert.equal(app.entered.at(-1), 'ins');
});

test('a box says it has the focus, and that it lost it only a moment later, of the box it was then; one of a template\'s loads what it suggests', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(), a = alpine(app), el = textarea(), name = textarea();
  a.on('box', el, 'capW', ['lines']);
  a.on('box', name, "'tname'", ['loads']);
  try {
    el.fire('focus');
    assert.deepEqual([app.boxes.cap.focus, app.loaded], [true, []], 'quick add\'s loads nothing as it\'s focused');
    // Left for a chip, which hands the focus back: it never says it lost it.
    el.fire('blur');
    document.activeElement = el;
    c.mock.timers.tick(150);
    assert.equal(app.boxes.cap.focus, true);
    // Left for good.
    el.fire('blur');
    document.activeElement = null;
    assert.equal(app.boxes.cap.focus, true, 'not yet');
    c.mock.timers.tick(150);
    assert.equal(app.boxes.cap.focus, false);
    // Left as quick add's box, which is the run's box a moment later: the one left is told, the other is as it was.
    el.fire('focus');
    app.boxes.ins.focus = true;
    el.fire('blur');
    app.names.capW = 'ins';
    c.mock.timers.tick(150);
    assert.deepEqual([app.boxes.cap.focus, app.boxes.ins.focus], [false, true]);
    name.fire('focus');
    assert.deepEqual([app.boxes.tname.focus, app.loaded], [true, ['people', 'labels']], 'a template\'s name: who can be assigned, and the labels');
    // Taken off the page while it has the focus (a step being changed, called off): it's blurred on its way out, with
    // nothing left around it to say which box it was. It listens no more by then, as an @event wouldn't.
    a.gone();
    delete app.names["'tname'"];
    name.fire('blur'); name.fire('keydown', key('Enter')); name.fire('input');
    c.mock.timers.tick(150);
    assert.deepEqual([app.boxes.tname.focus, app.entered], [true, []]);
  } finally { delete document.activeElement; }
});

test('x-grow keeps any other text box as tall as its text, fitted again when what it\'s given changes', () => {
  const app = component(), a = alpine(app), el = textarea();
  app.names['sheet.commentDraft'] = 'A comment';
  a.on('grow', el, 'sheet.commentDraft');
  a.ticks.shift()();
  assert.equal(el.style.height, '62px');
  el.scrollHeight = 100; el.offsetHeight = 102; el.clientHeight = 100;
  a.effects[0]();
  a.ticks.shift()();
  assert.equal(el.style.height, '102px');
});
