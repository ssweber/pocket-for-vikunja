// What ESLint can't check, run with it by npm run lint: no colour is written out (#hex, rgb(), rgba(), hsl(), hsla())
// in src/styles.css outside its :root blocks, nor anywhere in src/markup/. Colours are the custom properties set in
// :root, with their dark mode values beside them, so a colour written anywhere else would be the same in dark mode.
// And no :style given an object in the markup: x-style does that (component.js says why).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)?/gi;
const problems = [];
const lineOf = (text, at) => text.slice(0, at).split('\n').length;
const report = (file, text, at, what) => problems.push(`${relative(ROOT, file)}:${lineOf(text, at)}: ${what}`);

// The stylesheet: each block of declarations (the innermost braces) but those of :root.
const cssFile = join(ROOT, 'src', 'styles.css');
const css = readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));   // comments, keeping lines
for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
  if (/:root\s*$/.test(block[1])) continue;
  const at = block.index + block[1].length + 1;
  for (const m of block[2].matchAll(COLOUR)) report(cssFile, css, at + m.index, `${m[0]} is a colour: use a custom property from :root`);
}

// The markup: no colour at all, in a style or anywhere else.
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []);
for (const file of walk(join(ROOT, 'src', 'markup'))) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(COLOUR)) report(file, html, m.index, `${m[0]} is a colour: use a custom property from src/styles.css`);
  for (const m of html.matchAll(/(?:\s:|x-bind:)style="\s*\{/g)) report(file, html, m.index, ':style with an object starts a timer each time: use x-style');
}

if (problems.length) {
  console.error(problems.join('\n') + `\n${problems.length} colour${problems.length === 1 ? '' : 's'} written out`);
  process.exit(1);
}
