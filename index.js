/**
 * Host half of dsh-multi-root-files.
 *
 * Why this plugin exists: DSH's built-in Files tab (dsh-better-sidebar's editor
 * explorer) is rooted at the session's single working directory. A very common
 * layout — several sibling checkouts beside the primary project — leaves the
 * additional roots invisible there, even when they are registered as writable
 * workspace roots through @dsh-electron/dsh-plugin-multi-root-workspace.
 *
 * This host half answers the one question the client cannot answer itself:
 * "which roots does this session have?" The answer comes from the multi-root
 * plugin's own durable store ($DSH_HOME/storages/multi_root_workspace.json),
 * keyed by the PRIMARY root's absolute path. The client then lists and reads
 * those roots through THIS plugin's own /fs.trees and /fs.read routes. They
 * deliberately do not go through dsh-better-sidebar's ensureWorkspacePath()
 * fence (which @dsh-electron/dsh-plugin-multi-root-workspace patches away only
 * while it loads): an absolute path outside cwd resolves fine even when that
 * upstream plugin failed to load after a DSH upgrade.
 *
 * Writes exactly one thing: /fs.write saves the text a human edited in this
 * panel's own editor, for a file it has already read as text. It never
 * creates, renames, moves or deletes a file, never touches a binary or an
 * oversized file, and refuses to run when the file changed on disk since the
 * editor loaded it. The text keeps the file's OWN encoding and line endings
 * (a GBK document is written back as GBK), so saving one paragraph does not
 * rewrite every Chinese line in the diff.
 *
 * /open is the only OS-level action (REVEAL one path in Explorer / Finder);
 * it launches no editor and accepts no arguments.
 */
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, relative, sep } from 'node:path';

const API = '/dsh-multi-root-files/api';

/** Panel font scale: allowed range and step (a tenth at a time). */
const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.6;
/**
 * Share of the split given to the file tree when a file is open. The drag
 * handle clamps here so neither pane can be dragged to nothing: the tree keeps
 * at least a fifth and the preview at least a fifth of the row.
 */
const TREE_RATIO_MIN = 0.2;
const TREE_RATIO_MAX = 0.8;
const DEFAULT_SETTINGS = { fontScale: 1, treeRatio: 0.45 };

/** Additional roots one slot may report (matches the multi-root plugin's cap). */
const MAX_ADDITIONAL_ROOTS = 64;
/** One git invocation's budget; a stalled mount must not hold the panel. */
const GIT_TIMEOUT_MS = 8000;
/** Ceiling on a status answer; the client only ever lists a few hundred rows. */
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
/** Ceiling on paths sent to `git check-ignore --stdin`. */
const MAX_IGNORE_PATHS = 4096;
/** Ceiling on an image served into the preview (a bigger one is refused). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** The file manager gets a shorter leash than git: it should answer at once. */
const OPEN_TIMEOUT_MS = 6000;
/** Max directory rows in one fs.trees level (mirrors the sidebar explorer's cap). */
const LIST_LIMIT = 1000;
/** Max paths accepted in one fs.trees batch (the client batches by 64). */
const MAX_TREE_PATHS = 64;
/** Text files bigger than this are served as a short `too-large` head. */
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
/** Bytes read from an oversized file, enough to sniff its encoding. */
const READ_HEAD_LIMIT = 4096;
/**
 * Ceiling on one save request. The text itself is capped at
 * MAX_EDITABLE_BYTES; the rest is JSON escaping headroom (a 4-byte character
 * can become a 12-byte `\uXXXX` pair, and Windows newlines double).
 */
const MAX_WRITE_BODY = MAX_EDITABLE_BYTES * 4 + 64 * 1024;

/** Image types the preview can draw, by extension. */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
};

/** The media type of a path, or `undefined` when it is not a drawable image. */
function imageTypeFor(path) {
  return IMAGE_TYPES[extname(String(path)).toLowerCase()];
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

function registryPath() {
  return join(dshHome(), 'storages', 'multi_root_workspace.json');
}

/**
 * THIS plugin owns its own settings file. dsh-multi-root-changes stores its
 * fontScale in multi_root_changes_settings.json; the two panels are meant to
 * be adjustable independently (the user asked for separate values), so they
 * must never overwrite each other.
 */
function settingsPath() {
  return join(dshHome(), 'storages', 'multi_root_files_settings.json');
}

/**
 * Whitelist + clamp, mirroring the changes panel's rules.
 *
 * `fontScale` snaps to a 0.1 step (it is a discrete setting with buttons).
 * `treeRatio` is the draggable split position and is kept as a continuous
 * share rounded to three decimals: a pointer drag must land where it was
 * released, not jump back to the nearest tenth.
 */
function sanitizeSettings(raw) {
  const clean = { ...DEFAULT_SETTINGS };
  if (raw !== null && typeof raw === 'object') {
    const value = Number(raw.fontScale);
    if (Number.isFinite(value)) {
      const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
      clean.fontScale = Math.round(clamped * 10) / 10;
    }
    const ratio = Number(raw.treeRatio);
    if (Number.isFinite(ratio)) {
      const clampedRatio = Math.min(TREE_RATIO_MAX, Math.max(TREE_RATIO_MIN, ratio));
      clean.treeRatio = Math.round(clampedRatio * 1000) / 1000;
    }
  }
  return clean;
}

async function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(await readFile(settingsPath(), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  const file = settingsPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

/** Platform-aware identity used only for comparing absolute roots. */
function pathIdentity(path) {
  const absolute = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** The last path segment of either separator style. */
function baseName(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sendText(response, status, text) {
  const body = Buffer.from(text);
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('body too large');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJsonBody(request, limit = 64 * 1024) {
  const raw = await readBody(request, limit);
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw.toString('utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * The session's live cwd, falling back to the client's own summary hint while
 * the session is still hydrating at page load.
 */
function resolveSessionCwd(ctx, sessionId, clientCwd) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId);
      if (session !== undefined) {
        const live = ctx.get('workingDirectory')?.get?.(session);
        if (typeof live === 'string' && live !== '') return live;
        if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd;
      }
    } catch { /* fall through to the client hint */ }
  }
  return typeof clientCwd === 'string' && clientCwd !== '' ? clientCwd : '';
}

/**
 * Read the multi-root registry and return the additional roots registered for
 * one primary root. A missing or unreadable file is not an error: it means
 * "no additional roots", exactly how DSH behaves without that plugin.
 */
async function readAdditionalRoots(primaryRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(registryPath(), 'utf8'));
  } catch {
    return { roots: [], registryFound: false };
  }
  const table = parsed?.tables?.roots;
  if (!table || typeof table !== 'object') return { roots: [], registryFound: false };

  const wanted = pathIdentity(primaryRoot);
  let bucket;
  for (const [key, value] of Object.entries(table)) {
    if (pathIdentity(key) === wanted) { bucket = value; break; }
  }
  if (!bucket || !Array.isArray(bucket.roots)) return { roots: [], registryFound: true };

  const roots = [];
  for (const row of bucket.roots) {
    if (roots.length >= MAX_ADDITIONAL_ROOTS) break;
    const path = typeof row?.path === 'string' && row.path !== '' ? row.path : row?.recordedPath;
    if (typeof path !== 'string' || path === '') continue;
    roots.push({
      path,
      aliasId: typeof row.aliasId === 'string' ? row.aliasId : undefined,
      access: typeof row.access === 'string' ? row.access : (typeof row.grant === 'string' ? row.grant : undefined)
    });
  }
  return { roots, registryFound: true };
}

/** Whether a registered root still sits on disk (a moved folder would fail to list). */
async function rootExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------ own fs list / read routes */

/*
 * These two routes replace dsh-better-sidebar's `fs.trees` / `fs.read` for this
 * panel. The sidebar versions call ensureWorkspacePath(), a containment fence
 * that only lets paths inside the session cwd through; it is the UPSTREAM
 * multi-root plugin's patch that removes that fence, so when that plugin fails
 * to load after a DSH upgrade the tree dies. Our own host routes read absolute
 * paths directly (exactly like this plugin's existing /image and /open routes
 * already do), which removes that hard dependency entirely.
 *
 * Wire shapes are byte-compatible with the sidebar so the client only has to
 * change the route path, not the renderer.
 */

function messageOf(error) {
  return String(error?.message ?? error);
}

/** Compare two byte prefixes. */
function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF32LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
const UTF32BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const GBK_DECODER = new TextDecoder('gbk', { fatal: true });
const GB18030_DECODER = new TextDecoder('gb18030', { fatal: true });

function decodeUtf16(bytes, littleEndian) {
  const length = bytes.length - (bytes.length % 2);
  const body = Buffer.from(bytes.subarray(0, length));
  if (!littleEndian) body.swap16();
  return body.toString('utf16le');
}

function decodeUtf32(bytes, littleEndian) {
  const length = bytes.length - (bytes.length % 4);
  let content = '';
  for (let offset = 0; offset < length; offset += 4) {
    const codePoint = littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    content += codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : '\ufffd';
  }
  return content;
}

function isUtf16TextUnit(unit) {
  if (unit === 9 || unit === 10 || unit === 13) return true;
  if (unit >= 32 && unit <= 126) return true;
  if (unit >= 160 && unit <= 55295) return true;
  return unit >= 57344 && unit <= 65533;
}

function looksLikeUtf16Text(bytes, pairs, littleEndian) {
  if (pairs === 0) return false;
  let text = 0;
  for (let index = 0; index < pairs; index += 1) {
    const unit = littleEndian
      ? bytes[index * 2] | (bytes[index * 2 + 1] << 8)
      : (bytes[index * 2] << 8) | bytes[index * 2 + 1];
    if (isUtf16TextUnit(unit)) text += 1;
  }
  return text * 10 >= pairs * 9;
}

/** Detect BOM-less UTF-16 from the NUL-byte lane, guarded by a text-lane vote. */
function bomlessUtf16(bytes) {
  if (bytes.length < 4) return undefined;
  const pairs = Math.min(Math.floor(bytes.length / 2), 1024);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs; i += 1) {
    if (bytes[i * 2] === 0) evenZeros += 1;
    if (bytes[i * 2 + 1] === 0) oddZeros += 1;
  }
  const minimumZeros = Math.max(2, Math.floor(pairs * 0.2));
  if (oddZeros >= minimumZeros && oddZeros >= evenZeros * 4 && looksLikeUtf16Text(bytes, pairs, true)) return 'utf16le';
  if (evenZeros >= minimumZeros && evenZeros >= oddZeros * 4 && looksLikeUtf16Text(bytes, pairs, false)) return 'utf16be';
  return undefined;
}

function tryDecode(decoder, bytes) {
  try { return decoder.decode(bytes); } catch { return undefined; }
}

function hasGb18030FourByteSequence(bytes) {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    const b1 = bytes[i]; const b2 = bytes[i + 1]; const b3 = bytes[i + 2]; const b4 = bytes[i + 3];
    if (b1 >= 129 && b1 <= 254 && b2 >= 48 && b2 <= 57 && b3 >= 129 && b3 <= 254 && b4 >= 48 && b4 <= 57) return true;
  }
  return false;
}

function hasIncompleteUtf8Tail(bytes) {
  for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start += 1) {
    const lead = bytes[start];
    const size = lead >= 240 && lead <= 244 ? 4 : lead >= 224 && lead <= 239 ? 3 : lead >= 194 && lead <= 223 ? 2 : 0;
    if (size === 0 || start + size <= bytes.length) continue;
    let incomplete = true;
    for (let i = start + 1; i < bytes.length; i += 1) {
      const trail = bytes[i];
      if (trail < 128 || trail > 191) { incomplete = false; break; }
    }
    if (incomplete && tryDecode(UTF8_DECODER, bytes.subarray(0, start)) !== undefined) return true;
  }
  return false;
}

/**
 * Decode a text buffer, or `null` when it looks binary. The result names the
 * encoding it picked, because saving has to put the bytes back the same way.
 */
function decodeTextBytes(bytes, truncated = false) {
  if (startsWith(bytes, UTF32LE_BOM)) return { content: decodeUtf32(bytes.subarray(4), true), encoding: 'utf32le-bom' };
  if (startsWith(bytes, UTF32BE_BOM)) return { content: decodeUtf32(bytes.subarray(4), false), encoding: 'utf32be-bom' };
  if (startsWith(bytes, UTF8_BOM)) return { content: bytes.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  if (startsWith(bytes, UTF16LE_BOM)) return { content: decodeUtf16(bytes.subarray(2), true), encoding: 'utf16le-bom' };
  if (startsWith(bytes, UTF16BE_BOM)) return { content: decodeUtf16(bytes.subarray(2), false), encoding: 'utf16be-bom' };
  const utf16 = bomlessUtf16(bytes);
  if (utf16 !== undefined) return { content: decodeUtf16(bytes, utf16 === 'utf16le'), encoding: utf16 };
  if (bytes.includes(0)) return null;
  const utf8 = tryDecode(UTF8_DECODER, bytes);
  if (utf8 !== undefined) return { content: utf8, encoding: 'utf8' };
  if (truncated && hasIncompleteUtf8Tail(bytes)) return { content: bytes.toString('utf8'), encoding: 'utf8' };
  const gb18030 = tryDecode(GB18030_DECODER, bytes);
  if (gb18030 !== undefined && hasGb18030FourByteSequence(bytes)) return { content: gb18030, encoding: 'gb18030' };
  const gbk = tryDecode(GBK_DECODER, bytes);
  if (gbk !== undefined) return { content: gbk, encoding: 'gbk' };
  if (gb18030 !== undefined) return { content: gb18030, encoding: 'gb18030' };
  return { content: bytes.toString('utf8'), encoding: 'utf8' };
}

/**
 * Encodings we can write back byte-for-byte. Node decodes gbk / gb18030 but
 * ships no encoder for them, so a "save" there would silently rewrite the
 * whole file as UTF-8 and turn every Chinese line into a diff. Those two are
 * therefore readable but NOT editable — an honest refusal beats quiet damage.
 */
const WRITABLE_ENCODINGS = new Set([
  'utf8', 'utf8-bom',
  'utf16le', 'utf16le-bom', 'utf16be', 'utf16be-bom',
  'utf32le-bom', 'utf32be-bom'
]);

function encodeUtf32(text, littleEndian, withBom) {
  const points = [...text];
  const body = Buffer.alloc(points.length * 4);
  for (let i = 0; i < points.length; i += 1) {
    const codePoint = points[i].codePointAt(0);
    if (littleEndian) body.writeUInt32LE(codePoint, i * 4);
    else body.writeUInt32BE(codePoint, i * 4);
  }
  if (!withBom) return body;
  return Buffer.concat([littleEndian ? UTF32LE_BOM : UTF32BE_BOM, body]);
}

/** Re-encode editor text in the file's own encoding. Throws when unsupported. */
function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf8': return Buffer.from(text, 'utf8');
    case 'utf8-bom': return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.from(text, 'utf16le');
    case 'utf16le-bom': return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]);
    case 'utf16be': { const body = Buffer.from(text, 'utf16le'); body.swap16(); return body; }
    case 'utf16be-bom': { const body = Buffer.from(text, 'utf16le'); body.swap16(); return Buffer.concat([UTF16BE_BOM, body]); }
    case 'utf32le-bom': return encodeUtf32(text, true, true);
    case 'utf32be-bom': return encodeUtf32(text, false, true);
    default: throw new Error(`cannot write ${encoding} without changing its encoding`);
  }
}

/** Which line ending the file already uses, so a save keeps it. */
function detectLineEnding(text) {
  let total = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    total += 1;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
  }
  return total > 0 && crlf * 2 > total ? '\r\n' : '\n';
}

/** A textarea hands back LF only; put the file's own ending back. */
function applyLineEnding(text, eol) {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/** Directory-first, case-insensitive name ordering (mirrors the sidebar). */
function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** Read one directory level; wire shape matches the sidebar's listDirectory(). */
async function listDirectory(path) {
  const dirents = await readdir(path, { withFileTypes: true });
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
  const truncated = dirents.length > LIST_LIMIT;
  const kept = truncated ? dirents.slice(0, LIST_LIMIT) : dirents;
  const rows = new Array(kept.length);
  for (let index = 0; index < kept.length; index += 1) {
    const dirent = kept[index];
    rows[index] = {
      name: dirent.name,
      path: `${prefix}${dirent.name}`,
      isDir: dirent.isDirectory(),
      isSymlink: dirent.isSymbolicLink(),
      broken: false,
      hidden: dirent.name.startsWith('.')
    };
  }
  rows.sort(compareEntries);
  return { path, entries: rows, truncated };
}

/** The generic RPC envelope the sidebar's call() wrapper produces. */
function rpcOk(value) { return { ok: true, value }; }
/**
 * `code` carries the syscall code (ENOENT, EACCES, EISDIR…) so the client can
 * tell "this file is gone" from "this file is unreadable" and react to the
 * first by refreshing a tree that still lists the file. The message stays
 * human: a raw Node errno string in a panel banner helps nobody.
 */
function rpcError(message, code) {
  const error = { message: String(message) };
  if (code !== undefined && typeof code === 'string') error.code = code;
  return { ok: false, error };
}

/** One sentence a person can act on, for the file-vanished case. */
function missingFileMessage(path) {
  return `"${path}" is no longer on disk (deleted or renamed after the tree was read)`;
}

/** POST /fs.trees: batch of directory levels. body {paths:[abs]} → {levels:[...]}. */
async function handleFsTrees(ctx, request, response) {
  const body = await readJsonBody(request);
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((value) => typeof value === 'string' && value !== '')
    : [];
  if (paths.length === 0) { sendJson(response, 200, rpcError('paths must be a non-empty array')); return; }
  const levels = await Promise.all(paths.slice(0, MAX_TREE_PATHS).map(async (raw) => {
    try {
      return await listDirectory(resolve(raw));
    } catch (error) {
      return { path: raw, entries: [], truncated: false, error: messageOf(error) };
    }
  }));
  sendJson(response, 200, rpcOk({ levels }));
}

/** POST /fs.read: one text file. body {path:abs} → {kind, content|head, size, mtimeMs}. */
async function handleFsRead(ctx, request, response) {
  const body = await readJsonBody(request);
  const path = typeof body?.path === 'string' ? body.path : '';
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    sendJson(response, 200, rpcError(
      code === 'ENOENT' ? missingFileMessage(path) : messageOf(error),
      code
    ));
    return;
  }
  if (info.isDirectory()) {
    sendJson(response, 200, rpcError(`"${path}" is a directory`, 'EISDIR'));
    return;
  }
  const size = info.size;
  const oversized = size > MAX_EDITABLE_BYTES;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    sendJson(response, 200, rpcError(
      code === 'ENOENT' ? missingFileMessage(path) : messageOf(error),
      code
    ));
    return;
  }
  try {
    const window = oversized ? READ_HEAD_LIMIT : size;
    const buffer = Buffer.alloc(window);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    const decoded = decodeTextBytes(slice, oversized);
    if (decoded === null) {
      sendJson(response, 200, rpcOk({
        kind: 'binary', size, mtimeMs: info.mtimeMs,
        head: slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64')
      }));
      return;
    }
    if (oversized) {
      sendJson(response, 200, rpcOk({
        kind: 'too-large', size, mtimeMs: info.mtimeMs, head: slice.toString('base64')
      }));
      return;
    }
    sendJson(response, 200, rpcOk({
      kind: 'text',
      content: decoded.content,
      size,
      mtimeMs: info.mtimeMs,
      encoding: decoded.encoding,
      eol: detectLineEnding(decoded.content),
      editable: WRITABLE_ENCODINGS.has(decoded.encoding)
    }));
  } finally {
    await handle.close();
  }
}

/**
 * POST /fs.write: save text a human edited here. body {path, content, mtimeMs}.
 * Refuses when the file moved on disk (mtimeMs mismatch), when it is not text,
 * and when its encoding has no Node encoder — never rewrites a GBK file as
 * UTF-8. `expectedMtimeMs` may be omitted to accept whatever is on disk.
 */
async function handleFsWrite(ctx, request, response) {
  const body = await readJsonBody(request, MAX_WRITE_BODY);
  const path = typeof body?.path === 'string' ? body.path : '';
  const content = typeof body?.content === 'string' ? body.content : undefined;
  if (path === '') { sendJson(response, 200, rpcError('path must be a non-empty string')); return; }
  if (content === undefined) { sendJson(response, 200, rpcError('content must be a string')); return; }

  let info;
  try {
    info = await stat(path);
  } catch (error) {
    // The tree this path came from may be older than the disk: report the
    // disappearance in words (plus a code the client can branch on) rather
    // than echoing "ENOENT: no such file or directory, stat 'F:\\...'".
    const code = typeof error?.code === 'string' ? error.code : undefined;
    sendJson(response, 200, rpcError(
      code === 'ENOENT' ? missingFileMessage(path) : messageOf(error),
      code
    ));
    return;
  }
  if (info.isDirectory()) { sendJson(response, 200, rpcError(`"${path}" is a directory`, 'EISDIR')); return; }
  if (info.size > MAX_EDITABLE_BYTES) {
    sendJson(response, 200, rpcError('file is too large to edit here'));
    return;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_BYTES * 4) {
    sendJson(response, 200, rpcError('text is too large to save here'));
    return;
  }
  // Another tool (or the agent) rewrote the file while the editor was open.
  // Saving then would silently discard their work, so refuse and say so.
  const expected = typeof body?.mtimeMs === 'number' ? body.mtimeMs : undefined;
  if (expected !== undefined && Math.abs(info.mtimeMs - expected) > 0.5) {
    sendJson(response, 200, rpcError('the file changed on disk since you opened it'));
    return;
  }

  let bytes;
  try {
    const raw = await readFile(path);
    const decoded = decodeTextBytes(raw);
    if (decoded === null) { sendJson(response, 200, rpcError('this file is not text')); return; }
    if (!WRITABLE_ENCODINGS.has(decoded.encoding)) {
      sendJson(response, 200, rpcError(`this file is ${decoded.encoding}; saving it here would change its encoding`));
      return;
    }
    bytes = encodeText(applyLineEnding(content, detectLineEnding(decoded.content)), decoded.encoding);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    sendJson(response, 200, rpcError(
      code === 'ENOENT' ? missingFileMessage(path) : messageOf(error),
      code
    ));
    return;
  }

  try {
    await writeFile(path, bytes);
    const after = await stat(path);
    sendJson(response, 200, rpcOk({ size: after.size, mtimeMs: after.mtimeMs }));
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    sendJson(response, 200, rpcError(
      code === 'ENOENT' ? missingFileMessage(path) : messageOf(error),
      code
    ));
  }
}

/* ------------------------------------------------------------ git status */

/**
 * Run one git command and resolve its stdout as a Buffer. `-z` output carries
 * NUL separators and paths are NOT quoted, so keeping bytes (never a JS string
 * round-trip through the console) is what preserves CJK and spaces.
 */
function runGit(cwd, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '--no-pager', ...args],
      {
        cwd,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_STATUS_BYTES,
        encoding: 'buffer'
      },
      (error, stdout) => {
        if (error) {
          // `check-ignore` exits 1 when NOTHING is ignored; that is an ordinary
          // answer, not a failure. Anything else is a real problem.
          if (args[0] === 'check-ignore' && error.code === 1) { resolveRun(stdout); return; }
          const wrapped = new Error((error.message || 'git failed').trim());
          wrapped.gitArgs = args;
          rejectRun(wrapped);
          return;
        }
        resolveRun(stdout);
      }
    );
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* a closed stdin is handled by the exit code */ });
      child.stdin.end(input);
    }
    child.on('error', rejectRun);
  });
}

/** Absolute paths (Windows or POSIX) become one normalized lookup key. */
function pathKey(path) {
  return resolve(path).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** Split a NUL-terminated buffer into non-empty UTF-8 strings. */
function splitNul(buffer) {
  const out = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) out.push(buffer.toString('utf8', start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) out.push(buffer.toString('utf8', start));
  return out;
}

/**
 * The two-letter porcelain code → `{ letter, tone }`, matching VS Code's ink
 * (and dsh-better-sidebar's own FileTree):
 *   M/T modified (warn), A added & ? untracked (success), D deleted (error),
 *   R/C renamed/copied (business), U conflict (error).
 * `!!` (ignored) and a clean `'  '` carry no badge. The index side wins.
 */
function statusOfXY(xy) {
  if (xy === '??') return { letter: 'U', tone: 'untracked' };
  if (xy.length < 2 || xy === '!!' || xy === '  ') return undefined;
  const x = xy[0];
  const y = xy[1];
  const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
  const lead = x !== ' ' && x !== '?' ? x : y;
  let tone;
  if (conflict) tone = 'conflict';
  else if (lead === 'M' || lead === 'T') tone = 'modified';
  else if (lead === 'A') tone = 'added';
  else if (lead === 'D') tone = 'deleted';
  else if (lead === 'R') tone = 'renamed';
  else if (lead === 'C') tone = 'copied';
  else tone = 'modified';
  // `U` is already the untracked letter, so a conflict uses `X` to keep the
  // two inks apart (the client's STATUS_INK maps X → conflict).
  return { letter: conflict ? 'X' : lead, tone };
}

/**
 * Whether one directory is a git work tree at its own top level. A root nested
 * inside someone else's repository must NOT borrow the parent's status (that
 * would attribute another checkout's changes to this root).
 */
async function inspectRepo(root) {
  let top;
  try {
    top = (await runGit(root, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  } catch (error) {
    if (/not a git repository|not a git work tree/i.test(error.message || '')) return false;
    return false;
  }
  return top !== '' && pathKey(top) === pathKey(root);
}

/**
 * One root's changed paths. porcelain v1 `-z` records are `XY <path>\0`; a
 * rename/copy (`R`/`C`) carries the ORIGINAL path as a second NUL field, which
 * must be consumed so it is never mistaken for a file of its own.
 */
async function readChanged(root) {
  if (!(await inspectRepo(root))) return { isRepo: false, statuses: {}, dirs: [] };
  let raw;
  try {
    raw = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return { isRepo: true, statuses: {}, dirs: [] };
  }
  const chunks = splitNul(raw);
  const statuses = {};
  const dirs = new Set();
  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index];
    if (record.length < 3) continue;
    const xy = record.slice(0, 2);
    const info = statusOfXY(xy);
    // A rename/copy record is `R  new\0old\0`: the ORIGINAL path is a separate
    // NUL field right after it. Consume that field so it is never mistaken for
    // a changed file of its own. porcelain v1 only puts R/C in the X slot.
    if (xy[0] === 'R' || xy[0] === 'C') index += 1;
    if (info === undefined) continue;
    const rel = record.slice(3);
    if (rel === '') continue;
    statuses[pathKey(join(root, rel))] = info;
    // Every ancestor directory of a changed file gets a "has changes" hint.
    let parent = rel.replace(/[\\/]+$/, '');
    let at = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'));
    while (at > 0) {
      dirs.add(pathKey(join(root, parent.slice(0, at))));
      parent = parent.slice(0, at);
      at = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'));
    }
  }
  return { isRepo: true, statuses, dirs: [...dirs] };
}

/**
 * Which of `paths` git ignores. `check-ignore --stdin -z` answers with only
 * the HITS, so no 2.5 MB `--ignored` listing is ever built; a root that is not
 * a repository simply has no ignored set.
 */
async function readIgnored(root, paths) {
  const clean = paths
    .filter((value) => typeof value === 'string' && value !== '')
    .slice(0, MAX_IGNORE_PATHS);
  if (clean.length === 0) return [];
  // Feed repo-relative POSIX paths: git's own ignore matcher expects that
  // form. A path OUTSIDE the repository makes `check-ignore` fail as a
  // whole, which would silently drop every ignore verdict — so such paths
  // are dropped here instead.
  const inside = [];
  for (const value of clean) {
    const rel = relative(root, value).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('../') || rel === '..') continue;
    inside.push({ value, rel });
  }
  if (inside.length === 0) return [];
  const input = Buffer.from(`${inside.map((row) => row.rel).join('\0')}\0`, 'utf8');
  let raw;
  try {
    raw = await runGit(root, ['check-ignore', '-z', '--stdin'], input);
  } catch {
    // One unusable path makes `check-ignore` fail as a whole, which would
    // silently drop every ignore verdict. The batch is halved instead of
    // retried path by path: one bad path then costs O(log n) git calls, not
    // one call per path.
    const hits = new Set();
    const probe = async (rows) => {
      try {
        const one = await runGit(root, ['check-ignore', '-z', '--stdin'], Buffer.from(`${rows.map((row) => row.rel).join('\0')}\0`, 'utf8'));
        for (const value of splitNul(one)) hits.add(pathKey(join(root, value)));
        return true;
      } catch {
        if (rows.length === 1) return false;
        const middle = Math.floor(rows.length / 2);
        await probe(rows.slice(0, middle));
        await probe(rows.slice(middle));
        return true;
      }
    };
    await probe(inside);
    return inside.filter((row) => hits.has(pathKey(row.value))).map((row) => row.value);
  }
  const hits = new Set(splitNul(raw).map((value) => pathKey(join(root, value))));
  return inside.filter((row) => hits.has(pathKey(row.value))).map((row) => row.value);
}

/**
 * POST /image: one image's bytes for the in-tab preview.
 *   body: { path: abs }
 *   reply: { mime, base64, width?: number, height?: number }
 *
 * The preview draws the image itself, so the bytes travel base64-encoded in
 * JSON: the panel is a page inside the GUI, and a data URL needs no second
 * request and no session admission to be drawn.
 */
async function handleImage(ctx, request, response) {
  try {
    const body = await readJsonBody(request);
    const path = typeof body?.path === 'string' ? body.path : '';
    const mime = imageTypeFor(path);
    if (mime === undefined) {
      sendJson(response, 200, { error: 'not an image' });
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) {
      sendJson(response, 200, { error: 'not a file' });
      return;
    }
    if (info.size > MAX_IMAGE_BYTES) {
      sendJson(response, 200, { error: 'image too large', size: info.size });
      return;
    }
    const bytes = await readFile(path);
    sendJson(response, 200, { mime, base64: bytes.toString('base64'), size: info.size });
  } catch (error) {
    sendJson(response, 200, { error: String(error?.message ?? error) });
  }
}

/**
 * POST /open: reveal one path in the OS file manager.
 *   body: { path: abs }
 *   reply: { ok: true } — or { ok: false, error }
 *
 * A file is SELECTED in its folder (Windows `explorer /select,`, macOS
 * `open -R`); a folder is opened itself (Windows plain `explorer`, Linux
 * `xdg-open`). The process runs DETACHED with stdio ignored, so the spawned
 * window outlives this request and the call answers without waiting for the
 * GUI to come up. The extension check keeps Windows from treating an
 * argument-like path as anything but a plain file/folder to reveal.
 */
async function handleOpen(ctx, request, response) {
  const body = await readJsonBody(request);
  const target = typeof body?.path === 'string' ? body.path : '';
  if (extname(target) === '.exe' || extname(target) === '.bat' || extname(target) === '.cmd') {
    sendJson(response, 200, { ok: false, error: 'refusing to open an executable path' });
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    // The path is gone (deleted, moved, a stale entry): say THAT, not a
    // launcher problem — the caller sees a real diagnosis in the toast.
    sendJson(response, 200, { ok: false, error: 'no such file or folder' });
    return;
  }
  if (!info.isFile() && !info.isDirectory()) {
    sendJson(response, 200, { ok: false, error: 'not a file or folder' });
    return;
  }
  const absolute = resolve(target);
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = info.isDirectory() ? [absolute] : [`/select,${absolute}`];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = info.isDirectory() ? [absolute] : ['-R', absolute];
  } else {
    command = 'xdg-open';
    args = [absolute];
  }
  const child = execFile(command, args, {
    // NO windowsHide here: it sends SW_HIDE through STARTUPINFO and the file
    // manager's first window comes up INVISIBLE (a console-app option that
    // backfires on GUI programs). NO verbatim arguments either: Node's own
    // quoting keeps `/select,<path with spaces>` one argument.
    timeout: OPEN_TIMEOUT_MS
  });
  child.stdout?.on('data', () => { /* explorer answers nothing useful */ });
  child.stderr?.on('data', () => { /* ditto; the exit code decides */ });
  // Detach: the file manager window must not be tied to this request's
  // lifetime, and "the process spawned" is already success — Explorer in
  // particular keeps unrelated explorer.exe processes alive forever.
  child.unref();
  child.on('error', (error) => {
    // The response is usually already gone by now; this only keeps a missing
    // launcher visible in the host log instead of vanishing silently.
    console.warn('[dsh-multi-root-files] open:', error?.message ?? error);
  });
  sendJson(response, 200, { ok: true });
}

/**
 * POST /diff: the changed LINE NUMBERS of one file.
 *   body: { path: abs }
 *   reply: { added: [n], removed: [n], hunks: [{ from, to, lines }] }
 *
 * `git diff --unified=0` names every changed line exactly; the client paints
 * those rows in the preview, which is the same ink the multi-root-changes
 * panel uses for its diff.
 */
async function handleDiff(ctx, request, response) {
  try {
    const body = await readJsonBody(request);
    const path = typeof body?.path === 'string' ? body.path : '';
    const root = await repoRootOf(path);
    if (root === undefined) {
      sendJson(response, 200, { added: [], removed: [], hunks: [] });
      return;
    }
    const rel = relative(root, path).replace(/\\/g, '/');
    let raw = '';
    try {
      raw = await runGit(root, ['diff', '--unified=0', '--no-color', '--', rel]);
    } catch {
      sendJson(response, 200, { added: [], removed: [], hunks: [] });
      return;
    }
    const parsed = parseUnifiedHunks(raw);
    sendJson(response, 200, parsed);
  } catch (error) {
    sendJson(response, 200, { error: String(error?.message ?? error), added: [], removed: [], hunks: [] });
  }
}

/**
 * The repository a path belongs to: the path itself when it is a work tree
 * root, else its nearest ancestor that is one.
 */
async function repoRootOf(path) {
  let current = resolve(path);
  for (let depth = 0; depth < 24; depth += 1) {
    try {
      const top = (await runGit(current, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
      if (top !== '') return top;
      return undefined;
    } catch {
      const parent = join(current, '..');
      if (parent === current) return undefined;
      current = resolve(parent);
    }
  }
  return undefined;
}

/**
 * Parse a `--unified=0` diff into the changed line numbers.
 *
 * The hunk header is `@@ -oldStart,oldCount +newStart,newCount @@`: the NEW
 * side's start plus its added count give the added rows, and the old side's
 * start plus its removed count give the removed rows (which have no place in
 * the new file, so the client only marks them in the gutter).
 */
function parseUnifiedHunks(raw) {
  const added = new Set();
  const removed = new Set();
  const hunks = [];
  const lines = String(raw).split('\n');
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    for (let index = 0; index < oldCount; index += 1) removed.add(oldStart + index);
    for (let index = 0; index < newCount; index += 1) added.add(newStart + index);
    hunks.push({ from: newStart, to: newStart + Math.max(newCount, 1) - 1, added: newCount, removed: oldCount });
  }
  return {
    added: [...added].sort((a, b) => a - b),
    removed: [...removed].sort((a, b) => a - b),
    hunks
  };
}

/**
 * POST /status: one merged answer for all visible roots.
 *   body: { sessionId?, cwd?, roots: [abs], paths: [abs] }
 *   reply: { statuses: { absKey: {letter, tone} }, ignored: [absKey],
 *            changedDirs: [absKey], repos: { absKey: boolean } }
 * A failure on one root costs only that root's data, never the whole answer.
 */
async function handleStatus(ctx, request, response) {
  try {
    const body = await readJsonBody(request);
    const resolvedCwd = resolveSessionCwd(ctx, body.sessionId, body.cwd);
    const roots = Array.isArray(body?.roots) ? body.roots.filter((value) => typeof value === 'string' && value !== '') : [];
    const paths = Array.isArray(body?.paths) ? body.paths.filter((value) => typeof value === 'string' && value !== '') : [];
    if (roots.length === 0) {
      const fallback = resolvedCwd !== '' ? [resolve(resolvedCwd)] : [];
      roots.push(...fallback);
    }

    const answers = await Promise.all(roots.map(async (root) => {
      try {
        const [changed, ignored] = await Promise.all([
          readChanged(root),
          readIgnored(root, paths.filter((value) => {
            const key = pathKey(value);
            const base = pathKey(root);
            return key === base || key.startsWith(`${base}/`);
          }))
        ]);
        return { root, changed, ignored };
      } catch {
        return { root, changed: { isRepo: false, statuses: {}, dirs: [] }, ignored: [] };
      }
    }));

    const statuses = {};
    const changedDirs = [];
    const ignored = [];
    const repos = {};
    for (const answer of answers) {
      repos[pathKey(answer.root)] = answer.changed.isRepo;
      Object.assign(statuses, answer.changed.statuses);
      changedDirs.push(...answer.changed.dirs);
      ignored.push(...answer.ignored.map((value) => pathKey(value)));
    }
    sendJson(response, 200, { statuses, ignored, changedDirs, repos });
  } catch (error) {
    // Never let a decorations failure become an opaque 500: the client degrades
    // to an undecorated tree, and the reason is available for diagnosis.
    sendJson(response, 200, {
      statuses: {}, ignored: [], changedDirs: [], repos: {},
      error: String(error?.stack ?? error?.message ?? error)
    });
  }
}

/**
 * GET-equivalent POST /roots: the primary root plus every registered
 * additional root. A root that vanished is still reported with `exists:false`
 * so the panel can say "this folder is gone" instead of showing an empty list.
 */
async function handleRoots(ctx, request, response) {
  try {
  const body = await readJsonBody(request);
  const resolvedCwd = resolveSessionCwd(ctx, body.sessionId, body.cwd);
  if (resolvedCwd === '') {
    sendJson(response, 400, { error: 'cwd or sessionId is required' });
    return;
  }
  const primaryRoot = resolve(resolvedCwd);
  const registry = await readAdditionalRoots(primaryRoot);

  const rows = [
    { path: primaryRoot, kind: 'primary', label: baseName(primaryRoot) },
    ...registry.roots
      .filter((row) => pathIdentity(row.path) !== pathIdentity(primaryRoot))
      .map((row) => ({
        path: row.path,
        kind: 'additional',
        label: baseName(row.path),
        aliasId: row.aliasId,
        access: row.access
      }))
  ];

  const roots = await Promise.all(rows.map(async (row) => ({
    ...row,
    exists: await rootExists(row.path)
  })));

  sendJson(response, 200, {
    primaryRoot,
    registryFound: registry.registryFound,
    roots
  });
  } catch (error) {
    // A failure here costs the decorations, never the tree: the client
    // renders an undecorated tree and the reason travels with the answer.
    sendJson(response, 200, {
      primaryRoot: '', registryFound: false, roots: [],
      error: String(error?.stack ?? error?.message ?? error)
    });
  }
}

/**
 * Read (GET) or write (POST) this panel's durable UI settings.
 *
 * Only `fontScale` and `treeRatio` are accepted (whitelist in
 * sanitizeSettings). The desktop web port changes on every launch, so browser
 * localStorage is not durable; the values live in the plugin's own file under
 * $DSH_HOME/storages and are deliberately SEPARATE from
 * dsh-multi-root-changes' settings.
 */
async function handleSettings(host, request, response) {
  if (request.method === 'GET') {
    sendJson(response, 200, await loadSettings());
    return;
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    try {
      // PATCH semantics: a request may carry one setting and must not reset
      // the others, so the body is merged OVER what is already on disk. The
      // font control sends only `fontScale`; the splitter sends only
      // `treeRatio`.
      const current = await loadSettings();
      const patch = body !== null && typeof body === 'object' ? body : {};
      sendJson(response, 200, await saveSettings({ ...current, ...patch }));
    } catch (error) {
      sendText(response, 500, error.message || 'settings write failed');
    }
    return;
  }
  sendText(response, 405, 'method not allowed');
}

/** GET/POST route with the same error policy as registerPost. */
function registerSettings(host) {
  return host.webServer.register({
    kind: 'exact',
    path: `${API}/settings`,
    handler: (request, response) => {
      Promise.resolve()
        .then(() => handleSettings(host, request, response))
        .catch((error) => {
          const status = Number.isInteger(error?.status) ? error.status : 500;
          if (!response.headersSent) sendText(response, status, 'internal error');
          else response.end();
        });
    }
  });
}

/** One POST route with the same error policy for every handler. */
function registerPost(host, path, handle) {
  return host.webServer.register({
    kind: 'exact',
    path: `${API}/${path}`,
    handler: (request, response) => {
      if (request.method !== 'POST') { sendText(response, 405, 'method not allowed'); return; }
      Promise.resolve()
        .then(() => handle(host, request, response))
        .catch((error) => {
          const status = Number.isInteger(error?.status) ? error.status : 500;
          if (!response.headersSent) sendText(response, status, status === 413 ? 'body too large' : 'internal error');
          else response.end();
        });
    }
  });
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        registerPost(host, 'roots', handleRoots),
        registerPost(host, 'fs.trees', handleFsTrees),
        registerPost(host, 'fs.read', handleFsRead),
        registerPost(host, 'fs.write', handleFsWrite),
        registerPost(host, 'status', handleStatus),
        registerPost(host, 'image', handleImage),
        registerPost(host, 'diff', handleDiff),
        registerPost(host, 'open', handleOpen),
        registerSettings(host)
      ];
      return () => {
        for (const dispose of disposers) {
          try { dispose?.(); } catch { /* already gone */ }
        }
      };
    }, 'multi-root-files: routes');
  });
}

export const __test = {
  pathIdentity, baseName, readAdditionalRoots, statusOfXY, splitNul, parseUnifiedHunks, imageTypeFor,
  decodeTextBytes, encodeText, detectLineEnding, applyLineEnding, WRITABLE_ENCODINGS,
  compareEntries, listDirectory, handleFsWrite, handleFsRead, MAX_WRITE_BODY, MAX_EDITABLE_BYTES,
  sanitizeSettings, handleSettings, settingsPath, FONT_SCALE_MIN, FONT_SCALE_MAX, DEFAULT_SETTINGS,
  TREE_RATIO_MIN, TREE_RATIO_MAX
};
