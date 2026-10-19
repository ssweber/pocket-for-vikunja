// ESLint looks for mistakes only (a name that isn't defined, a variable never used, an import assigned to), not style,
// and that only api.js talks to Vikunja, only util.js asks whether less motion is wanted, only lists.js decides how
// many days Today shows, only checklists.js decides what kind of task a task is, only tasks.js writes a task's row, only
// src/js/ops/ compares an op's name, only messages.js writes the sentences Pocket shows, and only the files in DIRECT
// write to Vikunja without the outbox and its keys: npm run lint, which also runs scripts/check.mjs. CI runs it too.
import js from '@eslint/js';
import globals from 'globals';

// Every no-restricted-syntax selector, with the files allowed to break it. They share one array because a second entry
// for the rule replaces the first, and 'off' would turn off every selector in a file. restricted(file) leaves out the
// selectors that file is allowed. An allowed path ending in /** allows every file under it.
const WRITE = 'Send a change through the outbox as an op (this.act), not straight to Vikunja.';
const KEY = "Send a write with a key (api's `key` option), so a write sent again after a lost reply is made once. An op's stage sends with c.send, which gives each request its key.";
const ALIAS = "Call api() by its own name, so lint can check that a write has a key.";
const STORE = 'Write the store inside this.change(w => …) with its writers (src/js/app/tasks.js). w.answer() writes what Vikunja answered, and w.leave() marks a row leaving.';
// A write to a task's row: this.tasks[id] = …, this.tasks[id].done = …, delete or ++ on one, or Object.assign onto one.
// The sheet's task and a checklist's are rows too (sheetTask, runTask). show() reads the leaving marks too.
const ROW = "MemberExpression[object.type='ThisExpression'][property.name=/^(tasks|sheetTask|runTask|leaving)$/]";
// this.sheet.task and this.view.run, where the sheet and a checklist's screen kept their own copies of tasks.
const HELD = (a, b) => `MemberExpression[object.type='MemberExpression'][object.object.type='ThisExpression'][object.property.name='${a}'][property.name='${b}']`;
const BY_ID = "The sheet and a checklist's screen hold ids. Read this.sheet.id or this.sheetTask, and this.view.shownRun or this.runTask (tasks.js).";
// An entry's op name, as e.op or e?.op, compared to a string (===, !==, a switch), or looked up in a list (includes).
const OP = name => `:matches([${name}.property.name='op'], [${name}.expression.property.name='op'])`;
const TEXT = name => `:matches([${name}.type='Literal'], [${name}.type='TemplateLiteral'])`;
const OP_NAME = `:matches(BinaryExpression[operator=/^[!=]==?$/]:matches(${OP('left')}${TEXT('right')}, ${OP('right')}${TEXT('left')}), SwitchStatement${OP('discriminant')}, CallExpression[callee.property.name=/^(includes|indexOf|has)$/]${OP('arguments.0')})`;
const BY_OP = 'Only src/js/ops/ knows which op is which. Ask the op (opOf, src/js/ops/index.js), adding a field with its default there, or call a helper in the op\'s own file.';
const WORDING = 'Write the sentence in src/js/messages.js, as a constant or a function, and pass that here. One situation has one wording there.';
/* A sentence written where it is shown fails lint outside messages.js. A sentence is a string with a letter, or a
   template literal with a letter outside its ${}, anywhere in a + chain, a choice (?:, ||, &&, ??) or a ${} that makes
   the first argument of say, notify or confirm (window.confirm too), this.said, a marked row's `said` (markRow), or an
   action's label ({label, fn}). A call's arguments aren't followed, so offlineFor('rename the project') passes, and
   messages.js holds the sentence. The rule can't see a sentence put in a variable first, returned by a function outside
   messages.js, given in another property of say's options (row: {text}), or written in the markup. A selector can't
   follow a + chain to any depth, so this is a rule of its own. */
const lettered = s => /[A-Za-z]/.test(s ?? '');
const sentence = n =>
  n?.type === 'Literal' ? typeof n.value === 'string' && lettered(n.value)
  : n?.type === 'TemplateLiteral' ? n.quasis.some(q => lettered(q.value.cooked)) || n.expressions.some(sentence)
  : n?.type === 'BinaryExpression' ? n.operator === '+' && (sentence(n.left) || sentence(n.right))
  : n?.type === 'LogicalExpression' ? sentence(n.left) || sentence(n.right)
  : n?.type === 'ConditionalExpression' ? sentence(n.consequent) || sentence(n.alternate)
  : false;
const named = (o, name) => o?.type === 'ObjectExpression' && o.properties.find(p => p.type === 'Property' && !p.computed && p.key.name === name);
const WORDS = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const check = n => sentence(n) && context.report({ node: n, message: WORDING });
    return {
      CallExpression({ callee: c, arguments: args }) {
        const method = c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
        if (/^(say|notify)$/.test(method) || c.name === 'confirm' || (method === 'confirm' && c.object.name === 'window'))
          check(args[0]);
        if (method === 'markRow') for (const a of args) check(named(a, 'said')?.value);
      },
      AssignmentExpression(n) {
        if (n.left.type === 'MemberExpression' && n.left.property.name === 'said') check(n.right);
      },
      ObjectExpression(n) {
        if (named(n, 'fn')) check(named(n, 'label')?.value);
      },
    };
  },
};
/* The files that write to Vikunja directly, not through the outbox. What they write needs Vikunja's answer before
   anything else can happen, and the user waits for it on screen. Every other write is an op, sent by acts.js with a
   key through a stage's c.send, which no selector here matches. */
const DIRECT = [
  'src/js/api.js', // api() itself, renewing the session, and a file's upload (keyed, from the outbox's file entries)
  'src/js/app/auth.js', // signing in
  'src/js/app/checklists.js', // renaming, archiving and deleting a project, the Checklists project, and turning checklists on or off
  'src/js/app/views.js', // creating a project
];
const RESTRICTED = [
  { selector: 'Literal[value=/prefers-reduced-motion/]', message: 'Ask motion() in src/js/util.js whether things may move.', allow: ['src/js/util.js'] },
  { selector: "CallExpression[callee.name='addDays'][arguments.1.value=8]", message: "Ask dayGroup() in src/js/lists.js which of Today's groups a date is in, or use TODAY_DAYS.", allow: ['src/js/lists.js'] },
  { selector: "CallExpression[callee.name='api'] > ObjectExpression > Property[key.name='method']:not([value.value='GET'])", message: WRITE, allow: DIRECT },
  /* A call to api with no key whose options may make it a write: a method other than GET, a spread (...opts), or
     options a selector can't read, such as a variable. A selector can't follow api through a variable or a function,
     so api is called by its own name only, and lint fails where it is renamed, imported under another name or passed
     on. It can't see inside a spread either, so `{ ...opts, key }` passes whatever `opts` holds. */
  { selector: "CallExpression[callee.name='api'] > ObjectExpression:has(> :matches(Property[key.name='method']:not([value.value='GET']), SpreadElement)):not(:has(> Property[key.name='key']))", message: KEY, allow: DIRECT },
  { selector: "CallExpression[callee.name='api'][arguments.1]:not([arguments.1.type='ObjectExpression']), CallExpression[callee.name='api'] > SpreadElement", message: KEY, allow: DIRECT },
  { selector: "Identifier[name='api']:not(CallExpression > .callee, ImportSpecifier > Identifier, MemberExpression > .property, Property > .key), ImportSpecifier[imported.name='api']:not([local.name='api']), ImportDeclaration[source.value=/api\\.js$/] > ImportNamespaceSpecifier", message: ALIAS, allow: DIRECT },
  { selector: `:matches(AssignmentExpression > MemberExpression.left, UpdateExpression > MemberExpression.argument, UnaryExpression[operator='delete'] > MemberExpression.argument) ${ROW}`, message: STORE, allow: ['src/js/app/tasks.js'] },
  { selector: `CallExpression[callee.object.name='Object'][callee.property.name='assign'] > MemberExpression.arguments:first-child ${ROW}`, message: STORE, allow: ['src/js/app/tasks.js'] },
  { selector: `:matches(${HELD('sheet', 'task')}, ${HELD('view', 'run')})`, message: BY_ID, allow: ['src/js/app/tasks.js'] },
  { selector: "MemberExpression[object.type='ThisExpression'][property.name='opsOn']", message: "Read a task's waiting ops with this.opsOf(id) (tasks.js).", allow: ['src/js/app/tasks.js'] },
  { selector: OP_NAME, message: BY_OP, allow: ['src/js/ops/**'] },
  { selector: "CallExpression[callee.object.type='ThisExpression'][callee.property.name='unchanged']", message: "Undo with undoOps. An op's invert checks Vikunja's copy itself, field by field.", allow: [] },
];
// The tests that make up roleOf in checklists.js. A file outside it asks roleOf, or the component's role(t).
const ROLES = { group: ['**/checklists.js'], importNames: ['hasTemplateLabel', 'isTemplate', 'isRun', 'isRunStepTask', 'isRunDesc', 'hasOwnOrder'],
  message: 'Ask roleOf() in src/js/checklists.js, or this.role(t), what kind of task a task is.' };
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
      'no-restricted-imports': ['error', { patterns: [ROLES] }],
    },
  },
  { files: ['src/**/*.js'], ignores: ['src/js/messages.js'], plugins: { pocket: { rules: { words: WORDS } } }, rules: { 'pocket/words': 'error' } },
  { files: ['src/js/api.js'], rules: { 'no-restricted-globals': 'off' } },
  { files: ['src/js/checklists.js'], rules: { 'no-restricted-imports': 'off' } },
  ...[...new Set(RESTRICTED.flatMap(r => r.allow))].map(file => ({ files: [file], rules: { 'no-restricted-syntax': restricted(file) } })),
  {
    // Node, and functions the tests run in the page.
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Alpine: 'readonly', sanitize: 'readonly', colorOf: 'readonly' } },
  },
];
