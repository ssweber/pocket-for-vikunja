// A page for working on how a task's row looks, for development only:
//
//   npm run specimen        then open specimen/index.html in a browser
//
// It shows src/markup/task-row.html in every state (open, done, waiting to send, with progress, subtasks at each depth,
// due dates, priority, labels, people and comments, a run's row, read only, a task's subtasks in its sheet, with who's
// doing each, and a run's steps on its screen), in light and dark side by side, with Pocket's stylesheet and its own Alpine component given made-up tasks
// (scripts/specimen/). It isn't part of Pocket: it's built into specimen/, which git ignores, outside pocket/app/, so
// it's never served or saved for offline.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { include } from './build.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HERE = join(ROOT, 'scripts', 'specimen'), OUT = join(ROOT, 'specimen');

let page = include(join(HERE, 'page.html'));
// Pocket's stylesheet, with its dark mode colours on .theme-dark rather than on the whole page when the computer is in
// dark mode, so both show at once.
const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
let css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
if (!dark.test(css)) throw new Error('src/styles.css has no @media (prefers-color-scheme:dark){:root{...}} block for the dark side');
css = css.replace(dark, '.theme-dark{$1}');
page = page.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`);
const code = await esbuild.build({ entryPoints: [join(HERE, 'specimen.mjs')], bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent' });
page = page.replace('<script type="module" src="specimen.js"></script>', () => `<script type="module">\n${code.outputFiles[0].text}</script>`);
// The copy of Alpine that Pocket loads, by the name src/index.html has for it.
const alpine = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8').match(/src="(alpine-[^"]+\.js)"/)[1];
page = page.replace('src="alpine.js"', `src="../pocket/app/${alpine}"`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), page);
console.log('Built specimen/index.html: open it in a browser');
