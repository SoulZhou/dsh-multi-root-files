/**
 * Regression for POST /fs.write (the panel's own editor saving a file).
 * Everything runs in a TEMP directory; no workspace file is touched.
 *
 * Run: node tests/verify-fs-write.mjs
 */
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = await import(pathToFileURL(join(dir, 'index.js')).href);
const {
  handleFsWrite, handleFsRead, decodeTextBytes, encodeText, detectLineEnding, applyLineEnding,
  WRITABLE_ENCODINGS, MAX_EDITABLE_BYTES
} = mod.__test;

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

async function save(body) {
  const { response, done } = makeResponse();
  const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = 'POST';
  await handleFsWrite(null, stream, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* not json */ }
  return { status: res.statusCode, json, text: res.text };
}

/** Same envelope, through the read handler — it must explain ENOENT too. */
async function read(path) {
  const { response, done } = makeResponse();
  const stream = Readable.from([Buffer.from(JSON.stringify({ path }), 'utf8')]);
  stream.method = 'POST';
  await handleFsRead(null, stream, response);
  const res = await done;
  let json;
  try { json = JSON.parse(res.text); } catch { /* not json */ }
  return { status: res.statusCode, json, text: res.text };
}

const root = await mkdtemp(join(tmpdir(), 'mrf-write-'));
try {
  /* -------------------------------------------------- encoding round-trips */
  console.log('\n=== decode names its encoding, and it round-trips ===');
  const samples = {
    utf8: Buffer.from('你好 world\n', 'utf8'),
    'utf8-bom': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n', 'utf8')]),
    'utf16le-bom': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好\n', 'utf16le')]),
    'utf16be-bom': (() => {
      const body = Buffer.from('你好\n', 'utf16le');
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    })(),
    utf16le: Buffer.from('config\n', 'utf16le')
  };
  for (const [name, bytes] of Object.entries(samples)) {
    const decoded = decodeTextBytes(bytes);
    check(`${name}: detected as ${name}`, decoded?.encoding === name, `got ${decoded?.encoding}`);
    check(`${name}: re-encodes byte-identically`, encodeText(decoded.content, decoded.encoding).equals(bytes));
  }

  console.log('\n=== GBK is readable but NOT writable (no Node encoder) ===');
  const gbk = decodeTextBytes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  check('gbk decodes to 你好', gbk.content === '你好');
  check('gbk is refused for writing', WRITABLE_ENCODINGS.has(gbk.encoding) === false);
  check('encodeText throws instead of rewriting as utf8', (() => {
    try { encodeText('你好', 'gbk'); return false; } catch { return true; }
  })());

  console.log('\n=== line endings are preserved ===');
  check('crlf detected', detectLineEnding('a\r\nb\r\n') === '\r\n');
  check('lf detected', detectLineEnding('a\nb\n') === '\n');
  check('lf text becomes crlf', applyLineEnding('a\nb', '\r\n') === 'a\r\nb');
  check('crlf text stays single crlf', applyLineEnding('a\r\nb', '\r\n') === 'a\r\nb');
  check('crlf file keeps lf when editor returns lf', applyLineEnding('a\nb', '\n') === 'a\nb');

  /* ------------------------------------------------------ the real handler */
  console.log('\n=== POST /fs.write through the real handler ===');
  const utf8Path = join(root, 'note.md');
  await writeFile(utf8Path, '# 标题\r\n\r\n原文\r\n', 'utf8');
  const before = await stat(utf8Path);
  const ok = await save({ path: utf8Path, content: '# 标题\n\n改后的内容\n', mtimeMs: before.mtimeMs });
  check('save returns ok', ok.json?.ok === true, ok.text);
  const afterRaw = await readFile(utf8Path);
  check('content on disk is what the editor held', afterRaw.toString('utf8') === '# 标题\r\n\r\n改后的内容\r\n', JSON.stringify(afterRaw.toString('utf8')));
  check('CRLF line ending survived the save', afterRaw.toString('utf8').includes('\r\n'));
  check('handler reports the new mtime', typeof ok.json?.value?.mtimeMs === 'number');
  check('mtime actually advanced', ok.json?.value?.mtimeMs >= before.mtimeMs);

  console.log('\n=== conflicts and refusals ===');
  const stale = await save({ path: utf8Path, content: 'nope', mtimeMs: before.mtimeMs - 5000 });
  check('stale mtime is refused', stale.json?.ok === false && /changed on disk/.test(stale.json.error.message), stale.text);
  check('refused save did not touch the file', (await readFile(utf8Path, 'utf8')).includes('改后的内容'));

  const noMtime = await save({ path: utf8Path, content: '允许\n' });
  check('omitting mtimeMs accepts what is on disk', noMtime.json?.ok === true, noMtime.text);

  const missingPath = await save({ content: 'x' });
  check('missing path is refused', missingPath.json?.ok === false && /path must be/.test(missingPath.json.error.message), missingPath.text);
  const missingContent = await save({ path: utf8Path });
  check('missing content is refused', missingContent.json?.ok === false && /content must be/.test(missingContent.json.error.message), missingContent.text);
  const dirTarget = await save({ path: root, content: 'x' });
  check('directory target is refused', dirTarget.json?.ok === false && /is a directory/.test(dirTarget.json.error.message), dirTarget.text);

  // A file deleted after the tree was read: the panel used to surface the raw
  // "ENOENT: no such file or directory, stat 'F:\\...'" text in its banner.
  const gonePath = join(root, 'gone.md');
  const gone = await save({ path: gonePath, content: 'x' });
  check('vanished file is refused', gone.json?.ok === false, gone.text);
  check('vanished file gets a sentence, not a raw errno',
    /no longer on disk/.test(gone.json?.error?.message ?? '') && !/ENOENT/.test(gone.json?.error?.message ?? ''),
    gone.json?.error?.message);
  check('vanished file carries the ENOENT code', gone.json?.error?.code === 'ENOENT', gone.json?.error?.code);
  check('nothing was created in its place', (await stat(gonePath).catch(() => null)) === null);

  const goneRead = await read(gonePath);
  check('fs.read explains the vanished file too',
    goneRead.json?.ok === false && /no longer on disk/.test(goneRead.json.error.message) && goneRead.json.error.code === 'ENOENT',
    goneRead.text);

  const gbkPath = join(root, 'gbk.txt');
  await writeFile(gbkPath, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  const gbkSave = await save({ path: gbkPath, content: '你好呀' });
  check('GBK file refuses to save', gbkSave.json?.ok === false && /gbk/.test(gbkSave.json.error.message), gbkSave.text);
  check('GBK file is byte-unchanged', (await readFile(gbkPath)).equals(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])));

  const binPath = join(root, 'blob.bin');
  await writeFile(binPath, Buffer.from([0, 1, 2, 3, 4]));
  const binSave = await save({ path: binPath, content: 'x' });
  check('binary file refuses to save', binSave.json?.ok === false && /not text/.test(binSave.json.error.message), binSave.text);
  check('binary file is byte-unchanged', (await readFile(binPath)).equals(Buffer.from([0, 1, 2, 3, 4])));

  const utf16Path = join(root, 'wide.txt');
  const utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('旧\n', 'utf16le')]);
  await writeFile(utf16Path, utf16Bytes);
  const utf16Save = await save({ path: utf16Path, content: '新\n' });
  check('UTF-16LE file saves', utf16Save.json?.ok === true, utf16Save.text);
  const utf16After = await readFile(utf16Path);
  check('UTF-16LE BOM kept', utf16After[0] === 0xff && utf16After[1] === 0xfe);
  check('UTF-16LE body is new text', utf16After.subarray(2).toString('utf16le') === '新\n');

  /* ---------------------------------------------- the client wiring exists */
  console.log('\n=== client wiring ===');
  const { readFileSync } = await import('node:fs');
  const clientSrc = readFileSync(join(dir, 'client.js'), 'utf8');
  assertMatch(clientSrc, /saveFile\s*\(/, 'client has a saveFile helper');
  assertMatch(clientSrc, /failure\.code = typeof parsed\?\.error\?\.code/, 'saveFile keeps the error code');
  assertMatch(clientSrc, /error\?\.code === 'ENOENT'\) void load\(\)/, 'a vanished file refreshes the tree');
  assertMatch(clientSrc, /mrf-mdToggle/, 'toggle still present');
  assertMatch(clientSrc, /textContent|\.value\b/, 'editor uses a textarea/value');

  function assertMatch(source, pattern, name) {
    check(name, pattern.test(source));
  }

  console.log(`\nMAX_EDITABLE_BYTES = ${MAX_EDITABLE_BYTES}`);
} finally {
  try { await rm(root, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);