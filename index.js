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
 * those roots through dsh-better-sidebar's existing /sidebar fs routes, whose
 * containment fence is gone, so an absolute path outside cwd resolves fine.
 *
 * Read-only: this plugin never writes, renames or deletes anything. Opening a
 * file is the sidebar editor's job (still inside the right sidebar).
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, relative } from 'node:path';

const API = '/dsh-multi-root-files/api';

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
        registerPost(host, 'status', handleStatus),
        registerPost(host, 'image', handleImage),
        registerPost(host, 'diff', handleDiff)
      ];
      return () => {
        for (const dispose of disposers) {
          try { dispose?.(); } catch { /* already gone */ }
        }
      };
    }, 'multi-root-files: routes');
  });
}

export const __test = { pathIdentity, baseName, readAdditionalRoots, statusOfXY, splitNul, parseUnifiedHunks, imageTypeFor };
