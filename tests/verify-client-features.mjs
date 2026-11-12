/**
 * Verify the two client-side features added to dsh-multi-root-files:
 *   1. the Markdown renderer (extracted from client.js, run in a vm with a
 *      recording createElement) — block syntax, link whitelist, XSS safety;
 *   2. static wiring for the font-size setting (CSS rewrite + control + route).
 *
 * Run: node tests/verify-client-features.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const clientSrc = readFileSync(join(here, '..', 'client.js'), 'utf8');
const indexSrc = readFileSync(join(here, '..', 'index.js'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

/* ---- extract the markdown renderer source region verbatim ---------------- */
const start = clientSrc.indexOf('/* ------------------------------------------------------------------ *');
const endMark = 'function isMarkdownPath(path) {';
const end = clientSrc.indexOf(endMark, start);
if (start < 0 || end < 0) { console.log('FAIL  renderer region not found'); process.exit(1); }
const afterEnd = clientSrc.indexOf('\n    }', end);
const region = clientSrc.slice(start, afterEnd + 6);

function h(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(3).filter((c) => c !== null && c !== undefined && c !== false) };
}
function flatten(n) {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(flatten).join('');
  if (n && typeof n === 'object') return n.children.map(flatten).join('');
  return '';
}
function tags(n, type) {
  const found = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (x.type === type) found.push(x);
    x.children.forEach(walk);
  };
  walk(n); return found;
}
const ctx = { h, console };
vm.createContext(ctx);
vm.runInContext(region + '\nthis.MarkdownBody = MarkdownBody; this.isMarkdownPath = isMarkdownPath; this.safeMarkdownUrl = safeMarkdownUrl;', ctx);
const { MarkdownBody, isMarkdownPath, safeMarkdownUrl } = ctx;

console.log('\n=== markdown renderer ===');
for (const p of ['a.md', 'README.MD', 'x.markdown', 'y.mdown', 'z.mkd']) check(`detects ${p}`, isMarkdownPath(p) === true);
for (const p of ['a.txt', 'a.mdx', 'md']) check(`rejects ${p}`, isMarkdownPath(p) === false);
check('https allowed', safeMarkdownUrl('https://x.test') === 'https://x.test');
check('javascript: blocked', safeMarkdownUrl('javascript:alert(1)') === null);
check('data: blocked', safeMarkdownUrl('data:text/html,x') === null);

const doc = ['# Title', '', 'A **bold** and *italic* with `code` and [link](https://x.test).', '',
  '- one', '- two', '', '1. first', '2. second', '', '> quote', '', '---', '',
  '```js', 'const x = 1;', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
  '[bad](javascript:alert(1))'].join('\n');
const tree = MarkdownBody({ content: doc });
check('root is .mrf-markdown', tree.type === 'div' && tree.props.className === 'mrf-markdown');
check('h1 heading', tags(tree, 'h1').length === 1 && flatten(tags(tree, 'h1')[0]).includes('Title'));
check('bold / em / code', tags(tree, 'strong').length >= 1 && tags(tree, 'em').length >= 1 && tags(tree, 'code').length >= 2);
check('safe link with noopener', (() => { const a = tags(tree, 'a')[0]; return a && a.props.href === 'https://x.test' && /noopener/.test(a.props.rel); })());
check('no anchor for javascript:', tags(tree, 'a').length === 1, `anchors=${tags(tree, 'a').length}`);
check('ul / ol / blockquote / hr', tags(tree, 'ul').length === 1 && tags(tree, 'ol').length === 1 && tags(tree, 'blockquote').length === 1 && tags(tree, 'hr').length === 1);
check('fenced code in <pre>', tags(tree, 'pre').length === 1 && flatten(tags(tree, 'pre')[0]).includes('const x = 1;'));
check('table thead + tbody', tags(tree, 'table').length === 1 && tags(tree, 'th').length === 2 && tags(tree, 'td').length === 2);
check('no innerHTML / dangerouslySetInnerHTML', !/dangerouslySetInnerHTML/.test(clientSrc) && !/\.innerHTML\s*=/.test(clientSrc));

console.log('\n=== markdown preview toggle wiring ===');
check('PreviewPane defaults to preview', /useState\('preview'\)/.test(clientSrc));
check('preview resets when the file changes', /setView\('preview'\); \}, \[preview\.path\]\)/.test(clientSrc));
check('preview branch renders MarkdownBody', /h\(MarkdownBody, \{ content: String\(value\?\.content/.test(clientSrc));
check('source branch keeps the line view', /mrf-codeLine/.test(clientSrc));
check('toggle uses both labels', /t\('markdownPreview'\)/.test(clientSrc) && /t\('markdownSource'\)/.test(clientSrc));
check('image / binary / too-large keep their own branches', /value\?\.kind === 'binary'/.test(clientSrc) && /value\?\.kind === 'too-large'/.test(clientSrc));

console.log('\n=== font-size setting wiring ===');
check('host registers /settings', /path: `\$\{API\}\/settings`/.test(indexSrc));
check('host uses its OWN settings file', /multi_root_files_settings\.json/.test(indexSrc));
check('host sanitizes fontScale', /function sanitizeSettings/.test(indexSrc) && /FONT_SCALE_MIN/.test(indexSrc));
check('client reads /settings on mount', /fetchJson\(ctxRef\.current, `\$\{API_BASE\}\/settings`\)/.test(clientSrc));
check('client writes /settings on change', /postPlain\(ctxRef\.current, `\$\{API_BASE\}\/settings`, \{ fontScale: value \}\)/.test(clientSrc));
check('panel root exposes --mrf-scale', /'--mrf-scale': fontScale/.test(clientSrc));
check('ensureStyle rewrites font-size to calc()', /CSS\.replace\(\/font-size:\\s\*\(\\d\+\(\?:\\\.\\d\+\)\?\)px\/g/.test(clientSrc) && /var\(--mrf-scale, 1\)/.test(clientSrc));
check('toolbar renders FontSizeControl', /h\(FontSizeControl, \{ scale: fontScale/.test(clientSrc) && /function FontSizeControl/.test(clientSrc));
check('A− / A+ / reset present', /t\('fontSmaller'\)/.test(clientSrc) && /t\('fontLarger'\)/.test(clientSrc) && /onDoubleClick: \(\) => onChange\(FONT_DEFAULT\)/.test(clientSrc));

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
