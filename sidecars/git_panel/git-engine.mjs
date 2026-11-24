/**
 * Local Git Engine for Antigravity Git Management Sidecar.
 *
 * Drives the system `/usr/bin/git` binary directly via execFile/spawn (no shell)
 * so UI state always matches terminal `git status` with zero external deps.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_BIN = 'git';
const MAX_BUFFER = 20 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'vendor',
  '.next',
  '.nuxt',
]);

// ---------------------------------------------------------------------------
// Validation & Path Helpers
// ---------------------------------------------------------------------------

export function uriToPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith('file://')) {
      return fileURLToPath(trimmed);
    }
    return isAbsolute(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

export function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function assertSafeArg(val, label = 'argument') {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  if (val.includes('\0')) {
    throw new Error(`Invalid null byte in ${label}`);
  }
  return val;
}

export function assertSafeRef(ref, label = 'ref') {
  const v = assertSafeArg(ref, label).trim();
  if (v.startsWith('-')) {
    throw new Error(`Invalid ${label}: cannot start with '-'`);
  }
  if (/[\s~^:?*\[\\]/.test(v) || v.includes('..') || v.includes('@{')) {
    throw new Error(`Invalid ${label}: "${v}"`);
  }
  return v;
}

export function assertSafeHash(hash) {
  const v = assertSafeArg(hash, 'commit hash').trim();
  if (!/^[0-9a-f]{4,40}$/i.test(v)) {
    throw new Error(`Invalid commit hash: "${v}"`);
  }
  return v;
}

export function assertSafeStashRef(ref) {
  const v = assertSafeArg(ref, 'stash ref').trim();
  if (!/^stash@\{\d+\}$/.test(v)) {
    throw new Error(`Invalid stash ref: "${v}"`);
  }
  return v;
}

export function assertPathInsideRepo(repoRoot, relPath) {
  const clean = assertSafeArg(relPath, 'file path');
  const rootReal = safeRealpath(repoRoot);
  const full = resolve(rootReal, clean);
  if (full !== rootReal && !full.startsWith(rootReal + sep)) {
    throw new Error(`Path escapes repository: "${clean}"`);
  }
  return full;
}

// ---------------------------------------------------------------------------
// Core Git Runner
// ---------------------------------------------------------------------------

export async function runGit(cwd, args, { stdin = null, timeoutMs = 30000, allowFail = false } = {}) {
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  if (stdin !== null) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(GIT_BIN, fullArgs, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(new Error(`git ${args[0]} timed out`));
          return;
        }
        if (code !== 0 && !allowFail) {
          rejectPromise(new Error((stderr || stdout || `git exited with code ${code}`).trim()));
          return;
        }
        resolvePromise({ stdout, stderr, code: code ?? 0 });
      });

      child.stdin.end(stdin, 'utf8');
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, fullArgs, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    if (allowFail) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        code: typeof err.code === 'number' ? err.code : 1,
      };
    }
    const msg = (err.stderr || err.stdout || err.message || 'git command failed').trim();
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// Repository Discovery
// ---------------------------------------------------------------------------

async function getGitToplevel(dir) {
  const res = await runGit(dir, ['rev-parse', '--show-toplevel'], { allowFail: true, timeoutMs: 4000 });
  if (res.code !== 0) return null;
  const top = res.stdout.trim();
  return top && existsSync(top) ? safeRealpath(top) : null;
}

function walkForGitDirs(rootDir, maxDepth = 3) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        found.push(dir);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }
  walk(rootDir, 0);
  return found;
}

export async function discoverRepos(workspacePaths) {
  const seen = new Map();
  const validRoots = [];

  for (const raw of workspacePaths || []) {
    const p = raw.startsWith('file://') ? uriToPath(raw) : raw;
    if (!p || !existsSync(p)) continue;
    const real = safeRealpath(p);
    validRoots.push(real);

    // Check if the workspace root itself is inside a git repository
    const top = await getGitToplevel(real);
    if (top && !seen.has(top)) {
      seen.set(top, { path: top, root: real });
    }

    // Also scan nested repos (up to depth 3)
    const nested = walkForGitDirs(real, 3);
    for (const candidate of nested) {
      const cReal = safeRealpath(candidate);
      if (!seen.has(cReal)) {
        seen.set(cReal, { path: cReal, root: real });
      }
    }
  }

  const repos = [];
  for (const [repoPath, meta] of seen.entries()) {
    const branchRes = await runGit(repoPath, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true, timeoutMs: 3000 });
    let branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';
    if (!branch) {
      const shaRes = await runGit(repoPath, ['rev-parse', '--short', 'HEAD'], { allowFail: true, timeoutMs: 3000 });
      branch = shaRes.code === 0 ? `@${shaRes.stdout.trim()}` : '(unborn)';
    }
    let isWorktree = false;
    try {
      isWorktree = statSync(join(repoPath, '.git')).isFile();
    } catch {}
    const rel = relative(meta.root, repoPath);
    const label = !rel || rel.startsWith('..') ? basename(repoPath) : `${basename(meta.root)}/${rel}`;
    repos.push({
      path: repoPath,
      name: basename(repoPath),
      label,
      branch,
      isWorktree,
    });
  }

  repos.sort((a, b) => a.label.localeCompare(b.label));
  return repos;
}

export async function resolveAllowedRepo(requestedRepo, workspacePaths, { fallbackToFirst = false } = {}) {
  const repos = await discoverRepos(workspacePaths);
  if (!requestedRepo) {
    return repos[0]?.path || null;
  }
  const reqReal = safeRealpath(requestedRepo);
  if (repos.some((r) => r.path === reqReal)) {
    return reqReal;
  }
  // Also allow registered worktrees of any discovered repo
  for (const r of repos) {
    const wt = await getWorktrees(r.path).catch(() => []);
    if (wt.some((w) => safeRealpath(w.path) === reqReal)) {
      return reqReal;
    }
  }
  if (fallbackToFirst && repos.length > 0) {
    return repos[0].path;
  }
  throw new Error('Requested repository is outside active Antigravity workspaces');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function parseNumstat(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    let filePath = rest.join('\t');
    // Rename format: old => new or prefix/{old => new}/suffix
    if (filePath.includes(' => ')) {
      filePath = filePath.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1');
      if (filePath.includes(' => ')) {
        filePath = filePath.split(' => ').pop();
      }
    }
    const binary = addRaw === '-' && delRaw === '-';
    map.set(filePath, {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    });
  }
  return map;
}

async function resolveGitDir(repo) {
  const res = await runGit(repo, ['rev-parse', '--git-dir'], { allowFail: true, timeoutMs: 3000 });
  if (res.code !== 0) return join(repo, '.git');
  const d = res.stdout.trim();
  return isAbsolute(d) ? d : resolve(repo, d);
}

export async function getStatus(repo) {
  const [statusRes, unstagedStatRes, stagedStatRes, gitDir, lastCommitRes] = await Promise.all([
    runGit(repo, ['status', '--porcelain=v2', '--branch', '-uall']),
    runGit(repo, ['diff', '--numstat'], { allowFail: true }),
    runGit(repo, ['diff', '--cached', '--numstat'], { allowFail: true }),
    resolveGitDir(repo),
    runGit(repo, ['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%B'], { allowFail: true }),
  ]);

  const unstagedStats = parseNumstat(unstagedStatRes.stdout);
  const stagedStats = parseNumstat(stagedStatRes.stdout);

  const info = {
    repo,
    name: basename(repo),
    branch: '(detached)',
    oid: null,
    initial: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    operationState: null,
    lastCommit: null,
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
  };

  if (existsSync(join(gitDir, 'MERGE_HEAD'))) info.operationState = 'MERGING';
  else if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) info.operationState = 'REBASING';
  else if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) info.operationState = 'CHERRY-PICKING';

  if (lastCommitRes.code === 0 && lastCommitRes.stdout.trim()) {
    const [hash, shortHash, subject, fullMessage] = lastCommitRes.stdout.split('\x1f');
    info.lastCommit = {
      hash: (hash || '').trim(),
      shortHash: (shortHash || '').trim(),
      subject: (subject || '').trim(),
      message: (fullMessage || '').trim(),
    };
  }

  for (const line of statusRes.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const v = line.slice('# branch.oid '.length).trim();
      info.oid = v === '(initial)' ? null : v;
      info.initial = v === '(initial)';
    } else if (line.startsWith('# branch.head ')) {
      info.branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      info.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        info.ahead = Number(m[1]) || 0;
        info.behind = Number(m[2]) || 0;
      }
    } else if (line.startsWith('? ')) {
      const path = line.slice(2);
      info.untracked.push({
        path,
        status: '?',
        scope: 'untracked',
        additions: 0,
        deletions: 0,
        binary: false,
      });
    } else if (line.startsWith('u ')) {
      // Unmerged entry: u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = line.split(' ');
      const xy = parts[1] || 'UU';
      const path = parts.slice(10).join(' ');
      const st = unstagedStats.get(path) || { additions: 0, deletions: 0, binary: false };
      info.conflicts.push({ path, status: xy, scope: 'unstaged', ...st });
    } else if (line.startsWith('1 ')) {
      // Ordinary changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ');
      const xy = parts[1] || '..';
      const x = xy[0];
      const y = xy[1];
      const path = parts.slice(8).join(' ');
      if (x && x !== '.') {
        const st = stagedStats.get(path) || { additions: 0, deletions: 0, binary: false };
        info.staged.push({ path, status: x, scope: 'staged', ...st });
      }
      if (y && y !== '.') {
        const st = unstagedStats.get(path) || { additions: 0, deletions: 0, binary: false };
        info.unstaged.push({ path, status: y, scope: 'unstaged', ...st });
      }
    } else if (line.startsWith('2 ')) {
      // Rename/copy entry: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const tabIdx = line.indexOf('\t');
      const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
      const origPath = tabIdx >= 0 ? line.slice(tabIdx + 1) : '';
      const parts = left.split(' ');
      const xy = parts[1] || '..';
      const x = xy[0];
      const y = xy[1];
      const path = parts.slice(9).join(' ');
      if (x && x !== '.') {
        const st = stagedStats.get(path) || { additions: 0, deletions: 0, binary: false };
        info.staged.push({ path, origPath, status: x, scope: 'staged', ...st });
      }
      if (y && y !== '.') {
        const st = unstagedStats.get(path) || { additions: 0, deletions: 0, binary: false };
        info.unstaged.push({ path, origPath, status: y, scope: 'unstaged', ...st });
      }
    }
  }

  info.totalChanges =
    info.conflicts.length + info.staged.length + info.unstaged.length + info.untracked.length;
  info.signature = [
    info.branch,
    info.oid || 'init',
    info.upstream || '',
    info.ahead,
    info.behind,
    info.operationState || '',
    ...info.conflicts.map((f) => `u:${f.path}:${f.status}`),
    ...info.staged.map((f) => `s:${f.path}:${f.status}:${f.additions}:${f.deletions}`),
    ...info.unstaged.map((f) => `w:${f.path}:${f.status}:${f.additions}:${f.deletions}`),
    ...info.untracked.map((f) => `?:${f.path}`),
  ].join('|');

  return info;
}

// ---------------------------------------------------------------------------
// Diff & Hunk Parsing
// ---------------------------------------------------------------------------

export function parseUnifiedDiff(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) {
    return { binary: false, files: [], hunks: [], raw: '' };
  }
  const lines = rawDiff.split('\n');
  // Drop trailing empty element caused by final newline
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const files = [];
  let currentFile = null;
  let currentHunk = null;

  const flushHunk = () => {
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      flushHunk();
      currentFile = {
        headerLines: [line],
        oldPath: '',
        newPath: '',
        binary: false,
        hunks: [],
      };
      files.push(currentFile);
      continue;
    }

    if (!currentFile) {
      currentFile = { headerLines: [], oldPath: '', newPath: '', binary: false, hunks: [] };
      files.push(currentFile);
    }

    if (!currentHunk) {
      if (line.startsWith('@@ ')) {
        const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        const oldStart = m ? Number(m[1]) : 1;
        const newStart = m ? Number(m[3]) : 1;
        currentHunk = {
          header: line,
          oldStart,
          newStart,
          oldCursor: oldStart,
          newCursor: newStart,
          rawLines: [line],
          lines: [],
        };
      } else {
        currentFile.headerLines.push(line);
        if (line.startsWith('--- ')) currentFile.oldPath = line.slice(4);
        if (line.startsWith('+++ ')) currentFile.newPath = line.slice(4);
        if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
          currentFile.binary = true;
        }
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      flushHunk();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      const oldStart = m ? Number(m[1]) : 1;
      const newStart = m ? Number(m[3]) : 1;
      currentHunk = {
        header: line,
        oldStart,
        newStart,
        oldCursor: oldStart,
        newCursor: newStart,
        rawLines: [line],
        lines: [],
      };
      continue;
    }

    currentHunk.rawLines.push(line);
    const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (cleanLine.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        oldLine: null,
        newLine: currentHunk.newCursor++,
        content: cleanLine.slice(1),
      });
    } else if (cleanLine.startsWith('-')) {
      currentHunk.lines.push({
        type: 'del',
        oldLine: currentHunk.oldCursor++,
        newLine: null,
        content: cleanLine.slice(1),
      });
    } else if (cleanLine.startsWith('\\')) {
      currentHunk.lines.push({
        type: 'meta',
        oldLine: null,
        newLine: null,
        content: cleanLine,
      });
    } else {
      currentHunk.lines.push({
        type: 'ctx',
        oldLine: currentHunk.oldCursor++,
        newLine: currentHunk.newCursor++,
        content: cleanLine.startsWith(' ') ? cleanLine.slice(1) : cleanLine,
      });
    }
  }
  flushHunk();

  // Build self-contained apply-ready patch per hunk
  for (const f of files) {
    const patchHeader = f.headerLines.join('\n');
    for (const h of f.hunks) {
      h.patch = `${patchHeader}\n${h.rawLines.join('\n')}\n`;
      delete h.rawLines;
      delete h.oldCursor;
      delete h.newCursor;
    }
  }

  const first = files[0] || { binary: false, hunks: [] };
  return {
    binary: first.binary,
    files,
    hunks: first.hunks,
    raw: rawDiff,
  };
}

export async function getFileDiff(repo, { path: filePath, scope = 'unstaged' }) {
  const full = assertPathInsideRepo(repo, filePath);

  if (scope === 'untracked') {
    if (!existsSync(full)) {
      return { path: filePath, scope, binary: false, hunks: [], empty: true };
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      return { path: filePath, scope, binary: false, hunks: [], note: 'Directory' };
    }
    const maxBytes = 512 * 1024;
    const buf = readFileSync(full);
    const truncated = buf.length > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    if (slice.includes(0)) {
      return { path: filePath, scope, binary: true, hunks: [] };
    }
    const text = slice.toString('utf8').replace(/\r\n/g, '\n');
    const fileLines = text.split('\n');
    if (fileLines.length && fileLines[fileLines.length - 1] === '') fileLines.pop();
    return {
      path: filePath,
      scope,
      binary: false,
      truncated,
      hunks: [
        {
          header: `@@ -0,0 +1,${fileLines.length} @@ (untracked)`,
          oldStart: 0,
          newStart: 1,
          patch: null,
          lines: fileLines.map((content, idx) => ({
            type: 'add',
            oldLine: null,
            newLine: idx + 1,
            content,
          })),
        },
      ],
    };
  }

  const args =
    scope === 'staged'
      ? ['diff', '--cached', '-U3', '--', filePath]
      : ['diff', '-U3', '--', filePath];
  const res = await runGit(repo, args);
  const parsed = parseUnifiedDiff(res.stdout);
  return {
    path: filePath,
    scope,
    binary: parsed.binary,
    hunks: parsed.hunks,
    empty: !parsed.binary && parsed.hunks.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Staging, Unstaging, Discarding, Hunk Apply, Commit
// ---------------------------------------------------------------------------

export async function stageFiles(repo, { paths = [], all = false }) {
  if (all) {
    await runGit(repo, ['add', '-A']);
    return { ok: true };
  }
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('No files specified');
  for (const p of paths) assertPathInsideRepo(repo, p);
  await runGit(repo, ['add', '--', ...paths]);
  return { ok: true };
}

export async function unstageFiles(repo, { paths = [], all = false }) {
  const hasHead = (await runGit(repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
  if (all) {
    if (hasHead) {
      await runGit(repo, ['reset', 'HEAD']);
    } else {
      await runGit(repo, ['rm', '--cached', '-r', '.'], { allowFail: true });
    }
    return { ok: true };
  }
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('No files specified');
  for (const p of paths) assertPathInsideRepo(repo, p);
  if (hasHead) {
    await runGit(repo, ['reset', 'HEAD', '--', ...paths]);
  } else {
    await runGit(repo, ['rm', '--cached', '-r', '--', ...paths]);
  }
  return { ok: true };
}

export async function discardFiles(repo, { items = [], all = false }) {
  if (all) {
    await runGit(repo, ['checkout', '--', '.'], { allowFail: true });
    await runGit(repo, ['clean', '-fd']);
    return { ok: true };
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error('No files specified');
  const tracked = [];
  for (const item of items) {
    const p = typeof item === 'string' ? item : item.path;
    const scope = typeof item === 'string' ? 'unstaged' : item.scope;
    const full = assertPathInsideRepo(repo, p);
    if (scope === 'untracked') {
      if (existsSync(full)) {
        rmSync(full, { recursive: true, force: true });
      }
    } else {
      tracked.push(p);
    }
  }
  if (tracked.length) {
    await runGit(repo, ['checkout', '--', ...tracked]);
  }
  return { ok: true };
}

export async function applyHunk(repo, { patch, action }) {
  assertSafeArg(patch, 'patch');
  let args;
  if (action === 'stage') args = ['apply', '--cached', '--recount'];
  else if (action === 'unstage') args = ['apply', '--cached', '-R', '--recount'];
  else if (action === 'discard') args = ['apply', '-R', '--recount'];
  else throw new Error(`Unknown hunk action: ${action}`);
  await runGit(repo, args, { stdin: patch });
  return { ok: true };
}

export async function commitChanges(repo, { message, amend = false, stageAll = false }) {
  const msg = assertSafeArg(message, 'commit message').trim();
  if (stageAll) {
    await runGit(repo, ['add', '-A']);
  }
  const args = ['commit', '-m', msg];
  if (amend) args.splice(1, 0, '--amend');
  const res = await runGit(repo, args);
  return { ok: true, output: (res.stdout || res.stderr || '').trim() };
}

// ---------------------------------------------------------------------------
// Commit Graph with Multi-Color Swimlanes
// ---------------------------------------------------------------------------

function parseDecorations(raw) {
  if (!raw || !raw.trim()) return [];
  const refs = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    if (item.startsWith('HEAD -> ')) {
      refs.push({ name: item.slice('HEAD -> '.length), type: 'head', current: true });
    } else if (item === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'head', current: true });
    } else if (item.startsWith('tag: ')) {
      refs.push({ name: item.slice('tag: '.length), type: 'tag', current: false });
    } else if (item.includes('/')) {
      refs.push({ name: item, type: 'remote', current: false });
    } else {
      refs.push({ name: item, type: 'local', current: false });
    }
  }
  return refs;
}

function computeSwimlanes(commits) {
  // activeLanes[col] = { hash, color } | null
  const activeLanes = [];
  let nextColor = 0;
  const PALETTE_SIZE = 8;

  const allocColor = () => nextColor++ % PALETTE_SIZE;
  const findFreeCol = () => {
    const idx = activeLanes.findIndex((l) => l === null);
    if (idx !== -1) return idx;
    activeLanes.push(null);
    return activeLanes.length - 1;
  };
  const trimTrailingNulls = () => {
    while (activeLanes.length && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
  };

  let maxCols = 1;

  for (const commit of commits) {
    // Find all lanes currently expecting this commit hash
    const matchingCols = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] && activeLanes[i].hash === commit.hash) {
        matchingCols.push(i);
      }
    }

    let col;
    let color;
    const incoming = [];

    if (matchingCols.length > 0) {
      col = matchingCols[0];
      color = activeLanes[col].color;
      // Collapse duplicate lanes pointing to this commit into `col`
      for (const mc of matchingCols) {
        incoming.push({ fromCol: mc, toCol: col, color: activeLanes[mc].color });
        if (mc !== col) activeLanes[mc] = null;
      }
    } else {
      col = findFreeCol();
      color = allocColor();
      activeLanes[col] = { hash: commit.hash, color };
    }

    // Record lanes that simply pass straight through this row
    const passThrough = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (i !== col && activeLanes[i] !== null) {
        passThrough.push({ col: i, color: activeLanes[i].color });
      }
    }

    // Now advance `col` to commit's parents
    const parents = commit.parents;
    const outgoing = [];

    if (parents.length === 0) {
      activeLanes[col] = null;
    } else {
      // First parent inherits `col` unless another lane already tracks it
      const p0 = parents[0];
      const existingP0 = activeLanes.findIndex((l, i) => i !== col && l && l.hash === p0);
      if (existingP0 !== -1) {
        outgoing.push({ fromCol: col, toCol: existingP0, color });
        activeLanes[col] = null;
      } else {
        activeLanes[col] = { hash: p0, color };
        outgoing.push({ fromCol: col, toCol: col, color });
      }

      // Secondary parents (merge commit)
      for (let pi = 1; pi < parents.length; pi++) {
        const p = parents[pi];
        const existing = activeLanes.findIndex((l) => l && l.hash === p);
        if (existing !== -1) {
          outgoing.push({ fromCol: col, toCol: existing, color: activeLanes[existing].color });
        } else {
          const newCol = findFreeCol();
          const newColor = allocColor();
          activeLanes[newCol] = { hash: p, color: newColor };
          outgoing.push({ fromCol: col, toCol: newCol, color: newColor });
        }
      }
    }

    trimTrailingNulls();
    const rowCols = Math.max(
      col + 1,
      activeLanes.length,
      ...incoming.map((e) => Math.max(e.fromCol, e.toCol) + 1),
      ...outgoing.map((e) => Math.max(e.fromCol, e.toCol) + 1),
      ...passThrough.map((e) => e.col + 1)
    );
    if (rowCols > maxCols) maxCols = rowCols;

    commit.graph = {
      col,
      color,
      incoming,
      outgoing,
      passThrough,
    };
  }

  return maxCols;
}

export async function getGraph(
  repo,
  { limit = 60, skip = 0, allBranches = true, search = '', author = '', pathFilter = '' } = {}
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 60, 1), 250);
  const safeSkip = Math.max(Number(skip) || 0, 0);

  const args = [
    'log',
    `--max-count=${safeLimit + 1}`,
    `--skip=${safeSkip}`,
    '--topo-order',
    '--format=%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%ar%x1f%s',
  ];
  if (allBranches) args.push('--branches', '--tags', '--remotes');
  if (search && search.trim()) {
    args.push(`--grep=${search.trim()}`, '-i');
  }
  if (author && author.trim()) {
    args.push(`--author=${author.trim()}`, '-i');
  }
  if (pathFilter && pathFilter.trim()) {
    assertPathInsideRepo(repo, pathFilter.trim());
    args.push('--', pathFilter.trim());
  }

  const res = await runGit(repo, args, { allowFail: true });
  if (res.code !== 0 || !res.stdout.trim()) {
    return { commits: [], hasMore: false, maxCols: 1 };
  }

  const rawRecords = res.stdout.split('\x1e').filter((r) => r.trim());
  const hasMore = rawRecords.length > safeLimit;
  const records = hasMore ? rawRecords.slice(0, safeLimit) : rawRecords;

  const commits = records.map((rec) => {
    const [hash, shortHash, parentsRaw, refsRaw, authorName, authorEmail, ts, relDate, subject] =
      rec.trim().split('\x1f');
    const parents = (parentsRaw || '').trim() ? parentsRaw.trim().split(' ') : [];
    return {
      hash: hash || '',
      shortHash: shortHash || '',
      parents,
      isMerge: parents.length > 1,
      refs: parseDecorations(refsRaw || ''),
      author: authorName || '',
      email: authorEmail || '',
      timestamp: Number(ts) || 0,
      relDate: relDate || '',
      subject: subject || '',
    };
  });

  const maxCols = computeSwimlanes(commits);
  return { commits, hasMore, maxCols };
}

export async function getCommitDetail(repo, hash) {
  const safeHash = assertSafeHash(hash);
  const [metaRes, filesStatRes, filesStatusRes] = await Promise.all([
    runGit(repo, ['show', '--no-patch', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%D%x1f%B', safeHash]),
    runGit(repo, ['diff-tree', '--no-commit-id', '--numstat', '-r', '-m', '--first-parent', '--root', safeHash]),
    runGit(repo, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-m', '--first-parent', '--root', safeHash]),
  ]);

  const [fullHash, shortHash, parentsRaw, author, email, isoDate, relDate, refsRaw, body] =
    metaRes.stdout.split('\x1f');

  const statMap = parseNumstat(filesStatRes.stdout);
  const files = [];
  const seenPaths = new Set();
  for (const line of filesStatusRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = (parts[0] || 'M')[0];
    const path = parts.length >= 3 ? parts[2] : parts[1];
    const origPath = parts.length >= 3 ? parts[1] : undefined;
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const st = statMap.get(path) || { additions: 0, deletions: 0, binary: false };
    files.push({ path, origPath, status, ...st });
  }

  return {
    hash: (fullHash || safeHash).trim(),
    shortHash: (shortHash || '').trim(),
    parents: (parentsRaw || '').trim() ? parentsRaw.trim().split(' ') : [],
    author: (author || '').trim(),
    email: (email || '').trim(),
    isoDate: (isoDate || '').trim(),
    relDate: (relDate || '').trim(),
    refs: parseDecorations(refsRaw || ''),
    message: (body || '').trim(),
    files,
  };
}

export async function getCommitFileDiff(repo, hash, filePath) {
  const safeHash = assertSafeHash(hash);
  assertPathInsideRepo(repo, filePath);
  const res = await runGit(repo, ['show', '--format=', '-m', '--first-parent', '-U3', safeHash, '--', filePath]);
  const parsed = parseUnifiedDiff(res.stdout);
  return {
    hash: safeHash,
    path: filePath,
    binary: parsed.binary,
    hunks: parsed.hunks,
    empty: !parsed.binary && parsed.hunks.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Branches, Remotes, Sync & Worktrees
// ---------------------------------------------------------------------------

export async function getWorktrees(repo) {
  const res = await runGit(repo, ['worktree', 'list', '--porcelain'], { allowFail: true });
  if (res.code !== 0) return [];
  const items = [];
  let cur = null;
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) {
      if (cur) {
        items.push(cur);
        cur = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), head: '', branch: '', bare: false, detached: false, locked: false };
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim().slice(0, 7);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (line === 'bare') cur.bare = true;
      else if (line === 'detached') cur.detached = true;
      else if (line.startsWith('locked')) cur.locked = true;
    }
  }
  if (cur) items.push(cur);
  const currentReal = safeRealpath(repo);
  for (const w of items) {
    w.current = safeRealpath(w.path) === currentReal;
    w.name = basename(w.path);
  }
  return items;
}

export async function getBranchesAndRemotes(repo) {
  const fmt = '%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:relative)%1f%(subject)%1f%(symref)';
  const [localRes, remoteRes, remotesRaw, worktrees] = await Promise.all([
    runGit(repo, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'], { allowFail: true }),
    runGit(repo, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/remotes'], { allowFail: true }),
    runGit(repo, ['remote', '-v'], { allowFail: true }),
    getWorktrees(repo),
  ]);

  const parseList = (stdout) =>
    stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [head, name, upstream, track, hash, relDate, subject, symref] = line.split('\x1f');
        let ahead = 0;
        let behind = 0;
        let gone = false;
        if (track) {
          const ma = track.match(/ahead (\d+)/);
          const mb = track.match(/behind (\d+)/);
          if (ma) ahead = Number(ma[1]);
          if (mb) behind = Number(mb[1]);
          if (track.includes('gone')) gone = true;
        }
        return {
          current: head === '*',
          name: name || '',
          upstream: upstream || '',
          ahead,
          behind,
          gone,
          hash: hash || '',
          relDate: relDate || '',
          subject: subject || '',
          symref: (symref || '').trim(),
        };
      });

  const local = parseList(localRes.stdout).filter((b) => b.name && !b.symref);
  const remote = parseList(remoteRes.stdout).filter((r) => r.name && !r.symref && !r.name.endsWith('/HEAD'));

  const remoteMap = new Map();
  for (const line of remotesRaw.stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
    if (!m) continue;
    const [, name, url, kind] = m;
    if (!remoteMap.has(name)) remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
    if (kind === 'fetch') remoteMap.get(name).fetchUrl = url;
    else remoteMap.get(name).pushUrl = url;
  }

  return {
    local,
    remote,
    remotes: Array.from(remoteMap.values()),
    worktrees,
  };
}

export async function checkoutBranch(repo, { name, isRemote = false }) {
  const safeName = assertSafeRef(name, 'branch name');
  if (isRemote) {
    const localName = safeName.includes('/') ? safeName.split('/').slice(1).join('/') : safeName;
    const existsLocal =
      (await runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], { allowFail: true })).code ===
      0;
    if (existsLocal) {
      await runGit(repo, ['checkout', localName]);
    } else {
      await runGit(repo, ['checkout', '--track', safeName]);
    }
  } else {
    await runGit(repo, ['checkout', safeName]);
  }
  return { ok: true };
}

export async function createBranch(repo, { name, startPoint = '', checkout = true }) {
  const safeName = assertSafeRef(name, 'branch name');
  const check = await runGit(repo, ['check-ref-format', '--branch', safeName], { allowFail: true });
  if (check.code !== 0) throw new Error(`Invalid Git branch name: "${safeName}"`);
  const args = checkout ? ['checkout', '-b', safeName] : ['branch', safeName];
  if (startPoint && startPoint.trim()) {
    args.push(assertSafeRef(startPoint.trim(), 'start point'));
  }
  await runGit(repo, args);
  return { ok: true };
}

export async function deleteBranch(repo, { name, force = false }) {
  const safeName = assertSafeRef(name, 'branch name');
  await runGit(repo, ['branch', force ? '-D' : '-d', safeName]);
  return { ok: true };
}

export async function mergeBranch(repo, { name }) {
  const safeName = assertSafeRef(name, 'branch name');
  const res = await runGit(repo, ['merge', '--no-edit', safeName]);
  return { ok: true, output: (res.stdout || res.stderr || '').trim() };
}

export async function syncRemote(repo, { action }) {
  if (action === 'fetch') {
    const res = await runGit(repo, ['fetch', '--all', '--prune'], { timeoutMs: 60000 });
    return { ok: true, output: (res.stdout || res.stderr || 'Fetched all remotes').trim() };
  }
  if (action === 'pull') {
    const res = await runGit(repo, ['pull'], { timeoutMs: 60000 });
    return { ok: true, output: (res.stdout || res.stderr || 'Pulled latest changes').trim() };
  }
  if (action === 'push') {
    const st = await getStatus(repo);
    let args = ['push'];
    if (!st.upstream && st.branch && st.branch !== '(detached)') {
      args = ['push', '-u', 'origin', st.branch];
    }
    const res = await runGit(repo, args, { timeoutMs: 60000 });
    return { ok: true, output: (res.stdout || res.stderr || 'Pushed successfully').trim() };
  }
  throw new Error(`Unknown sync action: ${action}`);
}

export async function addWorktree(repo, { path: wtPath, branch, newBranch = false, startPoint = '' }) {
  const cleanPath = assertSafeArg(wtPath, 'worktree path').trim();
  const absPath = isAbsolute(cleanPath) ? cleanPath : resolve(repo, cleanPath);
  const args = ['worktree', 'add'];
  if (newBranch) {
    const safeB = assertSafeRef(branch, 'branch name');
    args.push('-b', safeB, absPath);
    if (startPoint && startPoint.trim()) {
      args.push(assertSafeRef(startPoint.trim(), 'start point'));
    }
  } else {
    args.push(absPath);
    if (branch && branch.trim()) {
      args.push(assertSafeRef(branch.trim(), 'branch name'));
    }
  }
  const res = await runGit(repo, args);
  return { ok: true, path: absPath, output: (res.stdout || res.stderr || '').trim() };
}

export async function removeWorktree(repo, { path: wtPath, force = false }) {
  const cleanPath = assertSafeArg(wtPath, 'worktree path').trim();
  const worktrees = await getWorktrees(repo);
  const targetReal = safeRealpath(cleanPath);
  if (!worktrees.some((w) => safeRealpath(w.path) === targetReal && !w.current)) {
    throw new Error('Target is not a removable worktree of this repository');
  }
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetReal);
  await runGit(repo, args);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stashes
// ---------------------------------------------------------------------------

export async function getStashes(repo) {
  const res = await runGit(repo, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ar'], { allowFail: true });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return res.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const [ref, hash, message, relDate] = line.split('\x1f');
      return { ref: ref || '', hash: hash || '', message: message || '', relDate: relDate || '' };
    });
}

export async function stashSave(repo, { message = '', includeUntracked = true }) {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message && message.trim()) {
    args.push('-m', message.trim());
  }
  const res = await runGit(repo, args);
  return { ok: true, output: (res.stdout || res.stderr || '').trim() };
}

export async function stashAction(repo, { ref, action }) {
  const safeRef = assertSafeStashRef(ref);
  if (!['apply', 'pop', 'drop'].includes(action)) {
    throw new Error(`Invalid stash action: ${action}`);
  }
  const res = await runGit(repo, ['stash', action, safeRef]);
  return { ok: true, output: (res.stdout || res.stderr || '').trim() };
}

export async function getStashDiff(repo, ref) {
  const safeRef = assertSafeStashRef(ref);
  const res = await runGit(repo, ['stash', 'show', '-p', '--include-untracked', safeRef], { allowFail: true });
  const parsed = parseUnifiedDiff(res.stdout);
  return { ref: safeRef, files: parsed.files, raw: res.stdout };
}
