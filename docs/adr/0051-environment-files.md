# 0051: Development defaults are committed in `.env.development`, a developer's values live in `.env.local`, and `serve` reads no env file

Status: accepted (2026-10-29)

## Context

Development needs working defaults and a committed list of what can be set, while a developer's secrets stay out of Git and reach each linked worktree, whose setup copies the files `.worktreeinclude` lists ([ADR 0014](0014-worktree-setup.md)). A deployment needs the opposite: `apps/server/config.ts` refuses to start on a missing setting rather than run on a value nobody meant for that installation, which a development default loaded in production would defeat.

Verified on Bun 1.4.3: without `--env-file`, Bun loads `.env`, `.env.<NODE_ENV>` (`development` while unset), `.env.local` (skipped under `test`), then `.env.<NODE_ENV>.local`, each over the one before and the shell over all; `--no-env-file` loads none, even in a script run by `bun run`. Vite ranks `.env.<mode>` over `.env.local`, the reverse, and production builds skip `.env.development`.

## Decision

**Three files, none of them `.env`:**

| File                     | Git                                        | Holds                                                                                                   |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `.env.development`       | committed                                  | defaults that are no secret (`DATABASE_URL`, `BRAIVO_URL`); the optional settings, as comments          |
| `.env.local`             | ignored, copied into every linked worktree | secrets and own values: `BETTER_AUTH_SECRET`, `TEST_DATABASE_URL`, `ANTHROPIC_API_KEY`, Google's client |
| `.env.development.local` | ignored, one per worktree                  | ports and `BRAIVO_URL`, written by worktree setup (ADR 0014)                                            |

The server's `dev` and `check` scripts name all three in that order, Bun's own. The root `test` script names `.env.local` alone: under `NODE_ENV=test` Bun would skip it, and with it `TEST_DATABASE_URL`, so the database suites would skip unnoticed; the other two describe the running dev servers, which tests have no use for.

Because Vite reverses the order, what either app reads (`BRAIVO_*`, `PORT`) is overridden in `.env.development.local`, which both rank highest. The committed file lists secrets only as comments: a blank assignment there would, under Vite's order, erase `.env.local`'s value.

**`serve` reads its environment alone** (`bun --no-env-file`), so no development default stands in for a setting a deployment left out, whatever `NODE_ENV` says. The demo already runs its server so ([ADR 0043](0043-development-demo.md)).

## Alternatives rejected

- **One ignored `.env` for defaults and secrets** (replaced). Bun loads it in every mode, so its values reached `serve` and `db:migrate` in production; nothing committed listed the settings.
- **Committed `.env` with defaults, secrets in `.env.local`** (Vite's layout). Bun loads `.env` in production, so a deployment missing `DATABASE_URL` would quietly reach `localhost`; and tracking `.env` would have Git overwrite each developer's ignored one, secrets included, on the next pull.
- **Ignored `.env` beside a committed `.env.example`.** Nothing loads the example, so it drifts, and defaults and secrets still share a file every mode loads.
- **The OS credential store, via `Bun.secrets`.** No plaintext copy, but same-user code can query it as the dev server does, and a terminal outside the desktop session, as an agent's after a logout, cannot reach it.
- **A cloud secret manager.** Cloudflare's secrets are readable only by a deployed Worker; Google Secret Manager needs a local credential, as exposed as the key it guards, and a network call per start.
- **The test database in the committed file.** The database suites would fail, rather than skip, without PostgreSQL.

## Consequences

- A contributor writes only `BETTER_AUTH_SECRET` into `.env.local`, plus `TEST_DATABASE_URL` for the database suites; everything else has a working default.
- `.env.local` holds development credentials only (ADR 0014): anything running as the developer, a branch's install scripts included, can read it. A paid key there should be a development key with a spend limit.
- Commands run as `bun <file>` (`db:migrate`, `config check`, `organization create`) load the env files Bun finds, which is what makes them work locally; a deployment runs them with `--no-env-file` (`docs/guides/deployment.md`).
- Tests see only `.env.local`; suites build the configuration they test explicitly.
