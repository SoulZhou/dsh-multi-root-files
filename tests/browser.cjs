/**
 * Locates a Chromium build these browser-level tests can drive.
 *
 * A bundled Playwright Chromium is preferred. When it is absent — e.g. the
 * machine never ran `playwright install` — an installed Edge is used instead:
 * it speaks the same CDP protocol, so playwright-core drives it unchanged.
 *
 * Both `verify-font-scale.cjs` and `verify-image-zoom.cjs` used to hard-code
 * the ms-playwright scan and so failed outright here with
 * "no chromium under ms-playwright"; this module is the single fix.
 */
const fs = require('node:fs');
const path = require('node:path');

function playwrightCore() {
  return require(path.join(
    process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'));
}

function findChromium() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // A fresh install can hold several revisions; prefer the newest so the
    // measured behaviour matches the browser users actually get.
    const dirs = fs.readdirSync(root)
      .filter((name) => /^chromium-\d+|^chrome-/.test(name) || /^\d+\./.test(name))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
        'chrome-headless-shell-win/chrome-headless-shell.exe']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const edgeRoots = [
    'C:\\Program Files (x86)\\Microsoft\\EdgeCore',
    'C:\\Program Files\\Microsoft\\EdgeCore'
  ];
  for (const root of edgeRoots) {
    if (!fs.existsSync(root)) continue;
    const versions = fs.readdirSync(root)
      .filter((name) => /^\d+\./.test(name))
      .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]));
    for (const version of versions) {
      const p = path.join(root, version, 'msedge.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no Chromium found: install one with `npx playwright install chromium`, '
    + 'or make Edge available under Program Files\\Microsoft\\EdgeCore');
}

/** Launch a headless browser through playwright-core with the located build. */
async function launch() {
  return playwrightCore().chromium.launch({ executablePath: findChromium(), headless: true });
}

module.exports = { findChromium, launch, playwrightCore };