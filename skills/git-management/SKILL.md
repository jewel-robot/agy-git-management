---
name: git-management
description: Open the native Git Management side-pane panel to inspect working-tree changes, hunk diffs, commit graph, branches, worktrees, stash, sync, and GitHub PRs/Issues. Use when the user runs /git-management or asks to open the Git panel.
---

# Git Management Panel

Open or guide the user to the **Git Management** side-pane panel (`git-management/git_panel`).

## Instructions

1. Check read-only whether the `git-management/git_panel` sidecar is active:
   - Look up `.sidecars["git-management/git_panel"].enabled == true` in `~/.gemini/config/config.json`, or
   - Check if `~/.gemini/antigravity/sidecar_data/git-management/git_panel/logs/sidecar.log` exists and is non-empty.
2. **If active**, output the one-click pill on its own line:
   `[Git Management](sidecar://git-management/git_panel/)`
   Tell the user they can also open it from the `+` button (`Ctrl+T` / `Cmd+T`) in the right auxiliary pane and pin the tab via **Right-click tab -> Pin Tab**.
3. **If not yet enabled**, do not output a `sidecar://git-management/git_panel/` link. Instead, provide:
   - `[Git Management](customization://git-management)`
   - `[Open Sidecars Dashboard](sidecar://dashboard)`
   Tell them to enable the **Git Management** sidecar once so it appears in the side panel `+` menu at zero token cost.
