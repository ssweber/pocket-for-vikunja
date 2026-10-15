// ESLint looks for mistakes only (a name that isn't defined, a variable never used, an import assigned to), not style,
// and that only api.js talks to Vikunja, only util.js asks whether less motion is wanted, and only lists.js decides how
// many days Today shows: npm run lint, which also runs scripts/check.mjs. CI runs it too.
import js from '@eslint/js';
import globals from 'globals';

// Every no-restricted-syntax selector, with the files allowed to break it. They share one array because a second entry
// for the rule replaces the first, and 'off' would turn off every selector in a file. restricted(file) leaves out the
// selectors that file is allowed.
const RESTRICTED = [
  { selector: 'Literal[value=/prefers-reduced-motion/]', message: 'Ask motion() in src/js/util.js whether things may move.', allow: ['src/js/util.js'] },
  { selector: "CallExpression[callee.name='addDays'][arguments.1.value=8]", message: "Ask dayGroup() in src/js/lists.js which of Today's groups a date is in, or use TODAY_DAYS.", allow: ['src/js/lists.js'] },
];
const restricted = file => ['error', ...RESTRICTED.filter(r => !r.allow.includes(file)).map(({ selector, message }) => ({ selector, message }))];

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
