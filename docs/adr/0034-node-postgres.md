# 0034: node-postgres, so the server reaches PostgreSQL from Bun or from Workers through Hyperdrive

Status: proposed (2026-10-04)

## Context

Braivo Cloud may serve the API from Cloudflare Workers, which reach PostgreSQL through Hyperdrive: per database, an uncached configuration and a cached one, which answers a repeated read from up to a minute ago and is never told of a write. Bun's SQL client runs only on Bun. And a Worker never shares an I/O object between requests, so a connection opened for one request cannot serve the next.

## Decision

- **node-postgres (`pg`), through `drizzle-orm/node-postgres`,** everywhere: the server, migrations, tests, and tooling. It is the driver Cloudflare documents for Hyperdrive, and it runs on Bun unchanged. `createDatabase(connectionString)` stays the one constructor, since a Hyperdrive binding hands over a connection string.
- **Drizzle's own `jsonb`.** Bun's client encoded the JSON Drizzle had already serialized, storing a string where an object or array belonged; node-postgres sends Drizzle's as it is, so the pass-through column type and the lint rule against Drizzle's are gone.
- **Databases are arguments, built by whoever serves.** `serve` builds them once. A Worker builds them and the server (`createServer`, `@braivo/server`) per request, and closes nothing: Hyperdrive cleans up a Worker's connections when the request ends. Nothing in `@braivo/db` reads a file or a module URL on import, so a Worker can bundle it.
- **`cachedDatabase` only for reads whose cached answer equals a fresh one.** `createApi` takes it beside `database`, defaulting to it, so a single-database installation changes nothing. A cache is never told of a write, so staleness that merely seems harmless does not qualify. A source does: it never changes ([ADR 0020](0020-source-content.md)), is never deleted, and its ID is generated as it is stored, so nobody asks for it before it exists. Who may read it is still checked through `database`.

## Alternatives rejected

- **postgres.js**, which also runs on Workers. node-postgres is the one Cloudflare documents first for Hyperdrive, and one driver is enough.
- **Bun's client on Bun, another driver on Workers.** Their encodings differ, as `jsonb` showed, so tests on Bun would not exercise the driver Workers run.
- **The cache for reads whose staleness seems harmless**, such as a learn domain's name or a list of courses. The learn app promises a rename on the next load, and a list is what a person reads right after changing it.

## Consequences

- `pg` is a dependency of `@braivo/db`. A raw `execute` answers `{ rows }`, not an array.
- This repository ships no Worker; whoever deploys to Workers writes the entry. One run through local Hyperdrive bindings queried, read in a transaction, and served the API with Better Auth per request; routes reaching hashing or the file stores were not exercised.
- The request path keeps off Bun's own APIs, which a lint rule refuses (`bunFree` in `vite.config.ts`); hashing is `node:crypto`'s. Bun stays in the CLI, the tests, and both file stores (`Bun.file`, `S3Client`), which `serve` builds; a Worker passes its own `FileStore`. That workerd runs the rest, `node:` modules and dependencies included, is for a deployment to prove.
- Built per request, a Worker pays for the route table and Better Auth's setup on every request; measure before caching either.
- A read moves to `cachedDatabase` only with a reason in its doc comment that a cached answer equals a fresh one.
