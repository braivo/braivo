# 0014: One worktree bootstrap script, called from agent tools' hooks

Status: accepted (2026-09-23).

## Context

People and agents work in parallel in linked worktrees created by `git worktree add`, VS Code agent sessions, Zed, or Claude Code. A new worktree has only committed files: no `.env`, no `node_modules`, and no Git hooks, since Vite+ installs its hook shims into the gitignored `.vite-hooks/_` during `bun install`. Until then, commits there skip `vp staged`.

The tools prepare worktrees at different layers (verified on Claude Code 2.1.272, VS Code 1.138, Zed 1.20):

- **Git and VS Code.** `git worktree add` runs `post-checkout` inside the new worktree. VS Code creates agent worktrees with plain `git worktree add`.
- **Claude Code** creates worktrees with Git hooks off, copies the gitignored files `.worktreeinclude` lists, then runs `SessionStart` in the new worktree. Its only creation event, `WorktreeCreate`, replaces creation altogether.
- **Zed** can run Git with `core.hooksPath=/dev/null`, and offers a `create_worktree` task hook.

## Decision

**`tooling/worktree-setup.ts` bootstraps a linked worktree for development**: `.worktreeinclude`'s files copied from the main checkout, the gitignored `tmp/` scratch directory created, and dependencies installed from the committed lockfile, which also installs the Git hooks. It never overwrites a file, always reinstalls (a no-op that repairs a failed install), and does nothing in the main checkout.

**Agent tools' own hooks call it; plain Git does not:**

| Trigger                                           | Runs the script                                      |
| ------------------------------------------------- | ---------------------------------------------------- |
| Zed creating a worktree                           | `.zed/tasks.json`, `create_worktree`                 |
| Claude Code session starting in a linked worktree | `.claude/settings.json`, `SessionStart` on `startup` |
| `git worktree add`, VS Code, other                | by hand, or the agent as `AGENTS.md` tells it        |

In VS Code it depends on the agent harness: Copilot and Codex follow `AGENTS.md`; the Claude harness runs on the Claude Agent SDK, so it may run the `SessionStart` hook too (unverified). Cloud agents start from the GitHub repository and get none of the main checkout's local files.

These hooks run the worktree's own copy of the script and its `bun install`, so they execute the checked-out branch's code, as the tools already do with the worktree's own `tasks.json` and `settings.json`. `SessionStart` is limited to `startup` so that resuming, clearing, or compacting a conversation does not reinstall.

**`.worktreeinclude` is the one list of local files**, because Claude Code reads it natively, including for subagent worktrees no hook reaches. The script accepts only literal paths, the subset of its `.gitignore` syntax that means the same to both, refuses patterns, and like Claude Code copies only paths the worktree ignores.

## Alternatives rejected

- **A `post-checkout` hook.** It would make a plain `git worktree add` run the checked-out branch's code: its setup script and its `prepare` script. A Git operation must not execute a branch; an agent environment is already one that executes code. It also ran alongside Zed's task, two installs at once in one checkout.
- **Each tool's own copy list** (`git.worktreeIncludeFiles`, a Zed task that copies, `.worktreeinclude`): lists that drift, and none installs dependencies.
- **A `WorktreeCreate` hook for Claude Code.** It replaces Claude Code's creation, losing its base-branch choice, pull-request checkout, and the marker its clean-up relies on, for what `SessionStart` already gives.
- **A worktree manager CLI.** The editors and agents create worktrees themselves and would not call it.
- **Approving `.envrc` automatically.** direnv's approval is a person's decision; the script only copies the file.

## Consequences

- Automatic bootstrap is for trusted development worktrees, not a sandbox for inspecting untrusted changes: use plain Git for those.
- Agents read `.env` in their worktrees, so it holds development credentials only.
- A worktree no hook reaches — plain Git, VS Code's Copilot and Codex harnesses, Claude Code mid-session (`EnterWorktree`, a subagent's `isolation: worktree`) — needs the script run in it; the agent does so as `AGENTS.md` tells it, since the script is safe to rerun.
- Worktrees share ports and the databases `.env` names, so concurrent dev servers or database suites collide. The script does not isolate them.
- Claude Code's worktrees live in the repository, under `.claude/worktrees/`, which is gitignored.
