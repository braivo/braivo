# 0014: One worktree bootstrap script, called from agent tools' hooks

Status: accepted (2026-09-23)

## Context

People and agents work in parallel in linked worktrees created by `git worktree add`, VS Code agent sessions, Zed, or Claude Code. A worktree made by `git worktree add` has only committed files: no `.env`, no `node_modules`, and no Git hooks, since Vite+ installs its hook shims into the gitignored `.vite-hooks/_` during `bun install`. Until then, commits there skip `vp staged`.

When this was decided, the tools prepared worktrees at different layers (verified on Claude Code 2.1.272, VS Code 1.138, Zed 1.20):

- **Git and VS Code.** `git worktree add` runs `post-checkout` inside the new worktree. VS Code creates agent worktrees with plain `git worktree add`.
- **Claude Code** creates worktrees with Git hooks off, copies the gitignored files `.worktreeinclude` lists, then runs `SessionStart` in the new worktree. Its only creation event, `WorktreeCreate`, replaces creation altogether.
- **Zed** can run Git with `core.hooksPath=/dev/null`, and offers a `create_worktree` task hook.

## Decision

**`tooling/worktree-setup.ts` bootstraps a linked worktree for development**: `.worktreeinclude`'s files copied from the main checkout, the gitignored `tmp/` scratch directory created, ports of its own assigned, and dependencies installed from the committed lockfile, which also installs the Git hooks. It never overwrites a file, always runs `bun install` (a no-op that repairs a failed install), and does nothing in the main checkout. It also links the shared notes ([ADR 0019](0019-shared-local-notes.md)).

**Agent tools' own hooks call it; plain Git does not:**

| Trigger                                           | Runs the script                                      |
| ------------------------------------------------- | ---------------------------------------------------- |
| Zed creating a worktree                           | `.zed/tasks.json`, `create_worktree`                 |
| Claude Code session starting in a linked worktree | `.claude/settings.json`, `SessionStart` on `startup` |
| `git worktree add`, VS Code, other                | by hand, or the agent as `AGENTS.md` tells it        |

In VS Code, agents follow `AGENTS.md`. Cloud agents start from the GitHub repository and get none of the main checkout's local files.

These hooks run the worktree's own copy of the script and its `bun install`, so they execute the checked-out branch's code, as the tools already do with the worktree's own `tasks.json` and `settings.json`. `SessionStart` is limited to `startup` so that resuming, clearing, or compacting a conversation does not reinstall.

**`.worktreeinclude` is the one list of files to copy**, because Claude Code reads it natively, including for subagent worktrees no hook reaches. The script accepts only literal paths, the subset of its `.gitignore` syntax that means the same to both, refuses patterns, and like Claude Code copies only paths the worktree ignores.

**Each linked worktree tests against a database of its own**, derived when the server's suites start, not written into `.env`: `tooling/test-database.ts` suffixes `TEST_DATABASE_URL`'s database with the worktree's Git id, verbatim (`braivo_test_braivo1`), and creates it if missing. Past PostgreSQL's 63-byte identifier limit, which worktree folders named after long branches reach, it cuts the id on a character boundary and ends the name in `_` and the first 8 hex characters of the whole name's SHA-256 (`braivo_test_abc-12-a-long-branch-name-a-tool-gave-this_071bb8d3`): still derived and readable in `psql -l`, and ids differing only past the cut are unlikely to collide. A configured name leaving no room for a character of the id is refused. The main checkout uses the configured database. Suites seed fixed IDs, so worktrees sharing one database cleared each other's rows, and one branch's schema broke another's tests.

**Each linked worktree serves on ports of its own, written once into its gitignored `.env.development.local`**: `PORT`, `BRAIVO_URL`, and `BRAIVO_LEARN_PORT`, the variables the servers already read (`tooling/dev-ports.ts`); the console's dev server listens on `BRAIVO_URL`'s port, as `BRAIVO_URL` is locally the console's. Slots are 20 apart, slot 0 the defaults 3000, 5173, and 5174; a worktree takes the first slot whose ports, and its demo's 10 above them ([ADR 0043](0043-development-demo.md)), no other worktree uses. Vite and Bun load the file in development alone, over `.env` and `.env.local`, as the server's dev script does, so every way of starting the apps agrees, and tests and builds never see it. It is the standard file for a checkout's development overrides, which a worktree's ports are, so setup shares it with the developer: written only when missing, never overwritten, editable, and removed with the worktree, the only record of its ports.

## Alternatives rejected

- **A `post-checkout` hook.** It would make a plain `git worktree add` run the checked-out branch's setup and `prepare` scripts, and plain Git must not run a branch's code; an agent environment already runs it. It also ran alongside Zed's task, two installs at once in one checkout.
- **Each tool's own copy list** (`git.worktreeIncludeFiles`, a Zed task that copies, `.worktreeinclude`): lists that drift, and none installs dependencies.
- **A `WorktreeCreate` hook for Claude Code.** It replaces Claude Code's creation, losing its base-branch choice, pull-request checkout, and the marker its clean-up relies on, for what `SessionStart` already gives.
- **A worktree manager CLI.** The editors and agents create worktrees themselves and would not call it.
- **Rewriting `TEST_DATABASE_URL` in a worktree's `.env`.** Claude Code copies `.env` before the script runs, and the script never overwrites, so those worktrees would keep the shared database.
- **A launcher setting the ports as `bun run dev` starts.** One app's `vp dev` or the server alone would miss them, and it would override what the main checkout's `.env` sets.
- **Ports derived from a hash of the worktree's name.** No state, but two worktrees can share ports by chance.
- **A machine-wide registry of ports.** It outlives removed worktrees, and only the tool that writes it reads it.
- **The ports in `.env.local`.** Vite loads it in every mode, builds included.
- **A file of setup's own, such as `.env.worktree`.** Neither Vite nor Bun loads it, so every way of starting the apps would need loading it added.
- **A hostname per worktree, such as `feature.localhost`, behind a proxy.** It would keep cookies apart, but sign-in codes are logged only while `BRAIVO_URL` is `localhost`, `127.0.0.1`, or `[::1]` ([ADR 0033](0033-email-over-smtp.md)), and learn domains already take `<slug>.localhost`.
- **The id verbatim, refusing a name past 63 bytes** (replaced). No server test could run in a worktree named after a long branch.
- **Always a hash of the id.** It would rename, and so orphan, every existing worktree's database, and `psql -l` would not tell them apart.
- **A short name recorded at setup, in `.env.development.local`.** Tests never load that file, and it adds state.
- **A schema per worktree.** Schema names have the same limit, and migrations assume one schema.
- **A fresh database per test run.** A run killed midway leaves its database behind, and a sweep cannot tell that orphan from a live run between files.

## Consequences

- Automatic bootstrap is for trusted branches: it copies `.env`, then runs the branch's install scripts, which could read it. So `.env` holds development credentials only, and untrusted changes are inspected with plain Git, without setup.
- The script copies `.envrc` but never approves it: direnv's approval stays a person's decision.
- A worktree no hook reaches — plain Git, VS Code's Copilot and Codex harnesses, Claude Code mid-session (`EnterWorktree`, a subagent's `isolation: worktree`) — needs the script run in it; the agent does so as `AGENTS.md` tells it, since the script is safe to rerun.
- Worktrees share the development database. Their dev servers run side by side, but cookies ignore ports, so one browser holds one sign-in for every worktree on `localhost`, and Google sign-in works on the main checkout's `BRAIVO_URL` alone, the one its OAuth client names. Test runs collide only within one worktree.
- Setup reads other worktrees' ports as literal values from `.env`, `.env.development`, `.env.local`, and `.env.development.local`, and fails on a worktree's file that leaves any of the three unset. Two worktrees' setups racing may assign the same ports; the second dev server to start then refuses (`strictPort`): edit its file. Variables the shell exports, as from `.envrc`, override them all. A worktree's test database outlives it, and Git may reuse its id: `dropdb` it before removing the worktree, while `git rev-parse --git-dir` still names it. The database is the configured one, decoded from the URL, `_`, and that id; past 63 bytes, it is the one in `psql -l` that starts with as much of that as fits and ends in the hash `printf %s '<database>_<id>' | shasum -a 256 | cut -c1-8` prints, as worktrees sharing the start differ only there.
- Claude Code's worktrees live in the repository, under `.claude/worktrees/`, which is gitignored.
