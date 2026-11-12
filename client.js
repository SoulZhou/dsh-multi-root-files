/**
 * Browser half of dsh-multi-root-files.
 *
 * Registers one sidebar tab ("多根文件") through dsh-better-sidebar's
 * `ctx.betterSidebar.registerTab`, so the page lands in DSH's own right column
 * next to Files / Git / Tasks instead of becoming a parallel surface.
 *
 * The page shows ONE root at a time: the session's primary root by default, any
 * root registered through multi-root-workspace picked from the toolbar's
 * dropdown. Levels load lazily through the sidebar's own `fs.trees` route (the
 * workspace fence is gone, so an absolute path outside the session cwd lists
 * fine). Clicking a file reads it through `fs.read` and renders it in a preview
 * pane BESIDE the tree, inside this tab — the same in-tab split the
 * multi-root-changes tab uses, so no new window, no extra sidebar tab, and no
 * external app is involved. Right-clicking a row (or the preview title) offers
 * "copy path" and "open in the OS file manager" (the host's /open route).
 *
 * Dependency-free by design: React comes from the shell, no bundler, no imports.
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-root-files',
  factory(require) {
    'use strict';

    const React = require('react');
    const {
      createElement: h,
      Fragment,
      useCallback,
      useEffect,
      useLayoutEffect,
      useRef,
      useState
    } = React;

    /** This plugin's own host route (roots registry). */
    const API_BASE = 'dsh-multi-root-files/api';
    const TAB_ID = 'multi-root-files';
    const STYLE_ID = 'dsh-multi-root-files-style';
    /** Same cap the host enforces on one `fs.trees` batch. */
    const MAX_BATCH = 64;
    /** Row indent per tree level. */
    const INDENT = 22;
    /**
     * Ceiling on the paths one decoration request may carry. The dsh-app://
     * protocol caps a request body (about 64 KiB); a deep tree would blow
     * past it and the whole request would fail, taking every colour with it.
     * Two hundred paths of the longest real names stay well inside the cap.
     */
    const MAX_DECORATION_PATHS = 200;
    /** Font-size setting: must match the host's FONT_SCALE_* constants. */
    const FONT_MIN = 0.8;
    const FONT_MAX = 1.6;
    const FONT_STEP = 0.1;
    const FONT_DEFAULT = 1;

    const COPY = {
      zh: {
        tab: '多根文件',
        tabDesc: '同时浏览会话主目录与所有附加工作目录，点击文件直接在右侧打开',
        refresh: '刷新',
        refreshTitle: '重新读取目录列表',
        loading: '正在读取…',
        empty: '这个目录是空的',
        loadFailed: '这个目录读取失败',
        truncated: '内容过多，只显示了一部分',
        rootsFailed: '无法读取工作目录列表',
        registryMissing: '未检测到附加工作目录登记（multi-root-workspace 未登记或未安装）',
        primary: '主目录',
        additional: '附加',
        missingRoot: '目录不存在或不可访问',
        rootPicker: '切换根目录',
        previewLoading: '正在读取文件…',
        previewFailed: '无法读取这个文件',
        previewBinary: '二进制文件，无法按文本预览',
        previewTooLarge: '文件过大，无法预览',
        previewTruncated: '只显示前 {count} 行',
        ignored: '已忽略',
        close: '关闭',
        copyPath: '复制路径',
        openInFiles: '在文件管理器打开',
        copiedPath: '已复制路径',
        copyFailed: '复制失败',
        openFailed: '无法在文件管理器打开',
        openedInFiles: '已在文件管理器打开',
        rootCount: '{count} 个目录',
        fontSize: '字体大小',
        fontSmaller: '缩小字体',
        fontLarger: '放大字体',
        fontReset: '恢复默认字体大小',
        fontScaleTitle: '当前 {percent}% · A− 缩小 / A+ 放大 / 双击数值恢复默认',
        markdownPreview: '预览',
        markdownSource: '源码',
        markdownPreviewTitle: '按 Markdown 排版渲染全文',
        markdownSourceTitle: '查看逐行源码'
      },
      en: {
        tab: 'Multi-root files',
        tabDesc: 'Browse the session root and every additional workspace root; files open inline here',
        refresh: 'Refresh',
        refreshTitle: 'Reload the directory listings',
        loading: 'Reading…',
        empty: 'This folder is empty',
        loadFailed: 'Could not read this folder',
        truncated: 'Too many entries — only part of this folder is shown',
        rootsFailed: 'Could not read the workspace roots',
        registryMissing: 'No additional workspace roots registered (multi-root-workspace is absent or has no entry)',
        primary: 'primary',
        additional: 'extra',
        missingRoot: 'Folder is missing or unreadable',
        rootPicker: 'Switch root',
        previewLoading: 'Reading the file…',
        previewFailed: 'Could not read this file',
        previewBinary: 'Binary file — no text preview',
        previewTooLarge: 'File is too large to preview',
        previewTruncated: 'Showing the first {count} lines',
        ignored: 'Ignored',
        close: 'Close',
        copyPath: 'Copy path',
        openInFiles: 'Open in File Manager',
        copiedPath: 'Path copied',
        copyFailed: 'Could not copy the path',
        openFailed: 'Could not open in the file manager',
        openedInFiles: 'Opened in the file manager',
        rootCount: '{count} folders',
        fontSize: 'Font size',
        fontSmaller: 'Smaller font',
        fontLarger: 'Larger font',
        fontReset: 'Reset font size',
        fontScaleTitle: 'Now {percent}% · A− to shrink / A+ to grow / double-click the number to reset',
        markdownPreview: 'Preview',
        markdownSource: 'Source',
        markdownPreviewTitle: 'Render the whole file as formatted Markdown',
        markdownSourceTitle: 'Show the line-by-line source'
      }
    };

    function isZh() {
      const language = (navigator.language || '').toLowerCase();
      return language.startsWith('zh');
    }

    function useCopy() {
      const [zh, setZh] = useState(isZh);
      useEffect(() => {
        const read = () => setZh(isZh());
        const observer = new MutationObserver(read);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        window.addEventListener('focus', read);
        return () => { observer.disconnect(); window.removeEventListener('focus', read); };
      }, []);
      return useCallback((key, vars) => {
        const table = zh ? COPY.zh : COPY.en;
        let text = table[key] ?? COPY.en[key] ?? key;
        if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
        return text;
      }, [zh]);
    }

    /**
     * Resolve a host route through the sidebar service (prefix-safe, and the
     * page's own base in the desktop shell). Falling back to the bare relative
     * path keeps the same guarantees: no leading slash may ever pin the request
     * to the origin root, which would leave a reverse-proxy prefix behind.
     */
    function routeUrl(ctx, path) {
      const clean = String(path).replace(/^\/+/, '');
      try {
        const service = ctx?.get?.('betterSidebar');
        if (service && typeof service.hostRouteUrl === 'function') return service.hostRouteUrl(clean);
      } catch { /* fall back to the relative route */ }
      return clean;
    }

    /** Fetch one of this plugin's own routes: GET when body is omitted. */
    async function fetchJson(ctx, path, body) {
      const isGet = body === undefined;
      let response;
      try {
        response = await fetch(routeUrl(ctx, path), {
          method: isGet ? 'GET' : 'POST',
          headers: isGet ? undefined : { 'content-type': 'application/json' },
          body: isGet ? undefined : JSON.stringify(body)
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      if (!response.ok) {
        let detail = `${response.status}`;
        try { detail = (await response.text()) || detail; } catch { /* keep the status */ }
        throw new Error(detail);
      }
      return response.json();
    }

    /** POST one JSON body and return the parsed plain-JSON answer. */
    function postPlain(ctx, path, body) {
      return fetchJson(ctx, path, body ?? {});
    }

    /** The primary root plus every additional root registered for the session. */
    function fetchRoots(ctx, scope) {
      return postPlain(ctx, `${API_BASE}/roots`, {
        sessionId: scope?.sessionId,
        cwd: scope?.cwd
      });
    }

    /** One batch of directory levels through the sidebar's own fs route. */
    async function fetchLevels(ctx, scope, paths) {
      const payload = { paths };
      if (scope?.sessionId) payload.sessionId = scope.sessionId;
      if (scope?.cwd) payload.cwd = scope.cwd;
      let response;
      try {
        response = await fetch(routeUrl(ctx, 'sidebar/api/fs.trees'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      let parsed = null;
      try { parsed = await response.json(); } catch { /* keep the status below */ }
      if (!response.ok || parsed?.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
      }
      return Array.isArray(parsed?.value?.levels) ? parsed.value.levels : [];
    }

    /**
     * One file's bytes for the in-tab preview, through the sidebar's own read
     * route: `{ kind: 'text', content }`, or the `binary` / `too-large`
     * verdicts the editor host also answers with.
     */
    /**
     * Git decorations for the visible rows. The host runs `git status` per root
     * (dsh-better-sidebar's own `git.status` is pinned to the session cwd and
     * cannot see an additional root), then `git check-ignore --stdin -z` on the
     * paths we actually list, so ignored build folders are marked without ever
     * pulling a multi-megabyte `--ignored` listing.
     */
    const EMPTY_DECORATION = { statuses: {}, ignored: new Set(), changedDirs: new Set() };

    /**
     * One decoration reading.
     *
     * `null` means the REQUEST failed (the network, the protocol's body cap,
     * a busy host): the caller keeps the colours it already has and tries
     * again later. An empty reading means the host answered and there is
     * nothing to mark — that one replaces what was on screen.
     */
    async function fetchStatus(ctx, scope, roots, paths) {
      let response;
      try {
        response = await fetch(routeUrl(ctx, `${API_BASE}/status`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: scope?.sessionId,
            cwd: scope?.cwd,
            roots: roots ?? [],
            paths
          })
        });
      } catch (error) {
        console.warn('[dsh-multi-root-files] status request failed:', error instanceof Error ? error.message : error);
        return null;
      }
      if (!response.ok) {
        console.warn('[dsh-multi-root-files] status request failed: HTTP', response.status);
        return null;
      }
      let parsed = null;
      try { parsed = await response.json(); } catch { return null; }
      if (typeof parsed?.error === 'string' && parsed.error !== '') {
        // The host reports decoration failures in-band (never a 500), so the
        // tree still renders without colors and the reason is visible here.
        console.warn('[dsh-multi-root-files] status:', parsed.error);
        return null;
      }
      return {
        statuses: parsed?.statuses && typeof parsed.statuses === 'object' ? parsed.statuses : {},
        ignored: new Set(Array.isArray(parsed?.ignored) ? parsed.ignored : []),
        changedDirs: new Set(Array.isArray(parsed?.changedDirs) ? parsed.changedDirs : [])
      };
    }

    /** Must match `pathKey()` in the host half exactly. */
    function pathKey(path) {
      return String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    /**
     * letter → ink, mirroring VS Code and dsh-better-sidebar's own FileTree.
     * The host already folds the two-letter porcelain code into one letter.
     */
    const STATUS_INK = {
      M: { cls: 'modified', word: 'Modified', zh: '已修改' },
      T: { cls: 'modified', word: 'Modified', zh: '已修改' },
      A: { cls: 'added', word: 'Added', zh: '新增' },
      D: { cls: 'deleted', word: 'Deleted', zh: '已删除' },
      U: { cls: 'untracked', word: 'Untracked', zh: '未跟踪' },
      R: { cls: 'renamed', word: 'Renamed', zh: '已重命名' },
      C: { cls: 'copied', word: 'Copied', zh: '已复制' },
      X: { cls: 'conflict', word: 'Conflicted', zh: '有冲突' }
    };

    async function fetchFile(ctx, scope, path) {
      const payload = { path };
      if (scope?.sessionId) payload.sessionId = scope.sessionId;
      if (scope?.cwd) payload.cwd = scope.cwd;
      let response;
      try {
        response = await fetch(routeUrl(ctx, 'sidebar/api/fs.read'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      let parsed = null;
      try { parsed = await response.json(); } catch { /* keep the status below */ }
      if (!response.ok || parsed?.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
      }
      return parsed?.value ?? null;
    }

    /**
     * One image's bytes for the preview, through this plugin's own route (the
     * sidebar's media route needs a session admission this panel does not
     * carry for the additional roots).
     */
    async function fetchImage(ctx, path) {
      let response;
      try {
        response = await fetch(routeUrl(ctx, `${API_BASE}/image`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path })
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let parsed = null;
      try { parsed = await response.json(); } catch { return null; }
      if (!parsed || typeof parsed.base64 !== 'string' || parsed.mime === undefined) return null;
      return { mime: parsed.mime, src: `data:${parsed.mime};base64,${parsed.base64}`, size: parsed.size };
    }

    /**
     * The changed line numbers of one file, through this plugin's own route.
     * The preview paints them; a file with no change simply has none.
     */
    async function fetchDiff(ctx, path) {
      let response;
      try {
        response = await fetch(routeUrl(ctx, `${API_BASE}/diff`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path })
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let parsed = null;
      try { parsed = await response.json(); } catch { return null; }
      if (!parsed || !Array.isArray(parsed.added)) return null;
      return {
        added: new Set(parsed.added),
        removed: new Set(Array.isArray(parsed.removed) ? parsed.removed : [])
      };
    }

    function formatSize(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** One level, normalized so rendering never has to re-check the wire shape. */
    function normalizeLevel(level) {
      return {
        entries: Array.isArray(level?.entries) ? level.entries : [],
        error: typeof level?.error === 'string' && level.error !== '' ? level.error : undefined,
        truncated: level?.truncated === true
      };
    }

    function normalizePath(path) {
      return String(path).replace(/\//g, '\\').replace(/\\+$/, '');
    }

    /** Whether `path` is a strict descendant of (or equal to) `root`. */
    function isUnder(path, root) {
      const target = normalizePath(path);
      const base = normalizePath(root);
      if (target === base) return true;
      const foldedTarget = target.toLowerCase();
      const foldedBase = base.toLowerCase();
      return foldedTarget.startsWith(`${foldedBase}\\`) || foldedTarget.startsWith(`${foldedBase}/`);
    }

    function baseName(path) {
      const trimmed = String(path).replace(/[\\/]+$/, '');
      const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return at === -1 ? trimmed : trimmed.slice(at + 1);
    }

    /** Windows-style backslash spelling for the clipboard. */
    function displayPath(path) {
      return String(path).replace(/\//g, '\\');
    }

    /* ---------------------------------------------------------------- icons */

    function FolderGlyph(props) {
      const size = props?.size ?? 14;
      return h('svg', {
        className: 'mrf-glyph mrf-folderGlyph', width: size, height: size, viewBox: '0 0 28 28',
        fill: 'none', 'aria-hidden': 'true'
      }, h('path', {
        fill: 'currentColor',
        d: 'M2.80078 10.2112C2.80078 9.52802 2.80078 9.18642 2.85314 8.866C2.98648 8.05 3.36942 7.29538 3.94925 6.70595C4.17694 6.4745 4.45264 6.2728 5.00404 5.86939C5.29197 5.65874 5.43594 5.55342 5.58711 5.46632C5.97089 5.24521 6.39638 5.10618 6.83667 5.05803C7.01011 5.03906 7.18849 5.03906 7.54524 5.03906H11.6543C12.4669 5.03906 12.8732 5.03906 13.2599 5.13697C13.3882 5.16945 13.5143 5.20986 13.6375 5.25795C14.0091 5.40294 14.3398 5.63902 15.0012 6.1112L16.2632 7.01224C16.5526 7.21881 16.6972 7.3221 16.8598 7.38553C16.9137 7.40657 16.9689 7.42425 17.025 7.43846C17.1942 7.4813 17.372 7.4813 17.7275 7.4813H19.8008C22.0506 7.4813 23.1755 7.4813 23.9641 8.05425C24.2188 8.23928 24.4428 8.46326 24.6278 8.71794C25.2008 9.50654 25.2008 10.6315 25.2008 12.8813V18.7283C25.2008 20.9781 25.2008 22.1031 24.6278 22.8917C24.4428 23.1463 24.2188 23.3703 23.9641 23.5554C23.1755 24.1283 22.0506 24.1283 19.8008 24.1283H8.20077C5.95094 24.1283 4.82602 24.1283 4.03743 23.5554C3.78274 23.3703 3.55877 23.1463 3.37373 22.8917C2.80078 22.1031 2.80078 20.9781 2.80078 18.7283V10.2112Z'
      }));
    }

    function FileGlyph(props) {
      const size = props?.size ?? 14;
      return h('svg', {
        className: 'mrf-glyph mrf-fileGlyph', width: size, height: size, viewBox: '0 0 28 28',
        fill: 'none', 'aria-hidden': 'true'
      },
      h('path', {
        fill: 'currentColor',
        d: 'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z'
      }),
      h('path', {
        fill: 'currentColor', fillOpacity: '0.45',
        d: 'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z'
      }));
    }

    function CaretGlyph(props) {
      return h('svg', {
        className: `mrf-caret${props?.open ? ' mrf-caretOpen' : ''}`,
        width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true'
      }, h('path', { d: 'M4.5 2.5 8 6 4.5 9.5' }));
    }

    /** A small inline glyph: two stacked folders, drawn in currentColor. */
    function MultiRootFilesIcon(props) {
      const size = props?.size ?? 14;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true'
      },
      h('path', { d: 'M3.4 2.6h3.3l1.1 1.4h5.7v4.6', opacity: '0.6' }),
      h('path', { d: 'M1.6 5.4h3.3l1.1 1.4h6.9v6H1.6z' }));
    }

    /* -------------------------------------------------------------- rows */

    function FileRow(props) {
      const { entry, depth, active, onOpenFile, onContextMenu, decoration, icon, t } = props;
      const key = pathKey(entry.path);
      const status = decoration.statuses[key];
      const ignored = decoration.ignored.has(key);
      const ink = status ? (STATUS_INK[status.letter] ?? STATUS_INK.M) : undefined;
      const classes = ['mrf-row', 'mrf-fileRow'];
      if (active === true) classes.push('mrf-rowActive');
      if (ignored) classes.push('mrf-rowIgnored');
      if (ink !== undefined) classes.push(`mrf-rowChanged mrf-tone-${ink.cls}`);
      const title = ink !== undefined
        ? `${entry.path} · ${isZh() ? ink.zh : ink.word}`
        : entry.path;
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        style: { paddingLeft: `${6 + depth * INDENT + 16}px` },
        title,
        'aria-current': active === true ? 'true' : undefined,
        onClick: () => onOpenFile(entry),
        onContextMenu: (event) => onContextMenu?.(event, entry.path, false)
      },
      // The host's own file-type artwork (48 colored categories) is the same
      // glyph the built-in Files tab shows; fall back to our sheet when the
      // service is not published yet.
      icon !== undefined && icon !== null ? icon : h(FileGlyph),
      h('span', { className: 'mrf-name' }, entry.name),
      ink !== undefined
        ? h('span', {
            className: `mrf-badge mrf-badge-${ink.cls}`,
            'data-letter': status.letter,
            title: isZh() ? ink.zh : ink.word
          }, status.letter)
        : null);
    }

    function DirRow(props) {
      const { entry, depth, open, onToggleDir, onContextMenu, decoration } = props;
      const key = pathKey(entry.path);
      const ignored = decoration.ignored.has(key);
      const changed = decoration.changedDirs.has(key);
      const classes = ['mrf-row', 'mrf-dirRow'];
      if (open) classes.push('mrf-dirRowOpen');
      if (ignored) classes.push('mrf-rowIgnored');
      if (changed) classes.push('mrf-dirChanged');
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        style: { paddingLeft: `${6 + depth * INDENT}px` },
        title: entry.path,
        onClick: () => onToggleDir(entry),
        onContextMenu: (event) => onContextMenu?.(event, entry.path, true)
      },
      h(CaretGlyph, { open }),
      h(FolderGlyph),
      h('span', { className: 'mrf-name' }, entry.name));
    }

    /**
     * One directory level and, recursively, the expanded levels below it.
     * Rendering is driven by the caller's `expanded` map, so collapsing a
     * directory hides the subtree without dropping its cached levels.
     */
    function DirectoryLevel(props) {
      const { path, depth, levels, expanded, activePath, onToggleDir, onOpenFile, onContextMenu, t, decoration, fileIcon } = props;
      const level = levels[path];
      if (level === undefined) {
        return h('div', { className: 'mrf-note', style: { paddingLeft: `${6 + depth * INDENT + 16}px` } }, t('loading'));
      }
      if (level.error !== undefined) {
        return h('div', {
          className: 'mrf-note mrf-noteError',
          style: { paddingLeft: `${6 + depth * INDENT + 16}px` },
          title: level.error
        }, t('loadFailed'));
      }
      if (level.entries.length === 0) {
        return h('div', { className: 'mrf-note', style: { paddingLeft: `${6 + depth * INDENT + 16}px` } }, t('empty'));
      }

      const rows = [];
      for (const entry of level.entries) {
        // The repository's own metadata directory is never part of the
        // project's files: the built-in Files tab hides it, and so does this
        // one (its hooks/refs/logs are noise, not source).
        if (entry.isDir === true && entry.name === '.git') continue;
        const open = entry.isDir === true && expanded[entry.path] === true;
        if (entry.isDir === true) {
          rows.push(h(DirRow, { key: `d:${entry.path}`, entry, depth, open, onToggleDir, onContextMenu, decoration }));
          if (open) {
            rows.push(h(DirectoryLevel, {
              key: `l:${entry.path}`,
              path: entry.path,
              depth: depth + 1,
              levels,
              expanded,
              activePath,
              onToggleDir,
              onOpenFile,
              onContextMenu,
              t,
              decoration,
              fileIcon
            }));
          }
        } else {
          rows.push(h(FileRow, {
            key: `f:${entry.path}`,
            entry,
            depth,
            active: activePath === entry.path,
            onOpenFile,
            onContextMenu,
            decoration,
            icon: fileIcon ? fileIcon(entry.path) : undefined,
            t
          }));
        }
      }
      if (level.truncated === true) {
        rows.push(h('div', {
          key: 'truncated',
          className: 'mrf-note',
          style: { paddingLeft: `${6 + depth * INDENT + 16}px` }
        }, t('truncated')));
      }
      return h(Fragment, null, rows);
    }

    function RootSection(props) {
      const { root, expanded, levels, activePath, onToggleRoot, onToggleDir, onOpenFile, onContextMenu, t, decoration, fileIcon } = props;
      const open = expanded[root.path] === true;
      const label = root.label || baseName(root.path);
      return h('section', { className: 'mrf-root' },
        h('button', {
          type: 'button',
          className: 'mrf-rootHead',
          title: root.path,
          onClick: () => onToggleRoot(root),
          onContextMenu: (event) => onContextMenu?.(event, root.path, true)
        },
        h(CaretGlyph, { open }),
        h(FolderGlyph, { size: 14 }),
        h('span', { className: 'mrf-rootLabel' }, label),
        h('span', { className: `mrf-tag${root.kind === 'additional' ? ' mrf-tagAlt' : ''}` },
          root.kind === 'additional' ? t('additional') : t('primary'))),
        open
          ? (root.exists === false
              ? h('div', { className: 'mrf-note mrf-noteError mrf-indent' }, t('missingRoot'))
              : h(DirectoryLevel, {
                  path: root.path,
                  depth: 1,
                  levels,
                  expanded,
                  activePath,
                  onToggleDir,
                  onOpenFile,
                  onContextMenu,
                  t,
                  decoration,
                  fileIcon
                }))
          : null);
    }

    /* ------------------------------------------------------------------ *
     * A tiny, dependency-free Markdown renderer.
     *
     * The client half cannot import a markdown package (no bundler, React is
     * borrowed from the shell), and rendering untrusted file content through
     * innerHTML would be an injection hole. So this walks the block structure
     * by hand and builds EVERY node with createElement — text is always a text
     * node, never HTML. Links are restricted to http/https/mailto/# targets.
     * Supported: headings, bold/italic, inline code, links, fenced code,
     * unordered/ordered lists, blockquotes, horizontal rules and GFM tables.
     * ------------------------------------------------------------------ */

    /** Only these URL schemes may become a link target. */
    function safeMarkdownUrl(raw) {
      const url = String(raw).trim();
      if (url.startsWith('#')) return url;
      if (/^(https?:|mailto:)/i.test(url)) return url;
      return null;
    }

    /**
     * Inline markup -> an array of React children. A single regex with named
     * alternatives keeps the scanner linear and avoids nested-string recursion;
     * `**bold**`, `*em*`, `` `code` `` and `[text](url)` are all handled here.
     */
    function renderInline(text) {
      const out = [];
      const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**') || token.startsWith('__')) {
          out.push(h('strong', { key: match.index }, match[2] ?? match[3]));
        } else if (token.startsWith('`')) {
          out.push(h('code', { key: match.index, className: 'mrf-mdCode' }, match[6]));
        } else if (token.startsWith('[')) {
          const url = safeMarkdownUrl(match[8]);
          // An unsafe scheme degrades to plain text instead of a live link.
          out.push(url === null
            ? match[7]
            : h('a', { key: match.index, href: url, target: '_blank', rel: 'noopener noreferrer' }, match[7]));
        } else {
          out.push(h('em', { key: match.index }, match[4] ?? match[5]));
        }
        last = match.index + token.length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    /** Split a table row on unescaped pipes, dropping the outer empty cells. */
    function splitTableRow(line) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      return cells.map((cell) => cell.trim());
    }

    /** Is `line` a GFM delimiter row like `| --- | :---: | ---: |`? */
    function isTableDelimiter(line) {
      const cells = splitTableRow(line);
      return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    /** Render a whole Markdown document into React elements (no innerHTML). */
    function MarkdownBody(props) {
      const { content } = props;
      const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let key = 0;

      while (i < lines.length) {
        const line = lines[i];

        // Fenced code block: collect verbatim until the closing fence.
        const fence = /^```\s*([^`]*)$/.exec(line);
        if (fence) {
          const code = [];
          i += 1;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
          if (i < lines.length) i += 1;
          blocks.push(h('pre', { key: key++, className: 'mrf-mdPre' },
            h('code', { className: 'mrf-mdCode' }, code.join('\n'))));
          continue;
        }

        // Blank line: just skip it (paragraph separation is implicit).
        if (line.trim() === '') { i += 1; continue; }

        // Horizontal rule.
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: key++, className: 'mrf-mdHr' }));
          i += 1;
          continue;
        }

        // ATX heading (# .. ######).
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          blocks.push(h(`h${level}`, { key: key++, className: `mrf-mdH mrf-mdH${level}` }, renderInline(heading[2].replace(/\s+#+\s*$/, ''))));
          i += 1;
          continue;
        }

        // Blockquote: consume consecutive `>` lines into one quote block.
        if (/^\s*>/.test(line)) {
          const quoted = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s*>\s?/, ''));
            i += 1;
          }
          blocks.push(h('blockquote', { key: key++, className: 'mrf-mdQuote' }, renderInline(quoted.join(' '))));
          continue;
        }

        // GFM table: a header row immediately followed by a delimiter row.
        if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
          const header = splitTableRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(splitTableRow(lines[i]));
            i += 1;
          }
          const headRow = h('tr', null, header.map((cell, c) =>
            h('th', { key: c }, renderInline(cell))));
          const bodyRows = rows.map((row, r) => h('tr', { key: r },
            header.map((_, c) => h('td', { key: c }, row[c] !== undefined ? renderInline(row[c]) : null))));
          const table = h('table', { className: 'mrf-mdTable' },
            h('thead', null, headRow),
            h('tbody', null, bodyRows));
          blocks.push(h('div', { key: key++, className: 'mrf-mdTableWrap' }, table));
          continue;
        }

        // Unordered / ordered list: keep consecutive items of the same kind.
        const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ul || ol) {
          const ordered = ul === null;
          const items = [];
          while (i < lines.length) {
            const m = ordered
              ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
              : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
            if (!m) break;
            items.push(h('li', { key: items.length }, renderInline(m[1])));
            i += 1;
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: key++, className: 'mrf-mdList' }, items));
          continue;
        }

        // Paragraph: join consecutive non-blank, non-block lines with a space.
        const para = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== ''
          && !/^```|^\s*>|^#{1,6}\s|^\s*(-{3,}|\*{3,}|_{3,})\s*$|^\s*[-*+]\s|^\s*\d+[.)]\s/.test(lines[i])) {
          para.push(lines[i]);
          i += 1;
        }
        blocks.push(h('p', { key: key++, className: 'mrf-mdP' }, renderInline(para.join(' '))));
      }

      return h('div', { className: 'mrf-markdown' }, blocks);
    }

    /** True for file names the panel should offer a Markdown preview for. */
    function isMarkdownPath(path) {
      return /\.(md|markdown|mdown|mkd)$/i.test(String(path ?? ''));
    }
    /* ---------------------------------------------------------- preview */

    /** Rendered line cap: the preview is read-only, so a huge file is clipped. */
    const PREVIEW_LINE_CAP = 4000;

    function PreviewPane(props) {
      const { preview, t, onClose, decoration, onContextMenu } = props;
      const value = preview.value;
      // The open file carries the same git state the tree shows: the reader
      // must not have to look back at the tree to know whether the file in
      // front of them is modified, added or ignored.
      const key = pathKey(preview.path);
      const status = decoration.statuses[key];
      const ignored = decoration.ignored.has(key);
      const ink = status ? (STATUS_INK[status.letter] ?? STATUS_INK.M) : undefined;

      // Markdown files open as a RENDERED document. The explorer already has
      // the whole file text (`value.content`), so no extra host read is needed.
      // "源码" falls back to the original line-by-line view; the toggle only
      // exists for a text .md-ish file (not an image or a binary blob).
      const isMd = isMarkdownPath(preview.path)
        && preview.image === undefined
        && value?.kind !== 'binary'
        && value?.kind !== 'too-large';
      const [view, setView] = useState('preview');
      useEffect(() => { setView('preview'); }, [preview.path]);

      const toggle = isMd
        ? h('div', { className: 'mrf-mdToggle' },
          h('button', {
            type: 'button',
            className: view === 'preview' ? 'mrf-mdToggleBtn mrf-mdToggleActive' : 'mrf-mdToggleBtn',
            title: t('markdownPreviewTitle'),
            onClick: () => setView('preview')
          }, t('markdownPreview')),
          h('button', {
            type: 'button',
            className: view === 'source' ? 'mrf-mdToggleBtn mrf-mdToggleActive' : 'mrf-mdToggleBtn',
            title: t('markdownSourceTitle'),
            onClick: () => setView('source')
          }, t('markdownSource')))
        : null;

      let body;
      if (preview.phase === 'loading') {
        body = h('div', { className: 'mrf-note mrf-pad' }, t('previewLoading'));
      } else if (preview.phase === 'error') {
        body = h('div', { className: 'mrf-note mrf-noteError mrf-pad' },
          `${t('previewFailed')}: ${preview.error}`);
      } else if (preview.image !== undefined && preview.image !== null) {
        // A drawable image wins over the text: the bytes are there, so the
        // picture is shown (the text read of a picture is meaningless).
        body = h('div', { className: 'mrf-imageWrap' },
          h('img', {
            className: 'mrf-image',
            src: preview.image.src,
            alt: preview.name
          }),
          h('div', { className: 'mrf-note' },
            `${preview.name}${preview.image.size === undefined ? '' : ` · ${formatSize(preview.image.size)}`}`));
      } else if (value?.kind === 'binary') {
        body = h('div', { className: 'mrf-note mrf-pad' },
          `${t('previewBinary')}${value.size === undefined ? '' : ` · ${formatSize(value.size)}`}`);
      } else if (value?.kind === 'too-large') {
        body = h('div', { className: 'mrf-note mrf-pad' },
          `${t('previewTooLarge')}${value.size === undefined ? '' : ` · ${formatSize(value.size)}`}`);
      } else if (isMd && view === 'preview') {
        body = h('div', { className: 'mrf-mdScroll' }, h(MarkdownBody, { content: String(value?.content ?? '') }));
      } else {
        const lines = String(value?.content ?? '').replace(/\r\n/g, '\n').split('\n');
        const shown = lines.slice(0, PREVIEW_LINE_CAP);
        // The changed rows are painted in the diff's ink: a green band for an
        // added row, a red band for one that was removed. The line NUMBER
        // carries the colour too, so the change is legible even where the
        // text itself is short.
        const added = preview.diff?.added;
        const removed = preview.diff?.removed;
        body = h('div', { className: 'mrf-code' },
          shown.map((text, index) => {
            const lineNo = index + 1;
            const isAdded = added !== undefined && added.has(lineNo);
            const isRemoved = removed !== undefined && removed.has(lineNo);
            const classes = ['mrf-codeLine'];
            if (isAdded) classes.push('mrf-lineAdded');
            if (isRemoved) classes.push('mrf-lineRemoved');
            return h('div', { key: index, className: classes.join(' ') },
              h('span', { className: 'mrf-lineNo' }, String(lineNo)),
              h('span', { className: 'mrf-lineText' }, text === '' ? '\u00a0' : text));
          }),
          lines.length > shown.length
            ? h('div', { className: 'mrf-note' }, t('previewTruncated', { count: shown.length }))
            : null);
      }
      return h('div', { className: 'mrf-previewPane' },
        h('div', { className: 'mrf-previewBar' },
          h('span', {
            className: `mrf-previewTitle${ink !== undefined ? ` mrf-tone-${ink.cls}` : ''}`,
            title: preview.path,
            onContextMenu: (event) => onContextMenu?.(event, preview.path, false)
          }, preview.name),
          ignored ? h('span', { className: 'mrf-previewTag' }, t('ignored')) : null,
          ink !== undefined
            ? h('span', {
                className: `mrf-badge mrf-badge-${ink.cls}`,
                'data-letter': status.letter,
                title: isZh() ? ink.zh : ink.word
              }, status.letter)
            : null,
          toggle,
          h('button', {
            type: 'button',
            className: 'mrf-iconButton',
            title: t('close'),
            'aria-label': t('close'),
            onClick: onClose
          }, '\u00d7')),
        body);
    }

    /* -------------------------------------------------------- clipboard
                                                           and open */

    /**
     * Copy one absolute path to the clipboard. The async Clipboard API needs a
     * focus+permission combination a sandboxed panel does not always have, so
     * the legacy `execCommand('copy')` path stays as the fallback.
     */
    async function copyTextToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* fall through to the legacy path */ }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }

    /** Ask the host to reveal `path` in the OS file manager. */
    async function openInFileManager(ctx, path) {
      const parsed = await postPlain(ctx, `${API_BASE}/open`, { path });
      if (parsed?.ok !== true) {
        throw new Error(typeof parsed?.error === 'string' && parsed.error !== '' ? parsed.error : 'open failed');
      }
    }

    /** One ephemeral toast; the caller lets it expire on its own. */
    function Toast(props) {
      if (!props.message) return null;
      return h('div', { className: 'mrf-toast', role: 'status' }, props.message);
    }

    /** The two-action context menu: copy the path, open the file manager. */
    function ContextMenu(props) {
      const { menu, t, onCopy, onOpen } = props;
      const menuRef = useRef(null);
      // Clamp into the panel after layout: offsetParent is the positioned
      // ancestor (.mrf-panel), so menu offset coords and its client size are
      // measured in the same coordinate space. Runs in the same frame as the
      // mount, before the browser paints — no flicker.
      useLayoutEffect(() => {
        const el = menuRef.current;
        const parent = el?.offsetParent;
        if (!(el instanceof HTMLElement) || !(parent instanceof HTMLElement)) return;
        const maxX = Math.max(0, parent.clientWidth - el.offsetWidth);
        const maxY = Math.max(0, parent.clientHeight - el.offsetHeight);
        const left = Math.min(Math.max(menu.x, 0), maxX);
        const top = Math.min(Math.max(menu.y, 0), maxY);
        if (left !== el.offsetLeft || top !== el.offsetTop) {
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
        }
      }, [menu]);
      if (menu === null || menu === undefined) return null;
      return h('div', {
        className: 'mrf-menu',
        role: 'menu',
        ref: menuRef,
        style: { left: `${Math.max(menu.x, 0)}px`, top: `${Math.max(menu.y, 0)}px` }
      },
      h('button', {
        type: 'button', role: 'menuitem', className: 'mrf-menuItem',
        onClick: () => onCopy(menu.path)
      }, t('copyPath')),
      h('button', {
        type: 'button', role: 'menuitem', className: 'mrf-menuItem',
        onClick: () => onOpen(menu.path)
      }, t('openInFiles')));
    }

    /**
     * Font-size control for the toolbar: A− / percentage / A+ / reset.
     * The parent owns `scale` and persists it through /settings; this control
     * is stateless so a failed write cannot leave UI and disk disagreeing.
     */
    function FontSizeControl(props) {
      const { scale, t, onChange } = props;
      const percent = Math.round(scale * 100);
      const clamp = (value) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value * 10) / 10));
      const label = t('fontScaleTitle', { percent });
      return h('div', { className: 'mrf-fontControl', title: label },
        h('span', { className: 'mrf-fontLabel' }, t('fontSize')),
        h('button', {
          type: 'button',
          className: 'mrf-fontBtn',
          title: t('fontSmaller'),
          'aria-label': t('fontSmaller'),
          disabled: scale <= FONT_MIN + 0.001,
          onClick: () => onChange(clamp(scale - FONT_STEP))
        }, 'A−'),
        h('button', {
          type: 'button',
          className: 'mrf-fontValue',
          title: t('fontReset'),
          'aria-label': `${label} · ${t('fontReset')}`,
          onDoubleClick: () => onChange(FONT_DEFAULT)
        }, `${percent}%`),
        h('button', {
          type: 'button',
          className: 'mrf-fontBtn',
          title: t('fontLarger'),
          'aria-label': t('fontLarger'),
          disabled: scale >= FONT_MAX - 0.001,
          onClick: () => onChange(clamp(scale + FONT_STEP))
        }, 'A+'));
    }

    /* ------------------------------------------------------------ panel */

    function MultiRootFilesTab(props) {
      const { ctx, scope, visible } = props;
      const t = useCopy();

      const [roots, setRoots] = useState([]);
      const [registryFound, setRegistryFound] = useState(true);
      const [levels, setLevels] = useState({});
      const [expanded, setExpanded] = useState({});
      const [phase, setPhase] = useState('idle');
      const [errorText, setErrorText] = useState('');
      /** '' = follow the primary root; otherwise the root picked in the toolbar. */
      const [pickedRoot, setPickedRoot] = useState('');
      const [preview, setPreview] = useState(null);
      const [decoration, setDecoration] = useState(EMPTY_DECORATION);
      /** The open context menu, positioned relative to the panel's top-left. */
      const [contextMenu, setContextMenu] = useState(null);
      /** The current toast: `{ key, at }` or null; `at` re-arms the timer. */
      const [toast, setToast] = useState(null);
      /** The panel root: context-menu coordinates are relative to it. */
      const panelRef = useRef(null);

      /** The sidebar's own file-type icon resolver; undefined until published. */
      const [fileIcon, setFileIcon] = useState(null);
      /**
       * The panel context is held in a ref, never in a dependency array: the
       * sidebar hands a FRESH context object to every render, so a dependency
       * on `ctx` would restart this effect on every single render (and cancel
       * the debounce below before it ever fired).
       */
      const ctxRef = useRef(ctx);
      ctxRef.current = ctx;

      // Durable font scale, read from THIS plugin's /settings on mount and
      // written back on every change. It is deliberately separate from
      // dsh-multi-root-changes' setting: the two panels are independent.
      const [fontScale, setFontScale] = useState(FONT_DEFAULT);
      useEffect(() => {
        let live = true;
        fetchJson(ctxRef.current, `${API_BASE}/settings`)
          .then((reply) => {
            if (!live) return;
            const value = Number(reply?.fontScale);
            if (Number.isFinite(value)) setFontScale(Math.min(FONT_MAX, Math.max(FONT_MIN, value)));
          })
          .catch(() => { /* first run / host half not loaded yet: keep default */ });
        return () => { live = false; };
      }, []);
      const changeFontScale = useCallback((next) => {
        const value = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next * 10) / 10));
        setFontScale(value);
        postPlain(ctxRef.current, `${API_BASE}/settings`, { fontScale: value })
          .then((reply) => {
            const saved = Number(reply?.fontScale);
            if (Number.isFinite(saved)) setFontScale(saved);
          })
          .catch(() => { /* keep the chosen size for this session */ });
      }, []);

      useEffect(() => {
        const read = () => {
          const service = ctxRef.current.get?.('betterSidebar');
          const resolver = service && typeof service.fileIcon === 'function'
            ? (path) => {
                try { return service.fileIcon(path, 14); } catch { return undefined; }
              }
            : undefined;
          // A resolver is a FUNCTION: state must be set through an updater, or
          // React would call it as `prev => next` instead of storing it.
          setFileIcon(() => resolver ?? null);
        };
        read();
        const off = ctxRef.current.on?.('internal/service', (name) => { if (name === 'betterSidebar') read(); });
        return () => { try { off?.(); } catch { /* gone */ } };
      }, []);

      const generation = useRef(0);
      /** Bumped per decoration request so a slow git read cannot beat a newer one. */
      const decorationGeneration = useRef(0);
      /** Bumped per preview request so a slow read cannot beat a newer one. */
      const previewGeneration = useRef(0);
      const pickedRootRef = useRef('');
      pickedRootRef.current = pickedRoot;
      const scopeRef = useRef(scope);
      scopeRef.current = scope;
      const levelsRef = useRef(levels);
      levelsRef.current = levels;
      const expandedRef = useRef(expanded);
      expandedRef.current = expanded;
      /** The scope whose expansion set the current state belongs to. */
      const loadedKey = useRef(null);

      const scopeKey = `${scope?.sessionId ?? ''}|${scope?.cwd ?? ''}`;

      // Another session (or another cwd) owns a different root set: drop the
      // picked root and any open preview instead of showing foreign content.
      const loadedScopeKey = useRef(scopeKey);
      useEffect(() => {
        if (loadedScopeKey.current === scopeKey) return;
        loadedScopeKey.current = scopeKey;
        pickedRootRef.current = '';
        setPickedRoot('');
        previewGeneration.current += 1;
        setPreview(null);
      }, [scopeKey]);

      /**
       * Git decorations for the tree that is on screen. Only the paths the
       * tree actually lists are sent, so expanding one folder costs one small
       * `check-ignore` batch instead of a whole-repository scan.
       *
       * The request is tied to the tree, NOT to the tab's visibility: a
       * background tab is still a tab, and its rows must show their states
       * the moment it comes forward.
       */
      const refreshDecoration = useCallback(async (rootList, levelMap) => {
        const list = Array.isArray(rootList) ? rootList : [];
        if (list.length === 0) return;
        // ONE root is on screen, so ONE root is asked about: mixing the roots'
        // paths would send the same rows to every repository.
        const picked = pickedRootRef.current;
        const active = list.find((root) => root && root.path === picked)
          ?? list.find((root) => root && root.kind === 'primary')
          ?? list[0];
        if (!active || typeof active.path !== 'string') return;
        const base = pathKey(active.path);
        const paths = [];
        const seen = new Set();
        const add = (value) => {
          if (typeof value !== 'string' || value === '') return;
          const key = pathKey(value);
          if (seen.has(key)) return;
          if (key !== base && !key.startsWith(`${base}/`)) return;
          seen.add(key);
          paths.push(value);
        };
        add(active.path);
        // The LEVELS are walked by value, never by the expanded map's key: the
        // sidebar answers a level with ITS OWN path spelling, so looking a
        // level up by the expanded key silently misses it and the request
        // goes out with no paths at all (no ignored file, no colour).
        for (const level of Object.values(levelMap ?? {})) {
          if (level === undefined || level === null) continue;
          for (const entry of level.entries ?? []) {
            // The repository's own metadata directory is not part of the
            // project: it is never listed, so it is never asked about.
            if (entry.isDir === true && entry.name === '.git') continue;
            add(entry.path);
          }
        }
        // The dsh-app:// protocol caps a request body (about 64 KiB); a deep
        // tree would blow past it and the whole request would fail, taking the
        // colours down with it. The paths are therefore sent in batches, and
        // a batch that fails costs only its own rows.
        const gen = ++decorationGeneration.current;
        const statuses = {};
        const ignored = new Set();
        const changedDirs = new Set();
        let failed = false;
        for (let index = 0; index < paths.length; index += MAX_DECORATION_PATHS) {
          const batch = paths.slice(index, index + MAX_DECORATION_PATHS);
          const next = await fetchStatus(ctxRef.current, scopeRef.current, [active.path], batch);
          // A newer request already answered: that answer is the current one.
          if (gen !== decorationGeneration.current) return true;
          if (next === null) {
            failed = true;
            continue;
          }
          Object.assign(statuses, next.statuses);
          for (const value of next.ignored) ignored.add(value);
          for (const value of next.changedDirs) changedDirs.add(value);
        }
        // A failed batch must NOT clear the tree: the rows keep the colours
        // they already have, and the caller tries again.
        if (failed) return false;
        setDecoration({ statuses, ignored, changedDirs });
        return true;
      }, []);

      /**
       * Read the root list, then one batch for every level that is currently
       * open (roots included). Re-expanding a remembered directory is a cache
       * hit, so a refresh after a tab switch does not collapse the tree.
       */
      const load = useCallback(async () => {
        const live = scopeRef.current;
        const gen = ++generation.current;
        setPhase('loading');
        setErrorText('');
        try {
          const state = await fetchRoots(ctxRef.current, live);
          if (gen !== generation.current) return;

          const nextRoots = Array.isArray(state?.roots) ? state.roots : [];
          setRoots(nextRoots);
          setRegistryFound(state?.registryFound !== false);

          // One root is on screen at a time: the picked one, else the primary.
          // Expansions are remembered per path, so a refresh (or a tab switch)
          // keeps the open subtree; another root's expansions are dropped.
          const primary = nextRoots.find((root) => root && root.kind === 'primary') ?? nextRoots[0];
          const picked = pickedRootRef.current;
          const active = nextRoots.find((root) => root && root.path === picked) ?? primary;
          if (picked !== '' && !nextRoots.some((root) => root?.path === picked)) {
            pickedRootRef.current = '';
            setPickedRoot('');
          }

          const previous = loadedKey.current === scopeKey ? expandedRef.current : {};
          const nextExpanded = {};
          if (active && typeof active.path === 'string' && active.path !== '') {
            for (const path of Object.keys(previous)) {
              if (isUnder(path, active.path)) nextExpanded[path] = true;
            }
            if (active.exists !== false) nextExpanded[active.path] = true;
          }

          setExpanded(nextExpanded);
          loadedKey.current = scopeKey;

          const targets = Object.keys(nextExpanded);
          const nextLevels = {};
          for (let index = 0; index < targets.length; index += MAX_BATCH) {
            const fresh = await fetchLevels(ctxRef.current, live, targets.slice(index, index + MAX_BATCH));
            if (gen !== generation.current) return;
            for (const level of fresh) {
              if (level && typeof level.path === 'string') nextLevels[level.path] = normalizeLevel(level);
            }
          }
          setLevels(nextLevels);
          setPhase('ready');
          // The decorations follow the tree that was just read: asking for
          // them here (rather than from an effect keyed on the tree state)
          // keeps the request tied to ONE load, so a background tab that
          // never becomes visible still gets its colours.
          void refreshDecoration(nextRoots, nextLevels);
        } catch (error) {
          if (gen !== generation.current) return;
          setPhase('error');
          setErrorText(error instanceof Error ? error.message : String(error));
        }
      }, [scopeKey, refreshDecoration]);

      useEffect(() => {
        if (visible !== true) return;
        void load();
      }, [visible, load]);

      const loadLevel = useCallback(async (path) => {
        const live = scopeRef.current;
        const gen = generation.current;
        try {
          const fresh = await fetchLevels(ctxRef.current, live, [path]);
          if (gen !== generation.current) return;
          setLevels((prev) => {
            const next = { ...prev };
            for (const level of fresh) {
              if (level && typeof level.path === 'string') next[level.path] = normalizeLevel(level);
            }
            if (next[path] === undefined) next[path] = { entries: [], error: t('loadFailed') };
            return next;
          });
        } catch (error) {
          if (gen !== generation.current) return;
          setLevels((prev) => ({
            ...prev,
            [path]: { entries: [], error: error instanceof Error ? error.message : String(error) }
          }));
        }
      }, [t]);

      const toggleDir = useCallback((entry) => {
        if (!entry || entry.isDir !== true) return;
        const open = expandedRef.current[entry.path] === true;
        setExpanded((prev) => {
          const next = { ...prev };
          if (open) delete next[entry.path];
          else next[entry.path] = true;
          return next;
        });
        if (!open && levelsRef.current[entry.path] === undefined) void loadLevel(entry.path);
      }, [loadLevel]);

      /**
       * Re-read the decorations after the tree changed (a folder opened or
       * closed): the newly listed rows must carry their own states.
       *
       * A failed reading is retried: the host can be briefly unable to answer
       * (a busy machine, a request that outgrew the protocol's body cap), and
       * the colours must come back on their own instead of staying lost until
       * the next folder is opened.
       */
      useEffect(() => {
        if (roots.length === 0) return undefined;
        let timer = undefined;
        let attempt = 0;
        const tick = () => {
          void refreshDecoration(roots, levels).then((ok) => {
            if (ok !== false) return;
            attempt += 1;
            if (attempt > 4) return;
            // A short backoff: the host usually recovers within a second.
            timer = setTimeout(tick, 400 * attempt);
          });
        };
        timer = setTimeout(tick, 120);
        return () => { clearTimeout(timer); };
      }, [roots, levels, expanded, refreshDecoration]);

      const toggleRoot = useCallback((root) => {
        if (!root || typeof root.path !== 'string') return;
        const open = expandedRef.current[root.path] === true;
        setExpanded((prev) => {
          const next = { ...prev };
          if (open) delete next[root.path];
          else next[root.path] = true;
          return next;
        });
        if (!open && root.exists !== false && levelsRef.current[root.path] === undefined) void loadLevel(root.path);
      }, [loadLevel]);

      /** Switch the single visible root; its first level loads on demand. */
      const selectRoot = useCallback((path) => {
        if (typeof path !== 'string' || path === '') return;
        pickedRootRef.current = path;
        setPickedRoot(path);
        previewGeneration.current += 1;
        setPreview(null);
        setExpanded((prev) => (prev[path] === true ? prev : { ...prev, [path]: true }));
        if (levelsRef.current[path] === undefined) void loadLevel(path);
      }, [loadLevel]);

      /**
       * Show one file's content INSIDE this tab, in the pane beside the tree.
       * Nothing here opens a new window, adds a sidebar tab, or hands the path
       * to an external program — this is the same in-tab split the
       * multi-root-changes tab uses.
       */
      const openEntry = useCallback(async (entry) => {
        if (!entry || entry.isDir === true || typeof entry.path !== 'string') return;
        const gen = ++previewGeneration.current;
        setPreview({ path: entry.path, name: entry.name, phase: 'loading' });
        try {
          // The image bytes and the changed line numbers are independent of the
          // text: all three are asked for at once, and the preview picks what
          // it can draw.
          const [value, image, diff] = await Promise.all([
            fetchFile(ctxRef.current, scopeRef.current, entry.path).catch((error) => ({ __error: error })),
            fetchImage(ctxRef.current, entry.path),
            fetchDiff(ctxRef.current, entry.path)
          ]);
          if (gen !== previewGeneration.current) return;
          if (value && typeof value === 'object' && value.__error !== undefined) {
            throw value.__error;
          }
          setPreview({ path: entry.path, name: entry.name, phase: 'ready', value, image, diff });
        } catch (error) {
          if (gen !== previewGeneration.current) return;
          setPreview({
            path: entry.path,
            name: entry.name,
            phase: 'error',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }, []);

      const closePreview = useCallback(() => {
        previewGeneration.current += 1;
        setPreview(null);
      }, []);

      /* ------------------------------------------- context menu and toast */

      const closeMenu = useCallback(() => setContextMenu(null), []);

      /** One context menu for rows AND the root/preview titles. */
      const handleContextMenu = useCallback((event, path, isDir) => {
        if (typeof path !== 'string' || path === '') return;
        event.preventDefault();
        const wrap = panelRef.current;
        const rect = wrap instanceof HTMLElement ? wrap.getBoundingClientRect() : null;
        const x = rect === null ? event.clientX : event.clientX - rect.left;
        const y = rect === null ? event.clientY : event.clientY - rect.top;
        setContextMenu({ path, isDir: isDir === true, x, y });
      }, []);

      /** A click outside the menu, a blur or Escape closes it. */
      useEffect(() => {
        if (contextMenu === null) return undefined;
        // One stable closer per effect run: two separate `.bind()` calls would
        // create two different function objects and the removal would never
        // match the registration.
        const close = () => setContextMenu(null);
        const onClick = (event) => {
          const menu = panelRef.current?.querySelector('.mrf-menu');
          if (menu !== null && menu !== undefined && event.target instanceof Node
            && menu.contains(event.target)) return;
          close();
        };
        const onKey = (event) => { if (event.key === 'Escape') close(); };
        window.addEventListener('click', onClick, true);
        window.addEventListener('resize', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', onClick, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [contextMenu]);

      /** The toast expires on its own; a new toast re-arms the timer. */
      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 1800);
        return () => clearTimeout(timer);
      }, [toast]);

      /** Copy one absolute path; the toast reports the outcome. */
      const copyPath = useCallback(async (path) => {
        const ok = await copyTextToClipboard(displayPath(path));
        setToast({ key: ok ? 'copiedPath' : 'copyFailed', at: Date.now() });
      }, []);

      /** Reveal one path in the OS file manager through the host's /open route. */
      const openEntryInFiles = useCallback(async (path) => {
        try {
          await openInFileManager(ctxRef.current, path);
          setToast({ key: 'openedInFiles', at: Date.now() });
        } catch (error) {
          setToast({ key: 'openFailed', at: Date.now() });
          console.warn('[dsh-multi-root-files] open failed:',
            error instanceof Error ? error.message : error);
        }
      }, []);

      const menuCopy = useCallback((path) => {
        closeMenu();
        void copyPath(path);
      }, [closeMenu, copyPath]);

      const menuOpen = useCallback((path) => {
        closeMenu();
        void openEntryInFiles(path);
      }, [closeMenu, openEntryInFiles]);

      const primaryRoot = roots.find((root) => root && root.kind === 'primary') ?? roots[0];
      const activeRoot = roots.find((root) => root && root.path === pickedRoot) ?? primaryRoot;

      const busy = phase === 'loading';

      return h('div', {
        ref: panelRef,
        className: 'mrf-panel',
        // ONE variable scales every fixed-px font-size in the injected CSS.
        style: { '--mrf-scale': fontScale },
        'data-preview': preview !== null ? 'true' : 'false',
        // A read-only tally of the git decoration the tree is drawing: it
        // says at a glance whether the states were fetched at all.
        'data-mrf-deco': `${Object.keys(decoration.statuses).length}/${decoration.ignored.size}/${decoration.changedDirs.size}`
      },
        h('div', { className: 'mrf-bar' },
          h('span', { className: 'mrf-title' }, t('tab')),
          roots.length > 0
            ? h('select', {
                className: 'mrf-rootPicker',
                title: t('rootPicker'),
                'aria-label': t('rootPicker'),
                value: activeRoot?.path ?? '',
                onChange: (event) => selectRoot(event.target.value)
              }, roots.map((root) => h('option', { key: root.path, value: root.path },
                `${root.label || baseName(root.path)} · ${root.kind === 'additional' ? t('additional') : t('primary')}`)))
            : null,
          h('button', {
            type: 'button',
            className: 'mrf-refresh',
            title: t('refreshTitle'),
            'aria-label': t('refresh'),
            disabled: busy,
            onClick: () => { void load(); }
          }, '\u21bb'),
          h(FontSizeControl, { scale: fontScale, t, onChange: changeFontScale })),
        h('div', { className: 'mrf-split' },
          h('div', { className: 'mrf-treeWrap' },
            h('div', { className: 'mrf-body' },
              registryFound === false ? h('div', { className: 'mrf-registry' }, t('registryMissing')) : null,
              phase === 'error'
                ? h('div', { className: 'mrf-note mrf-noteError mrf-pad' }, `${t('rootsFailed')}: ${errorText}`)
                : null,
              phase === 'idle' || (busy && roots.length === 0)
                ? h('div', { className: 'mrf-note mrf-pad' }, t('loading'))
                : null,
              activeRoot
                ? h(RootSection, {
                    key: activeRoot.path,
                    root: activeRoot,
                    expanded,
                    levels,
                    activePath: preview?.path,
                    onToggleRoot: toggleRoot,
                    onToggleDir: toggleDir,
                    onOpenFile: openEntry,
                    onContextMenu: handleContextMenu,
                    t,
                    decoration,
                    fileIcon
                  })
                : null)),
          preview !== null ? h(PreviewPane, { preview, t, onClose: closePreview, decoration, onContextMenu: handleContextMenu }) : null),
        h(ContextMenu, { menu: contextMenu, t, onCopy: menuCopy, onOpen: menuOpen }),
        h(Toast, { message: toast === null ? '' : t(toast.key) }));
    }

    /* --------------------------------------------------------------- CSS */

    const CSS = `
[data-dockkit-pane]:has(.mrf-panel) [class*="tabHostHeader"],
[data-dockkit-pane]:has(.mrf-panel) [class*="tabStrip"] {
  background-color: var(--dsw-alias-bg-layer-1, #161b19) !important;
}
.mrf-panel { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: 12px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #161b19));
  background-color: var(--dsw-alias-bg-layer-1, #161b19);
  isolation: isolate; position: relative; }
/* The tree rows and the preview bar opt out of the browser's own menu so the
   two-action menu can take over. */
.mrf-body button, .mrf-previewBar { -webkit-user-select: none; user-select: none; }
.mrf-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
.mrf-title { font-weight: 600; flex: none; }
.mrf-rootPicker { flex: 1; min-width: 0; font: inherit; font-size: 11px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18));
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 2px 6px; }
.mrf-rootPicker:focus { outline: 1px solid var(--dsw-alias-state-business-primary); }
.mrf-count { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mrf-refresh { flex: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; border-radius: 4px; width: 22px; height: 22px; line-height: 1;
  font-size: 14px; padding: 0; }
.mrf-refresh:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.mrf-refresh:disabled { opacity: .45; cursor: default; }
/* Font-size control: fixed slot at the right end of the toolbar. */
.mrf-fontControl { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.mrf-fontLabel { color: var(--dsw-alias-label-tertiary); font-size: 10px; white-space: nowrap; }
.mrf-fontBtn, .mrf-fontValue { border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font: inherit; font-size: 11px; border-radius: 4px; height: 20px; }
.mrf-fontBtn { width: 24px; font-weight: 600; }
.mrf-fontValue { min-width: 44px; }
.mrf-fontBtn:hover:not(:disabled), .mrf-fontValue:hover {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mrf-fontBtn:disabled { opacity: .4; cursor: default; }
.mrf-notice { flex: none; padding: 4px 8px; font-size: 11px;
  color: var(--dsw-alias-state-error-primary);
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* Tree and preview share one row while a file is open. The panel is a narrow
   column, so a vertical split would squeeze the list to a few rows; the
   preview goes BESIDE the tree instead. The data-preview attribute switches
   the one rule. */
.mrf-split { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrf-panel[data-preview='true'] .mrf-split { flex-direction: row; }
.mrf-treeWrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mrf-panel[data-preview='true'] .mrf-treeWrap { flex: 1 1 45%; min-width: 150px;
  border-right: 1px solid var(--dsw-alias-border-l1); }
.mrf-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 4px 12px; }
.mrf-registry { padding: 6px 8px; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary); }
.mrf-root { min-width: 0; }
.mrf-rootHead { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
  background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer;
  padding: 0 8px 0 6px; height: 28px; border-radius: 4px; text-align: left;
  font: inherit; font-size: 12px; font-weight: 500; }
.mrf-rootHead:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrf-rootHead:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary);
  outline-offset: -1px; }
.mrf-rootLabel { flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mrf-tag { flex: none; font-size: 10px; line-height: 16px; padding: 0 5px; border-radius: 3px;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06)); }
.mrf-tagAlt { background: transparent;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2); }
.mrf-row { display: flex; align-items: center; gap: 6px; width: 100%; border: 0;
  background: transparent; color: var(--dsw-alias-label-primary); text-align: left;
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; height: 28px;
  padding: 0 8px 0 6px; border-radius: 4px; position: relative; }
.mrf-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrf-rowActive { background: var(--dsw-alias-interactive-bg-active, #343435); }
.mrf-rowActive::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px;
  width: 2px; border-radius: 1px;
  background: var(--dsw-alias-state-business-primary, #4176e6); }
.mrf-row:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.mrf-dirRow { font-weight: 500; }
.mrf-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrf-glyph { flex: none; }
.mrf-folderGlyph { color: #f7ad31; }
.mrf-fileGlyph { color: #cfd3d6; }
/* The host's FileTypeIcon is a 14px SVG/img; keep it from stretching the row. */
.mrf-fileRow > svg:not(.mrf-glyph), .mrf-fileRow > img { flex: none; width: 14px; height: 14px; }
/* Git-changed file names carry VS Code's ink; the letter badge repeats it. */
.mrf-tone-modified .mrf-name { color: var(--dsw-alias-state-warn-primary, #e2a03f); }
.mrf-tone-added .mrf-name, .mrf-tone-untracked .mrf-name,
.mrf-tone-copied .mrf-name { color: var(--dsw-alias-state-success-primary, #4cc38a); }
.mrf-tone-deleted .mrf-name, .mrf-tone-conflict .mrf-name {
  color: var(--dsw-alias-state-error-primary, #e5534b); }
.mrf-tone-renamed .mrf-name { color: var(--dsw-alias-state-business-primary, #7aaaff); }
.mrf-badge { flex: none; margin-left: auto; min-width: 12px; text-align: center;
  font-family: var(--ds-font-family-code, monospace); font-size: 10px; font-weight: 700; }
.mrf-badge-modified { color: var(--dsw-alias-state-warn-primary, #e2a03f); }
.mrf-badge-added, .mrf-badge-untracked, .mrf-badge-copied {
  color: var(--dsw-alias-state-success-primary, #4cc38a); }
.mrf-badge-deleted, .mrf-badge-conflict {
  color: var(--dsw-alias-state-error-primary, #e5534b); }
.mrf-badge-renamed { color: var(--dsw-alias-state-business-primary, #7aaaff); }
/* A directory whose subtree contains a change is tinted, never lettered. */
.mrf-dirChanged .mrf-name { color: var(--dsw-alias-state-business-primary, #7aaaff); }
/* Ignored files/folders are still listed, but visibly de-emphasized. */
.mrf-rowIgnored { opacity: .45; }
.mrf-rowIgnored:hover { opacity: .75; }
.mrf-caret { flex: none; color: var(--dsw-alias-label-tertiary);
  transition: transform .12s ease; }
.mrf-caretOpen { transform: rotate(90deg); }
.mrf-previewPane { flex: none; max-height: 45%; min-height: 120px; display: flex;
  flex-direction: column; border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1, #161b19); isolation: isolate; }
.mrf-panel[data-preview='true'] .mrf-previewPane { flex: 1 1 55%; max-height: none;
  min-height: 0; min-width: 0; border-top: 0; border-left: 1px solid var(--dsw-alias-border-l1); }
.mrf-previewBar { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  flex: none; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mrf-previewTitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-family: var(--ds-font-family-code); font-size: 11px; }
.mrf-previewTitle.mrf-tone-modified { color: var(--dsw-alias-state-warn-primary, #e2a03f); }
.mrf-previewTitle.mrf-tone-added, .mrf-previewTitle.mrf-tone-untracked,
.mrf-previewTitle.mrf-tone-copied { color: var(--dsw-alias-state-success-primary, #4cc38a); }
.mrf-previewTitle.mrf-tone-deleted, .mrf-previewTitle.mrf-tone-conflict {
  color: var(--dsw-alias-state-error-primary, #e5534b); }
.mrf-previewTitle.mrf-tone-renamed { color: var(--dsw-alias-state-business-primary, #7aaaff); }
.mrf-previewTag { flex: none; font-size: 10px; line-height: 16px; padding: 0 5px;
  border-radius: 3px; color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06)); }
/* In the preview bar the badge sits right next to the title, not at the far
   edge (the tree's badge uses margin-left:auto to pin itself to the row end). */
.mrf-previewBar .mrf-badge { margin-left: 0; }
.mrf-iconButton { flex: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; border-radius: 4px; width: 20px; height: 20px; line-height: 1;
  font-size: 14px; padding: 0; }
.mrf-iconButton:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.mrf-code { flex: 1; min-height: 0; overflow: auto; padding: 4px 0;
  font-family: var(--ds-font-family-code); font-size: 11px; }
.mrf-codeLine { display: flex; gap: 8px; padding: 0 8px; white-space: pre; }
/* Markdown preview: rendered document instead of line-by-line source. */
.mrf-mdToggle { display: flex; gap: 4px; flex: none; }
.mrf-mdToggleBtn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font: inherit; font-size: 10px; padding: 1px 8px; }
.mrf-mdToggleBtn:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.mrf-mdToggleActive { border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.mrf-mdScroll { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px; }
.mrf-markdown { color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.65;
  word-wrap: break-word; }
.mrf-markdown .mrf-mdH { margin: 14px 0 6px; line-height: 1.3; font-weight: 700; }
.mrf-markdown .mrf-mdH1 { font-size: 19px; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 4px; }
.mrf-markdown .mrf-mdH2 { font-size: 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 3px; }
.mrf-markdown .mrf-mdH3 { font-size: 14px; }
.mrf-markdown .mrf-mdH4, .mrf-markdown .mrf-mdH5, .mrf-markdown .mrf-mdH6 { font-size: 12px; }
.mrf-markdown .mrf-mdP { margin: 6px 0; }
.mrf-markdown .mrf-mdList { margin: 6px 0; padding-left: 22px; }
.mrf-markdown .mrf-mdList li { margin: 2px 0; }
.mrf-markdown .mrf-mdQuote { margin: 8px 0; padding: 2px 10px;
  border-left: 3px solid var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-secondary); }
.mrf-markdown .mrf-mdHr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 12px 0; }
.mrf-markdown a { color: var(--dsw-alias-state-business-primary); }
.mrf-markdown .mrf-mdCode { font-family: var(--ds-font-family-code); font-size: 11px;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18)); border-radius: 3px; padding: 1px 4px; }
.mrf-markdown .mrf-mdPre { overflow: auto; margin: 8px 0; padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18));
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; }
.mrf-markdown .mrf-mdPre .mrf-mdCode { background: transparent; padding: 0; }
.mrf-markdown .mrf-mdTableWrap { overflow-x: auto; }
.mrf-markdown .mrf-mdTable { border-collapse: collapse; margin: 8px 0; font-size: 11px; }
.mrf-markdown .mrf-mdTable th, .mrf-markdown .mrf-mdTable td {
  border: 1px solid var(--dsw-alias-border-l2); padding: 3px 8px; text-align: left; }
.mrf-markdown .mrf-mdTable th { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18)); font-weight: 600; }
/* The changed rows carry the diff's ink: an added row is green, a removed one
   red. The tint is a wash and the line number is coloured too, so a change is
   legible even on an empty line. */
.mrf-lineAdded { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.mrf-lineAdded .mrf-lineNo { color: var(--dsw-alias-state-success-primary); font-weight: 700; }
.mrf-lineRemoved { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.mrf-lineRemoved .mrf-lineNo { color: var(--dsw-alias-state-error-primary); font-weight: 700; }
/* The picture preview: the image is drawn at its own size inside a padded
   box that scrolls, so a large picture never squeezes the tree. */
.mrf-imageWrap { flex: 1; min-height: 0; overflow: auto; padding: 8px;
  display: flex; flex-direction: column; align-items: center; gap: 6px; }
.mrf-image { max-width: 100%; height: auto; display: block;
  border-radius: 4px; box-shadow: 0 1px 6px rgba(0,0,0,.35); }
.mrf-lineNo { flex: none; min-width: 34px; text-align: right; user-select: none;
  color: var(--dsw-alias-label-tertiary); }
.mrf-lineText { white-space: pre; }
.mrf-note { padding: 3px 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mrf-noteError { color: var(--dsw-alias-state-error-primary); }
.mrf-pad { padding: 12px 8px; }
.mrf-indent { padding-left: 30px; }
/* The two-action context menu. It is positioned INSIDE the panel (the
   coordinates were computed relative to it), so a long menu can never escape
   the narrow sidebar column; the max-height cap keeps it visible on short
   panels. */
.mrf-menu { position: absolute; z-index: 40; min-width: 170px; max-height: 45%;
  overflow: auto; padding: 4px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #22262a);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 6px 18px rgba(0,0,0,.4); isolation: isolate; }
.mrf-menuItem { display: block; width: 100%; border: 0; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
  text-align: left; padding: 5px 10px; border-radius: 4px; cursor: pointer;
  white-space: nowrap; }
.mrf-menuItem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mrf-menuItem:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); }
/* The one-line outcome toast (path copied / open failed). It sits above the
   bottom edge so it never covers the row that was clicked. */
.mrf-toast { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
  z-index: 41; max-width: calc(100% - 24px); padding: 5px 12px; border-radius: 6px;
  font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, #22262a);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 4px 12px rgba(0,0,0,.35); pointer-events: none; }
`;

    /**
     * Inject the panel stylesheet once. Every `font-size: Npx` becomes
     * `calc(Npx * var(--mrf-scale, 1))`, so one variable set on the panel root
     * scales ALL fixed-px text (tree, preview, toolbar, markdown) together.
     * The variable is scoped to .mrf-panel and cannot affect the shell around
     * it. `font: inherit` controls follow automatically.
     */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const scaled = CSS.replace(/font-size:\s*(\d+(?:\.\d+)?)px/g,
        (_match, px) => `font-size: calc(${px}px * var(--mrf-scale, 1))`);
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = scaled;
      document.head.appendChild(element);
    }

    function apply(ctx) {
      ensureStyle();

      // The tab service is published by dsh-better-sidebar, possibly AFTER this
      // plugin's own activation: reconcile on the service event instead of
      // requiring a mount order that belongs to another package.
      let current = null;
      const reconcile = () => {
        const service = ctx.get('betterSidebar');
        if (current?.service === service) return;
        current?.dispose();
        current = undefined;
        if (service === undefined) return;
        try {
          current = {
            service,
            dispose: service.registerTab({
              id: TAB_ID,
              title: () => (isZh() ? COPY.zh.tab : COPY.en.tab),
              description: () => (isZh() ? COPY.zh.tabDesc : COPY.en.tabDesc),
              icon: (size) => h(MultiRootFilesIcon, { size }),
              order: 26,
              single: true,
              component: (props) => h(MultiRootFilesTab, props)
            })
          };
        } catch (error) {
          // A duplicate registration (a reload that did not dispose) must not
          // take the whole plugin tree down.
          console.error('[dsh-multi-root-files] tab registration failed:', error);
          current = undefined;
          return;
        }
        // Registering a tab TYPE does not open it: the page only appears once
        // the layout holds it, and a restart can reset that layout.
        //
        // The open must go through DSH's OWN right column (`sidebarRight`):
        // better-sidebar's `openTab` lands in the plugin's bottom workbench,
        // which is off screen — the page has to be in the right dock where the
        // reader works.
        const openIfMissing = () => {
          try {
            const right = ctx.get?.('sidebarRight');
            if (right === undefined || typeof right.openTab !== 'function') return false;
            right.openTab(TAB_ID, { params: {} });
            return true;
          } catch (error) {
            console.warn('[dsh-multi-root-files] could not open the tab:', error);
            return true;
          }
        };
        const done = openIfMissing();
        if (!done) {
          // The host publishes the column service a moment after the plugin
          // activates; retry on that event instead of opening blind.
          const off = ctx.on?.('internal/service', (name) => {
            if (name === 'sidebarRight') openIfMissing();
          });
          current.extraDispose = () => { try { off?.(); } catch { /* gone */ } };
        }
      };

      ctx.effect(() => {
        reconcile();
        const offService = ctx.on('internal/service', (name) => {
          if (name === 'betterSidebar') reconcile();
        });
        return () => {
          offService?.();
          current?.extraDispose?.();
          current?.dispose();
          current = undefined;
          document.getElementById(STYLE_ID)?.remove();
        };
      }, 'multi-root-files: sidebar tab');
    }

    const module = { exports: { apply, name: 'dsh-multi-root-files' } };
    module.exports.__test = { isUnder, baseName, normalizeLevel };
    return module.exports;
  }
});
