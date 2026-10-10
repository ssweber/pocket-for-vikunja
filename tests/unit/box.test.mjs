// An add box's own directive, x-box, and x-grow beside it (src/js/component.js): what every add box does, written
// once. Run here on a pretend element and a pretend Alpine, which keeps each directive as it's registered, runs an
// effect once as it's made, and keeps what's asked for the next tick.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directives } from '../../src/js/component.js';

// The directives, as Alpine is given them; `ticks`: what waits for the next tick; `effects`: each effect, to run again;
// `gone()`: the element taken off the page, as Alpine does it: what each directive asked to have cleaned up, and of
// the effects made with the `effect` it was handed, only the last let go of (Alpine keeps one per directive);
// `running`: the effects still kept up to date.
function alpine(app){
  const made = {}, ticks = [], effects = [], cleanups = [], running = new Set();
  directives({ directive: (name, fn) => { made[name] = fn; }, $data: () => app, nextTick: fn => ticks.push(fn), release: fn => running.delete(fn) });
  const evaluate = x => { if (!(x in app.names)) throw new ReferenceError(x + ' is not defined'); return app.names[x]; };
  const on = (name, el, expression, modifiers = []) => {
    let last;
    made[name](el, { expression, modifiers },
      { evaluate, effect: fn => { effects.push(fn); running.add(fn); last = fn; fn(); return fn; }, evaluateLater: () => () => {}, cleanup: fn => cleanups.push(fn) });
    cleanups.push(() => running.delete(last));
  };
  return { on, ticks, effects, running, names: Object.keys(made), gone(){ for (const fn of cleanups.splice(0)) fn(); } };
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
  const app = { boxes: { cap: { text: '', focus: false, caret: 0 }, ins: { text: '', focus: false, caret: 0 }, tname: { text: '', focus: false, caret: 0 } }, entered: [], loaded: [], checked: [],
    names: { capW: 'cap', "'tname'": 'tname' }, box(w){ return this.boxes[w]; }, boxEnter(w){ this.entered.push(w); },
    token: null, boxToken(){ return this.token; }, query: '', accessQuery(){ return this.query; }, checkAccess(w){ this.checked.push(w); },
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
  a.on('box', line, "'tname'");
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

test('a box says it has the focus, and that it lost it only a moment later, of the box it was then; taken off the page, it listens no more', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(), a = alpine(app), el = textarea(), name = textarea();
  a.on('box', el, 'capW', ['lines']);
  a.on('box', name, "'tname'");
  try {
    el.fire('focus');
    assert.deepEqual([app.boxes.cap.focus, app.loaded], [true, []], 'nothing is loaded for being focused');
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
    assert.deepEqual([app.boxes.tname.focus, app.loaded], [true, []], 'a template\'s name: the same');
    // Taken off the page while it has the focus (a step being changed, called off): it's blurred on its way out, with
    // nothing left around it to say which box it was. It listens no more by then, as an @event wouldn't.
    a.gone();
    delete app.names["'tname'"];
    name.fire('blur'); name.fire('keydown', key('Enter')); name.fire('input');
    c.mock.timers.tick(150);
    assert.deepEqual([app.boxes.tname.focus, app.entered], [true, []]);
  } finally { delete document.activeElement; }
});

/* Every add box, a step being written too: what @ and * suggest is loaded as one is started, and its @usernames are
   looked up once typing pauses, each time they or the project they'd go to change. (The effects are run again by
   hand here, as Alpine runs them when what they read changes: the 2nd made is the suggestions', the 3rd the look-up's.) */
test('starting an @username or a *label loads what to suggest; once typing pauses, a box\'s @usernames are looked up, once for each change', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(), a = alpine(app), el = textarea();
  a.on('box', el, 'capW', ['lines']);
  const [, suggest, look] = a.effects;
  assert.deepEqual([app.loaded, app.checked], [[], []], 'an empty box: nothing loaded, nothing looked up');
  app.token = { kind: 'label' }; suggest();
  app.token = { kind: 'assignee' }; suggest();
  app.token = null; suggest();
  assert.deepEqual(app.loaded, ['labels', 'people']);
  app.query = '1|bob'; look();
  c.mock.timers.tick(400);
  app.query = '1|bob|priya'; look();                       // still typing: the wait starts again
  c.mock.timers.tick(400);
  assert.deepEqual(app.checked, [], 'not while typing goes on');
  c.mock.timers.tick(100);
  assert.deepEqual(app.checked, ['cap']);
  look(); look();                                          // worked out again with nothing changed: not asked again
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap']);
  app.names.capW = 'under'; app.query = '7|bob|priya'; look();   // the box now adds subtasks to a task in another project
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap', 'under']);
  app.query = ''; look();
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap', 'under'], 'emptied: nothing to look up');
  // Taken off the page while a look-up waits: it's called off, and nothing of the box is kept up to date any more
  // (one effect left running would ask, at the next change, about a box with nothing around it).
  app.query = '7|sam'; look();
  assert.equal(a.running.size, 3);
  a.gone();
  c.mock.timers.tick(500);
  assert.deepEqual([app.checked, a.running.size], [['cap', 'under'], 0]);
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
