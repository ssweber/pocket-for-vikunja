// The x-box directive for add boxes, and x-grow beside it (src/js/component.js). Every add box behaves the same way
// because it uses x-box. The test runs the directives on a fake element and a fake Alpine. The fake Alpine records each
// directive when it is registered, runs each effect once when it is created, and holds callbacks for the next tick.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directives } from '../../src/js/component.js';
import { grow } from '../../src/js/util.js';

// The directives, registered the way Alpine registers them. `ticks` holds callbacks waiting for the next tick. `effects`
// holds every effect, so a test can run it again. `gone()` removes the element from the page as Alpine does. It runs
// each directive's cleanups, and of the effects a directive created, it releases only the last (Alpine keeps one per
// directive). `running` holds the effects that are still kept up to date.
function alpine(app) {
  const made = {},
    ticks = [],
    effects = [],
    cleanups = [],
    running = new Set();
  directives({
    directive: (name, fn) => {
      made[name] = fn;
    },
    $data: () => app,
    nextTick: fn => ticks.push(fn),
    release: fn => running.delete(fn),
  });
  const evaluate = x => {
    if (!(x in app.names)) throw new ReferenceError(x + ' is not defined');
    return app.names[x];
  };
  const on = (name, el, expression, modifiers = []) => {
    let last;
    made[name](
      el,
      { expression, modifiers },
      {
        evaluate,
        effect: fn => {
          effects.push(fn);
          running.add(fn);
          last = fn;
          fn();
          return fn;
        },
        evaluateLater: () => () => {},
        cleanup: fn => cleanups.push(fn),
      },
    );
    cleanups.push(() => running.delete(last));
  };
  return {
    on,
    ticks,
    effects,
    running,
    names: Object.keys(made),
    gone() {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
// A fake text box. `fire(type, event)` stands in for the browser sending an event to the listeners the directive added.
function textarea() {
  const heard = {};
  return {
    heard,
    style: {},
    selectionStart: 0,
    scrollTop: 0,
    scrollHeight: 60,
    offsetHeight: 62,
    clientHeight: 60,
    previousElementSibling: { scrollTop: 0 },
    closest: () => null,
    addEventListener(type, fn) {
      (heard[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      heard[type] = (heard[type] || []).filter(x => x !== fn);
    },
    fire(type, e = {}) {
      for (const fn of heard[type] || []) fn(e);
    },
  };
}
// A fake component with only what a box uses. It has the boxes by name, a record of Enter presses, and a record of what was loaded.
const component = () => {
  const app = {
    boxes: {
      cap: { text: '', focus: false, caret: 0 },
      ins: { text: '', focus: false, caret: 0 },
      tname: { text: '', focus: false, caret: 0 },
    },
    entered: [],
    loaded: [],
    checked: [],
    names: { capW: 'cap', "'tname'": 'tname' },
    box(w) {
      return this.boxes[w];
    },
    boxEnter(w) {
      this.entered.push(w);
    },
    token: null,
    boxToken() {
      return this.token;
    },
    query: '',
    accessQuery() {
      return this.query;
    },
    checkAccess(w) {
      this.checked.push(w);
    },
    loadPeople() {
      this.loaded.push('people');
      return Promise.resolve();
    },
    loadLabels() {
      this.loaded.push('labels');
      return Promise.resolve();
    },
  };
  return app;
};
const key = (key, more = {}) => ({
  key,
  shiftKey: false,
  isComposing: false,
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
  ...more,
});

test('Alt arrows move a list box and do not affect a step editor', () => {
  const app = component(),
    a = alpine(app),
    list = textarea(),
    editor = textarea(),
    moved = [],
    levels = [];
  app.boxMove = (w, dir) => {
    moved.push([w, dir]);
    return true;
  };
  app.boxLevel = out => {
    levels.push(out);
    return true;
  };
  a.on('box', list, 'capW', ['lines']);
  a.on('box', editor, "'tname'");
  for (const [name, dir] of [
    ['ArrowUp', -1],
    ['ArrowDown', 1],
  ]) {
    const e = key(name, { altKey: true });
    list.fire('keydown', e);
    assert.equal(e.prevented, true);
    editor.fire('keydown', key(name, { altKey: true }));
    assert.deepEqual(moved.at(-1), ['cap', dir]);
  }
  for (const [name, out] of [
    ['ArrowLeft', true],
    ['ArrowRight', false],
  ]) {
    const e = key(name, { altKey: true });
    list.fire('keydown', e);
    assert.equal(e.prevented, true);
    editor.fire('keydown', key(name, { altKey: true }));
    assert.equal(levels.at(-1), out);
    const plain = key(name);
    list.fire('keydown', plain);
    assert.equal(plain.prevented, false);
  }
  assert.equal(moved.length, 2);
  assert.equal(levels.length, 2);
  app.boxLevel = () => false;
  const limit = key('ArrowLeft', { altKey: true });
  list.fire('keydown', limit);
  assert.equal(limit.prevented, true, "reaching the level limit must not trigger the browser's Back");
  const e = key('ArrowUp', { altKey: true, ctrlKey: true });
  list.fire('keydown', e);
  assert.equal(e.prevented, false);
  assert.deepEqual(app.entered, []);
});

test('the directives the markup uses are x-style, x-grow and x-box', () => {
  assert.deepEqual(alpine(component()).names, ['style', 'grow', 'box']);
});

test('an add box tracks its cursor position, scrolls its highlights with it, and is as tall as its text', () => {
  const app = component(),
    a = alpine(app),
    el = textarea();
  a.on('box', el, 'capW', ['lines']);
  for (const [type, at] of [
    ['input', 3],
    ['click', 1],
    ['keyup', 7],
  ]) {
    el.selectionStart = at;
    el.fire(type);
    assert.equal(app.boxes.cap.caret, at, type);
  }
  el.scrollTop = 24;
  el.fire('scroll');
  assert.equal(el.previousElementSibling.scrollTop, 24, 'the marks behind the text scroll with the box');
  assert.equal(a.ticks.length, 1, 'the height is fitted once on the next tick, when the box is drawn');
  a.ticks.shift()();
  assert.equal(el.style.height, '62px', 'the box is as tall as its text and its borders');
  a.effects[0]();
  assert.equal(a.ticks.length, 1, 'the height is fitted again when the text changes');
});

test('Enter sends an add box except while a word is being composed, and Shift+Enter breaks the line only in a list box', () => {
  const app = component(),
    a = alpine(app),
    list = textarea(),
    line = textarea();
  a.on('box', list, 'capW', ['lines']);
  a.on('box', line, "'tname'");
  const press = (el, more) => {
    const e = key('Enter', more);
    el.fire('keydown', e);
    return e.prevented;
  };
  assert.deepEqual([press(list), app.entered], [true, ['cap']], 'Enter sends the box and adds no line break');
  assert.deepEqual(
    [press(list, { shiftKey: true }), app.entered],
    [false, ['cap']],
    'Shift+Enter in a list box breaks the line and sends nothing',
  );
  assert.deepEqual(
    [press(list, { isComposing: true }), app.entered],
    [false, ['cap']],
    'an Enter that picks a word being composed is left to the keyboard',
  );
  assert.deepEqual(
    [press(line), press(line, { shiftKey: true }), app.entered],
    [true, true, ['cap', 'tname', 'tname']],
    'in a box that holds one line, Shift+Enter works as Enter',
  );
  assert.equal(press(line, { isComposing: true, shiftKey: true }), false);
  const other = key('a');
  list.fire('keydown', other);
  assert.deepEqual([other.prevented, app.entered.length], [false, 3], 'any other key is left to the box');
  // Enter goes to whichever box the name points at now. On a checklist's screen, quick add's box is the checklist's box.
  app.names.capW = 'ins';
  press(list);
  assert.equal(app.entered.at(-1), 'ins');
});

test('a box reports that it has the focus, reports losing it after a short delay, and stops listening when removed from the page', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(),
    a = alpine(app),
    el = textarea(),
    name = textarea();
  a.on('box', el, 'capW', ['lines']);
  a.on('box', name, "'tname'");
  try {
    el.fire('focus');
    assert.deepEqual([app.boxes.cap.focus, app.loaded], [true, []], 'focusing the box loads nothing');
    // The user taps a chip, which gives the focus back to the box. The box never reports that it lost the focus.
    el.fire('blur');
    document.activeElement = el;
    c.mock.timers.tick(150);
    assert.equal(app.boxes.cap.focus, true);
    // The user leaves the box and the focus does not come back.
    el.fire('blur');
    document.activeElement = null;
    assert.equal(app.boxes.cap.focus, true, 'the box does not report losing the focus yet');
    c.mock.timers.tick(150);
    assert.equal(app.boxes.cap.focus, false);
    // The user leaves the box, and a moment later the name `capW` points at the checklist's box. The box that was left
    // is told it lost the focus, and the other box is unchanged.
    el.fire('focus');
    app.boxes.ins.focus = true;
    el.fire('blur');
    app.names.capW = 'ins';
    c.mock.timers.tick(150);
    assert.deepEqual([app.boxes.cap.focus, app.boxes.ins.focus], [false, true]);
    name.fire('focus');
    assert.deepEqual([app.boxes.tname.focus, app.loaded], [true, []], "a template's name box behaves the same way");
    // The box is removed from the page while it has the focus (for example, a step edit is cancelled). The browser blurs
    // it on the way out, when nothing around it says which box it was. By then it must not listen any more, just as an
    // @event listener would not.
    a.gone();
    delete app.names["'tname'"];
    name.fire('blur');
    name.fire('keydown', key('Enter'));
    name.fire('input');
    c.mock.timers.tick(150);
    assert.deepEqual([app.boxes.tname.focus, app.entered], [true, []]);
  } finally {
    delete document.activeElement;
  }
});

/* This applies to every add box, including the box for writing a step. Starting an @username or a *label loads the
   suggestions. When typing pauses, the box looks up its @usernames, again each time they change or the project they
   would go to changes. The test runs the effects by hand, as Alpine does when the data they read changes. The second
   effect created is the suggestions and the third is the look-up. */
test('starting an @username or a *label loads suggestions, and a pause in typing looks up the @usernames once per change', c => {
  c.mock.timers.enable({ apis: ['setTimeout'] });
  const app = component(),
    a = alpine(app),
    el = textarea();
  a.on('box', el, 'capW', ['lines']);
  const [, suggest, look] = a.effects;
  assert.deepEqual([app.loaded, app.checked], [[], []], 'an empty box loads nothing and looks nothing up');
  app.token = { kind: 'label' };
  suggest();
  app.token = { kind: 'assignee' };
  suggest();
  app.token = null;
  suggest();
  assert.deepEqual(app.loaded, ['labels', 'people']);
  app.query = '1|bob';
  look();
  c.mock.timers.tick(400);
  app.query = '1|bob|priya';
  look(); // still typing, so the wait restarts
  c.mock.timers.tick(400);
  assert.deepEqual(app.checked, [], 'no look-up happens while typing continues');
  c.mock.timers.tick(100);
  assert.deepEqual(app.checked, ['cap']);
  look();
  look(); // nothing changed, so no second look-up
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap']);
  app.names.capW = 'under';
  app.query = '7|bob|priya';
  look(); // the box now adds subtasks to a task in another project
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap', 'under']);
  app.query = '';
  look();
  c.mock.timers.tick(500);
  assert.deepEqual(app.checked, ['cap', 'under'], 'an emptied box has nothing to look up');
  // Removing the box from the page while a look-up waits cancels the look-up and stops every effect of the box. An
  // effect left running would ask about a box that is no longer on the page, the next time anything changed.
  app.query = '7|sam';
  look();
  assert.equal(a.running.size, 3);
  a.gone();
  c.mock.timers.tick(500);
  assert.deepEqual([app.checked, a.running.size], [['cap', 'under'], 0]);
});

test('fitting a text box to its text keeps the page scrolled where it was, even though measuring shortens the page', t => {
  // The page extends 600px past the screen and is scrolled to its end. It ends with a box of three lines, which is 48px taller than the box with one line.
  const page = { y: 600, end: 600 },
    el = textarea(),
    tall = 86;
  const was = Object.fromEntries(
    ['scrollY', 'scrollX', 'scrollTo'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  t.after(() => {
    for (const [k, d] of Object.entries(was))
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
  });
  Object.defineProperty(globalThis, 'scrollY', { get: () => page.y, configurable: true });
  Object.defineProperty(globalThis, 'scrollX', { get: () => 0, configurable: true });
  Object.defineProperty(globalThis, 'scrollTo', {
    value: (x, y) => {
      page.y = Math.min(y, page.end);
    },
    configurable: true,
    writable: true,
  });
  // This copies a browser. With the box at its smallest height the page is 48px shorter, and the scroll position cannot go past the end of the page.
  el.style = {
    set height(h) {
      page.end = h === 'auto' ? 600 - 48 : 600;
      page.y = Math.min(page.y, page.end);
      this.h = h;
    },
    get height() {
      return this.h;
    },
  };
  Object.assign(el, { scrollHeight: tall - 2, offsetHeight: tall, clientHeight: tall - 2 });
  grow(el);
  assert.equal(el.style.height, tall + 'px');
  assert.equal(page.y, 600, 'the page is scrolled to where it was, at its end');
});

test('x-grow keeps any other text box as tall as its text, and fits it again when its text changes', () => {
  const app = component(),
    a = alpine(app),
    el = textarea();
  app.names['sheet.commentDraft'] = 'A comment';
  a.on('grow', el, 'sheet.commentDraft');
  a.ticks.shift()();
  assert.equal(el.style.height, '62px');
  el.scrollHeight = 100;
  el.offsetHeight = 102;
  el.clientHeight = 100;
  a.effects[0]();
  a.ticks.shift()();
  assert.equal(el.style.height, '102px');
});
