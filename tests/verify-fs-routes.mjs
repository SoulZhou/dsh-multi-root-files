/**
 * Regression for the self-owned fs routes (decouple from upstream).
 * Verifies:
 *  1. decodeTextBytes matches the sidebar's encoding sniffing for UTF-8 / BOMs /
 *     BOM-less UTF-16 / GBK / GB18030 / binary verdicts.
 *  2. listDirectory returns the sidebar-compatible shape and directory-first,
 *     case-insensitive ordering, and works on an ABSOLUTE path outside cwd.
 *  3. The client no longer references the sidebar fs routes (hard dependency gone).
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = await import(pathToFileURL(join(dir, 'index.js')).href);
const { decodeTextBytes, compareEntries, listDirectory } = mod.__test;

// --- 1. decoding -----------------------------------------------------------
assert.equal(decodeTextBytes(Buffer.from('hello 世界', 'utf8')).content, 'hello 世界');
assert.equal(decodeTextBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('utf8bom', 'utf8')])).content, 'utf8bom');
assert.equal(decodeTextBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16le', 'utf16le')])).content, 'utf16le');
const be16 = Buffer.from('utf16be', 'utf16le'); be16.swap16();
assert.equal(decodeTextBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be16])).content, 'utf16be');
// BOM-less UTF-16LE (NUL lane + text vote)
assert.equal(decodeTextBytes(Buffer.from('config', 'utf16le')).content, 'config');
// binary: NUL bytes without a text lane
assert.equal(decodeTextBytes(Buffer.from([0, 1, 2, 3, 4, 5])), null);
// GBK Chinese ('你好' in GBK bytes)
assert.equal(decodeTextBytes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])).content, '你好');

// --- 2. listDirectory ------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'mrf-fs-'));
await mkdir(join(root, 'Zdir'));
await mkdir(join(root, 'adir'));
await writeFile(join(root, 'b.txt'), 'b');
await writeFile(join(root, 'A.txt'), 'A');
const level = await listDirectory(resolve(root));
assert.equal(level.path, resolve(root));
assert.deepEqual(level.entries.map((e) => e.name), ['adir', 'Zdir', 'A.txt', 'b.txt']);
assert.equal(level.entries[0].isDir, true);
assert.equal(level.entries[2].isDir, false);
assert.match(level.entries[2].path, /[\\/]A\.txt$/);
assert.equal(level.truncated, false);
// comparator standalone
assert.equal(compareEntries({ name: 'a', isDir: false }, { name: 'B', isDir: true }), 1);

// --- 3. client has no hard dependency on sidebar fs routes ----------------
const clientSrc = readFileSync(join(dir, 'client.js'), 'utf8');
assert.equal(clientSrc.includes('sidebar/api/fs.trees'), false, 'client still calls sidebar fs.trees');
assert.equal(clientSrc.includes('sidebar/api/fs.read'), false, 'client still calls sidebar fs.read');
assert.match(clientSrc, /fetch\(routeUrl\(ctx, `\$\{API_BASE\}\/fs\.trees`\)/);
assert.match(clientSrc, /fetch\(routeUrl\(ctx, `\$\{API_BASE\}\/fs\.read`\)/);

const indexSrc = readFileSync(join(dir, 'index.js'), 'utf8');
assert.match(indexSrc, /registerPost\(host, 'fs\.trees', handleFsTrees\)/);
assert.match(indexSrc, /registerPost\(host, 'fs\.read', handleFsRead\)/);

console.log('verify-fs-routes: OK');
