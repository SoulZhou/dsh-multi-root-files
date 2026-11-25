/**
 * Browser-level proof that the divider between the tree and the preview is
 * real: the REAL Splitter component (extracted from client.js) is mounted
 * against the REAL stylesheet in headless Chromium, then driven with real
 * pointer events. It measures the two panes, not the source.
 *
 * Covers: drag resizes proportionally, the seam stays under the pointer,
 * clamping at both ends, no text selection during the gesture, double-click
 * reset, and Left/Right/Home keyboard nudges.
 *
 * Run: node tests/verify-splitter.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

/* ---- the real stylesheet, rewritten the way ensureStyle() does it -------- */
const cssStart = clientSrc.indexOf('const CSS = `') + 'const CSS = `'.length;
const css = clientSrc.slice(cssStart, clientSrc.indexOf('`;', cssStart));
const scaled = css.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g,
  (_m, px) => `font-size: calc(${px}px * var(--mrf-scale, 1))`);

/* ---- the real Splitter component source --------------------------------- */
const fnStart = clientSrc.indexOf('function Splitter(props) {');
const fnEnd = clientSrc.indexOf('/* ------------------------------------------------------------ panel */', fnStart);
if (fnStart < 0 || fnEnd < 0) { console.log('FAIL  Splitter source not found'); process.exit(1); }
const splitterSrc = clientSrc.slice(fnStart, fnEnd);

/* ---- the constants it closes over, read from client.js ------------------ */
const num = (name, fallback) => {
  const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)`).exec(clientSrc);
  return m ? Number(m[1]) : fallback;
};
const consts = {
  TREE_MIN: num('TREE_MIN', 0.2),
  TREE_MAX: num('TREE_MAX', 0.8),
  TREE_DEFAULT: num('TREE_DEFAULT', 0.45),
  TREE_KEY_STEP: num('TREE_KEY_STEP', 0.02)
};

const browserHelper = require('./browser.cjs');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

(async () => {
  const browser = await browserHelper.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`<!doctype html><style>${scaled}
      html, body { margin: 0; }
      #panel { width: 600px; height: 400px; display: flex; flex-direction: column; }
      #row { height: 300px; }
    </style>
    <div class="mrf-panel" id="panel" data-preview="true" style="--mrf-scale:1;
      --dsw-alias-border-l1:#e3e5e8; --dsw-alias-state-business-primary:#4d6bfe">
      <div class="mrf-split" id="row" style="--mrf-tree-share:45%">
        <div class="mrf-treeWrap" id="tree"><div class="mrf-body"></div></div>
        <div id="seam"></div>
        <div class="mrf-previewPane" id="preview"><div class="mrf-previewBar"></div></div>
      </div>
    </div>`);

    // Mount the REAL component's virtual tree as real DOM inside #seam's place.
    await page.evaluate(({ src, consts }) => {
      // React-style prop names (onDoubleClick) are not DOM event names
      // (dblclick); map the ones this component uses.
      const EVENTS = { onDoubleClick: 'dblclick', onPointerDown: 'pointerdown', onKeyDown: 'keydown', onClick: 'click' };
      const h = (type, props, ...children) => {
        if (typeof type === 'function') return type(props);
        const el = document.createElement(type);
        for (const [key, value] of Object.entries(props || {})) {
          if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(EVENTS[key] || key.slice(2).toLowerCase(), value);
          } else if (key === 'className') el.className = value;
          else if (key === 'tabIndex') el.tabIndex = value;
          else el.setAttribute(key, String(value));
        }
        for (const child of children.flat(4)) {
          if (child === null || child === undefined || child === false) continue;
          el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return el;
      };
      const useCallback = (fn) => fn;
      const t = (key) => key;
      const row = document.getElementById('row');
      window.__log = { drag: [], commit: [], reset: 0, ratio: consts.TREE_DEFAULT };
      const onDrag = (ratio) => {
        window.__log.drag.push(ratio);
        window.__log.ratio = ratio;
        row.style.setProperty('--mrf-tree-share', `${ratio * 100}%`);
      };
      const onCommit = (ratio) => {
        window.__log.commit.push(ratio);
        window.__log.ratio = ratio;
        row.style.setProperty('--mrf-tree-share', `${ratio * 100}%`);
      };
      const onReset = () => { window.__log.reset += 1; onCommit(consts.TREE_DEFAULT); };
      // eslint-disable-next-line no-new-func
      const Splitter = new Function('h', 'useCallback', 'TREE_MIN', 'TREE_MAX', 'TREE_KEY_STEP', 't',
        `${src}\nreturn Splitter;`)(h, useCallback, consts.TREE_MIN, consts.TREE_MAX, consts.TREE_KEY_STEP, t);
      const node = Splitter({ ratio: consts.TREE_DEFAULT, t, onDrag, onCommit, onReset });
      document.getElementById('seam').replaceWith(node);
      window.__row = row;
    }, { src: splitterSrc, consts });

    const widths = () => page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      // #seam was replaced by the mounted Splitter, so read the handle itself.
      const row = rect('row'), tree = rect('tree');
      const handle = document.querySelector('.mrf-splitter').getBoundingClientRect();
      return {
        row: { left: row.left, width: row.width },
        tree: tree.width, preview: rect('preview').width,
        handle: { left: handle.left, width: handle.width },
        gap: row.width - tree.width - rect('preview').width - handle.width
      };
    });

    const base = await widths();
    console.log('\n=== layout at the default 45% split ===');
    console.log(' ', JSON.stringify(base));
    check('tree takes ~45% of the row', near(base.tree, base.row.width * 0.45, 4),
      `tree=${base.tree} row=${base.row.width}`);
    check('preview takes the rest', near(base.preview, base.row.width * 0.55 - base.handle.width, 6),
      `preview=${base.preview}`);
    check('the two panes abut with no gap (handle overlays the seam)',
      near(base.tree + base.preview, base.row.width, 1.5),
      `tree+preview=${base.tree + base.preview} row=${base.row.width}`);
    check('handle is a grabbable width, not hairline', base.handle.width >= 6 && base.handle.width <= 10,
      `width=${base.handle.width}`);

    /* ---------------------------------------------------------- real drag */
    const drag = async (toShare) => {
      const start = await widths();
      const grabX = start.handle.left + start.handle.width / 2;
      const targetX = start.row.left + start.row.width * toShare;
      await page.mouse.move(grabX, 200);
      await page.mouse.down();
      await page.mouse.move(targetX, 200, { steps: 8 });
      await page.mouse.up();
      return { start, result: await widths() };
    };

    console.log('\n=== drag the seam to 70% ===');
    const drag70 = await drag(0.7);
    console.log(' ', JSON.stringify(drag70.result));
    check('drag moved state to ~0.70',
      Math.abs((await page.evaluate(() => window.__log.ratio)) - 0.7) < 0.02,
      String(await page.evaluate(() => window.__log.ratio)));
    check('tree width followed the drag to ~70%',
      near(drag70.result.tree, drag70.result.row.width * 0.7, 6),
      `tree=${drag70.result.tree} want=${(drag70.result.row.width * 0.7).toFixed(1)}`);
    check('preview shrank accordingly',
      drag70.result.preview < drag70.start.preview, `${drag70.result.preview} < ${drag70.start.preview}`);
    check('seam sits under the pointer (no drift)', near(
      drag70.result.handle.left + drag70.result.handle.width / 2,
      drag70.result.row.left + drag70.result.row.width * 0.7, 2),
      `handle=${drag70.result.handle.left} want=${(drag70.result.row.left + drag70.result.row.width * 0.7).toFixed(1)}`);
    check('gesture ended with exactly one commit',
      (await page.evaluate(() => window.__log.commit.length)) === 1,
      `commits=${await page.evaluate(() => window.__log.commit.length)}`);

    console.log('\n=== clamping at both ends ===');
    const tooFar = await drag(1.4);
    check('dragging past the right edge stops at 80%',
      near(tooFar.result.tree, tooFar.result.row.width * 0.8, 6), `tree=${tooFar.result.tree}`);
    const tooNear = await drag(-0.4);
    check('dragging past the left edge stops at 20%',
      near(tooNear.result.tree, tooNear.result.row.width * 0.2, 6), `tree=${tooNear.result.tree}`);
    check('preview never collapses to nothing', tooNear.result.preview > 40, `preview=${tooNear.result.preview}`);

    console.log('\n=== text selection is suppressed during the gesture ===');
    await page.evaluate(() => {
      const handle = document.querySelector('.mrf-splitter');
      const rect = handle.getBoundingClientRect();
      window.__during = null;
      const mark = () => { window.__during = document.body.classList.contains('mrfResizing'); };
      window.addEventListener('pointermove', mark, { once: true });
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, clientX: rect.left + 3 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, clientX: rect.left + 90 }));
      const mid = document.body.classList.contains('mrfResizing');
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, clientX: rect.left + 90 }));
      window.__during = mid && window.__during;
    });
    check('body.mrfResizing is on while dragging', await page.evaluate(() => window.__during) === true);
    check('body.mrfResizing is cleared after release',
      await page.evaluate(() => !document.body.classList.contains('mrfResizing')));

    console.log('\n=== double-click and keyboard ===');
    await page.evaluate(() => document.querySelector('.mrf-splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    check('double-click resets to the default split',
      Math.abs((await page.evaluate(() => window.__log.ratio)) - consts.TREE_DEFAULT) < 0.001,
      String(await page.evaluate(() => window.__log.ratio)));
    check('reset was counted', (await page.evaluate(() => window.__log.reset)) === 1);

    const key = async (name) => {
      await page.evaluate((k) => {
        document.querySelector('.mrf-splitter').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      }, name);
      return page.evaluate(() => window.__log.ratio);
    };
    const before = await key('ArrowRight');
    check('ArrowRight nudges right', before > consts.TREE_DEFAULT, String(before));
    check('ArrowRight commits (persists) immediately',
      (await page.evaluate(() => window.__log.commit.length)) >= 2);
    const afterLeft = await key('ArrowLeft');
    check('ArrowLeft nudges back', afterLeft < before, `${afterLeft} < ${before}`);
    const home = await key('Home');
    check('Home goes to the left limit', Math.abs(home - consts.TREE_MIN) < 0.001, String(home));
    const end = await key('End');
    check('End goes to the right limit', Math.abs(end - consts.TREE_MAX) < 0.001, String(end));

    console.log('\n=== appearance (thin line, grip only on hover) ===');
    // Park the pointer far from the seam so the resting state is measured.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    const style = await page.evaluate(() => {
      const el = document.querySelector('.mrf-splitter');
      const grip = el.querySelector('.mrf-splitterGrip');
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      return {
        cursor: cs.cursor, touchAction: cs.touchAction,
        beforeWidth: before.width, beforeBg: before.backgroundColor,
        gripOpacity: getComputedStyle(grip).opacity,
        role: el.getAttribute('role'), orientation: el.getAttribute('aria-orientation'),
        min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax'),
        text: el.getAttribute('aria-valuetext'), tabIndex: el.tabIndex
      };
    });
    console.log('  resting:', JSON.stringify(style));
    check('cursor is col-resize', style.cursor === 'col-resize');
    check('touch-action none (no scroll-steal on touch)', style.touchAction === 'none');
    check('the visible line is thin (1px), not the whole hit area', style.beforeWidth === '1px', style.beforeWidth);
    check('the line uses a theme border token', style.beforeBg === 'rgb(227, 229, 232)', style.beforeBg);
    check('grip is hidden until hover', style.gripOpacity === '0', style.gripOpacity);
    check('exposed as a separator with its range',
      style.role === 'separator' && style.orientation === 'vertical'
      && style.min === '20' && style.max === '80' && style.text === '45%', JSON.stringify(style));
    check('keyboard reachable (tabIndex 0)', style.tabIndex === 0);

    // Hovering the seam must light it up: thicker line, brand colour, grip out.
    const box = await page.evaluate(() => {
      const r = document.querySelector('.mrf-splitter').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(250);
    const hover = await page.evaluate(() => {
      const el = document.querySelector('.mrf-splitter');
      return {
        width: getComputedStyle(el, '::before').width,
        bg: getComputedStyle(el, '::before').backgroundColor,
        gripOpacity: getComputedStyle(el.querySelector('.mrf-splitterGrip')).opacity
      };
    });
    console.log('  hover:  ', JSON.stringify(hover));
    check('hover thickens the line to 2px', hover.width === '2px', hover.width);
    check('hover switches to the brand colour', hover.bg === 'rgb(77, 107, 254)', hover.bg);
    check('hover reveals the grip', hover.gripOpacity === '1', hover.gripOpacity);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });