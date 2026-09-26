# Architecture

Where responsibilities live and which dependencies are allowed. Product intent is in `product.md`, terms in `glossary.md`; implementation details belong in code.

Braivo is early-stage. Architecture optimizes for fast iteration on the learning experience, not for scale.

## Shape

- One TypeScript codebase on Bun, organized as a modular monolith. Do not split it into independently deployed services without a concrete need.
- Server code lives in `apps/server/`, one folder per module. Extract a module into its own package only when a consumer needs it independently.
- `apps/server` exports only its browser client, `@braivo/server/client`, which may import nothing from the server but types. Add exports only when a real consumer requires them.
- `packages/db` owns the database: schema, migrations, client, and test seeding. It stores learning data but holds no learning behaviour and imports nothing from the server; queries live in `persistence`.
- `apps/console` is the content owners' application and `apps/learn` the learner app. Each is served at the root of its own origin together with `/api` — the console on Braivo's origin, the learn app on a domain serving one organization — and reaches the server through that same-origin API ([ADR 0004](adr/0004-one-application-origin.md)). The console addresses an organization by its slug, `/<organization>/…`.
- `packages/ui` holds the apps' tokens and components, `apps/storybook` shows those components, and `packages/auth-client` holds browser authentication helpers ([ADR 0003](adr/0003-workspace-layout.md), [ADR 0011](adr/0011-design-system-and-auth-packages.md), [ADR 0013](adr/0013-ui-package-and-storybook.md)).
- One toolchain, Vite+, configured in the root `vite.config.ts`: `vp check` formats, lints, and type-checks; `bun run test` runs Vitest on Bun.
- Developers integrate over the documented HTTP API. Braivo's own code is AGPL-3.0-only, with a commercial license available, and third-party code keeps its upstream license ([ADR 0002](adr/0002-agpl-only.md)).
- No microservices, queues, or caches until a concrete workflow or measured problem requires them.
- Tests sit next to the code they cover as `*.test.ts`; an app's route tests sit in its `routes.test.tsx`.

## Modules

- **content:** structured learning content and its link to source material. Today, task kinds: what a task asks, what a learner sees of it, and how an answer is graded — pure, like `learning` ([ADR 0015](adr/0015-tasks.md)).
- **learning:** turns learner evidence into knowledge estimates, and estimates into the next objective and learning intent, or into a report of where a learner stands ([spec](specs/learning-model.md)). It does not choose activities: naming one requires subject knowledge it deliberately lacks. One active model, replaced and recomputed rather than selected at runtime ([ADR 0007](adr/0007-one-learning-model.md)).
- **ai:** model calls, prompts, and validation of model output.
- **auth:** identity, sessions, and organization membership, via Better Auth ([ADR 0006](adr/0006-better-auth.md)). Its handler is a standard `Request` → `Response` function, so mounting it does not commit us to a web framework.
- **application:** use cases that coordinate `content`, `learning`, `ai`, and `persistence`. Not `auth`: identity is resolved before a use case is called and reaches it as plain user IDs — the actor's, and the learner's where one is named.
- **persistence:** the queries Braivo asks of its database, shaped for the modules that ask them. The client, tables, and migrations are `packages/db`'s: PostgreSQL with Drizzle ([ADR 0005](adr/0005-postgresql-drizzle.md)).
- **api:** HTTP entry point to `application`, a Hono app over Web-standard `Request` and `Response` ([ADR 0010](adr/0010-hono-http-layer.md)). A route resolves identity from the session, calls one use case, and turns the result into a status; it runs no queries of its own. Only explicitly documented endpoints and types are public contracts.
- **web:** learner and content-owner UI, as the `learn` and `console` apps.
- **cli:** the process and operational entry point — composing the server, applying migrations. A command that does anything beyond that calls the module that owns it — `application`, or `auth` for accounts and organizations — or HTTP where it addresses a remote installation. No business logic.

## Dependency rules

- `learning` is plain, deterministic code: no I/O, network, database, clock, or implicit randomness. Callers pass in the state and values a decision needs.
- `learning` never calls AI. AI may produce evidence, such as a scored answer, that `learning` consumes.
- `api` mounts `auth`'s handler and resolves the session, then hands `application` plain user IDs; `application` never imports `auth`. `cli` imports it to compose the process and to create organizations. `learning` never sees a learner's identity — evidence and estimates carry objective IDs, and the caller keys them by learner.
- Organization context from a request or session is not authorization. A workflow verifies the relevant user's membership or permission before acting on an organization ([ADR 0006](adr/0006-better-auth.md)); passing an `organizationId` explicitly only removes hidden state.
- `content`, `learning`, and `ai` never import `application`, `persistence`, `api`, `web`, or `cli`. Workflows spanning modules belong in `application`.
- `api`, `web`, and `cli` never query persistence directly. Browser code reaches Braivo only over HTTP. `packages/ui` is presentation only and imports no other Braivo package.
- Code that accesses persistence receives its data-access dependencies explicitly, with no global request or tenant state.
- Modules import each other only through the module's `index.ts`, which lists explicit exports (no `export *`). Files within a module import each other directly.
- No import cycles, enforced by `import/no-cycle`.
- `braivo` never depends on Braivo Cloud's code. The managed service builds on this repository; nothing here reaches the other way.

## Data

- Preserve the learner evidence used to derive learning state, including AI-derived evidence passed to `learning`, not only the derived estimates. This lets estimates be recomputed when the learning model changes.
- Store enough immutable task context to interpret an attempt after content changes; edits must not rewrite historical evidence.
- Keep derived content linked to the source material it came from.
- Persistence schemas are implementation details unless exposed through an explicit public contract.

## AI

- Use deterministic code wherever a rule can reasonably be deterministic; use AI for interpretation, transformation, and generation.
- Treat model output as untrusted: validate its structure and constraints before it affects product state or is shown to learners.
- Prompts are version-controlled next to the code that uses them.
- Start with one AI provider behind a thin integration. Do not build a multi-provider abstraction until another provider is actually needed.

## Abstractions

Add an abstraction only for a concrete need: another implementation, an integration boundary, or testability that cannot be achieved simply otherwise.

## Not yet decided

Hosting, AI provider, how tenant data is separated in storage, how learners are enrolled in individual courses (for now, organization membership by invitation stands in for it, [ADR 0018](adr/0018-sign-in-and-invitations.md)), and how Braivo Cloud consumes Braivo. A machine credential for server-to-server callers is open too — evidence is recordable over HTTP today, but only by a session ([ADR 0010](adr/0010-hono-http-layer.md)). Record material choices as ADRs in `adr/` when they are made; do not let architecture emerge implicitly.
