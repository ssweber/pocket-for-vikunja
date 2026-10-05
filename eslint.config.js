// ESLint looks for mistakes only (a name that isn't defined, a variable never used, an import assigned to), not style:
// npm run lint. CI runs it too.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['pocket/app/**', 'node_modules/**', 'test-results/**'] },
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
  },
  {
    // Node, and functions the tests run in the page.
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Alpine: 'readonly', sanitize: 'readonly', colorOf: 'readonly' } },
  },
];
