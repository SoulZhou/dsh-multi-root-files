/**
 * Browser-level proof that --mrf-scale actually scales the files panel.
 * Injects the REAL (rewritten) stylesheet into headless Chromium and measures
 * computed font-size at scale 1 / 1.5 / 0.8, including a point OUTSIDE the
 * panel that must stay fixed.
 *
 * Run: node tests/verify-font-scale.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const s = clientSrc.indexOf('const CSS = `');
const from = s + 'const CSS = `'.length;
const to = clientSrc.indexOf('`;', from);
const css = clientSrc.slice(from, to);
const scaled = css.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g,
  (_m, px) => `font-size: calc(${px}px * var(--mrf-scale, 1))`);

function findChromium() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
        'chrome-headless-shell-win/chrome-headless-shell.exe']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('no chromium under ms-playwright');
}
const playwright = require(path.join(
  process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

(async () => {
  const browser = await playwright.chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>${scaled}</style>
      <div id="outside" style="font-size:11px">outside</div>
      <div class="mrf-panel" id="panel" style="--mrf-scale:1">
        <div class="mrf-bar"><span class="mrf-title" id="title">tab</span></div>
        <div class="mrf-note" id="note">note</div>
        <div class="mrf-code"><div class="mrf-lineNo" id="code">1</div></div>
        <div class="mrf-markdown"><h1 class="mrf-mdH mrf-mdH1" id="h1">Heading</h1></div>
      </div>`);
    const read = async (scale) => {
      await page.evaluate((v) => document.getElementById('panel').style.setProperty('--mrf-scale', String(v)), scale);
      return page.evaluate(() => {
        const get = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
        return { title: get('title'), note: get('note'), code: get('code'), h1: get('h1'), outside: get('outside') };
      });
    };
    const base = await read(1), big = await read(1.5), small = await read(0.8);
    console.log('\n=== computed font-size at 1 / 1.5 / 0.8 ===');
    console.log('  1  :', JSON.stringify(base));
    console.log('  1.5:', JSON.stringify(big));
    console.log('  0.8:', JSON.stringify(small));
    check('all font-size declarations rewritten', (scaled.match(/font-size: calc\(/g) || []).length >= 25,
      `count=${(scaled.match(/font-size: calc\(/g) || []).length}`);
    check('title scales 12 -> 18', Math.abs(big.title - base.title * 1.5) < 0.2);
    check('note scales 11 -> 16.5', Math.abs(big.note - base.note * 1.5) < 0.2);
    check('code line scales too', Math.abs(big.code - base.code * 1.5) < 0.2);
    check('markdown h1 scales 19 -> 28.5', Math.abs(big.h1 - base.h1 * 1.5) < 0.3);
    check('shrink to 0.8 proportional', Math.abs(small.title - base.title * 0.8) < 0.2);
    check('one shared scale factor', Math.abs(big.h1 / base.h1 - big.title / base.title) < 0.02);
    check('does NOT leak outside .mrf-panel', Math.abs(big.outside - base.outside) < 0.01 && Math.abs(small.outside - base.outside) < 0.01);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
