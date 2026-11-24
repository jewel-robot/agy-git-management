/**
 * Antigravity Git Management Panel Frontend.
 *
 * Zero-dependency UI communicating with main.mjs via window.sidecar.fetch.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const LANE_COLORS_LIGHT = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#ea580c', '#4f46e5'];
  const LANE_COLORS_DARK = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#818cf8'];
  const getLaneColors = () =>
    document.documentElement.dataset.theme === 'dark' ? LANE_COLORS_DARK : LANE_COLORS_LIGHT;
  const POLL_ACTIVE_MS = 2200;
  const POLL_HIDDEN_MS = 8000;

  const state = {
    workspaces: [],
    repos: [],
    repo: '',
    tab: 'changes',
    etag: '',
    status: null,
    stashes: [],
    viewMode: localStorage.getItem('agy_git_view') === 'tree' ? 'tree' : 'flat',
    diffMode: localStorage.getItem('agy_git_diff_mode') === 'split' ? 'split' : 'unified',
    collapsedGroups: new Set(),
    selectedDiff: null, // { path, scope, data }
    graph: { commits: [], hasMore: false, maxCols: 1, skip: 0, loaded: false },
    selectedCommit: null,
    commitFileDiff: null,
    branches: null,
    github: { data: null, subTab: 'prs', state: 'open', loaded: false },
    timer: null,
    toastTimer: null,
    modalResolve: null,
  };

  function wsStorageKey(workspaces) {
    const key = Array.isArray(workspaces) && workspaces.length ? workspaces.slice().sort().join('|') : 'default';
    return `agy_git_repo::${key}`;
  }

  function loadSavedRepo(workspaces) {
    try {
      return localStorage.getItem(wsStorageKey(workspaces)) || '';
    } catch {
      return '';
    }
  }

  function saveRepoForWs(workspaces, repoPath) {
    try {
      if (repoPath) localStorage.setItem(wsStorageKey(workspaces), repoPath);
    } catch {}
  }

  // ---------- Host Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const nextTheme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== nextTheme) {
      document.documentElement.dataset.theme = nextTheme;
      if (state.graph?.loaded) renderGraphList();
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function showToast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', Boolean(isError));
    el.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 4200 : 2400);
  }

  function confirmModal(title, body, confirmLabel = 'Confirm') {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-body').textContent = body;
      $('modal-confirm').textContent = confirmLabel;
      $('modal-backdrop').classList.remove('hidden');
      state.modalResolve = resolve;
    });
  }

  function closeModal(result) {
    $('modal-backdrop').classList.add('hidden');
    if (state.modalResolve) {
      const fn = state.modalResolve;
      state.modalResolve = null;
      fn(result);
    }
  }

  $('modal-cancel').addEventListener('click', () => closeModal(false));
  $('modal-confirm').addEventListener('click', () => closeModal(true));
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal(false);
  });

  function sidecarFetch(url, opts) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    return f(url, opts);
  }

  async function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    if (state.workspaces.length) qs.set('workspaces', state.workspaces.join('|'));
    if (state.repo && !params.repo) qs.set('repo', state.repo);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const res = await sidecarFetch(`${path}?${qs.toString()}`, { method: 'GET' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  async function apiPost(path, body = {}) {
    const payload = {
      ...body,
      repo: body.repo || state.repo,
      workspaces: state.workspaces,
    };
    const res = await sidecarFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Operation failed');
    return json;
  }

  function openFileInHost(fileUri) {
    if (!fileUri) return;
    window.sidecar?.ui?.toggleAuxPane?.({ tabType: 'fileView', uri: fileUri });
  }

  function statusClass(st) {
    if (!st) return 'st-M';
    if (st === '?') return 'st-Q';
    if (st.length > 1 || st === 'U') return 'st-conflict';
    return `st-${st[0]}`;
  }

  function statusLetter(st) {
    if (!st) return 'M';
    if (st === '?') return 'U';
    if (st.length > 1 || st === 'U') return '!';
    return st[0];
  }

  function statusTitle(st) {
    const map = {
      '?': 'Untracked',
      M: 'Modified',
      A: 'Added',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
    };
    if (!st) return 'Modified';
    if (st.length > 1 || st === 'U') return `Conflict (${st})`;
    return map[st[0]] || st;
  }

  function getFolderIconSvg(folderLabel) {
    const seg = String(folderLabel || '').split('/').pop().toLowerCase();
    const baseFolder =
      '<path d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3.15l1.35 1.4H13A1.25 1.25 0 0 1 14.25 5.4v6.6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12V4Z" fill="none" stroke="#6b7280" stroke-width="1.3" stroke-linejoin="round"/>';
    let badge = '';
    if (seg === 'src' || seg === 'source') {
      badge =
        '<rect x="7.4" y="8.2" width="7.8" height="6.2" rx="1.2" fill="var(--bg, #fff)"/><path d="M9.6 9.8 8.1 11.3l1.5 1.5M12.9 9.8l1.5 1.5-1.5 1.5M11.7 9.4l-1 3.8" fill="none" stroke="#e07a2f" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>';
    } else if (seg === 'config' || seg === 'settings') {
      badge =
        '<circle cx="12.2" cy="11.8" r="3.1" fill="var(--bg, #fff)"/><path d="M12.2 9.4v.9M12.2 13.3v.9M9.8 11.8h.9M13.7 11.8h.9M10.5 10.1l.65.65M13.25 12.85l.65.65M13.9 10.1l-.65.65M11.15 12.85l-.65.65" stroke="#4da3f5" stroke-width="1.1" stroke-linecap="round"/><circle cx="12.2" cy="11.8" r="1.25" fill="none" stroke="#4da3f5" stroke-width="1.1"/>';
    } else if (seg === '.git') {
      badge = '<circle cx="12.4" cy="12" r="2.7" fill="var(--bg, #fff)"/><circle cx="12.4" cy="12" r="2" fill="#e06c75"/>';
    } else if (seg === '.vscode') {
      badge = '<circle cx="12.4" cy="12" r="2.7" fill="var(--bg, #fff)"/><circle cx="12.4" cy="12" r="2" fill="#5b6ee1"/>';
    } else if (seg === 'test' || seg === 'tests') {
      badge = '<circle cx="12.4" cy="12" r="2.7" fill="var(--bg, #fff)"/><circle cx="12.4" cy="12" r="2" fill="#52b788"/>';
    } else if (seg === 'doc' || seg === 'docs') {
      badge = '<circle cx="12.4" cy="12" r="2.7" fill="var(--bg, #fff)"/><circle cx="12.4" cy="12" r="2" fill="#5b8def"/>';
    }
    return `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">${baseFolder}${badge}</svg>`;
  }

  function getFileIconSvg(filePath) {
    const base = String(filePath || '').split('/').pop().toLowerCase();
    const ext = base.includes('.') ? base.split('.').pop() : '';

    // Git files (.gitignore, .gitattributes, .gitmodules) — coral rotated diamond
    if (base.startsWith('.git')) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.1" y="3.1" width="9.8" height="9.8" rx="1.6" transform="rotate(45 8 8)" fill="#e06c75"/><path d="M8 5.2v5.6M8 7.6c0-.9 1.9-.9 1.9-1.9" fill="none" stroke="#fff" stroke-width="1.25" stroke-linecap="round"/><circle cx="8" cy="5.2" r="1" fill="#fff"/><circle cx="8" cy="10.8" r="1" fill="#fff"/><circle cx="9.9" cy="5.7" r="1" fill="#fff"/></svg>';
    }
    // CMakeLists.txt / .cmake — pastel tri-color CMake triangle
    if (base === 'cmakelists.txt' || ext === 'cmake') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><polygon points="8,1.8 1.9,13.8 8.3,8.5" fill="#5b8def"/><polygon points="8,1.8 14.1,13.8 8.9,10.7" fill="#e06c75"/><polygon points="1.9,13.8 14.1,13.8 6.7,10.3" fill="#57b875"/><polygon points="8,7.3 6.7,10.3 9.3,10.3" fill="var(--surface, #fff)"/></svg>';
    }
    // Markdown (.md / .mdx) — compact cornflower-blue M↓
    if (ext === 'md' || ext === 'mdx') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 10.9V5.4l2.3 2.7 2.3-2.7v5.5M11.8 5.3v5.1m-1.7-1.8 1.7 1.9 1.7-1.9" fill="none" stroke="#5b8def" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // C++ source (.cpp/.cc/.cxx/.cu) — crisp sky-blue C++
    if (['cpp', 'cc', 'cxx', 'cu'].includes(ext)) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M7.2 10.35a3.05 3.05 0 1 1 0-4.7" fill="none" stroke="#529ef0" stroke-width="1.65" stroke-linecap="round"/><path d="M8.7 8h2.6M10 6.7v2.6M12.2 8h2.6M13.5 6.7v2.6" stroke="#529ef0" stroke-width="1.3" stroke-linecap="round"/></svg>';
    }
    // C/C++ header (.h/.hpp/.hh/.hxx) — exact Antigravity lowercase sky-blue h
    if (['h', 'hpp', 'hh', 'hxx', 'cuh'].includes(ext)) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 3.4v9.2M5.4 8.2c.6-1.2 1.55-1.75 2.7-1.75 1.45 0 2.35.95 2.35 2.45v3.7" fill="none" stroke="#529ef0" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // C source (.c) — sky-blue C
    if (ext === 'c') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 10.6a3.7 3.7 0 1 1 0-5.2" fill="none" stroke="#529ef0" stroke-width="1.75" stroke-linecap="round"/></svg>';
    }
    // YAML (.yaml/.yml) — exact Antigravity soft lavender-violet Y
    if (ext === 'yml' || ext === 'yaml') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.2 8 8.7l3.4-4.5M8 8.7v3.7" fill="none" stroke="#857ef2" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // ROS .launch — minimalist rocket icon
    if (ext === 'launch') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#e07a2f" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 6.2 6.2 9.8M13.5 2.5c-2.8.1-5.2 1.2-7.1 3.1L4.6 7.4l4 4 1.8-1.8c1.9-1.9 3-4.3 3.1-7.1Z"/><path d="M5.4 6.6 3.2 7l-.7 2.2 2.1.6M9.4 10.6l-.4 2.2-2.2.7-.6-2.1"/><circle cx="10.2" cy="5.8" r="0.9" fill="#e07a2f" stroke="none"/></svg>';
    }
    // .cfg (dynamic_reconfigure / parameter config) — sleek tuning sliders icon
    if (ext === 'cfg' || ext === 'conf' || ext === 'ini' || ext === 'toml') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#2aa89b" stroke-width="1.45" stroke-linecap="round" aria-hidden="true"><path d="M2.5 5.2h11M2.5 10.8h11"/><circle cx="6.2" cy="5.2" r="1.7" fill="var(--surface, #fff)"/><circle cx="10.4" cy="10.8" r="1.7" fill="var(--surface, #fff)"/></svg>';
    }
    // XML (.xml) — exact Antigravity warm orange RSS/XML wave mark
    if (ext === 'xml') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.8" cy="12.2" r="1.45" fill="#e07a2f"/><path d="M2.6 7.8a5.6 5.6 0 0 1 5.6 5.6M2.6 3.8a9.6 9.6 0 0 1 9.6 9.6" fill="none" stroke="#e07a2f" stroke-width="1.65" stroke-linecap="round"/></svg>';
    }
    // Python (.py/.pyi/.pyw) — airy dual-tone Python emblem
    if (ext === 'py' || ext === 'pyi' || ext === 'pyw') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M7.9 2c-2.35 0-2.15 1.05-2.15 1.05v1.4h2.85V5H4.4S2.3 4.8 2.3 7.3s1.7 2.35 1.7 2.35h1V8.45S4.95 6.75 6.7 6.75h2.75s1.5 0 1.5-1.45V3.5s.2-1.5-3.05-1.5Z" fill="#529ef0"/><path d="M8.1 14c2.35 0 2.15-1.05 2.15-1.05v-1.4H7.4V11h4.2s2.1.2 2.1-2.3-1.7-2.35-1.7-2.35h-1v1.2s.05 1.7-1.7 1.7H6.55s-1.5 0-1.5 1.45v1.8s-.2 1.5 3.05 1.5Z" fill="#e5be53"/><circle cx="6.7" cy="3.5" r=".58" fill="#fff"/><circle cx="9.3" cy="12.5" r=".58" fill="#fff"/></svg>';
    }
    // HTML / SVG / URDF / XACRO — warm orange angle brackets
    if (['html', 'htm', 'svg', 'urdf', 'xacro'].includes(ext)) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1 4.6 2 8l3.1 3.4M10.9 4.6 14 8l-3.1 3.4M9.1 3.8l-2.2 8.4" fill="none" stroke="#e07a2f" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // JSON — warm gold curly braces
    if (ext === 'json' || ext === 'jsonc') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.2c-1.1 0-1.4.6-1.4 1.5v1.7c0 .7-.5 1.3-1.2 1.6.7.3 1.2.9 1.2 1.6v1.7c0 .9.3 1.5 1.4 1.5M10 3.2c1.1 0 1.4.6 1.4 1.5v1.7c0 .7.5 1.3 1.2 1.6-.7.3-1.2.9-1.2 1.6v1.7c0 .9-.3 1.5-1.4 1.5" fill="none" stroke="#d9a441" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // Shell / Makefile — mint-green prompt
    if (['sh', 'bash', 'zsh'].includes(ext) || base === 'makefile' || ext === 'mk') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 5.2 3.2 2.8L3 10.8M7.6 11h5.2" fill="none" stroke="#4caf7d" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    // JS / TS
    if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.2" fill="#e5be53"/><path d="M6.6 6.2v4.1c0 .9-.5 1.4-1.3 1.4-.5 0-.9-.2-1.1-.5M11.4 6.8c-.3-.4-.8-.6-1.4-.6-.9 0-1.4.4-1.4 1.1 0 .7.5 1 1.4 1.2.9.2 1.5.5 1.5 1.4 0 .9-.7 1.5-1.7 1.5-.8 0-1.4-.3-1.8-.8" fill="none" stroke="#1e293b" stroke-width="1.25" stroke-linecap="round"/></svg>';
    }
    if (['ts', 'tsx'].includes(ext)) {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.2" fill="#529ef0"/><path d="M4 6.4h3.8M5.9 6.4v5.1M11.8 7c-.3-.4-.8-.6-1.4-.6-.8 0-1.3.4-1.3 1 0 .6.4.9 1.3 1.1.9.2 1.4.6 1.4 1.4 0 .9-.6 1.5-1.6 1.5-.7 0-1.3-.3-1.7-.7" fill="none" stroke="#fff" stroke-width="1.25" stroke-linecap="round"/></svg>';
    }
    // CSS
    if (ext === 'css' || ext === 'scss') {
      return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.2 4.9 12.8M11.1 3.2 9.8 12.8M3 6.1h10M2.6 9.9h10" fill="none" stroke="#529ef0" stroke-width="1.4" stroke-linecap="round"/></svg>';
    }
    // Default / .cfg / .launch / .clang-format — exact Antigravity slate folded-corner document
    return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 2.2h5.4l3.4 3.4v8.2H3.6V2.2Z" fill="none" stroke="#6b7280" stroke-width="1.35" stroke-linejoin="round"/><path d="M8.8 2.2v3.6h3.6" fill="none" stroke="#6b7280" stroke-width="1.35" stroke-linejoin="round"/></svg>';
  }

  function splitPath(p) {
    const idx = p.lastIndexOf('/');
    if (idx === -1) return { base: p, dir: '' };
    return { base: p.slice(idx + 1), dir: p.slice(0, idx) };
  }

  // ---------- Status & Header ----------
  function closeRepoMenu() {
    $('repo-menu').classList.add('hidden');
    $('repo-trigger').setAttribute('aria-expanded', 'false');
  }

  function renderReposSelect(repos) {
    state.repos = repos || [];
    const labelEl = $('repo-trigger-label');
    const menuEl = $('repo-menu');
    const prev = state.repo;
    if (!state.repos.length) {
      labelEl.textContent = 'No repository';
      menuEl.innerHTML = '';
      $('no-repo').classList.remove('hidden');
      $('content').classList.add('hidden');
      return;
    }
    $('no-repo').classList.add('hidden');
    $('content').classList.remove('hidden');

    if (!state.repos.some((r) => r.path === prev)) {
      state.repo = state.repos[0].path;
      saveRepoForWs(state.workspaces, state.repo);
    }

    const active = state.repos.find((r) => r.path === state.repo) || state.repos[0];
    labelEl.textContent = active.label;

    menuEl.innerHTML = state.repos
      .map((r) => {
        const isAct = r.path === state.repo;
        return `
          <button type="button" class="dd-item ${isAct ? 'active' : ''}" role="option" aria-selected="${isAct}" data-select-repo="${esc(r.path)}">
            <span class="dd-item-left">
              <svg class="dd-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-6.5"/></svg>
              <span class="dd-item-name" title="${esc(r.path)}">${esc(r.label)}</span>
            </span>
            <span class="dd-item-branch">${esc(r.branch)}</span>
          </button>`;
      })
      .join('');
  }

  function renderHeader(st) {
    $('branch-name').textContent = st.branch || '(detached)';
    $('tab-changes-count').textContent = String(st.totalChanges || 0);

    const op = $('op-badge');
    if (st.operationState) {
      op.textContent = st.operationState;
      op.classList.remove('hidden');
    } else {
      op.classList.add('hidden');
    }

    const ab = $('ab-badge');
    if (st.ahead > 0 || st.behind > 0) {
      const parts = [];
      if (st.ahead > 0) parts.push(`↑${st.ahead}`);
      if (st.behind > 0) parts.push(`↓${st.behind}`);
      ab.textContent = parts.join(' ');
      ab.classList.remove('hidden');
    } else {
      ab.classList.add('hidden');
    }

    $('upstream-name').textContent = st.upstream ? `→ ${st.upstream}` : 'no upstream';
  }

  // ---------- Changes View ----------
  function buildFileTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      node.files.push(f);
    }
    return root;
  }

  function renderFileRowHtml(f, groupScope, indentPx = 0) {
    const { base, dir } = splitPath(f.path);
    const isSelected =
      state.selectedDiff &&
      state.selectedDiff.path === f.path &&
      state.selectedDiff.scope === groupScope;
    const statsHtml =
      f.binary
        ? '<span class="file-stats">bin</span>'
        : f.additions || f.deletions
          ? `<span class="file-stats">${f.additions ? `<span class="stat-add">+${f.additions}</span>` : ''}${f.deletions ? `<span class="stat-del">-${f.deletions}</span>` : ''}</span>`
          : '';

    const actions = [];
    if (groupScope === 'staged') {
      actions.push(`<button type="button" class="mini-btn" data-act="unstage" data-path="${esc(f.path)}" title="Unstage">&minus;</button>`);
    } else {
      actions.push(`<button type="button" class="mini-btn" data-act="stage" data-path="${esc(f.path)}" title="Stage">+</button>`);
      actions.push(`<button type="button" class="mini-btn danger" data-act="discard" data-path="${esc(f.path)}" data-scope="${esc(groupScope)}" title="Discard changes">&#x21BA;</button>`);
    }
    if (f.fileUri && f.status !== 'D') {
      actions.push(`<button type="button" class="mini-btn" data-act="open" data-uri="${esc(f.fileUri)}" title="Open file in Antigravity">&#x2197;</button>`);
    }

    const dirDisplay = state.viewMode === 'flat' && dir ? `<span class="file-dir">${esc(dir)}</span>` : '';
    return `
      <div class="file-row ${isSelected ? 'selected' : ''}" data-diff-path="${esc(f.path)}" data-diff-scope="${esc(groupScope)}" style="padding-left:${6 + indentPx}px">
        <span class="file-icon">${getFileIconSvg(f.path)}</span>
        <div class="file-name-wrap">
          <span class="file-base ${f.status === 'D' ? 'is-deleted' : ''}" title="${esc(f.path)}">${esc(base)}</span>
          ${dirDisplay}
        </div>
        ${statsHtml}
        <div class="row-actions">${actions.join('')}</div>
        <span class="st-badge ${statusClass(f.status)}" title="${esc(statusTitle(f.status))}">${esc(statusLetter(f.status))}</span>
      </div>`;
  }

  function renderTreeNodes(node, groupScope, depth = 0) {
    let html = '';
    const dirNames = Array.from(node.dirs.keys()).sort();
    for (const d of dirNames) {
      let label = d;
      let child = node.dirs.get(d);
      // Compress single-child folder chains
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [nextKey, nextChild] = child.dirs.entries().next().value;
        label += '/' + nextKey;
        child = nextChild;
      }
      html += `<div class="tree-folder" style="padding-left:${6 + depth * 12}px">${getFolderIconSvg(label)}<span>${esc(label)}</span></div>`;
      html += renderTreeNodes(child, groupScope, depth + 1);
    }
    for (const f of node.files) {
      html += renderFileRowHtml(f, groupScope, depth * 12);
    }
    return html;
  }

  const GROUP_CHEV_SVG =
    '<svg class="group-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6 3.5 4 3.5-4"/></svg>';

  function renderGroup(groupKey, title, files, groupScope, headActionsHtml = '') {
    if (!files.length) return '';
    const isCollapsed = state.collapsedGroups.has(groupKey);
    const bodyHtml =
      state.viewMode === 'tree'
        ? renderTreeNodes(buildFileTree(files), groupScope, 0)
        : files.map((f) => renderFileRowHtml(f, groupScope, 0)).join('');
    return `
      <div class="group-block ${isCollapsed ? 'collapsed' : ''}" data-group-key="${esc(groupKey)}">
        <div class="group-head" data-toggle-group="${esc(groupKey)}" role="button" aria-expanded="${!isCollapsed}" title="Click to ${isCollapsed ? 'expand' : 'collapse'}">
          <div class="group-head-left">
            ${GROUP_CHEV_SVG}
            <span>${esc(title)}</span>
            <span class="count-pill num">${files.length}</span>
          </div>
          <div class="group-head-actions">${headActionsHtml}</div>
        </div>
        <div class="group-items">${bodyHtml}</div>
      </div>`;
  }

  function renderChanges(st) {
    const wrap = $('changes-lists');
    if (!st.totalChanges) {
      wrap.innerHTML = `<div class="empty-state" style="padding:18px 8px"><div class="empty-title">Working tree clean</div><div class="empty-sub">No uncommitted changes on ${esc(st.branch)}.</div></div>`;
    } else {
      const html = [
        renderGroup('conflicts', 'Merge Conflicts', st.conflicts, 'unstaged'),
        renderGroup(
          'staged',
          'Staged Changes',
          st.staged,
          'staged',
          '<button type="button" class="btn btn-ghost btn-xs" data-bulk="unstage-all">Unstage All</button>'
        ),
        renderGroup(
          'unstaged',
          'Changes',
          st.unstaged,
          'unstaged',
          '<button type="button" class="btn btn-ghost btn-xs" data-bulk="stage-unstaged">Stage</button><button type="button" class="btn btn-ghost btn-xs" data-bulk="discard-unstaged">Discard</button>'
        ),
        renderGroup(
          'untracked',
          'Untracked',
          st.untracked,
          'untracked',
          '<button type="button" class="btn btn-ghost btn-xs" data-bulk="stage-untracked">Stage</button>'
        ),
      ].join('');
      wrap.innerHTML = html;
    }

    // Stashes
    $('stashes-count').textContent = String(state.stashes.length);
    const sl = $('stashes-list');
    if (!state.stashes.length) {
      sl.innerHTML = '<div class="muted-note" style="padding:4px 6px">No stashes saved.</div>';
    } else {
      sl.innerHTML = state.stashes
        .map(
          (s) => `
          <div class="stash-row">
            <div class="stash-meta">
              <div class="stash-msg" title="${esc(s.message)}">${esc(s.message)}</div>
              <div class="stash-sub mono">${esc(s.ref)} · ${esc(s.relDate)}</div>
            </div>
            <div class="stash-btns">
              <button type="button" class="btn btn-ghost btn-xs" data-stash-act="apply" data-ref="${esc(s.ref)}">Apply</button>
              <button type="button" class="btn btn-ghost btn-xs" data-stash-act="pop" data-ref="${esc(s.ref)}">Pop</button>
              <button type="button" class="btn btn-ghost btn-xs" data-stash-act="drop" data-ref="${esc(s.ref)}" style="color:var(--c-del)">Drop</button>
            </div>
          </div>`
        )
        .join('');
    }

    $('btn-view-flat').classList.toggle('on', state.viewMode === 'flat');
    $('btn-view-tree').classList.toggle('on', state.viewMode === 'tree');
  }

  // ---------- Lightweight Syntax Highlighter ----------
  const LANG_KEYWORDS = {
    c: new Set([
      'auto','break','case','catch','class','const','constexpr','consteval','constinit','continue',
      'default','delete','do','else','enum','explicit','export','extern','for','friend','goto',
      'if','inline','mutable','namespace','new','noexcept','operator','override','final','private',
      'protected','public','register','return','sizeof','static','static_assert','static_cast',
      'dynamic_cast','reinterpret_cast','const_cast','struct','switch','template','this','throw',
      'try','typedef','typeid','typename','union','using','virtual','volatile','while','co_await',
      'co_return','co_yield','concept','requires',
    ]),
    js: new Set([
      'async','await','break','case','catch','class','const','continue','debugger','default',
      'delete','do','else','enum','export','extends','finally','for','from','function','get',
      'if','implements','import','in','instanceof','interface','let','new','of','package',
      'private','protected','public','return','set','static','super','switch','this','throw',
      'try','type','typeof','var','void','while','with','yield','as','readonly','declare',
    ]),
    py: new Set([
      'and','as','assert','async','await','break','class','continue','def','del','elif','else',
      'except','finally','for','from','global','if','import','in','is','lambda','nonlocal',
      'not','or','pass','raise','return','try','while','with','yield','match','case',
    ]),
    go: new Set([
      'break','case','chan','const','continue','default','defer','else','fallthrough','for',
      'func','go','goto','if','import','interface','map','package','range','return','select',
      'struct','switch','type','var',
    ]),
    rs: new Set([
      'as','async','await','break','const','continue','crate','dyn','else','enum','extern',
      'fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return',
      'self','Self','static','struct','super','trait','type','unsafe','use','where','while',
    ]),
    sh: new Set([
      'if','then','else','elif','fi','for','in','do','done','while','until','case','esac',
      'function','return','local','export','readonly','unset','shift','exit','trap',
    ]),
    cmake: new Set([
      'if','elseif','else','endif','foreach','endforeach','while','endwhile','function',
      'endfunction','macro','endmacro','set','unset','option','project','cmake_minimum_required',
      'find_package','add_library','add_executable','target_link_libraries','target_include_directories',
      'target_compile_options','include','install','message','list','string','file',
    ]),
  };

  const LANG_TYPES = new Set([
    'void','bool','char','short','int','long','float','double','signed','unsigned','wchar_t',
    'size_t','ssize_t','ptrdiff_t','int8_t','int16_t','int32_t','int64_t','uint8_t','uint16_t',
    'uint32_t','uint64_t','string','wstring','vector','map','unordered_map','set','unordered_set',
    'pair','tuple','optional','variant','shared_ptr','unique_ptr','weak_ptr','array','deque',
    'true','false','nullptr','NULL','None','True','False','undefined','null','NaN','Infinity',
    'str','bytes','dict','list','int','float','bool','i8','i16','i32','i64','u8','u16','u32',
    'u64','usize','isize','f32','f64','Option','Result','Vec','String','Box','Arc','Rc',
    'number','boolean','any','unknown','never','Promise','Record','Array','Map','Set','Error',
  ]);

  function detectLang(filePath) {
    if (!filePath) return 'plain';
    const base = filePath.split('/').pop().toLowerCase();
    if (base === 'cmakelists.txt' || base.endsWith('.cmake')) return 'cmake';
    if (base === 'makefile' || base.endsWith('.mk')) return 'sh';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    if (['c','h','cc','hh','cpp','hpp','cxx','hxx','cu','cuh','ino','java','cs'].includes(ext)) return 'c';
    if (['js','mjs','cjs','jsx','ts','tsx'].includes(ext)) return 'js';
    if (['py','pyw','pyi'].includes(ext)) return 'py';
    if (ext === 'go') return 'go';
    if (ext === 'rs') return 'rs';
    if (['sh','bash','zsh'].includes(ext)) return 'sh';
    if (ext === 'json' || ext === 'jsonc') return 'json';
    if (['yml','yaml','toml','ini','cfg','conf'].includes(ext)) return 'yaml';
    if (['xml','html','htm','svg','launch','urdf','xacro'].includes(ext)) return 'xml';
    if (ext === 'css' || ext === 'scss') return 'css';
    return 'plain';
  }

  function highlightLine(rawInput, lang) {
    const raw = typeof rawInput === 'string' ? rawInput.replace(/\r$/, '') : '';
    if (!raw || lang === 'plain') return esc(raw);

    if (lang === 'xml') {
      const re = /(<!--[\s\S]*?-->|<\/?[A-Za-z_][\w:.-]*|\/?>|"[^"]*"|'[^']*'|\b[A-Za-z_][\w:.-]*(?==))/g;
      let out = '';
      let last = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > last) out += esc(raw.slice(last, m.index));
        const t = m[0];
        if (t.startsWith('<!--')) out += `<span class="tok-cmt">${esc(t)}</span>`;
        else if (t.startsWith('<') || t.endsWith('>')) out += `<span class="tok-kw">${esc(t)}</span>`;
        else if (t.startsWith('"') || t.startsWith("'")) out += `<span class="tok-str">${esc(t)}</span>`;
        else out += `<span class="tok-type">${esc(t)}</span>`;
        last = re.lastIndex;
      }
      if (last < raw.length) out += esc(raw.slice(last));
      return out;
    }

    if (lang === 'json') {
      const re = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\/\/[^\r\n]*)/g;
      let out = '';
      let last = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > last) out += esc(raw.slice(last, m.index));
        const t = m[0];
        if (t.startsWith('//')) out += `<span class="tok-cmt">${esc(t)}</span>`;
        else if (t.startsWith('"')) {
          const isKey = /^\s*:/.test(raw.slice(re.lastIndex));
          out += `<span class="${isKey ? 'tok-fn' : 'tok-str'}">${esc(t)}</span>`;
        } else if (/^(?:true|false|null)$/.test(t)) out += `<span class="tok-kw">${esc(t)}</span>`;
        else out += `<span class="tok-num">${esc(t)}</span>`;
        last = re.lastIndex;
      }
      if (last < raw.length) out += esc(raw.slice(last));
      return out;
    }

    if (lang === 'yaml') {
      const re = /(#[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^\s*[A-Za-z0-9_.-]+(?=\s*:)|\b(?:true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b)/g;
      let out = '';
      let last = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > last) out += esc(raw.slice(last, m.index));
        const t = m[0];
        if (t.startsWith('#')) out += `<span class="tok-cmt">${esc(t)}</span>`;
        else if (t.startsWith('"') || t.startsWith("'")) out += `<span class="tok-str">${esc(t)}</span>`;
        else if (/^\s*[A-Za-z0-9_.-]+$/.test(t) && /^\s*:/.test(raw.slice(re.lastIndex))) out += `<span class="tok-fn">${esc(t)}</span>`;
        else if (/^(?:true|false|null|yes|no)$/i.test(t)) out += `<span class="tok-kw">${esc(t)}</span>`;
        else out += `<span class="tok-num">${esc(t)}</span>`;
        last = re.lastIndex;
      }
      if (last < raw.length) out += esc(raw.slice(last));
      return out;
    }

    const hashComment = lang === 'py' || lang === 'sh' || lang === 'cmake';
    const kwSet = LANG_KEYWORDS[lang] || LANG_KEYWORDS.c;
    const re = hashComment
      ? /(#[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z_]\w*|\b0[xX][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b[A-Za-z_]\w*\b)/g
      : /(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|^\s*#\s*[a-zA-Z_]\w*|@[A-Za-z_]\w*|\b0[xX][0-9a-fA-F_']+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*\b|\b[A-Za-z_]\w*(?=\s*::)|\b[A-Za-z_]\w*\b)/g;

    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) out += esc(raw.slice(last, m.index));
      const t = m[0];
      const nextSlice = raw.slice(re.lastIndex);
      if (t.startsWith('//') || t.startsWith('/*') || (hashComment && t.startsWith('#'))) {
        out += `<span class="tok-cmt">${esc(t)}</span>`;
      } else if (t.startsWith('"') || t.startsWith("'") || t.startsWith('`')) {
        out += `<span class="tok-str">${esc(t)}</span>`;
      } else if (t.trimStart().startsWith('#') || t.startsWith('@')) {
        out += `<span class="tok-pre">${esc(t)}</span>`;
      } else if (/^\d/.test(t)) {
        out += `<span class="tok-num">${esc(t)}</span>`;
      } else if (/^\s*::/.test(nextSlice)) {
        out += `<span class="tok-ns">${esc(t)}</span>`;
      } else if (kwSet.has(lang === 'cmake' ? t.toLowerCase() : t)) {
        out += `<span class="tok-kw">${esc(t)}</span>`;
      } else if (LANG_TYPES.has(t)) {
        out += `<span class="tok-type">${esc(t)}</span>`;
      } else if (/^\s*(?:<[^>]{1,32}>)?\s*\(/.test(nextSlice)) {
        out += `<span class="tok-fn">${esc(t)}</span>`;
      } else if (/^[A-Z][A-Za-z0-9_]*$/.test(t) && !/^[A-Z0-9_]+$/.test(t)) {
        out += `<span class="tok-type">${esc(t)}</span>`;
      } else {
        out += esc(t);
      }
      last = re.lastIndex;
    }
    if (last < raw.length) out += esc(raw.slice(last));
    return out;
  }

  // ---------- Diff Renderer (Unified & Split + Hunk Actions) ----------
  function renderUnifiedHunk(hunk, lang) {
    const rows = hunk.lines
      .map((l) => {
        const cls = l.type === 'add' ? 'd-add' : l.type === 'del' ? 'd-del' : l.type === 'meta' ? 'd-meta' : '';
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        const codeHtml = l.type === 'meta' ? esc(l.content) : highlightLine(l.content, lang);
        return `<tr class="${cls}">
          <td class="diff-ln num">${l.oldLine ?? ''}</td>
          <td class="diff-ln num">${l.newLine ?? ''}</td>
          <td class="diff-sign">${sign}</td>
          <td class="diff-code">${codeHtml}</td>
        </tr>`;
      })
      .join('');
    return `<table class="diff-table"><tbody>${rows}</tbody></table>`;
  }

  function renderSplitHunk(hunk, lang) {
    const pairs = [];
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.type === 'ctx' || l.type === 'meta') {
        pairs.push([l, l]);
        i++;
      } else if (l.type === 'del') {
        const dels = [];
        const adds = [];
        while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
        while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
        const max = Math.max(dels.length, adds.length);
        for (let k = 0; k < max; k++) {
          pairs.push([dels[k] || null, adds[k] || null]);
        }
      } else if (l.type === 'add') {
        pairs.push([null, l]);
        i++;
      } else {
        i++;
      }
    }

    const rows = pairs
      .map(([left, right]) => {
        const lCls = left?.type === 'del' ? 'split-cell-del' : '';
        const rCls = right?.type === 'add' ? 'split-cell-add' : '';
        const lHtml = left ? (left.type === 'meta' ? esc(left.content) : highlightLine(left.content, lang)) : '';
        const rHtml = right ? (right.type === 'meta' ? esc(right.content) : highlightLine(right.content, lang)) : '';
        return `<tr>
          <td class="diff-ln num ${lCls}">${left?.oldLine ?? ''}</td>
          <td class="diff-code ${lCls}">${lHtml}</td>
          <td class="diff-ln num split-sep ${rCls}">${right?.newLine ?? ''}</td>
          <td class="diff-code ${rCls}">${rHtml}</td>
        </tr>`;
      })
      .join('');
    return `<table class="diff-table split-table"><tbody>${rows}</tbody></table>`;
  }

  function renderHunksHtml(diff, { allowHunkActions = false, scope = 'unstaged' } = {}) {
    if (diff.binary) return '<div class="muted-note" style="padding:10px">Binary file diff not shown.</div>';
    if (diff.empty || !diff.hunks?.length) return '<div class="muted-note" style="padding:10px">No diff content.</div>';
    const lang = detectLang(diff.path || '');
    return diff.hunks
      .map((hunk, idx) => {
        let btns = '';
        if (allowHunkActions && hunk.patch) {
          if (scope === 'staged') {
            btns = `<button type="button" class="btn btn-ghost btn-xs" data-hunk-act="unstage" data-hunk-idx="${idx}">Unstage Hunk</button>`;
          } else if (scope === 'unstaged') {
            btns = `
              <button type="button" class="btn btn-ghost btn-xs" data-hunk-act="stage" data-hunk-idx="${idx}">Stage Hunk</button>
              <button type="button" class="btn btn-ghost btn-xs" data-hunk-act="discard" data-hunk-idx="${idx}" style="color:var(--c-del)">Discard</button>`;
          }
        }
        const table = state.diffMode === 'split' ? renderSplitHunk(hunk, lang) : renderUnifiedHunk(hunk, lang);
        return `
          <div class="hunk-block">
            <div class="hunk-head">
              <span class="hunk-header-text">${esc(hunk.header)}</span>
              <div class="hunk-actions">${btns}</div>
            </div>
            ${table}
          </div>`;
      })
      .join('');
  }

  function renderDiffPane() {
    const pane = $('diff-pane');
    if (!state.selectedDiff) {
      pane.classList.add('hidden');
      return;
    }
    const { path, scope, data } = state.selectedDiff;
    pane.classList.remove('hidden');
    $('diff-scope-tag').textContent = scope;
    $('diff-file-path').textContent = path;
    $('btn-diff-unified').classList.toggle('on', state.diffMode === 'unified');
    $('btn-diff-split').classList.toggle('on', state.diffMode === 'split');
    $('diff-body').innerHTML = renderHunksHtml(data, { allowHunkActions: scope !== 'untracked', scope });
  }

  async function openDiff(path, scope) {
    try {
      const res = await apiGet('/api/diff', { path, scope });
      state.selectedDiff = { path, scope, data: res.diff };
      renderDiffPane();
      if (state.status) renderChanges(state.status);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ---------- Graph View & Subway-Arc Continuous SVG ----------
  const GRAPH_ROW_H = 30;
  const GRAPH_COL_W = 14;
  const GRAPH_PAD_X = 13;

  const REF_HEAD_ICON =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>';
  const REF_REMOTE_ICON =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.8 12.5h6.9a2.8 2.8 0 0 0 .5-5.55A4.1 4.1 0 0 0 4.3 5.9a3.1 3.1 0 0 0 .5 6.6Z"/></svg>';
  const REF_TAG_ICON =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8.5V3.5a1 1 0 0 1 1-1h5l5 5-5 5-5-5Z"/><circle cx="5.5" cy="5.5" r="0.8" fill="currentColor" stroke="none"/></svg>';

  function computeContinuousGraph(commits) {
    const activeLanes = [];
    const openEdges = [];
    const edges = [];
    const nodes = [];
    let nextColor = 0;
    const PALETTE_SIZE = 8;

    const allocColor = () => nextColor++ % PALETTE_SIZE;
    const findFreeCol = () => {
      const idx = activeLanes.findIndex((l) => l === null);
      if (idx !== -1) return idx;
      activeLanes.push(null);
      return activeLanes.length - 1;
    };
    const trimNulls = () => {
      while (activeLanes.length && activeLanes[activeLanes.length - 1] === null) {
        activeLanes.pop();
      }
    };

    let maxCols = 1;

    for (let row = 0; row < commits.length; row++) {
      const c = commits[row];
      const matchingCols = [];
      for (let i = 0; i < activeLanes.length; i++) {
        if (activeLanes[i] && activeLanes[i].hash === c.hash) matchingCols.push(i);
      }

      let col;
      let color;
      if (matchingCols.length > 0) {
        col = matchingCols[0];
        color = activeLanes[col].color;
        for (const mc of matchingCols) {
          if (mc !== col) activeLanes[mc] = null;
        }
      } else {
        col = findFreeCol();
        color = allocColor();
        activeLanes[col] = { hash: c.hash, color };
      }

      for (let ei = openEdges.length - 1; ei >= 0; ei--) {
        if (openEdges[ei].toHash === c.hash) {
          const e = openEdges.splice(ei, 1)[0];
          edges.push({ ...e, toRow: row, toCol: col });
        }
      }

      const isHead = (c.refs || []).some((r) => r.type === 'head');
      nodes.push({ row, col, color, isMerge: Boolean(c.isMerge), isHead });

      const parents = c.parents || [];
      if (parents.length === 0) {
        activeLanes[col] = null;
      } else {
        const p0 = parents[0];
        const existingP0 = activeLanes.findIndex((l, i) => i !== col && l && l.hash === p0);
        if (existingP0 !== -1) {
          openEdges.push({ fromRow: row, fromCol: col, railCol: existingP0, toHash: p0, color });
          activeLanes[col] = null;
        } else {
          activeLanes[col] = { hash: p0, color };
          openEdges.push({ fromRow: row, fromCol: col, railCol: col, toHash: p0, color });
        }

        for (let pi = 1; pi < parents.length; pi++) {
          const p = parents[pi];
          const existing = activeLanes.findIndex((l) => l && l.hash === p);
          if (existing !== -1) {
            openEdges.push({
              fromRow: row,
              fromCol: col,
              railCol: existing,
              toHash: p,
              color: activeLanes[existing].color,
            });
          } else {
            const newCol = findFreeCol();
            const newColor = allocColor();
            activeLanes[newCol] = { hash: p, color: newColor };
            openEdges.push({ fromRow: row, fromCol: col, railCol: newCol, toHash: p, color: newColor });
          }
        }
      }

      trimNulls();
      maxCols = Math.max(maxCols, col + 1, activeLanes.length);
    }

    for (const e of openEdges) {
      edges.push({ ...e, toRow: commits.length, toCol: e.railCol, dangling: true });
      maxCols = Math.max(maxCols, e.railCol + 1);
    }

    // Compute exact rightmost occupied column per row so text hugs its own rails tightly
    const rowMaxCol = nodes.map((n) => Math.min(n.col, 9));
    for (const e of edges) {
      const fCol = Math.min(e.fromCol, 9);
      const rCol = Math.min(e.railCol, 9);
      const tCol = Math.min(e.toCol, 9);
      if (e.fromRow < commits.length) {
        rowMaxCol[e.fromRow] = Math.max(rowMaxCol[e.fromRow], fCol, rCol);
      }
      const endRow = Math.min(e.toRow, commits.length - 1);
      for (let r = e.fromRow + 1; r < endRow; r++) {
        rowMaxCol[r] = Math.max(rowMaxCol[r], rCol);
      }
      if (!e.dangling && e.toRow < commits.length) {
        rowMaxCol[e.toRow] = Math.max(rowMaxCol[e.toRow], rCol, tCol);
      } else if (e.dangling && commits.length > 0) {
        const last = commits.length - 1;
        if (last >= e.fromRow) rowMaxCol[last] = Math.max(rowMaxCol[last], rCol);
      }
    }

    return { nodes, edges, rowMaxCol, maxCols: Math.min(Math.max(maxCols, 1), 10) };
  }

  function buildEdgePath(e, cx, cy) {
    const x1 = cx(e.fromCol);
    const y1 = cy(e.fromRow);
    const xr = cx(e.railCol);
    const x2 = cx(e.toCol);
    const y2 = e.dangling ? e.toRow * GRAPH_ROW_H : cy(e.toRow);

    // Pure straight vertical rail
    if (x1 === xr && xr === x2) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    // Subway-style quarter-circle elbow helper:
    // Smooth horizontal-departure / vertical-arrival OR vertical-departure / horizontal-arrival
    const drawMetroJoin = (sx, sy, tx, ty, exitHorizontal) => {
      const dx = tx - sx;
      const dy = ty - sy;
      const adx = Math.abs(dx);
      const dir = dx > 0 ? 1 : -1;
      const r = Math.min(9.5, adx * 0.5, dy * 0.45);
      if (adx <= GRAPH_COL_W + 1) {
        // Adjacent lane: silky symmetric S-curve
        const c = dy * 0.52;
        return `M ${sx} ${sy} C ${sx} ${sy + c}, ${tx} ${ty - c}, ${tx} ${ty}`;
      }
      if (exitHorizontal) {
        // Branch out from node horizontally, curve smoothly down into vertical rail
        return `M ${sx} ${sy} L ${tx - dir * r} ${sy} Q ${tx} ${sy} ${tx} ${sy + r} L ${tx} ${ty}`;
      }
      // Ride vertical rail down, curve cleanly with a quarter-circle into target node
      return `M ${sx} ${sy} L ${sx} ${ty - r} Q ${sx} ${ty} ${sx + dir * r} ${ty} L ${tx} ${ty}`;
    };

    // Single-row jump
    if (!e.dangling && e.toRow - e.fromRow === 1) {
      // Branching right (merge out to secondary parent): exit horizontally into right rail
      // Converging left (branch joining main trunk): ride down and quarter-circle left into trunk node
      return drawMetroJoin(x1, y1, x2, y2, x2 > x1);
    }

    const segs = [];
    let curX = x1;
    let curY = y1;

    // Top turn: x1 -> xr
    if (x1 !== xr) {
      const dx = xr - x1;
      const dir = dx > 0 ? 1 : -1;
      const adx = Math.abs(dx);
      const r = Math.min(9.5, adx * 0.5, GRAPH_ROW_H * 0.46);
      if (adx <= GRAPH_COL_W + 1) {
        const yEnd = Math.min(y1 + GRAPH_ROW_H * 0.85, y2);
        const c = (yEnd - y1) * 0.52;
        segs.push(`M ${x1} ${y1} C ${x1} ${y1 + c}, ${xr} ${yEnd - c}, ${xr} ${yEnd}`);
        curY = yEnd;
      } else {
        // Smooth horizontal metro branch-out at y1 into rail xr
        segs.push(`M ${x1} ${y1} L ${xr - dir * r} ${y1} Q ${xr} ${y1} ${xr} ${y1 + r}`);
        curY = y1 + r;
      }
      curX = xr;
    } else {
      segs.push(`M ${x1} ${y1}`);
    }

    // Bottom turn: xr -> x2
    if (xr !== x2 && !e.dangling) {
      const dx = x2 - xr;
      const dir = dx > 0 ? 1 : -1;
      const adx = Math.abs(dx);
      const r = Math.min(9.5, adx * 0.5, Math.max(y2 - curY, 4) * 0.46);
      if (adx <= GRAPH_COL_W + 1) {
        const yStart = Math.max(y2 - GRAPH_ROW_H * 0.85, curY);
        if (yStart > curY) segs.push(`L ${xr} ${yStart}`);
        const c = (y2 - yStart) * 0.52;
        segs.push(`C ${xr} ${yStart + c}, ${x2} ${y2 - c}, ${x2} ${y2}`);
      } else {
        const yTurn = Math.max(y2 - r, curY);
        if (yTurn > curY) segs.push(`L ${xr} ${yTurn}`);
        segs.push(`Q ${xr} ${y2} ${xr + dir * r} ${y2} L ${x2} ${y2}`);
      }
    } else if (y2 > curY) {
      segs.push(`L ${curX} ${y2}`);
    }

    return segs.join(' ');
  }

  function renderContinuousGraphSvg(layout, rowCount) {
    const palette = getLaneColors();
    const width = GRAPH_PAD_X * 2 + (layout.maxCols - 1) * GRAPH_COL_W + 6;
    const height = rowCount * GRAPH_ROW_H;
    const cx = (col) => GRAPH_PAD_X + Math.min(col, 9) * GRAPH_COL_W;
    const cy = (row) => row * GRAPH_ROW_H + GRAPH_ROW_H / 2;
    const colColor = (idx) => palette[idx % palette.length];

    const straight = [];
    const curved = [];
    for (const e of layout.edges) {
      const d = buildEdgePath(e, cx, cy);
      const stroke = colColor(e.color);
      const opacity = e.dangling ? '0.58' : '0.92';
      const isStraight = e.fromCol === e.railCol && e.railCol === e.toCol;
      if (isStraight) {
        straight.push(
          `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.85" stroke-linecap="round" opacity="${opacity}"/>`
        );
      } else {
        // Subtle surface bridge halo under curved joins so crossing rails never visually clash
        curved.push(
          `<path d="${d}" fill="none" stroke="var(--surface)" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>` +
          `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`
        );
      }
    }

    const dots = layout.nodes.map((n) => {
      const x = cx(n.col);
      const y = cy(n.row);
      const c = colColor(n.color);
      if (n.isHead) {
        return `<g>
          <circle cx="${x}" cy="${y}" r="7" fill="${c}" opacity="0.16"/>
          <circle cx="${x}" cy="${y}" r="5.6" fill="var(--surface)"/>
          <circle cx="${x}" cy="${y}" r="4.2" fill="var(--surface)" stroke="${c}" stroke-width="2.1"/>
        </g>`;
      }
      if (n.isMerge) {
        return `<g>
          <circle cx="${x}" cy="${y}" r="5.6" fill="var(--surface)"/>
          <circle cx="${x}" cy="${y}" r="4.2" fill="var(--surface)" stroke="${c}" stroke-width="1.75"/>
          <circle cx="${x}" cy="${y}" r="1.8" fill="${c}"/>
        </g>`;
      }
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="${c}" stroke="var(--surface)" stroke-width="1.9"/>`;
    });

    return {
      width,
      svg: `<svg class="graph-svg-overlay" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${straight.join('')}${curved.join('')}${dots.join('')}</svg>`,
    };
  }

  function renderGraphList() {
    const wrap = $('graph-list');
    const dimMerges = $('chk-dim-merges').checked;
    if (!state.graph.commits.length) {
      wrap.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-sub">No commits found.</div></div>';
      $('graph-more-wrap').classList.add('hidden');
      return;
    }

    const palette = getLaneColors();
    const layout = computeContinuousGraph(state.graph.commits);
    const { svg } = renderContinuousGraphSvg(layout, state.graph.commits.length);

    const rowsHtml = state.graph.commits
      .map((c, idx) => {
        const node = layout.nodes[idx];
        const laneColor = palette[(node?.color || 0) % palette.length];
        const rowPadLeft = GRAPH_PAD_X + (layout.rowMaxCol[idx] || 0) * GRAPH_COL_W + 14;

        const refsHtml = (c.refs || [])
          .map((r) => {
            if (r.type === 'tag') {
              return `<span class="ref-chip ref-tag" title="Tag: ${esc(r.name)}">${REF_TAG_ICON}<span class="ref-chip-text">${esc(r.name)}</span></span>`;
            }
            const icon = r.type === 'remote' ? REF_REMOTE_ICON : r.type === 'head' ? REF_HEAD_ICON : '';
            return `<span class="ref-chip ref-${esc(r.type)}" style="background:${laneColor}" title="${esc(r.name)}">${icon}<span class="ref-chip-text">${esc(r.name)}</span></span>`;
          })
          .join('');

        const selected = state.selectedCommit?.hash === c.hash ? 'selected' : '';
        const dim = dimMerges && c.isMerge ? 'dim-merge' : '';
        const headCls = node?.isHead ? 'is-head' : '';
        const tip = `${c.shortHash} · ${c.author} · ${c.relDate}\n${c.subject}`;

        return `
          <div class="commit-row ${selected} ${dim} ${headCls}" data-commit-hash="${esc(c.hash)}" title="${esc(tip)}" style="padding-left:${rowPadLeft}px">
            <div class="commit-info">
              <div class="commit-main">
                <span class="commit-subj">${esc(c.subject)}</span>
                <span class="commit-author">${esc(c.author)}</span>
              </div>
              ${refsHtml ? `<div class="commit-refs">${refsHtml}</div>` : ''}
            </div>
          </div>`;
      })
      .join('');

    wrap.innerHTML = svg + rowsHtml;
    $('graph-more-wrap').classList.toggle('hidden', !state.graph.hasMore);
  }

  async function loadGraph(append = false) {
    try {
      const skip = append ? state.graph.commits.length : 0;
      const res = await apiGet('/api/graph', {
        limit: 50,
        skip,
        allBranches: $('chk-all-branches').checked,
        search: $('graph-search').value.trim(),
        author: $('graph-author').value.trim(),
        pathFilter: $('graph-path').value.trim(),
      });
      if (append) {
        state.graph.commits = state.graph.commits.concat(res.graph.commits || []);
        state.graph.maxCols = Math.max(state.graph.maxCols, res.graph.maxCols || 1);
      } else {
        state.graph.commits = res.graph.commits || [];
        state.graph.maxCols = res.graph.maxCols || 1;
      }
      state.graph.hasMore = Boolean(res.graph.hasMore);
      state.graph.loaded = true;
      renderGraphList();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderCommitDetail() {
    const box = $('commit-detail');
    const c = state.selectedCommit;
    if (!c) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const filesHtml = (c.files || [])
      .map((f) => {
        const stats = f.binary
          ? 'bin'
          : `${f.additions ? `<span class="stat-add">+${f.additions}</span>` : ''} ${f.deletions ? `<span class="stat-del">-${f.deletions}</span>` : ''}`;
        const active = state.commitFileDiff?.path === f.path ? 'selected' : '';
        const { base, dir } = splitPath(f.path);
        return `
          <div class="file-row ${active}" data-commit-file="${esc(f.path)}">
            <span class="file-icon">${getFileIconSvg(f.path)}</span>
            <div class="file-name-wrap">
              <span class="file-base ${f.status === 'D' ? 'is-deleted' : ''}" title="${esc(f.path)}">${esc(base)}</span>
              ${dir ? `<span class="file-dir">${esc(dir)}</span>` : ''}
            </div>
            <span class="file-stats">${stats}</span>
            <span class="st-badge ${statusClass(f.status)}" title="${esc(statusTitle(f.status))}">${esc(statusLetter(f.status))}</span>
          </div>`;
      })
      .join('');

    let fileDiffHtml = '';
    if (state.commitFileDiff?.loading) {
      fileDiffHtml = `<div class="diff-pane" style="margin-top:8px"><div class="diff-head"><span class="diff-file-path mono">${esc(state.commitFileDiff.path)}</span></div><div class="muted-note" style="padding:10px">Loading diff...</div></div>`;
    } else if (state.commitFileDiff) {
      fileDiffHtml = `
        <div class="diff-pane" style="margin-top:8px">
          <div class="diff-head">
            <span class="diff-file-path mono" title="${esc(state.commitFileDiff.path)}">${esc(state.commitFileDiff.path)}</span>
            <div class="diff-head-actions">
              <div class="segmented">
                <button type="button" class="seg-btn ${state.diffMode === 'unified' ? 'on' : ''}" data-cdiff-mode="unified">Unified</button>
                <button type="button" class="seg-btn ${state.diffMode === 'split' ? 'on' : ''}" data-cdiff-mode="split">Split</button>
              </div>
              <button type="button" class="icon-btn" id="btn-close-cdiff" title="Close diff">&times;</button>
            </div>
          </div>
          <div class="diff-body" style="max-height:280px">${renderHunksHtml(state.commitFileDiff)}</div>
        </div>`;
    }

    box.innerHTML = `
      <div class="detail-head">
        <div style="display:flex;align-items:center;gap:6px;min-width:0">
          <span class="mono" style="font-weight:700">${esc(c.shortHash)}</span>
          <span class="muted-note" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.author)} · ${esc(c.relDate)}</span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button type="button" class="btn btn-ghost btn-xs" id="btn-copy-sha" data-sha="${esc(c.hash)}">Copy SHA</button>
          <button type="button" class="icon-btn" id="btn-close-commit" title="Close commit detail">&times;</button>
        </div>
      </div>
      <div class="detail-body">
        <div class="detail-msg">${esc(c.message)}</div>
        <div class="section-title" style="margin-bottom:4px">Changed Files (${(c.files || []).length})</div>
        <div class="commit-files-list">${filesHtml || '<div class="muted-note" style="padding:6px">No file changes.</div>'}</div>
        ${fileDiffHtml}
      </div>`;
  }

  async function loadCommitFileDiff(hash, filePath) {
    state.commitFileDiff = { path: filePath, loading: true };
    renderCommitDetail();
    try {
      const res = await apiGet('/api/commit-diff', { hash, path: filePath });
      if (state.selectedCommit?.hash === hash) {
        state.commitFileDiff = res.diff;
        renderCommitDetail();
      }
    } catch (err) {
      if (state.selectedCommit?.hash === hash) {
        state.commitFileDiff = null;
        renderCommitDetail();
      }
      showToast(err.message, true);
    }
  }

  async function selectCommit(hash) {
    // Clicking the already-selected commit collapses the detail drawer
    if (state.selectedCommit?.hash === hash) {
      state.selectedCommit = null;
      state.commitFileDiff = null;
      renderGraphList();
      renderCommitDetail();
      return;
    }
    try {
      const res = await apiGet('/api/commit', { hash });
      state.selectedCommit = res.commit;
      state.commitFileDiff = null;
      renderGraphList();
      renderCommitDetail();
      // Auto-load the first changed file's diff so code changes appear immediately
      if (res.commit?.files?.length > 0) {
        loadCommitFileDiff(res.commit.hash, res.commit.files[0].path);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ---------- Branches & Worktrees ----------
  function renderBranchesView() {
    if (!state.branches) return;
    const q = $('branch-search').value.trim().toLowerCase();
    const filterFn = (b) => !q || b.name.toLowerCase().includes(q) || (b.subject || '').toLowerCase().includes(q);
    const locals = (state.branches.local || []).filter(filterFn);
    const remotes = (state.branches.remote || []).filter(filterFn);

    $('branches-local-wrap').innerHTML = `
      <div class="section-head"><span class="section-title">Local Branches <span class="count-pill num">${locals.length}</span></span></div>
      <div class="item-list">
        ${
          locals.length
            ? locals
                .map((b) => {
                  const ab = b.ahead || b.behind ? `<span class="ab-badge num">${b.ahead ? `↑${b.ahead}` : ''}${b.ahead && b.behind ? ' ' : ''}${b.behind ? `↓${b.behind}` : ''}</span>` : '';
                  const btns = b.current
                    ? '<span class="muted-note" style="font-size:10.5px">Current</span>'
                    : `<button type="button" class="btn btn-ghost btn-xs" data-br-act="checkout" data-br="${esc(b.name)}">Checkout</button>
                       <button type="button" class="btn btn-ghost btn-xs" data-br-act="merge" data-br="${esc(b.name)}">Merge</button>
                       <button type="button" class="btn btn-ghost btn-xs" data-br-act="delete" data-br="${esc(b.name)}" style="color:var(--c-del)">Del</button>`;
                  return `
                    <div class="branch-row ${b.current ? 'current' : ''}">
                      <div class="branch-main">
                        <div class="branch-title">${b.current ? '<span class="cur-dot"></span>' : ''}<span>${esc(b.name)}</span>${ab}</div>
                        <div class="branch-meta"><span class="mono">${esc(b.hash)}</span> · ${esc(b.relDate)} · ${esc(b.subject)}</div>
                      </div>
                      <div class="branch-btns">${btns}</div>
                    </div>`;
                })
                .join('')
            : '<div class="muted-note" style="padding:8px">No matching local branches.</div>'
        }
      </div>`;

    $('branches-remote-wrap').innerHTML = `
      <div class="section-head"><span class="section-title">Remote Branches <span class="count-pill num">${remotes.length}</span></span></div>
      <div class="item-list">
        ${
          remotes.length
            ? remotes
                .map(
                  (b) => `
                <div class="branch-row">
                  <div class="branch-main">
                    <div class="branch-title">${esc(b.name)}</div>
                    <div class="branch-meta"><span class="mono">${esc(b.hash)}</span> · ${esc(b.relDate)} · ${esc(b.subject)}</div>
                  </div>
                  <div class="branch-btns">
                    <button type="button" class="btn btn-ghost btn-xs" data-br-act="checkout-remote" data-br="${esc(b.name)}">Checkout</button>
                  </div>
                </div>`
                )
                .join('')
            : '<div class="muted-note" style="padding:8px">No remote branches.</div>'
        }
      </div>`;

    const wts = state.branches.worktrees || [];
    $('wt-count').textContent = String(wts.length);
    $('wt-list').innerHTML = wts.length
      ? wts
          .map(
            (w) => `
          <div class="branch-row ${w.current ? 'current' : ''}">
            <div class="branch-main">
              <div class="branch-title">${w.current ? '<span class="cur-dot"></span>' : ''}<span>${esc(w.branch || (w.detached ? 'detached' : w.name))}</span> <span class="muted-note mono">${esc(w.head)}</span></div>
              <div class="branch-meta mono" title="${esc(w.path)}">${esc(w.path)}</div>
            </div>
            <div class="branch-btns">
              ${w.current ? '<span class="muted-note" style="font-size:10.5px">Active</span>' : `<button type="button" class="btn btn-ghost btn-xs" data-wt-remove="${esc(w.path)}" style="color:var(--c-del)">Remove</button>`}
            </div>
          </div>`
          )
          .join('')
      : '<div class="muted-note" style="padding:8px">No worktrees.</div>';

    const rems = state.branches.remotes || [];
    $('remotes-list').innerHTML = rems.length
      ? rems
          .map(
            (r) => `
          <div class="branch-row">
            <div class="branch-main">
              <div class="branch-title">${esc(r.name)}</div>
              <div class="branch-meta mono" title="${esc(r.fetchUrl)}">${esc(r.fetchUrl)}</div>
            </div>
          </div>`
          )
          .join('')
      : '<div class="muted-note" style="padding:8px">No remotes configured.</div>';
  }

  async function loadBranches() {
    try {
      const res = await apiGet('/api/branches');
      state.branches = res;
      renderBranchesView();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ---------- GitHub View ----------
  function renderGitHubView() {
    const gh = state.github.data;
    if (!gh) return;
    $('gh-token-status').textContent = gh.auth?.configured
      ? `Token active (${gh.auth.source}: ${gh.auth.masked || '***'})`
      : 'No token configured (public repos work without a token)';

    if (!gh.detected) {
      $('gh-repo-meta').textContent = 'No GitHub remote found';
      $('gh-list').innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-sub">This repository does not have a github.com remote URL.</div></div>';
      return;
    }

    if (gh.error) {
      $('gh-repo-meta').textContent = `${gh.owner}/${gh.repo}`;
      $('gh-list').innerHTML = `<div class="empty-state" style="padding:18px"><div class="empty-title">Could not load GitHub data</div><div class="empty-sub">${esc(gh.error)}${gh.needsAuth ? ' — click Token above to configure a GitHub PAT.' : ''}</div></div>`;
      return;
    }

    const r = gh.repoInfo;
    $('gh-repo-meta').innerHTML = `<a class="gh-link" href="${esc(r.htmlUrl)}" target="_blank" rel="noreferrer">${esc(r.fullName)}</a> <span class="muted-note">★ ${r.stars} · ⑂ ${r.forks}${r.private ? ' · Private' : ''}</span>`;
    $('gh-pr-count').textContent = String((gh.pulls || []).length);
    $('gh-issue-count').textContent = String((gh.issues || []).length);
    $('btn-gh-sub-prs').classList.toggle('on', state.github.subTab === 'prs');
    $('btn-gh-sub-issues').classList.toggle('on', state.github.subTab === 'issues');

    const items = state.github.subTab === 'prs' ? gh.pulls || [] : gh.issues || [];
    const kind = state.github.subTab === 'prs' ? 'pr' : 'issue';
    if (!items.length) {
      $('gh-list').innerHTML = `<div class="empty-state" style="padding:18px"><div class="empty-sub">No ${esc(state.github.state)} ${kind === 'pr' ? 'pull requests' : 'issues'}.</div></div>`;
      return;
    }

    $('gh-list').innerHTML = items
      .map((it) => {
        const labels = (it.labels || [])
          .map((l) => `<span class="gh-label" style="border-color:#${esc(l.color)}">${esc(l.name)}</span>`)
          .join('');
        const extra = kind === 'pr' ? `<span class="mono">${esc(it.head)} → ${esc(it.base)}</span>` : `<span>${it.comments || 0} comments</span>`;
        return `
          <div class="gh-row" data-gh-kind="${kind}" data-gh-num="${it.number}">
            <div class="gh-row-top">
              <span class="gh-state-dot gh-state-${esc(it.state)}"></span>
              <span class="gh-title">${esc(it.title)}</span>
              <span class="gh-num">#${it.number}</span>
            </div>
            <div class="gh-sub">
              <span>by ${esc(it.author)}</span>
              ${extra}
              ${labels}
            </div>
          </div>`;
      })
      .join('');
  }

  async function loadGitHub() {
    try {
      const res = await apiGet('/api/github/overview', { state: state.github.state });
      state.github.data = res.github;
      state.github.loaded = true;
      renderGitHubView();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function openGitHubItem(kind, number) {
    try {
      const res = await apiGet('/api/github/item', { kind, number });
      const it = res.item;
      const box = $('gh-detail');
      box.classList.remove('hidden');
      const commentsHtml = (it.comments || [])
        .map((c) => `<div class="gh-comment"><div class="muted-note" style="margin-bottom:3px"><strong>${esc(c.author)}</strong> · ${esc(c.createdAt?.slice(0, 10))}</div>${esc(c.body)}</div>`)
        .join('');
      const prStats =
        it.kind === 'pr'
          ? `<span>${esc(it.head)} → ${esc(it.base)}</span><span class="stat-add">+${it.additions}</span><span class="stat-del">-${it.deletions}</span><span>${it.changedFiles} files</span>`
          : '';
      box.innerHTML = `
        <div class="detail-head">
          <span style="font-weight:700">#${it.number} ${esc(it.title)}</span>
          <div style="display:flex;gap:6px;align-items:center">
            <a class="gh-link" href="${esc(it.htmlUrl)}" target="_blank" rel="noreferrer">Open ↗</a>
            <button type="button" class="icon-btn" id="btn-close-gh-detail">&times;</button>
          </div>
        </div>
        <div class="detail-body">
          <div class="detail-meta"><span>State: ${esc(it.state)}</span><span>Author: ${esc(it.author)}</span>${prStats}</div>
          <div class="detail-msg">${esc(it.body || '(No description)')}</div>
          ${commentsHtml ? `<div class="section-title" style="margin-top:8px">Comments (${it.comments.length})</div>${commentsHtml}` : ''}
        </div>`;
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ---------- Polling ----------
  async function refreshStatus(force = false) {
    try {
      const res = await apiGet('/api/status', force ? {} : { etag: state.etag });
      if (res.repo && res.repo !== state.repo) {
        state.repo = res.repo;
        saveRepoForWs(state.workspaces, state.repo);
      }
      if (res.repos) renderReposSelect(res.repos);
      if (!res.found) return;
      if (res.unchanged) return;
      state.etag = res.etag || '';
      state.status = res.status;
      state.stashes = res.stashes || [];
      renderHeader(state.status);
      renderChanges(state.status);

      // Keep currently opened diff fresh if file still exists in that scope
      if (state.selectedDiff) {
        const { path, scope } = state.selectedDiff;
        const list =
          scope === 'staged'
            ? state.status.staged
            : scope === 'untracked'
              ? state.status.untracked
              : [...state.status.unstaged, ...state.status.conflicts];
        if (list.some((f) => f.path === path)) {
          const dRes = await apiGet('/api/diff', { path, scope });
          state.selectedDiff.data = dRes.diff;
          renderDiffPane();
        } else {
          state.selectedDiff = null;
          renderDiffPane();
        }
      }
    } catch {
      // ignore transient reconnect hiccups
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS;
    state.timer = setTimeout(async () => {
      await refreshStatus(false);
      schedulePoll();
    }, delay);
  }

  async function refreshAllAfterMutation() {
    state.etag = '';
    await refreshStatus(true);
    if (state.tab === 'graph' || state.graph.loaded) await loadGraph(false);
    if (state.tab === 'branches' || state.branches) await loadBranches();
  }

  // ---------- Tab Switching ----------
  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((btn) => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-view').forEach((sec) => {
      sec.classList.toggle('hidden', sec.id !== `view-${name}`);
    });
    if (name === 'graph' && !state.graph.loaded) loadGraph(false);
    if (name === 'branches') loadBranches();
    if (name === 'github' && !state.github.loaded) loadGitHub();
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('branch-pill').addEventListener('click', () => switchTab('branches'));

  // ---------- Header & Sync Wiring ----------
  $('repo-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('repo-menu');
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    $('repo-trigger').setAttribute('aria-expanded', String(willOpen));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRepoMenu();
  });

  async function selectRepo(repoPath) {
    closeRepoMenu();
    if (!repoPath || repoPath === state.repo) return;
    state.repo = repoPath;
    saveRepoForWs(state.workspaces, state.repo);
    state.etag = '';
    state.selectedDiff = null;
    state.selectedCommit = null;
    state.graph.loaded = false;
    state.github.loaded = false;
    renderReposSelect(state.repos);
    renderDiffPane();
    renderCommitDetail();
    $('gh-detail').classList.add('hidden');
    await refreshStatus(true);
    if (state.tab === 'graph') await loadGraph(false);
    if (state.tab === 'branches') await loadBranches();
    if (state.tab === 'github') await loadGitHub();
  }

  async function runSync(action, btnId) {
    const btn = $(btnId);
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      const res = await apiPost('/api/sync', { action });
      showToast(res.output || `${action} completed`);
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  }
  $('btn-fetch').addEventListener('click', () => runSync('fetch', 'btn-fetch'));
  $('btn-pull').addEventListener('click', () => runSync('pull', 'btn-pull'));
  $('btn-push').addEventListener('click', () => runSync('push', 'btn-push'));
  $('btn-refresh').addEventListener('click', async () => {
    $('btn-refresh').classList.add('busy');
    state.etag = '';
    await refreshStatus(true);
    if (state.tab === 'graph') await loadGraph(false);
    if (state.tab === 'branches') await loadBranches();
    if (state.tab === 'github') await loadGitHub();
    $('btn-refresh').classList.remove('busy');
  });

  // ---------- Commit & Amend ----------
  $('chk-amend').addEventListener('change', () => {
    if ($('chk-amend').checked && !$('commit-msg').value.trim() && state.status?.lastCommit?.message) {
      $('commit-msg').value = state.status.lastCommit.message;
    }
  });

  async function doCommit(stageAll = false) {
    const message = $('commit-msg').value.trim();
    const amend = $('chk-amend').checked;
    if (!message) {
      showToast('Please enter a commit message', true);
      $('commit-msg').focus();
      return;
    }
    try {
      await apiPost('/api/commit', { message, amend, stageAll });
      $('commit-msg').value = '';
      $('chk-amend').checked = false;
      showToast(amend ? 'Commit amended' : 'Committed successfully');
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    }
  }
  $('btn-commit').addEventListener('click', () => doCommit(false));
  $('btn-stage-commit').addEventListener('click', () => doCommit(true));
  $('commit-msg').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doCommit(false);
    }
  });

  // ---------- SCM Toolbar & Stash Form ----------
  $('btn-view-flat').addEventListener('click', () => {
    state.viewMode = 'flat';
    localStorage.setItem('agy_git_view', 'flat');
    if (state.status) renderChanges(state.status);
  });
  $('btn-view-tree').addEventListener('click', () => {
    state.viewMode = 'tree';
    localStorage.setItem('agy_git_view', 'tree');
    if (state.status) renderChanges(state.status);
  });
  $('btn-stage-all').addEventListener('click', async () => {
    try {
      await apiPost('/api/stage', { all: true });
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('btn-unstage-all').addEventListener('click', async () => {
    try {
      await apiPost('/api/unstage', { all: true });
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('btn-stash-toggle').addEventListener('click', () => $('stash-form').classList.toggle('hidden'));
  $('btn-stash-cancel').addEventListener('click', () => $('stash-form').classList.add('hidden'));
  $('btn-stash-save').addEventListener('click', async () => {
    try {
      await apiPost('/api/stash/save', {
        message: $('stash-msg').value.trim(),
        includeUntracked: $('stash-untracked').checked,
      });
      $('stash-msg').value = '';
      $('stash-form').classList.add('hidden');
      showToast('Changes stashed');
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---------- Diff Mode & Close ----------
  $('btn-diff-unified').addEventListener('click', () => {
    state.diffMode = 'unified';
    localStorage.setItem('agy_git_diff_mode', 'unified');
    renderDiffPane();
  });
  $('btn-diff-split').addEventListener('click', () => {
    state.diffMode = 'split';
    localStorage.setItem('agy_git_diff_mode', 'split');
    renderDiffPane();
  });
  $('btn-diff-close').addEventListener('click', () => {
    state.selectedDiff = null;
    renderDiffPane();
    if (state.status) renderChanges(state.status);
  });

  // ---------- Graph Controls ----------
  $('btn-graph-filters').addEventListener('click', () => $('graph-extra-filters').classList.toggle('hidden'));
  $('btn-graph-apply').addEventListener('click', () => loadGraph(false));
  $('chk-all-branches').addEventListener('change', () => loadGraph(false));
  $('chk-dim-merges').addEventListener('change', () => renderGraphList());
  let searchDebounce = null;
  $('graph-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadGraph(false), 300);
  });
  $('btn-graph-more').addEventListener('click', () => loadGraph(true));

  // ---------- Branches & Worktrees Controls ----------
  $('branch-search').addEventListener('input', () => renderBranchesView());
  $('btn-new-branch-toggle').addEventListener('click', () => $('new-branch-form').classList.toggle('hidden'));
  $('btn-new-branch-cancel').addEventListener('click', () => $('new-branch-form').classList.add('hidden'));
  $('btn-new-branch-create').addEventListener('click', async () => {
    const name = $('new-branch-name').value.trim();
    if (!name) return showToast('Enter a branch name', true);
    try {
      await apiPost('/api/branch/create', {
        name,
        startPoint: $('new-branch-start').value.trim(),
        checkout: $('new-branch-checkout').checked,
      });
      $('new-branch-name').value = '';
      $('new-branch-start').value = '';
      $('new-branch-form').classList.add('hidden');
      showToast(`Created branch ${name}`);
      await refreshAllAfterMutation();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btn-wt-toggle').addEventListener('click', () => $('wt-form').classList.toggle('hidden'));
  $('btn-wt-cancel').addEventListener('click', () => $('wt-form').classList.add('hidden'));
  $('btn-wt-add').addEventListener('click', async () => {
    const path = $('wt-path').value.trim();
    const branch = $('wt-branch').value.trim();
    if (!path) return showToast('Enter a target path', true);
    try {
      await apiPost('/api/worktree/add', {
        path,
        branch,
        newBranch: $('wt-new-branch').checked,
      });
      $('wt-path').value = '';
      $('wt-branch').value = '';
      $('wt-form').classList.add('hidden');
      showToast('Worktree added');
      await loadBranches();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---------- GitHub Controls ----------
  $('btn-gh-sub-prs').addEventListener('click', () => {
    state.github.subTab = 'prs';
    renderGitHubView();
  });
  $('btn-gh-sub-issues').addEventListener('click', () => {
    state.github.subTab = 'issues';
    renderGitHubView();
  });
  $('gh-state-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gh-state]');
    if (!btn) return;
    state.github.state = btn.dataset.ghState;
    $('gh-state-seg').querySelectorAll('[data-gh-state]').forEach((b) => {
      b.classList.toggle('on', b === btn);
    });
    loadGitHub();
  });
  $('btn-gh-token-toggle').addEventListener('click', () => $('gh-token-form').classList.toggle('hidden'));
  $('btn-gh-token-save').addEventListener('click', async () => {
    const token = $('gh-token-input').value.trim();
    if (!token) return showToast('Enter a token', true);
    try {
      await apiPost('/api/github/token', { token });
      $('gh-token-input').value = '';
      $('gh-token-form').classList.add('hidden');
      showToast('GitHub token saved');
      await loadGitHub();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('btn-gh-token-clear').addEventListener('click', async () => {
    try {
      await apiPost('/api/github/token', { clear: true });
      showToast('GitHub token cleared');
      await loadGitHub();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('btn-gh-pr-toggle').addEventListener('click', () => {
    const form = $('gh-pr-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      if (!$('gh-pr-head').value && state.status?.branch) $('gh-pr-head').value = state.status.branch;
      if (!$('gh-pr-base').value && state.github.data?.repoInfo?.defaultBranch) {
        $('gh-pr-base').value = state.github.data.repoInfo.defaultBranch;
      }
      if (!$('gh-pr-title').value && state.status?.lastCommit?.subject) {
        $('gh-pr-title').value = state.status.lastCommit.subject;
      }
    }
  });
  $('btn-gh-pr-cancel').addEventListener('click', () => $('gh-pr-form').classList.add('hidden'));
  $('btn-gh-pr-submit').addEventListener('click', async () => {
    try {
      const res = await apiPost('/api/github/pr', {
        title: $('gh-pr-title').value.trim(),
        head: $('gh-pr-head').value.trim(),
        base: $('gh-pr-base').value.trim(),
        body: $('gh-pr-body').value,
        draft: $('gh-pr-draft').checked,
      });
      $('gh-pr-form').classList.add('hidden');
      $('gh-pr-title').value = '';
      $('gh-pr-body').value = '';
      showToast(`Created PR #${res.number}`);
      await loadGitHub();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---------- Delegated Click Handlers ----------
  document.addEventListener('click', async (e) => {
    // 0. Custom repo dropdown item & outside click close
    const repoOpt = e.target.closest('[data-select-repo]');
    if (repoOpt) {
      e.stopPropagation();
      selectRepo(repoOpt.dataset.selectRepo);
      return;
    }
    if (!e.target.closest('#repo-dropdown')) {
      closeRepoMenu();
    }

    // 1. File row actions
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      const path = actBtn.dataset.path;
      const scope = actBtn.dataset.scope;
      if (act === 'open') {
        openFileInHost(actBtn.dataset.uri);
        return;
      }
      try {
        if (act === 'stage') await apiPost('/api/stage', { paths: [path] });
        else if (act === 'unstage') await apiPost('/api/unstage', { paths: [path] });
        else if (act === 'discard') {
          const ok = await confirmModal(
            'Discard Changes?',
            `This will permanently discard ${scope === 'untracked' ? 'and delete ' : ''}"${path}".`,
            'Discard'
          );
          if (!ok) return;
          await apiPost('/api/discard', { items: [{ path, scope }] });
        }
        await refreshAllAfterMutation();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 2. Bulk group actions (must run before group collapse toggle)
    const bulkBtn = e.target.closest('[data-bulk]');
    if (bulkBtn) {
      e.stopPropagation();
      const bulk = bulkBtn.dataset.bulk;
      try {
        if (bulk === 'unstage-all') await apiPost('/api/unstage', { all: true });
        else if (bulk === 'stage-unstaged') {
          const paths = (state.status?.unstaged || []).map((f) => f.path);
          if (paths.length) await apiPost('/api/stage', { paths });
        } else if (bulk === 'stage-untracked') {
          const paths = (state.status?.untracked || []).map((f) => f.path);
          if (paths.length) await apiPost('/api/stage', { paths });
        } else if (bulk === 'discard-unstaged') {
          const items = (state.status?.unstaged || []).map((f) => ({ path: f.path, scope: 'unstaged' }));
          if (!items.length) return;
          const ok = await confirmModal(
            'Discard All Unstaged Changes?',
            `Permanently revert ${items.length} modified file(s)?`,
            'Discard All'
          );
          if (!ok) return;
          await apiPost('/api/discard', { items });
        }
        await refreshAllAfterMutation();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 2b. Toggle collapsible SCM group
    const toggleGroup = e.target.closest('[data-toggle-group]');
    if (toggleGroup) {
      const key = toggleGroup.dataset.toggleGroup;
      if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
      else state.collapsedGroups.add(key);
      if (state.status) renderChanges(state.status);
      return;
    }

    // 3. Open file diff
    const diffRow = e.target.closest('[data-diff-path]');
    if (diffRow) {
      openDiff(diffRow.dataset.diffPath, diffRow.dataset.diffScope);
      return;
    }

    // 4. Hunk action
    const hunkBtn = e.target.closest('[data-hunk-act]');
    if (hunkBtn && state.selectedDiff) {
      const action = hunkBtn.dataset.hunkAct;
      const idx = Number(hunkBtn.dataset.hunkIdx);
      const hunk = state.selectedDiff.data?.hunks?.[idx];
      if (!hunk?.patch) return;
      if (action === 'discard') {
        const ok = await confirmModal('Discard Hunk?', 'Revert this hunk in the working tree?', 'Discard Hunk');
        if (!ok) return;
      }
      try {
        await apiPost('/api/hunk', { patch: hunk.patch, action });
        showToast(`Hunk ${action}d`);
        await refreshAllAfterMutation();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 5. Stash actions
    const stashBtn = e.target.closest('[data-stash-act]');
    if (stashBtn) {
      const action = stashBtn.dataset.stashAct;
      const ref = stashBtn.dataset.ref;
      if (action === 'drop') {
        const ok = await confirmModal('Drop Stash?', `Permanently delete ${ref}?`, 'Drop');
        if (!ok) return;
      }
      try {
        await apiPost('/api/stash/action', { ref, action });
        showToast(`Stash ${action} completed`);
        await refreshAllAfterMutation();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 6. Commit row click
    const commitRow = e.target.closest('[data-commit-hash]');
    if (commitRow) {
      selectCommit(commitRow.dataset.commitHash);
      return;
    }

    // 7. Commit detail file click / diff mode / copy / close
    const cDiffMode = e.target.closest('[data-cdiff-mode]');
    if (cDiffMode) {
      state.diffMode = cDiffMode.dataset.cdiffMode;
      localStorage.setItem('agy_git_diff_mode', state.diffMode);
      renderCommitDetail();
      return;
    }
    const cFile = e.target.closest('[data-commit-file]');
    if (cFile && state.selectedCommit) {
      loadCommitFileDiff(state.selectedCommit.hash, cFile.dataset.commitFile);
      return;
    }
    if (e.target.id === 'btn-copy-sha') {
      try {
        await navigator.clipboard.writeText(e.target.dataset.sha || '');
        showToast('Commit SHA copied');
      } catch {
        showToast(e.target.dataset.sha || '');
      }
      return;
    }
    if (e.target.id === 'btn-close-commit') {
      state.selectedCommit = null;
      state.commitFileDiff = null;
      renderGraphList();
      renderCommitDetail();
      return;
    }
    if (e.target.id === 'btn-close-cdiff') {
      state.commitFileDiff = null;
      renderCommitDetail();
      return;
    }

    // 8. Branch actions
    const brBtn = e.target.closest('[data-br-act]');
    if (brBtn) {
      const act = brBtn.dataset.brAct;
      const name = brBtn.dataset.br;
      try {
        if (act === 'checkout') {
          await apiPost('/api/branch/checkout', { name, isRemote: false });
          showToast(`Switched to ${name}`);
        } else if (act === 'checkout-remote') {
          await apiPost('/api/branch/checkout', { name, isRemote: true });
          showToast(`Checked out ${name}`);
        } else if (act === 'merge') {
          const ok = await confirmModal('Merge Branch?', `Merge "${name}" into "${state.status?.branch}"?`, 'Merge');
          if (!ok) return;
          const res = await apiPost('/api/branch/merge', { name });
          showToast(res.output || `Merged ${name}`);
        } else if (act === 'delete') {
          const ok = await confirmModal('Delete Branch?', `Delete local branch "${name}"?`, 'Delete');
          if (!ok) return;
          try {
            await apiPost('/api/branch/delete', { name, force: false });
            showToast(`Deleted branch ${name}`);
          } catch (delErr) {
            const forceOk = await confirmModal(
              'Force Delete Unmerged Branch?',
              `${delErr.message}\n\nForce delete "${name}" (-D)?`,
              'Force Delete'
            );
            if (!forceOk) return;
            await apiPost('/api/branch/delete', { name, force: true });
            showToast(`Force deleted ${name}`);
          }
        }
        await refreshAllAfterMutation();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 9. Worktree remove
    const wtBtn = e.target.closest('[data-wt-remove]');
    if (wtBtn) {
      const path = wtBtn.dataset.wtRemove;
      const ok = await confirmModal('Remove Worktree?', `Remove worktree at "${path}"?`, 'Remove');
      if (!ok) return;
      try {
        await apiPost('/api/worktree/remove', { path, force: false });
        showToast('Worktree removed');
        await loadBranches();
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    // 10. GitHub item click & close
    const ghRow = e.target.closest('[data-gh-num]');
    if (ghRow) {
      openGitHubItem(ghRow.dataset.ghKind, ghRow.dataset.ghNum);
      return;
    }
    if (e.target.id === 'btn-close-gh-detail') {
      $('gh-detail').classList.add('hidden');
    }
  });

  // ---------- Workspace Sync & Boot ----------
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus(false);
    schedulePoll();
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange(async (uris) => {
      state.workspaces = Array.isArray(uris) ? uris : [];
      state.repo = loadSavedRepo(state.workspaces);
      state.etag = '';
      state.selectedDiff = null;
      state.selectedCommit = null;
      state.commitFileDiff = null;
      state.graph.loaded = false;
      state.branches = null;
      state.github.loaded = false;
      renderDiffPane();
      renderCommitDetail();
      $('gh-detail').classList.add('hidden');
      await refreshStatus(true);
      if (state.tab === 'graph') await loadGraph(false);
      if (state.tab === 'branches') await loadBranches();
      if (state.tab === 'github') await loadGitHub();
    });
  }

  (async () => {
    if (window.sidecar?.getWorkspaceUris) {
      try {
        state.workspaces = await window.sidecar.getWorkspaceUris();
      } catch {}
    }
    state.repo = loadSavedRepo(state.workspaces);
    await refreshStatus(true);
    schedulePoll();
  })();
})();
