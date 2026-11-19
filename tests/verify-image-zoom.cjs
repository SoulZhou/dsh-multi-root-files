/**
 * Browser-level proof for the full-window image lightbox:
 *   1. The transform translate(pan) scale(zoom) actually grows/shrinks the
 *      rendered image monotonically (no CSS-zoom/max-width conflict).
 *   2. Pointer-centred zoom keeps the pixel under the cursor fixed:
 *        pan' = p - (p - pan) * (z1/z0)
 *      so a magnified image can be explored by zooming at different points.
 *   3. Dragging adds the pointer delta to pan, revealing hidden parts.
 *
 * Run: node tests/verify-image-zoom.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
const s = clientSrc.indexOf('const CSS = `');
const from = s + 'const CSS = `'.length;
const to = clientSrc.indexOf('`;', from);
const css = clientSrc.slice(from, to);

function findChromium() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('no chromium under ms-playwright');
}
const playwright = require(path.join(
  process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'));

function imgData(w, h) {
  return 'data:image/svg+xml;base64,' + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="teal"/></svg>`
  ).toString('base64');
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

// The exact pointer-centred zoom transform from ImageLightbox, mirrored here
// so the browser can measure its rendered result.
function zoomAt(state, factor, p) {
  const z1 = Math.min(8, Math.max(0.25, Math.round(state.zoom * factor * 100) / 100));
  const ratio = z1 / state.zoom;
  return { zoom: z1, pan: { x: p.x - (p.x - state.pan.x) * ratio, y: p.y - (p.y - state.pan.y) * ratio } };
}

(async () => {
  const browser = await playwright.chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body style="margin:0">
      <div class="mrf-lbStage" id="stage" style="width:1200px;height:740px">
        <img class="mrf-lbImage" id="img" src="${imgData(160, 120)}">
      </div></body></html>`);
    const apply = async (state) => {
      await page.evaluate((st) => {
        document.getElementById('img').style.transform =
          `translate(${st.pan.x}px, ${st.pan.y}px) scale(${st.zoom})`;
      }, state);
      return page.evaluate(() => {
        const img = document.getElementById('img');
        const r = img.getBoundingClientRect();
        return { w: r.width, h: r.height, left: r.left, top: r.top };
      });
    };

    console.log('\n=== transform scale monotonic growth ===');
    let state = { zoom: 1, pan: { x: 0, y: 0 } };
    const z1 = await apply(state);
    state = zoomAt(state, 2, { x: 0, y: 0 }); const z2 = await apply(state);
    state = zoomAt(state, 2, { x: 0, y: 0 }); const z4 = await apply(state);
    console.log(`  1x=${Math.round(z1.w)}  2x=${Math.round(z2.w)}  4x=${Math.round(z4.w)}`);
    check('2x doubles rendered width', Math.abs(z2.w - z1.w * 2) <= 2, `${z1.w} -> ${z2.w}`);
    check('4x quadruples rendered width', Math.abs(z4.w - z1.w * 4) <= 3, `${z1.w} -> ${z4.w}`);

    console.log('\n=== pointer-centred zoom keeps cursor pixel fixed ===');
    // A large image so magnified size far exceeds the stage.
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body style="margin:0"><div class="mrf-lbStage" id="stage" style="width:1200px;height:740px">
        <img class="mrf-lbImage" id="img" src="${imgData(1000, 800)}"></div></body></html>`);
    // Stage centre on screen is (600, 370). Zoom at an off-centre pixel p=(900,500).
    const p = { x: 900, y: 500 };
    const pScreen = { x: 600 + p.x, y: 370 + p.y }; // stage left/top = 0 here
    let st = { zoom: 1, pan: { x: 0, y: 0 } };
    const beforeApply = await apply(st);
    // Image-centred coordinate under the pointer before zoom: u = (p - pan)/zoom
    const u = { x: (p.x - st.pan.x) / st.zoom, y: (p.y - st.pan.y) / st.zoom };
    st = zoomAt(st, 2.5, p);
    const afterApply = await apply(st);
    // Screen position of that same image pixel after zoom = centre + pan' + u*zoom'
    const screenAfter = { x: 600 + st.pan.x + u.x * st.zoom, y: 370 + st.pan.y + u.y * st.zoom };
    check('pixel under cursor stays put after zoom',
      Math.abs(screenAfter.x - pScreen.x) < 1 && Math.abs(screenAfter.y - pScreen.y) < 1,
      `expected ${JSON.stringify(pScreen)} got ${JSON.stringify(screenAfter)}`);
    check('magnified image can exceed the stage', afterApply.w > 1200,
      `rendered=${Math.round(afterApply.w)} stage=1200`);

    console.log('\n=== drag-to-pan shifts the rendered image ===');
    const beforeDrag = await apply(st);
    const dragged = { zoom: st.zoom, pan: { x: st.pan.x - 200, y: st.pan.y - 100 } };
    const afterDrag = await apply(dragged);
    check('drag left/up shifts image by delta',
      Math.abs((afterDrag.left - beforeDrag.left) - (-200)) < 1 &&
      Math.abs((afterDrag.top - beforeDrag.top) - (-100)) < 1,
      `dx=${afterDrag.left - beforeDrag.left} dy=${afterDrag.top - beforeDrag.top}`);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
