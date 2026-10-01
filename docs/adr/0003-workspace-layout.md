# 0003: Flat apps, a database package, and Vite+ as the one toolchain

Status: accepted (2026-09-16)

## Context

Braivo is one server and two UIs for two audiences, who want different things. A learner needs one question answered: what next. A content owner needs to see their organizations, courses, and learners. Both need to sign in.

A separate tool per job — Bun's test runner, oxlint and oxfmt with their own config files, husky with lint-staged — means as many configurations to keep in step, and no one command that checks everything.

## Decision

```text
/
├── vite.config.ts          # workspace policy: lint, fmt, type check, tests, commit hook
├── apps/
│   ├── server/             # API, learning model, CLI, and the apps' HTTP client
│   ├── learn/              # learners, on an organization's domain (ADR 0004)
│   ├── console/            # content owners, on Braivo's origin (ADR 0004)
│   └── storybook/          # the components' catalog (ADR 0011)
├── packages/
│   ├── db/                 # schema, migrations, client, test seeding
│   ├── ui/                 # presentation (ADR 0011)
│   └── auth-client/        # signing in, for the browser (ADR 0011)
└── tooling/                # shared dev tooling that is not a package
```

**Apps are flat.** An app's `routes/`, `lib/`, `main.tsx`, `index.html`, and `vite.config.ts` sit directly in its directory; a `src/` level would separate nothing from nothing. Folders appear when something goes in them. Both UIs are React with file-based TanStack Router routes and Tailwind, and each route reaches the outside world through the router's context — Braivo's client and the Better Auth client — rather than a module singleton, so a test renders the real route tree against stubs.

**The server is an app too.** It is deployed rather than depended on, so it sits beside the others, flat like them, and publishes nothing ([ADR 0002](0002-agpl-only.md)).

**Apps reach Braivo through `@braivo/server/client` only.** It is the server's one export: an HTTP client whose types are derived from the server's own types rather than restated, and which may import nothing from the server but types. It has a method only for what the apps call, and a contract test pins each against the real server. Identity goes through Better Auth's own client.

**`packages/db` owns the database, and only the database.** It holds the Drizzle schema (Better Auth's generated tables and Braivo's own), the committed migrations, `createDatabase`, `runMigrations`, and the seeding and clean-up that suites use. It knows nothing about learning. The queries stay in the server's `persistence` module, because what they return is shaped by the domain — `readLearnerEvidence` answers with `Evidence` — and a database package importing the learning model would point the dependency the wrong way. The package is flat, like the apps.

**Vite+ is the toolchain.** One root `vite.config.ts` carries lint, format, and staged-file rules and the test projects; `vp check` formats, lints, and type-checks (through tsgolint) in one command, and `vp staged` is the pre-commit hook. An app's `vite.config.ts` says only how that app is served and built. `vite` is overridden to Vite+'s core and `vitest` pinned to the version it bundles, so plugins and tests resolve the same copies `vp` does.

**Tests run on Vitest, under Bun.** `vp test` starts Vitest on Node, but the server and its tests use Bun's APIs, so `bun run test` runs `bun --bun vp test`. A plain `vp test` fails with that instruction rather than with hundreds of `Bun is not defined` failures (`tooling/require-bun.ts`). The server's database suites run one file at a time, because they share one database.

## Alternatives rejected

- **Keep `bun test` for the server and use Vitest for the apps.** Two runners, two sets of matchers, and a test command that cannot run everything. The migration was mechanical, and Vitest on Bun keeps the server's runtime.
- **Move the queries into `packages/db`.** It would make `db` depend on `learning`, or force the query results into shapes that do not say what they mean.

## Consequences

- The server does not serve the built apps. A deployment puts each app and the API behind one origin itself ([ADR 0004](0004-one-application-origin.md)); serving them from the server is what would keep a self-hosted installation a single process.
- Type-aware lint rules run on every check; their first run caught real defects, such as a promise left unawaited in a test teardown.
- The oxlint and oxfmt versions are whatever the pinned Vite+ bundles. Upgrading either means upgrading `vite-plus`.
