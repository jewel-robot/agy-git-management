# Git Management for Antigravity

A native, zero-dependency Antigravity 2.0 Sidecar Source Control plugin inspired by `dsh-git-management`.

## Features

- **Changes (SCM)**: Conflicts / Staged / Unstaged / Untracked groups, Flat & Tree views with Antigravity-style vector file & folder icons, rename origin hints, `+N/-N` line stats, docked resizable Unified & Split diff drawer with syntax highlighting, hunk-level Stage / Unstage / Discard, Commit & Amend, and Stash diff preview & management.
- **Commit Graph**: VS Code-style left-compacted multi-color SVG DAG commit graph with `HEAD` / `All` scope toggle, HEAD glow, hollow merge rings, branch/tag badges, merge dimming, keyword/author/path filters, and a docked resizable drawer to inspect commit details and file diffs in one click.
- **Branches & Worktrees & Sync**: One-click Fetch / Pull / Push with pending count badges, local & remote branch checkout/create/merge/delete, `gone` upstream indicators, remote URLs, and full `git worktree` management with instant worktree switching.
- **GitHub Integration**: Browse repository info, Issues, Pull Requests, and create PRs directly from the side panel (zero `gh` CLI requirement; public repos work out of the box, with optional Personal Access Token / `GITHUB_TOKEN` / `gh auth token` support for private repos and PR creation).
- **Zero extra LLM tokens**: Directly drives your local `git` binary with zero external npm dependencies, theme-matched custom tooltips, and keyboard navigation (`↑`/`↓`, `Enter`, `Esc`).

## Requirements

- **Antigravity 2.0**
- **Git** available in `$PATH`
- **Node.js 20+** (recommended Node.js 22+) available in `$PATH`

> **Note for `nvm` / `fnm` users**: Antigravity launches Sidecar processes in a non-interactive `$PATH`. If the sidecar reports `exec: "node": executable file not found in $PATH`, either symlink Node into `/usr/local/bin/node` (e.g. `sudo ln -sf "$(which node)" /usr/local/bin/node`) or set the absolute Node path in `sidecars/git_panel/sidecar.json`.

## Install

From GitHub:
```bash
agy plugin install https://github.com/jewel-robot/agy-git-management
```

From a local `.zip` package:
```bash
agy plugin install ./agy-git-management-v0.0.2.zip
```

After installation, enable the **Git Management** sidecar in **Customizations → Installed** (or the Sidecars Dashboard), then open **Git** from the right side-pane `+` button (`Ctrl+T` / `Cmd+T`).

## License

[MIT](LICENSE)
