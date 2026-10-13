// Builds Pocket's page, pocket/app/index.html, from src/:
//
//   npm run build              build once
//   npm run build -- --watch   build again on every change in src/ (npm run dev does this)
//
// It reads src/index.html and replaces these tags in place:
//   <!-- include markup/x.html -->           is replaced by src/markup/x.html, including any includes inside it
//   <!-- include markup/x.html run -->       is replaced by the same file, keeping each part of x.html between
//                                            <!-- only run sheet --> and <!-- /only --> whose words include "run".
//                                            Every other such part is left out.
//   <link rel="stylesheet" href="styles.css">  is replaced by that stylesheet from src/, minified, in a <style>
//   <script type="module" src="js/main.js">  is replaced by that script and everything it imports, as one minified
//                                            script. The source map is written next to the page (pocket.js.map).
//   <script defer src="alpine-3.17.4-pocket.3.min.js">
//                                            stays, and src/vendor/alpine-3.17.4.js is minified into that file next
//                                            to the page (see vendor() below)
// A stylesheet or script that isn't in src/ (the libraries in pocket/app/) is left as it is. The markup's comments and
// indentation are removed (see lean() below), and a template inside another template keeps its content in a template
// of its own (see shared()). The page is also written compressed, as index.html.br and index.html.gz, for main.go to
// send to browsers that accept them (see compressed()).
//
// The page is one file, so a phone never mixes a new page with old code. sw.js and main.go need nothing more. Edit
// src/, never pocket/app/index.html. The build overwrites that file, and CI checks that it matches the build of src/.
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src'), OUT = join(ROOT, 'pocket', 'app');
const MAP = 'pocket.js.map';

// Convert line endings to \n, so the output is the same on every computer whatever git checked out.
const read = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const inSrc = (from, path) => {
  const file = resolve(dirname(from), path);
  return file.startsWith(SRC + sep) && existsSync(file) ? file : null;
};

/* Keeps the text between <!-- only run sheet --> and <!-- /only --> (each tag on its own line) where the file is
   included with one of those words, and removes it everywhere else. This lets every list share one row
   (markup/task-row.html) without each row working out the parts that only another kind of list shows
   (docs/development.md, rule 10). A part cannot hold another part. */
export const onlyParts = (text, words = []) => text.replace(/^[ \t]*<!-- only (\S+(?: \S+)*) -->\n([\s\S]*?)^[ \t]*<!-- \/only -->\n?/gm, (_, only, part) => only.split(' ').some(word => words.includes(word)) ? part : '');

export function include(file, seen = [], words = []){
  if (seen.includes(file)) throw new Error(`${relative(ROOT, file)} includes itself`);
  const text = read(file);
  // Included with no word, such a file would silently lose every one of those parts.
  if (!words.length && /^[ \t]*<!-- only /m.test(text)) throw new Error(`${relative(ROOT, file)} has parts for some lists only: include it with the kind of list it is in`);
  return onlyParts(text, words).replace(/^([ \t]*)<!-- include (\S+)((?: \S+)*) -->\n?/gm, (_, indent, path, more) => {
    const part = inSrc(join(SRC, 'index.html'), path);                         // paths are always relative to src/index.html
    if (!part) throw new Error(`${relative(ROOT, file)}: no src file ${path} to include`);
    return include(part, [...seen, file], more.split(' ').filter(Boolean));
  });
}

/* Removes the markup's comments and its indentation, which is the white space between two tags that has a line break
   in it. Each row of a list is a copy of its template, so a comment or an indent in a row's markup is copied once for
   every row drawn. White space on one line is kept, because between two inline elements it shows as a space. Quoted
   attributes are left as they are. */
const PARTS = /<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g;   // a comment, a tag, or the text between two
export const lean = html => html.replace(PARTS, part =>
  part.startsWith('<!--') ? ''
  : part[0] === '<' ? part.replace(/"[^"]*"|'[^']*'|\s+/g, s => /^\s/.test(s) ? ' ' : s)
  : /^\s*\n\s*$/.test(part) ? '' : part);

/* Moves the content of each x-if and x-for template nested in another template into a template of its own, just
   before the page's scripts, and names that template on the nested one (data-from="part-1"). Alpine clones a template
   with everything in it, so a list's row was cloned with the content of every template inside the row, used or not.
   Pocket's Alpine clones the content of the template named (src/vendor, marked "Pocket:"). Templates with the same
   content share one, so the page holds each part of the row once however many lists include the row. */
export function shared(html){
  const ids = new Map(), stack = [[]];
  for (const part of html.match(PARTS) || []) {
    if (/^<template[\s>]/.test(part)) { stack.at(-1).push(part); stack.push([]); continue; }
    if (part !== '</template>') { stack.at(-1).push(part); continue; }
    if (stack.length < 2) throw new Error('A </template> closes no <template>');
    const content = stack.pop().join(''), out = stack.at(-1), open = out.pop();
    if (stack.length < 2 || !content || !/\sx-(if|for)=/.test(open)) { out.push(open, content, part); continue; }
    if (!ids.has(content)) ids.set(content, 'part-' + (ids.size + 1));
    out.push(`${open.slice(0, -1)} data-from="${ids.get(content)}">`, part);
  }
  if (stack.length > 1) throw new Error('A <template> is not closed');
  const page = stack[0], at = page.findIndex(part => /^<script[\s>]|^<\/body>/.test(part));
  page.splice(at < 0 ? page.length : at, 0, ...[...ids].map(([content, id]) => `<template id="${id}">${content}</template>`));
  return page.join('');
}

export async function css(file){
  const r = await esbuild.build({ entryPoints: [file], bundle: true, minify: true, write: false, logLevel: 'silent' });
  return r.outputFiles[0].text.trim();
}

async function js(file){
  const r = await esbuild.build({
    entryPoints: [file], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false, logLevel: 'silent',
    sourcemap: 'external', sourceRoot: '', outdir: OUT, sourcesContent: true, legalComments: 'none',
  });
  const code = r.outputFiles.find(f => f.path.endsWith('.js')).text.trim();
  const map = JSON.parse(r.outputFiles.find(f => f.path.endsWith('.map')).text);
  map.sources = map.sources.map(s => s.replace(/^(\.\.\/)+/, ''));       // gives "src/js/api.js" on every computer
  map.sourcesContent = map.sourcesContent.map(s => s.replace(/\r\n/g, '\n'));   // esbuild keeps the line endings git checked out
  map.file = 'index.html';
  return { code, map: JSON.stringify(map) + '\n' };
}

async function build(){
  let page = shared(lean(include(join(SRC, 'index.html')))), map = null;
  const tag = /<link rel="stylesheet" href="([^"]+)">|<script type="module" src="([^"]+)"><\/script>/g;
  const parts = [];
  for (const m of page.matchAll(tag)) {
    const file = inSrc(join(SRC, 'index.html'), m[1] || m[2]);
    if (!file) continue;
    if (m[1]) parts.push([m[0], `<style>${await css(file)}</style>`]);
    else {
      if (map) throw new Error('Only one script from src/ can go in the page: import the rest from it');
      const out = await js(file);
      map = out.map;
      parts.push([m[0], `<script type="module">${out.code}\n//# sourceMappingURL=${MAP}\n</script>`]);
    }
  }
  for (const [from, to] of parts) page = page.replace(from, () => to);
  // A "</script" or "</style" inside the inlined code would end the tag early.
  for (const [, to] of parts) if (/<\/(script|style)/i.test(to.replace(/^<(script|style)[^>]*>/, '').replace(/<\/(script|style)>$/, '')))
    throw new Error('A </script> or </style> inside the inlined code would cut it short');
  write(join(OUT, 'index.html'), page);
  compressed(join(OUT, 'index.html'), page);
  if (map) write(join(OUT, MAP), map);
  await vendor(page);
}

/* A library that Pocket patches is kept readable in src/vendor/ (alpine-3.17.4.js is Alpine as published, then
   patched, with each change marked "Pocket:"). This function minifies it into the file the page names
   (alpine-3.17.4-pocket.3.min.js). The name must change with every change to the patch. sw.js caches libraries by
   name, so a changed file under an old name would never reach an installed Pocket. */
async function vendor(page){
  for (const [, name, lib] of page.matchAll(/<script[^>]* src="(([\w.-]+?)-pocket\.\d+\.min\.js)"/g)) {
    const file = join(SRC, 'vendor', lib + '.js');
    if (!existsSync(file)) throw new Error(`The page loads ${name}, but there's no src/vendor/${lib}.js to make it from`);
    const { code } = await esbuild.transform(read(file), { minify: true, banner: `/* ${lib}.js, patched by Pocket: src/vendor/${lib}.js */` });
    write(join(OUT, name), code);
  }
}

/* Writes the page compressed with brotli (a fifth of the size) and gzip. main.go sends these to browsers that accept
   them. A file is rewritten only when it doesn't decompress to the page, so a build that changes nothing is quick. The
   bytes are the same on every computer: the gzip header holds no time, and its operating-system byte is fixed. */
export function compressed(file, page){
  const text = Buffer.from(page);
  const ways = {
    '.br': [brotliDecompressSync, () => brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: text.length } })],
    '.gz': [gunzipSync, () => { const gz = gzipSync(text, { level: 9 }); gz.writeUInt32LE(0, 4); gz[9] = 255; return gz; }],   // 255 means the operating system is unknown
  };
  for (const [ext, [unzip, zip]] of Object.entries(ways)) {
    try { if (unzip(readFileSync(file + ext)).equals(text)) continue; } catch {}
    writeFileSync(file + ext, zip());
  }
}

// Write only a file that changed. A new modification time makes every open copy of Pocket reload to get a new version.
function write(file, text){
  if (!existsSync(file) || read(file) !== text) writeFileSync(file, text);
}

// Run as a script, this file builds. When the specimen page imports it, it only provides its functions.
if (resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await build();
    console.log('Built pocket/app/index.html from src/');
  } catch (e) {
    console.error(e.message || e);
    if (!process.argv.includes('--watch')) process.exit(1);
  }

  if (process.argv.includes('--watch')) {
    let timer;
    watch(SRC, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().then(() => console.log(new Date().toLocaleTimeString(), 'rebuilt'), e => console.error(e.message || e)), 100);
    });
    console.log('Watching src/ for changes');
  }
}
