/**
 * Regression for THIS plugin's durable /settings route (font size).
 * Uses a TEMP DSH_HOME so the real settings file is never touched.
 *
 * Run: node tests/verify-settings.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const realHome = process.env.DSH_HOME;
let tmp;
try {
  tmp = mkdtempSync(join(tmpdir(), 'mrf-settings-'));
  process.env.DSH_HOME = tmp;                       // set BEFORE importing host
} catch (error) {
  console.log(`FAIL  cannot create temp DSH_HOME: ${error.message}`);
  process.exit(1);
}

const { __test } = await import('../index.js');
const { handleSettings, sanitizeSettings, settingsPath } = __test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

function makeResponse() {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const response = {
    statusCode: 0, headers: {}, text: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.text = chunk ? Buffer.from(chunk).toString('utf8') : ''; resolveDone(this); }
  };
  return { response, done };
}

async function call(method, body) {
  const { response, done } = makeResponse();
  const stream = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  await handleSettings(null, stream, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* plain-text error */ }
  return { status: res.statusCode, json, text: res.text };
}

console.log('\n=== sanitizeSettings (whitelist + range + step) ===');
check('fresh -> default 1', JSON.stringify(sanitizeSettings({})) === '{"fontScale":1}');
check('null -> default', JSON.stringify(sanitizeSettings(null)) === '{"fontScale":1}');
check('unknown keys dropped', JSON.stringify(sanitizeSettings({ fontScale: 1.3, evil: 1 })) === '{"fontScale":1.3}');
check('below min clamped to 0.8', sanitizeSettings({ fontScale: 0.1 }).fontScale === 0.8);
check('above max clamped to 1.6', sanitizeSettings({ fontScale: 9 }).fontScale === 1.6);
check('garbage -> default', sanitizeSettings({ fontScale: 'big' }).fontScale === 1);
check('snaps to 0.1 step', sanitizeSettings({ fontScale: 1.27 }).fontScale === 1.3);
check('settings file is this plugin\'s OWN', /multi_root_files_settings\.json$/.test(settingsPath()), settingsPath());

console.log('\n=== /settings GET/POST through the real handler ===');
try {
  const first = await call('GET');
  check('GET first run -> 200 default', first.status === 200 && first.json?.fontScale === 1, first.text);
  const saved = await call('POST', { fontScale: 1.4, ignored: true });
  check('POST -> 200 sanitized', saved.status === 200 && saved.json?.fontScale === 1.4 && saved.json?.ignored === undefined, saved.text);
  const back = await call('GET');
  check('GET reads persisted value back', back.json?.fontScale === 1.4, back.text);
  check('file written to disk', existsSync(settingsPath()), settingsPath());
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  check('disk contains ONLY fontScale', JSON.stringify(Object.keys(raw).sort()) === '["fontScale"]', JSON.stringify(raw));
  const clamped = await call('POST', { fontScale: -5 });
  check('POST clamps out-of-range to 0.8', clamped.json?.fontScale === 0.8, clamped.text);
  const bad = await call('DELETE');
  check('unsupported method -> 405', bad.status === 405, `status=${bad.status}`);
} catch (error) {
  failures += 1;
  console.log(`  FAIL  integration threw: ${error.message}`);
}

if (realHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = realHome;
if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows handle */ } }

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
