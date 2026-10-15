// ESLint looks for mistakes only (a name that isn't defined, a variable never used, an import assigned to), not style,
// and that only api.js talks to Vikunja, only util.js asks whether less motion is wanted, only lists.js decides how
// many days Today shows, and only the files in WRITERS write to Vikunja directly: npm run lint, which also runs
// scripts/check.mjs. CI runs it too.
import js from '@eslint/js';
import globals from 'globals';

// Every no-restricted-syntax selector, with the files allowed to break it. They share one array because a second entry
// for the rule replaces the first, and 'off' would turn off every selector in a file. restricted(file) leaves out the
// selectors that file is allowed. An allowed path ending in /** allows every file under it.
const WRITE = 'Send a change through the outbox as an op (this.act), not straight to Vikunja.';
// The files that still write to Vikunja directly, not through the outbox. Each phase removes the files it finishes.
// The ops and their sender stay on it for good, since that is where writes belong. They write through a stage's
// c.send, which no selector here matches yet.
const WRITERS = ['src/js/api.js', 'src/js/sync.js', 'src/js/app/actions.js', 'src/js/app/asks.js', 'src/js/app/auth.js',
  'src/js/app/checklists.js', 'src/js/app/runs.js', 'src/js/app/sending.js', 'src/js/app/sheet.js', 'src/js/app/views.js',
  'src/js/ops/**', 'src/js/app/acts.js'];
const RESTRICTED = [
  { selector: 'Literal[value=/prefers-reduced-motion/]', message: 'Ask motion() in src/js/util.js whether things may move.', allow: ['src/js/util.js'] },
  { selector: "CallExpression[callee.name='addDays'][arguments.1.value=8]", message: "Ask dayGroup() in src/js/lists.js which of Today's groups a date is in, or use TODAY_DAYS.", allow: ['src/js/lists.js'] },
  { selector: "CallExpression[callee.name='api'] > ObjectExpression > Property[key.name='method']", message: WRITE, allow: WRITERS },
  { selector: "CallExpression[callee.name='patchTask']", message: WRITE, allow: WRITERS },
  { selector: "CallExpression[callee.object.type='ThisExpression'][callee.property.name=/^(saveTask|saveEach)$/]", message: WRITE, allow: WRITERS },
];
const allows = (r, file) => r.allow.some(a => a.endsWith('/**') ? file.startsWith(a.slice(0, -2)) : a === file);
const restricted = (file = '') => ['error', ...RESTRICTED.filter(r => !allows(r, file)).map(({ selector, message }) => ({ selector, message }))];

export default [
  { ignores: ['pocket/app/**', 'node_modules/**', 'test-results/**', 'src/vendor/**', 'scratchpad/**'] },   // vendor/: Alpine as published; scratchpad/: scratch work, not in git
  js.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],                       // catch {} means "never mind" here
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-useless-escape': 'off',                                             // style, in regular expressions
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.browser, Alpine: 'readonly', chrono: 'readonly' } },
    // Requests to Vikunja go through api(), which signs them, renews the session and says when Pocket is offline. A
    // request of another kind is allowed where it says why (// eslint-disable-next-line no-restricted-globals -- why).
    // Whether things may move (prefers-reduced-motion) is asked in one place, motion() in util.js.
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Ask Vikunja through api() in src/js/api.js, which signs the request and renews the session.' }],
      'no-restricted-syntax': restricted(),
    },
  },
  { files: ['src/js/api.js'], rules: { 'no-restricted-globals': 'off' } },
  ...[...new Set(RESTRICTED.flatMap(r => r.allow))].map(file => ({ files: [file], rules: { 'no-restricted-syntax': restricted(file) } })),
  {
    // Node, and functions the tests run in the page.
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Alpine: 'readonly', sanitize: 'readonly', colorOf: 'readonly' } },
  },
];
