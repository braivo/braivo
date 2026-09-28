# 0019: Local notes shared by every worktree through one link

Status: accepted (2026-09-28).

## Context

Work on an area spans sessions and worktrees, and keeps notes too rough or private for Git: a queue across areas, workspace findings, and a plan per area (`docs/specs/README.md`). Copied into each worktree by [ADR 0014](0014-worktree-setup.md)'s `.worktreeinclude`, they diverged: each worktree edited its own copy, and nothing reconciled them. Linking each note file instead still missed a plan created in a worktree after setup, and left a link to a deleted one behind.

## Decision

**The main checkout's gitignored `local/` is the one set of notes; `tooling/worktree-setup.ts` links each linked worktree's `local/` to it as a whole**, creating it if missing. A note made or deleted in any worktree is so for all, with nothing to reconcile.

- `/local` is gitignored without a trailing slash, so the pattern matches the link as well as the directory.
- Setup never overwrites anything else at `local/`, such as a worktree's own directory or a dangling link: it reports it, and a person or agent moves what is worth keeping and reruns. A `.gitignore` without `/local` is reported the same way. Neither leaves an agent silently without its notes.
- `local/` is never in `.worktreeinclude`, or Claude Code would copy it before setup could link it. `AGENTS.local.md` stays there: Claude Code reads it at session start, before any hook.

## Alternatives rejected

- **Copying `local/` into each worktree:** copies diverge at the first edit.
- **A link per note file:** notes created or deleted after setup do not follow.
- **Committing the notes:** publishes temporary, sometimes private, state and turns disposable work into history.
- **A notes directory outside the repository:** another location to find and set up, for no benefit yet.

## Consequences

- One worktree works on an area at a time: sessions editing the same note concurrently lose to the last write.
- Deleting through the link deletes for every worktree.
- The link is absolute: after moving the main checkout, delete it and rerun setup.
- Cloud agents start from the GitHub repository and get no notes.
