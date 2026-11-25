// Errors in Pocket's own code (src/js/app/errors.js): a message with Reload, and the last few kept for the account
// sheet's Copy error details.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import errors, { keptErrors, ownError } from '../../src/js/app/errors.js';
import { saved } from '../../src/js/lists.js';
import { BROKE } from '../../src/js/messages.js';

const DAY = 86400000;
// An app with only the errors part, and a record of the messages shown.
const app = () =>
  Object.defineProperties(
    {
      errors: [],
      said: [],
      info: { version: '0.8.0' },
      notify(msg, action) {
        this.said.push([msg, action?.label]);
      },
    },
    Object.getOwnPropertyDescriptors(errors),
  );
const event = (type, more) => Object.assign(new Event(type), more);

test("an error counts only when Pocket's code threw it", () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'title')");
  assert.equal(ownError(event('error', { error: err, filename: 'http://pocket.test/plugins/pocket/' })), err);
  assert.equal(ownError(event('error', { error: err, filename: 'chrome-extension://abc/content.js' })), null);
  assert.equal(ownError(event('error', { error: null, filename: '' })), null, 'a ResizeObserver loop report');
  assert.equal(ownError(event('unhandledrejection', { reason: err })), err);
  assert.equal(ownError(event('unhandledrejection', { reason: 'cancelled' })), null);
});

test('an error says so once in a while with Reload, and the phone keeps the last ten for a week', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T12:00:00Z') });
  const a = app();
  location.hash = '#/today';
  a.noteError(new TypeError('first'));
  a.noteError(new TypeError('second'));
  assert.deepEqual(a.said, [[BROKE.msg, BROKE.reload]], 'a run of errors says so once');
  t.mock.timers.tick(10000);
  a.noteError(new Error('third'));
  assert.equal(a.said.length, 2);
  assert.deepEqual(
    saved.get('errors').map(x => [x.msg, x.where]),
    [
      ['TypeError: first', '#/today'],
      ['TypeError: second', '#/today'],
      ['Error: third', '#/today'],
    ],
  );
  for (let i = 0; i < 12; i++) a.noteError(new Error('more ' + i));
  assert.equal(a.errors.length, 10);
  assert.equal(a.errors.at(-1).msg, 'Error: more 11');
  t.mock.timers.tick(8 * DAY);
  assert.deepEqual(keptErrors(), [], 'errors older than a week are dropped');
  saved.set('errors', 'not a list');
  assert.deepEqual(keptErrors(), []);
});

test('the copied details name the version, the build and the browser, then each error', () => {
  const a = app();
  a.errors = [{ at: Date.parse('2026-11-25T12:00:00Z'), where: '#/today', msg: 'TypeError: x', stack: 'at y' }];
  assert.equal(
    a.errorsText(),
    `Pocket 0.8.0, build ?\n${navigator.userAgent}\n\n2026-11-25T12:00:00.000Z #/today\nTypeError: x\nat y`,
  );
});

test('an error thrown or a promise rejected anywhere in the page reaches noteError, and Pocket ignores the rest', () => {
  const was = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const a = app(),
      noted = [];
    a.noteError = e => noted.push(e.message);
    a.watchErrors();
    const err = new Error('in a tap');
    window.dispatchEvent(event('error', { error: err, filename: location.origin + '/app.js' }));
    window.dispatchEvent(event('unhandledrejection', { reason: new Error('in a request') }));
    window.dispatchEvent(event('error', { error: err, filename: 'moz-extension://x/y.js' }));
    assert.deepEqual(noted, ['in a tap', 'in a request']);
    a.noteError = () => {
      throw new Error('while noting');
    };
    window.dispatchEvent(event('error', { error: err, filename: location.origin + '/app.js' }));
  } finally {
    globalThis.window = was;
  }
});
