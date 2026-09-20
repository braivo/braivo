# 0003: Two apps, a database package, and Vite+ as the one toolchain

Status: accepted (2026-09-16). Its origin layout — learn at `/`, console at `/console/` — is superseded by [ADR 0004](0004-one-application-origin.md); the same-origin rule for the API stands.

## Context

Braivo had two packages: `braivo`, holding the server, schema, migrations, and CLI, and `@braivo/sdk`. It had no UI at all, although `architecture.md` has always named one — for learners and for content owners. The toolchain was a separate tool per job: Bun's test runner, oxlint and oxfmt with their own config files, and husky with lint-staged.

Two audiences need a UI now, and they want different things. A learner needs one question answered: what next. A content owner needs to see their organizations, courses, and learners. Both need to sign in.

## Decision

```text
/
├── vite.config.ts          # workspace policy: lint, fmt, type check, tests, commit hook
├── apps/
│   ├── server/             # API, learning model, CLI, and the apps' HTTP client
│   ├── learn/              # learners; served at /
│   └── console/            # content owners; served at /console/
├── packages/
│   ├── db/                 # schema, migrations, client, test seeding
│   └── ui/                 # what both apps share (since split, ADR 0011)
└── tooling/                # shared config that is not a package
```

**Apps are flat.** An app's `routes/`, `lib/`, `main.tsx`, `index.html`, and `vite.config.ts` sit directly in its directory; a `src/` level would separate nothing from nothing. Folders appear when something goes in them. Both are React with file-based TanStack Router routes and Tailwind, and each route reaches the outside world through the router's context — the SDK client and the Better Auth client — rather than a module singleton, so a test renders the real route tree against stubs.

**The server is an app too.** It is deployed rather than depended on, so it sits beside the other two, flat like them, and publishes nothing ([ADR 0002](0002-agpl-only.md)).

**Apps reach Braivo through `@braivo/server/client` only.** It is the server's one export: an HTTP client whose types are derived from the domain, and which may import nothing from the server but types. The apps needed `listCourses` and `listObjectives`, both over routes that already existed, and a contract test pins each against the real server. Identity goes through Better Auth's own client.

**Apps share an origin with the API.** Both Braivo and Better Auth refuse a write whose `Origin` is not `BRAIVO_URL`'s, and the client already documented same-origin as the supported arrangement. So the learn app is served at `/`, the console under `/console/`, and the API at `/api/`, on one origin. In development each Vite server stands in for that site: it proxies `/api` to the server, and rewrites the `Origin` of a request that is same-origin _to itself_ into the API's (`tooling/dev-proxy.ts`). A page on any other site still sends its own `Origin` and is still refused. The server keeps one trusted origin rather than a list that would have to be configured, validated, and kept in step with Better Auth's.

**`packages/db` owns the database, and only the database.** It holds the Drizzle schema (Better Auth's generated tables and Braivo's own), the committed migrations, `createDatabase`, `runMigrations`, and the seeding and clean-up that suites use. It knows nothing about learning. The queries stay in the server's `persistence` module, because what they return is shaped by the domain — `readLearnerEvidence` answers with `Evidence` — and a database package importing the learning model would point the dependency the wrong way. The package is flat, like the apps.

**`packages/ui` holds what must not drift** (since replaced by `packages/design-system` and `packages/auth-client`, [ADR 0011](0011-design-system-and-auth-packages.md)). The sign-in form and `safeRedirect`, which keeps a post-sign-in redirect on the app's own origin, are identical in both apps, and a security check copied twice is one that gets fixed once. Nothing moves there merely because both apps might use it someday.

**Vite+ is the toolchain.** One root `vite.config.ts` carries lint, format, and staged-file rules and the test projects; `vp check` formats, lints, and type-checks (through tsgolint) in one command, and `vp staged` is the pre-commit hook. An app's `vite.config.ts` says only how that app is served and built. `vite` is overridden to Vite+'s core and `vitest` pinned to the version it bundles, so plugins and tests resolve the same copies `vp` does.

**Tests run on Vitest, under Bun.** `vp test` starts Vitest on Node, but the server and its tests use Bun's APIs, so `bun run test` runs `bun --bun vp test`. A plain `vp test` fails with that instruction rather than with hundreds of `Bun is not defined` failures (`tooling/require-bun.ts`). The server's database suites run one file at a time, because they share one database.

## Alternatives rejected

- **Keep `bun test` for the server and use Vitest for the apps.** Two runners, two sets of matchers, and a test command that cannot run everything. The migration was mechanical, and Vitest on Bun keeps the server's runtime.
- **Move the queries into `packages/db`.** It would make `db` depend on `learning`, or force the query results into shapes that do not say what they mean.
- **Trust the app origins on the server.** Better Auth reads `BETTER_AUTH_TRUSTED_ORIGINS` on its own, but Braivo's own write check would need the same list, and a deployment would gain a setting whose only purpose is to be wrong in a new way. Same-origin needs no setting.
- **A shared package for all app code.** Two apps with a handful of screens each do not have a shared component library; they have a sign-in form.

## Consequences

- The server does not serve the built apps yet. Until it does, a deployment has to put the apps and the API behind one origin itself. Serving them from the server is the natural next step, and it is what keeps a self-hosted installation a single process.
- The console creates organizations and reads what is in them, but does not author content yet: objectives and courses are created through the API, as the README walkthrough shows.
- The learn app has no course list. The API has no endpoint that lists a learner's courses, and none can exist until enrolment is decided ([architecture.md](../architecture.md)). A learner opens a course by its link.
- Type-aware lint rules now run on every check, and caught real defects on their first run, such as a promise left unawaited in a test teardown.
- The oxlint and oxfmt versions are whatever the pinned Vite+ bundles. Upgrading either means upgrading `vite-plus`.
