# 0010: Hono for the HTTP layer, and what a route is allowed to do

Status: accepted (2026-09-16)

## Context

`api` is the HTTP entry point to `application` ([architecture.md](../architecture.md)). Beyond routing it has one structural job: mount Better Auth, whose handler is a plain `(Request) => Promise<Response>` ([ADR 0006](0006-better-auth.md)), so that identity has a single entry point rather than one per route.

Braivo runs on Bun and hosting is not decided. Whatever serves the API should therefore be a Web-standard fetch handler rather than something bound to one server API, so that deciding the host later is not also a rewrite of the HTTP layer.

This ADR is late — the layer was built first — so it records what was chosen rather than pretending the choice is still open.

## Decision

Use **Hono**. `createApi({ auth, database, baseUrl })` returns a Hono app, and `braivo serve` hands its `fetch` to `Bun.serve`.

Hono is a router over Web-standard `Request` and `Response`, which is exactly the shape Better Auth's handler already has, so mounting it is an ordinary route rather than an adapter. The same shape lets tests drive `app.request()` without binding a port, and keeps the HTTP boundary portable: what Braivo exposes there is a fetch handler and nothing more. The boundary only — the CLI and its file stores are Bun's ([ADR 0034](0034-node-postgres.md)), so leaving Bun would be a larger change than swapping what serves the routes.

Decided alongside it, and equally part of the contract:

- **The actor comes from the session, never from the request.** Whoever is asking is resolved from Better Auth. A learner who is being _written about_ or _read about_ is named in the path, because they may be somebody other than the actor — progress and evidence both do — and naming them is what there is to authorize; a path naming the actor still does not say who is asking. `next` has no such need: its learner is the actor, so there is nothing to authorize and nothing to get wrong.
- **One `404` for a course the learner cannot see, and a separate `204` for a learner who is caught up.** No such course and another organization's answer identically, since a `404` that appeared only for the second would enumerate those courses one guess at a time. Caught up is safe to tell apart because only a confirmed member reaches it. All three were briefly one `204`, on the reasoning that any separation disclosed something; that held for the first pair and not the third, and cost the distinction a client needs — a learner holding a stale course ID would have been told there was nothing to do, indefinitely.
- **Every read whose answer depends on the cookie or the host answers `Cache-Control: private, no-store`,** set by the route's `noStore` middleware on whatever it answers, a 500 out of the session lookup included. One URL returns different content per cookie, and a `Cookie` request header does not by itself stop a shared cache reusing a response.
- **A route performs no queries of its own.** It resolves who is asking, calls one use case, and turns the result into a status. Anything it had to look up for itself would be a workflow, and workflows belong to `application`.
- **The `next` endpoint serializes `LearningDecision`; `progress` serializes `LearnerProgressReport`**, the model's `KnowledgeReport` with each objective's title. Both are documented in `api/index.ts` and pinned by a test. The browser client's types are derived from them rather than restated ([ADR 0002](0002-agpl-only.md)), so nothing else has to be kept in step.

## Alternatives rejected

- **`Bun.serve` with hand-rolled routing.** No dependency, but Braivo would own path matching and method dispatch, and mounting Better Auth's wildcard would be hand-written. That is a small amount of code to write and a permanent amount to maintain, for a problem a router solves.
- **Express or Fastify.** Both are built around Node's request and response objects, so Better Auth's fetch handler needs an adapter in each direction, and the result is tied to Node semantics that Bun emulates rather than provides.
- **Elysia.** It would also serve: a fetch handler, Better Auth mounted directly, other runtimes through adapters. Hono was preferred for having no transitive dependencies and for treating multi-runtime as the design target rather than an adapter surface. That is a preference, recorded as one — nothing in the route rules above depends on which sits underneath.

## Consequences

- Hono is a runtime dependency of the server. It is small and has no transitive dependencies, which is much of why it is acceptable.
- The API is testable without a socket, so its tests run in the same suite as everything else and need no lifecycle of their own.
- What serves the routes stays open, because Braivo exposes a fetch handler and `Bun.serve` is merely the first thing to call it. The runtime is a separate question: the request path keeps off Bun's own APIs ([ADR 0034](0034-node-postgres.md)), save lifting Bun's idle timeout for a slow model call through the server Hono hands it as `env`, which elsewhere does nothing; but no Worker has served it end to end.
- Hono's default for an unhandled throw is a plain `500 Internal Server Error` with no detail, so no custom error handler was added. Hono makes that answer inside the middleware chain, so `noStore`, setting its header once the route has answered, reaches it too — pinned by a test rather than assumed. A 500 carries no learner data either way.
- A course is authorized in its use case, not its route: a route runs no queries, so `chooseNextObjective` resolves the course's organization and checks membership itself.
- Forged writes are refused rather than left open: a write must be `application/json`, which a browser cannot send cross-origin without a preflight this server does not answer, and any `Origin` it does send must be the host's own: this installation's, or an organization's domain writing to itself ([ADR 0004](0004-one-application-origin.md)). A server-to-server caller sends no `Origin` and sets the content type, so neither check touches it. Every Braivo write is body-limited too. The Better Auth mount is supplied Braivo's body limit and cache policy rather than trusted to have its own, but keeps its own origin validation: it knows which of its endpoints a browser is allowed to reach and Braivo does not.
- Deliberately not addressed for Braivo's own routes, and named here rather than left to be discovered: CORS, rate limiting, request logging, and a machine credential for server-to-server callers. Evidence _is_ recordable over HTTP by an `owner` or `admin` session; what the missing credential blocks is a caller with no browser and no cookie, which is a decision of its own. [ADR 0022](0022-machine-access.md) settles it for a person's own tools, which sign in through the device flow and send `Authorization: Bearer`; a caller acting as no person remains open.
- Better Auth rate-limits its _own_ endpoints under `NODE_ENV=production`, keyed on `X-Forwarded-For`. `braivo serve` supplies no peer address, so — both measured, not assumed — every caller shares one bucket, ten sign-in codes a minute for the whole installation, and any caller can start a fresh one by sending the header themselves. It is protection only behind a proxy that sets that header and keeps the backend unreachable directly; mistaken for brute-force protection without one, it is closer to a way for anybody to lock everybody out. The README says so where an operator will read it.
