// The lint rules that keep every write to Vikunja keyed (eslint.config.js), run on code as `eslint --stdin` would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();
// The messages lint gives `code` in a file at `path`, by line, each shortened to its first words.
const lint = async (code, path = 'src/js/app/new.js') => {
  const [r] = await eslint.lintText(code, { filePath: path });
  return r.messages.map(m => `${m.line}: ${m.message.split(/ \(|,/)[0]}`);
};
const KEY = 'Send a write with a key',
  WRITE = 'Send a change through the outbox as an op',
  ALIAS = 'Call api() by its own name';

test('a write without a key fails lint, however its options are given, and a read passes', async () => {
  const code = `import { api } from '../api.js';
export const f = async (p, more, opts, key) => [
  await api(p),
  await api(p, { method: 'GET', raw: true }),
  await api(p, { method: 'PATCH', body: {} }),
  await api(p, { method: 'PATCH', body: {}, key }),
  await api(p, { ...more }),
  await api(p, { ...more, key }),
  await api(p, opts),
  await api(...more),
];
`;
  assert.deepEqual(await lint(code), [
    `5: ${KEY}`,
    `5: ${WRITE}`,
    `6: ${WRITE}`,
    `7: ${KEY}`,
    `9: ${KEY}`,
    `10: ${KEY}`,
  ]);
});

test('api renamed, imported under another name or passed on fails lint', async () => {
  const code = `import { api as call } from '../api.js';
import * as all from '../api.js';
export const f = async p => [call(p), all, [p].map(call)];
`;
  assert.deepEqual(await lint(code), [`1: ${ALIAS}`, `2: ${ALIAS}`]);
  const passed = `import { api } from '../api.js';
const send = api;
export const f = async p => [send(p), [p].map(api), api.call(null, p, { method: 'DELETE' })];
`;
  assert.deepEqual(await lint(passed), [`2: ${ALIAS}`, `3: ${ALIAS}`, `3: ${ALIAS}`]);
});

test('a file that writes to Vikunja directly may write without a key', async () => {
  const code = `import { api } from '../api.js';
export const f = p => api(p, { method: 'POST', body: {} });
`;
  assert.deepEqual(await lint(code, 'src/js/app/views.js'), []);
});
