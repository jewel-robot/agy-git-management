/**
 * Zero-dependency GitHub REST API client for Antigravity Git Management Sidecar.
 *
 * Works out of the box for public GitHub repositories without `gh` CLI.
 * Supports optional Personal Access Token stored at 0600 in sidecar data dir,
 * GITHUB_TOKEN / GH_TOKEN env vars, or `gh auth token` when available.
 */

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runGit } from './git-engine.mjs';

const execFileAsync = promisify(execFile);
const TOKEN_FILE = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'git-management', 'github.json');
const API_BASE = 'https://api.github.com';

let ghCliTokenCache = { checked: false, token: null };

export function parseGitHubRemoteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  // HTTPS: https://github.com/owner/repo(.git)
  let m = trimmed.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // SSH: git@github.com:owner/repo(.git)
  m = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // ssh://git@github.com/owner/repo(.git)
  m = trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

export async function detectGitHubRepo(repoPath) {
  const originRes = await runGit(repoPath, ['remote', 'get-url', 'origin'], { allowFail: true, timeoutMs: 3000 });
  if (originRes.code === 0) {
    const parsed = parseGitHubRemoteUrl(originRes.stdout.trim());
    if (parsed) return { ...parsed, remote: 'origin', url: originRes.stdout.trim() };
  }
  const allRes = await runGit(repoPath, ['remote', '-v'], { allowFail: true, timeoutMs: 3000 });
  for (const line of allRes.stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (!m) continue;
    const parsed = parseGitHubRemoteUrl(m[2]);
    if (parsed) return { ...parsed, remote: m[1], url: m[2] };
  }
  return null;
}

function readStoredToken() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return typeof raw?.token === 'string' && raw.token.trim() ? raw.token.trim() : null;
  } catch {
    return null;
  }
}

async function resolveToken() {
  const stored = readStoredToken();
  if (stored) return { token: stored, source: 'saved' };

  const envTok = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envTok) return { token: envTok, source: 'env' };

  if (!ghCliTokenCache.checked) {
    ghCliTokenCache.checked = true;
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 2500 });
      const tok = stdout.trim();
      ghCliTokenCache.token = tok || null;
    } catch {
      ghCliTokenCache.token = null;
    }
  }
  if (ghCliTokenCache.token) return { token: ghCliTokenCache.token, source: 'gh-cli' };
  return { token: null, source: 'none' };
}

export async function getTokenStatus() {
  const { token, source } = await resolveToken();
  return {
    configured: Boolean(token),
    source,
    masked: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : null,
  };
}

export function saveToken(token) {
  const clean = typeof token === 'string' ? token.trim() : '';
  if (!clean) throw new Error('Token cannot be empty');
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ token: clean }, null, 2), { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {}
  return { ok: true };
}

export function clearToken() {
  try {
    if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE, { force: true });
  } catch {}
  return { ok: true };
}

async function ghFetch(path, { method = 'GET', body = null } = {}) {
  const { token } = await resolveToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'antigravity-git-management-sidecar',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.message || `GitHub API HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function getGitHubOverview(repoPath, { state = 'open' } = {}) {
  const detected = await detectGitHubRepo(repoPath);
  const auth = await getTokenStatus();
  if (!detected) {
    return { detected: false, auth };
  }

  const { owner, repo } = detected;
  const safeState = ['open', 'closed', 'all'].includes(state) ? state : 'open';

  try {
    const [repoInfo, pulls, issuesRaw] = await Promise.all([
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`),
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${safeState}&per_page=30`),
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${safeState}&per_page=30`),
    ]);

    const issues = (Array.isArray(issuesRaw) ? issuesRaw : []).filter((i) => !i.pull_request);

    return {
      detected: true,
      owner,
      repo,
      auth,
      repoInfo: {
        fullName: repoInfo.full_name,
        description: repoInfo.description || '',
        private: Boolean(repoInfo.private),
        defaultBranch: repoInfo.default_branch,
        stars: repoInfo.stargazers_count || 0,
        forks: repoInfo.forks_count || 0,
        openIssues: repoInfo.open_issues_count || 0,
        htmlUrl: repoInfo.html_url,
      },
      pulls: (Array.isArray(pulls) ? pulls : []).map((p) => ({
        number: p.number,
        title: p.title,
        state: p.merged_at ? 'merged' : p.state,
        draft: Boolean(p.draft),
        author: p.user?.login || '',
        head: p.head?.ref || '',
        base: p.base?.ref || '',
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        htmlUrl: p.html_url,
        labels: (p.labels || []).map((l) => ({ name: l.name, color: l.color })),
      })),
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login || '',
        comments: i.comments || 0,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        htmlUrl: i.html_url,
        labels: (i.labels || []).map((l) => ({ name: l.name, color: l.color })),
      })),
    };
  } catch (err) {
    return {
      detected: true,
      owner,
      repo,
      auth,
      error: err.message,
      status: err.status || 500,
      needsAuth: err.status === 401 || err.status === 403 || err.status === 404,
    };
  }
}

export async function getGitHubItemDetail(repoPath, { kind, number }) {
  const detected = await detectGitHubRepo(repoPath);
  if (!detected) throw new Error('No GitHub remote detected');
  const num = Number(number);
  if (!Number.isInteger(num) || num <= 0) throw new Error('Invalid number');
  const { owner, repo } = detected;

  if (kind === 'pr') {
    const [pr, comments] = await Promise.all([
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${num}`),
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}/comments?per_page=20`),
    ]);
    return {
      kind: 'pr',
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      author: pr.user?.login || '',
      head: pr.head?.ref || '',
      base: pr.base?.ref || '',
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      changedFiles: pr.changed_files || 0,
      mergeableState: pr.mergeable_state || '',
      body: pr.body || '',
      htmlUrl: pr.html_url,
      labels: (pr.labels || []).map((l) => ({ name: l.name, color: l.color })),
      comments: (Array.isArray(comments) ? comments : []).map((c) => ({
        author: c.user?.login || '',
        createdAt: c.created_at,
        body: c.body || '',
      })),
    };
  }

  const [issue, comments] = await Promise.all([
    ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}`),
    ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}/comments?per_page=20`),
  ]);
  return {
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login || '',
    body: issue.body || '',
    htmlUrl: issue.html_url,
    labels: (issue.labels || []).map((l) => ({ name: l.name, color: l.color })),
    comments: (Array.isArray(comments) ? comments : []).map((c) => ({
      author: c.user?.login || '',
      createdAt: c.created_at,
      body: c.body || '',
    })),
  };
}

export async function createGitHubPull(repoPath, { title, body = '', head, base, draft = false }) {
  const detected = await detectGitHubRepo(repoPath);
  if (!detected) throw new Error('No GitHub remote detected');
  if (!title || !title.trim()) throw new Error('PR title is required');
  if (!head || !base) throw new Error('Both head and base branches are required');
  const { owner, repo } = detected;

  const created = await ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    body: {
      title: title.trim(),
      body: String(body || ''),
      head: head.trim(),
      base: base.trim(),
      draft: Boolean(draft),
    },
  });

  return {
    ok: true,
    number: created.number,
    htmlUrl: created.html_url,
    title: created.title,
  };
}
