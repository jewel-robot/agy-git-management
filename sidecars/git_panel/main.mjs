/**
 * Antigravity Git Management Sidecar HTTP Server.
 *
 * Uses Antigravity's SidecarApp SDK to serve the Git Source Control UI and
 * expose workspace-scoped Git & GitHub REST endpoints at zero LLM token cost.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addWorktree,
  applyHunk,
  checkoutBranch,
  commitChanges,
  createBranch,
  deleteBranch,
  discardFiles,
  discoverRepos,
  getBranchesAndRemotes,
  getCommitDetail,
  getCommitFileDiff,
  getFileDiff,
  getGraph,
  getStashDiff,
  getStashes,
  getStatus,
  mergeBranch,
  removeWorktree,
  resolveAllowedRepo,
  stageFiles,
  stashAction,
  stashSave,
  syncRemote,
  unstageFiles,
} from './git-engine.mjs';
import {
  clearToken,
  createGitHubPull,
  getGitHubItemDetail,
  getGitHubOverview,
  getTokenStatus,
  saveToken,
} from './github-client.mjs';

const { SidecarApp, Response } = await import('sidecar_sdk');

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_STORE = { 'Cache-Control': 'no-store' };
const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function parseWorkspaceUris(raw, fallbackConfig) {
  if (Array.isArray(raw) && raw.length) {
    return raw.filter((u) => typeof u === 'string' && u.trim());
  }
  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr.filter((u) => typeof u === 'string' && u.trim());
      } catch {}
    }
    return trimmed
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(fallbackConfig?.workspaceUris) && fallbackConfig.workspaceUris.length) {
    return fallbackConfig.workspaceUris;
  }
  return [process.cwd()];
}

const app = new SidecarApp();

app.page('/', () => {
  return new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  });
});

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
        headers: NO_STORE,
      }),
    'GET'
  );
}

function handle(fn) {
  return async (data = {}) => {
    try {
      const ws = parseWorkspaceUris(data.workspaces, app.config);
      const result = await fn(data, ws);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

// ---------------------------------------------------------------------------
// Read Endpoints (GET)
// ---------------------------------------------------------------------------

app.api(
  '/api/repos',
  handle(async (_data, ws) => {
    const repos = await discoverRepos(ws);
    return { repos };
  }),
  'GET'
);

app.api(
  '/api/status',
  handle(async (data, ws) => {
    const repos = await discoverRepos(ws);
    if (!repos.length) {
      return { found: false, repos: [] };
    }
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const [status, stashes] = await Promise.all([getStatus(repo), getStashes(repo)]);
    const etag = `${repo}|${status.signature}|stashes:${stashes.length}`;
    if (data.etag && data.etag === etag) {
      return { found: true, unchanged: true, etag, repo, repos };
    }
    const attachUri = (list) =>
      list.map((f) => ({
        ...f,
        fileUri: pathToFileURL(join(repo, f.path)).href,
      }));
    return {
      found: true,
      etag,
      repo,
      repos,
      status: {
        ...status,
        conflicts: attachUri(status.conflicts),
        staged: attachUri(status.staged),
        unstaged: attachUri(status.unstaged),
        untracked: attachUri(status.untracked),
      },
      stashes,
    };
  }),
  'GET'
);

app.api(
  '/api/diff',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const diff = await getFileDiff(repo, {
      path: data.path,
      scope: data.scope || 'unstaged',
    });
    return { diff };
  }),
  'GET'
);

app.api(
  '/api/graph',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const graph = await getGraph(repo, {
      limit: data.limit ? Number(data.limit) : 60,
      skip: data.skip ? Number(data.skip) : 0,
      allBranches: data.allBranches !== 'false' && data.allBranches !== false,
      search: data.search || '',
      author: data.author || '',
      pathFilter: data.pathFilter || '',
    });
    return { graph };
  }),
  'GET'
);

app.api(
  '/api/commit',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const commit = await getCommitDetail(repo, data.hash);
    return { commit };
  }),
  'GET'
);

app.api(
  '/api/commit-diff',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const diff = await getCommitFileDiff(repo, data.hash, data.path);
    return { diff };
  }),
  'GET'
);

app.api(
  '/api/branches',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const dataOut = await getBranchesAndRemotes(repo);
    return dataOut;
  }),
  'GET'
);

app.api(
  '/api/stash-diff',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const diff = await getStashDiff(repo, data.ref);
    return { diff };
  }),
  'GET'
);

app.api(
  '/api/github/overview',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const gh = await getGitHubOverview(repo, { state: data.state || 'open' });
    return { github: gh };
  }),
  'GET'
);

app.api(
  '/api/github/item',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws, { fallbackToFirst: true });
    const item = await getGitHubItemDetail(repo, {
      kind: data.kind === 'pr' ? 'pr' : 'issue',
      number: data.number,
    });
    return { item };
  }),
  'GET'
);

// ---------------------------------------------------------------------------
// Write Endpoints (POST)
// ---------------------------------------------------------------------------

app.api(
  '/api/stage',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return stageFiles(repo, { paths: data.paths, all: Boolean(data.all) });
  })
);

app.api(
  '/api/unstage',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return unstageFiles(repo, { paths: data.paths, all: Boolean(data.all) });
  })
);

app.api(
  '/api/discard',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return discardFiles(repo, { items: data.items, all: Boolean(data.all) });
  })
);

app.api(
  '/api/hunk',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return applyHunk(repo, { patch: data.patch, action: data.action });
  })
);

app.api(
  '/api/commit',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return commitChanges(repo, {
      message: data.message,
      amend: Boolean(data.amend),
      stageAll: Boolean(data.stageAll),
    });
  })
);

app.api(
  '/api/branch/checkout',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return checkoutBranch(repo, { name: data.name, isRemote: Boolean(data.isRemote) });
  })
);

app.api(
  '/api/branch/create',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return createBranch(repo, {
      name: data.name,
      startPoint: data.startPoint || '',
      checkout: data.checkout !== false,
    });
  })
);

app.api(
  '/api/branch/delete',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return deleteBranch(repo, { name: data.name, force: Boolean(data.force) });
  })
);

app.api(
  '/api/branch/merge',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return mergeBranch(repo, { name: data.name });
  })
);

app.api(
  '/api/sync',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return syncRemote(repo, { action: data.action });
  })
);

app.api(
  '/api/worktree/add',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return addWorktree(repo, {
      path: data.path,
      branch: data.branch,
      newBranch: Boolean(data.newBranch),
      startPoint: data.startPoint || '',
    });
  })
);

app.api(
  '/api/worktree/remove',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return removeWorktree(repo, { path: data.path, force: Boolean(data.force) });
  })
);

app.api(
  '/api/stash/save',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return stashSave(repo, {
      message: data.message || '',
      includeUntracked: data.includeUntracked !== false,
    });
  })
);

app.api(
  '/api/stash/action',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return stashAction(repo, { ref: data.ref, action: data.action });
  })
);

app.api(
  '/api/github/token',
  handle(async (data) => {
    if (data.clear) {
      clearToken();
    } else {
      saveToken(data.token);
    }
    const auth = await getTokenStatus();
    return { auth };
  })
);

app.api(
  '/api/github/pr',
  handle(async (data, ws) => {
    const repo = await resolveAllowedRepo(data.repo, ws);
    return createGitHubPull(repo, {
      title: data.title,
      body: data.body || '',
      head: data.head,
      base: data.base,
      draft: Boolean(data.draft),
    });
  })
);

app.run();
