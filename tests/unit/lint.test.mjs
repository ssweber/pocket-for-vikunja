// The lint rules that keep every write to Vikunja keyed, and every sentence in messages.js (eslint.config.js), run on
// code as `eslint --stdin` would.
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
  ALIAS = 'Call api() by its own name',
  WORDS = 'Write the sentence in src/js/messages.js';

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

/* A sentence passed to say, notify or confirm, assigned to this.said, given as a marked row's said or as an action's
   label fails lint outside messages.js, wherever its letters are in a + chain, a choice or a ${}. A call that builds
   the sentence there passes, whatever its arguments, and so does a template literal with no letters outside its ${}. */
test('a sentence written where it is shown fails lint, and one from messages.js passes', async () => {
  const code = `import { notDone, UNDO } from '../messages.js';
export default {
  f(t, e, n) {
    this.say('Renamed', { place: 'sheet:top' });
    this.say('Not renamed: ' + e.message);
    this.notify(\`Deleted “\${t.title}”\`);
    this.say(e ? 'Saved' : t.title);
    confirm('Delete it?');
    this.said = 'Done: ' + t.title;
    this.markRow(t.id, { said: \`Done: \${t.title}\` });
    this.say(t.title, { action: { label: 'Undo', fn() {} } });
    confirm('Delete ' + t.title + '?');
    window.confirm(t.title + '?' + (n ? ' Sure' : ''));
    this.say(\`\${n ? 'Moved' : ''}\`);
    this.said = t.title + ', ' + (e.message || 'refused');
    this.say(notDone('renamed', e.message), { action: { label: UNDO, fn() {} } });
    this.say(t.problems.join('; '));
    this.say(\`\${n}%\`);
    this.said = \`\${t.title} \${n}\`;
    this.said = '';
  },
};
`;
  assert.deepEqual(
    await lint(code),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(n => `${n}: ${WORDS}`),
  );
  assert.deepEqual(await lint(code, 'src/js/messages.js'), []);
});
