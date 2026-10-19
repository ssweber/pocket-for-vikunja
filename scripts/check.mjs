// Checks that ESLint can't do, run by npm run lint. It fails on a colour written out (#hex, rgb(), rgba(), hsl(),
// hsla()) in src/styles.css outside the :root blocks, or anywhere in src/markup/. Colours are custom properties set in
// :root, with their dark mode values beside them, so a colour written anywhere else would look the same in dark mode.
// It also fails on a :style bound to an object in the markup, because x-style does that (component.js says why). It
// also keeps docs/development.md under a size limit, with lines short enough to read.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)?/gi;
const problems = [];
const lineOf = (text, at) => text.slice(0, at).split('\n').length;
const report = (file, text, at, what) => problems.push(`${relative(ROOT, file)}:${lineOf(text, at)}: ${what}`);

// The stylesheet: check each block of declarations (the innermost braces) except those of :root.
const cssFile = join(ROOT, 'src', 'styles.css');
const css = readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')); // blank out comments but keep the line numbers
for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
  if (/:root\s*$/.test(block[1])) continue;
  const at = block.index + block[1].length + 1;
  for (const m of block[2].matchAll(COLOUR))
    report(cssFile, css, at + m.index, `${m[0]} is a colour: use a custom property from :root`);
}

// The markup: no colour is allowed anywhere, in a style or elsewhere.
const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
  );
for (const file of walk(join(ROOT, 'src', 'markup'))) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(COLOUR))
    report(file, html, m.index, `${m[0]} is a colour: use a custom property from src/styles.css`);
  for (const m of html.matchAll(/(?:\s:|x-bind:)style="\s*\{/g))
    report(file, html, m.index, ':style with an object starts a timer each time: use x-style');
}

// docs/development.md is a map: where things are, the rules that hold across files, and what has tripped people up. It
// once grew to 115 KB, one clause at a time, retelling what each function does, which the comments in the code already
// say. So it has a size limit and a line length limit. Table rows and lines in code blocks are exempt from the line limit.
const DOC_BYTES = 24000,
  DOC_LINE = 120;
const docFile = join(ROOT, 'docs', 'development.md'),
  doc = readFileSync(docFile);
if (doc.length > DOC_BYTES)
  problems.push(
    `${relative(ROOT, docFile)}: ${doc.length} bytes, over ${DOC_BYTES}: say what a function or a file does in a comment where it is, and keep here only the map and the rules that hold across files`,
  );
let fenced = false;
doc
  .toString('utf8')
  .split('\n')
  .forEach((line, i) => {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && !line.startsWith('|') && line.length > DOC_LINE)
      problems.push(`${relative(ROOT, docFile)}:${i + 1}: a line of ${line.length} characters, over ${DOC_LINE}`);
  });

if (problems.length) {
  console.error(problems.join('\n') + `\n${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
