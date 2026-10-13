// A page for checking how a task row and the add boxes look, for development only:
//
//   npm run specimen        then open specimen/index.html in a browser
//
// It shows src/markup/task-row.html in every state, and the add boxes (the bar at the bottom, the box seated in a list,
// and the box at the end of a list) in every state. Light and dark are side by side. The page uses Pocket's stylesheet
// and Pocket's own Alpine component, given made-up tasks (scripts/specimen/). It isn't part of Pocket. It is built
// into specimen/, which git ignores and which is outside pocket/app/, so it is never served or cached for offline.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { include, lean, shared } from './build.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HERE = join(ROOT, 'scripts', 'specimen'), OUT = join(ROOT, 'specimen');

let page = shared(lean(include(join(HERE, 'page.html'))));
// Pocket's stylesheet applies its dark colours to the whole page when the computer is in dark mode. Here they apply to
// .theme-dark instead, so light and dark show at once.
const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
let css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
if (!dark.test(css)) throw new Error('src/styles.css has no @media (prefers-color-scheme:dark){:root{...}} block for the dark side');
css = css.replace(dark, '.theme-dark{$1}');
page = page.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`);
const code = await esbuild.build({ entryPoints: [join(HERE, 'specimen.mjs')], bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent' });
page = page.replace('<script type="module" src="specimen.js"></script>', () => `<script type="module">\n${code.outputFiles[0].text}</script>`);
// Use the same copy of Alpine that Pocket loads, found by the file name in src/index.html.
const alpine = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8').match(/src="(alpine-[^"]+\.js)"/)[1];
page = page.replace('src="alpine.js"', `src="../pocket/app/${alpine}"`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), page);
console.log('Built specimen/index.html: open it in a browser');
