// ESLint looks for mistakes only (a name that isn't defined, a variable never used, an import assigned to), not style,
// and that only api.js talks to Vikunja, and only util.js asks whether less motion is wanted: npm run lint, which also
// runs scripts/check.mjs. CI runs it too.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['pocket/app/**', 'node_modules/**', 'test-results/**', 'src/vendor/**'] },   // vendor/: Alpine as published
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
      'no-restricted-syntax': ['error', { selector: 'Literal[value=/prefers-reduced-motion/]', message: 'Ask motion() in src/js/util.js whether things may move.' }],
    },
  },
  { files: ['src/js/api.js'], rules: { 'no-restricted-globals': 'off' } },
  { files: ['src/js/util.js'], rules: { 'no-restricted-syntax': 'off' } },
  {
    // Node, and functions the tests run in the page.
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Alpine: 'readonly', sanitize: 'readonly', colorOf: 'readonly' } },
  },
];
