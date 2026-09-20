# Braivo

Adaptive learning powered by AI: turn existing educational content into a personal AI tutor.

Braivo is an open-source platform for educators, schools, training providers, and the products they build. It keeps an estimate of what each learner knows and answers one question from it — what should this learner do next — so a course adapts to the person taking it instead of running the same sequence for everyone.

- **Your content, not a generated course.** Braivo sequences and schedules what a content owner already teaches, and keeps the source material authoritative.
- **Decisions that can be explained.** What comes next follows from recorded evidence and a [specified selection rule](docs/specs/learning-model.md), not from an opaque prompt.
- **Self-hostable.** This repository is the whole platform: API, learning model, database schema, learner app, and console. Braivo Cloud adds managed-service concerns and nothing here depends on it.
- **White-label.** An organization runs the learner experience under its own brand and domain, with no Braivo branding.
- **An HTTP API.** Anything the apps do, another application can do.

## Status

Early development, before any release. The HTTP API, the database schema, and both apps change without deprecation or a compatibility layer.

Working end to end, over the API and in both apps: accounts and organizations, objectives arranged into courses, recorded evidence, the next-objective decision, and a learner's progress report.

Not built yet: the content itself, since an objective is currently a title and nothing else; AI-generated practice and feedback; enrolling learners in a course, which organization membership stands in for; and any deployment packaging ([below](#deployment)).

## How it works

```text
browser apps ──▶ same-origin /api ──▶ Bun server ──▶ PostgreSQL
```

1. A content owner names **objectives** and arranges them into a **course**. Position in the course is the order learners meet them in.
2. Braivo records **evidence**: which objective a learner attempted, when, and how it went.
3. The **learning model** replays that evidence into a knowledge estimate per objective. It is a pure function of the history, so the same evidence always yields the same estimate and a replaced model recomputes rather than migrates.
4. A request for what comes next picks one objective and an intent — introduce, reteach, or review — from those estimates and the course's order.

AI generates and interprets learning material; it does not decide learning state. That decision is deterministic and [specified](docs/specs/learning-model.md) rather than prompted, which is what makes it testable and explainable to the content owner.

## Quick start

Requires [Bun](https://bun.com) and PostgreSQL.

```bash
bun install
createdb braivo
createdb braivo_test
cat > .env <<ENV
DATABASE_URL=postgres://localhost/braivo
TEST_DATABASE_URL=postgres://localhost/braivo_test
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
BRAIVO_URL=http://localhost:3000
ENV
bun run db:migrate
bun run dev        # API on :3000, learn app on :5173, console on :5174/console/
```

`.env` is gitignored. Tests that need a database skip themselves when `TEST_DATABASE_URL` is unset; point it at a database of its own, since tests create, modify, and delete fixture data.

```bash
bun run test       # Vitest, on Bun
bunx vp check      # format, lint, and type-check; add --fix to fix
bun run storybook  # the component catalog
```

Run tests with `bun run test` rather than `vp test`, which starts Vitest on Node, where the server's code cannot run.

## The API, end to end

The whole loop, against a running server. Each step answers with an ID the next one needs, so they are captured as they go; `jar.txt` carries the session throughout.

```bash
BRAIVO=http://localhost:3000
field() { bun -e "const r = JSON.parse(await Bun.stdin.text()); console.log($1)"; }

# Sign up, then create an organization to own the content. Better Auth checks
# the request origin on its own endpoints, so that one needs the header;
# Braivo's routes below do not.
curl -sc jar.txt -X POST $BRAIVO/api/auth/sign-up/email -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"correct horse battery","name":"Owner"}' >/dev/null

LEARNER=$(curl -sb jar.txt $BRAIVO/api/auth/get-session | field 'r.user.id')

ORG=$(curl -sb jar.txt -c jar.txt -X POST $BRAIVO/api/auth/organization/create \
  -H 'content-type: application/json' -H "origin: $BRAIVO" \
  -d '{"name":"Example School","slug":"example-school"}' | field 'r.id')

# Name what is taught, then arrange it into a course. Position in objectiveIds
# is the order learners meet them in.
OBJECTIVES=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/objectives \
  -H 'content-type: application/json' -d '{"titles":["Greetings","Numbers"]}' \
  | field 'JSON.stringify(r.objectiveIds)')
FIRST=$(echo "$OBJECTIVES" | field 'r[0]')

COURSE=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/courses \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Beginners\",\"objectiveIds\":$OBJECTIVES}" | field 'r.courseId')

# Ask what to do next, record how it went, ask again.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/next
# {"objectiveId":"…","modelVersion":"v1","intent":"introduce"}

curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/learners/$LEARNER/evidence \
  -H 'content-type: application/json' \
  -d "{\"evidence\":[{\"id\":\"attempt-1\",\"objectiveId\":\"$FIRST\",\"outcome\":\"failure\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}]}"

curl -sb jar.txt $BRAIVO/api/courses/$COURSE/next
# {"objectiveId":"…","intent":"reteach","lastEvidenceAt":"…"}

# See where the learner stands on each objective, as the organization's owner.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/learners/$LEARNER/progress
# {"modelVersion":"v1","objectives":[{…,"phase":"acquiring",…},{…,"phase":"unseen"}]}
```

A few things that shape how this behaves:

- **The learner is whoever the session belongs to.** `next` takes no learner, so there is no second identity to authorize — the course still is: one in an organization the signed-in user is not in answers 404. The evidence route names a learner because it writes about someone else.
- **Grading is a content owner's act.** Recording evidence needs `owner` or `admin` in the organization, so someone who is only a `member` cannot grade themselves. One account plays both parts above — it created the organization, so it is the owner — which is why it can record evidence about itself. Invite a second account as a member and it will get decisions but be refused the write.
- **Progress is for the people who run the organization.** Reading a learner's standing needs `owner` or `admin`, and the learner has to belong to the organization. Above, the owner reads their own; a `member` asking about anyone, themselves included, gets a 404 — the same answer as a course that does not exist.
- **`at` must be exactly what `Date#toISOString` produces.** Braivo refuses looser formats, because a timestamp is what it orders replay by.
- **New material waits.** While anything in the course is still being acquired, none of its unseen objectives is introduced — so a learner who keeps failing stays within what they have already met instead of being handed more. Above, with one objective started, that means the same one comes back until it is passed; where several are in progress, re-teaching moves between them, oldest first. That is how content order sequences a course, and it is [specified and tested](docs/specs/learning-model.md#selection-rule) rather than incidental.

## Deployment

```bash
bun run serve
```

That serves the API and nothing else. **There is no deployment packaging yet** — no image, no static serving, no supported proxy configuration. Self-hosting is what Braivo is for and this repository holds everything an installation runs, but building the apps and putting them in front of the API is currently yours to arrange: they have to reach it from their own origin — `apps/learn` at `/`, `apps/console` at `/console/` — since Braivo and Better Auth refuse a write from any other. [ADR 0004](docs/adr/0004-one-application-origin.md) replaces that addressing and is not implemented, so a procedure written today would describe a layout about to change.

`BRAIVO_URL` is the public origin this installation is served from; Better Auth builds callback URLs from it, so it must match how the server is actually reached. `PORT` defaults to 3000.

**Set `NODE_ENV=production` when you deploy** — it is what enables Better Auth's rate limiting on its own endpoints, and worth knowing the shape of. The limit is keyed on `X-Forwarded-For` and `bun run serve` supplies no peer address, so with nothing in front of it every caller shares one bucket — three sign-ins per ten seconds across the whole installation — and any caller can sidestep it by sending that header themselves. It is real protection only behind a proxy that sets `X-Forwarded-For` itself and blocks direct access to the backend. Braivo's own routes are not rate limited in any environment.

The server mounts Better Auth at `/api/auth/*` and serves the learning API alongside it:

```bash
curl -i http://localhost:3000/api/courses/<course-id>/next   # 401 without a session
```

## Development

The repository is one [Vite+](https://viteplus.dev) workspace ([ADR 0003](docs/adr/0003-workspace-layout.md)):

```text
apps/learn              the learner app
apps/console            the content owners' app
apps/server             the API, the learning model, and the CLI, plus the browser client the apps import
apps/storybook          the component catalog, stories kept beside what they show
packages/db             schema, migrations, and database client
packages/ui             shadcn/ui components generated from a preset, and Braivo's own
packages/auth-client    signing in, for both apps
vite.config.ts          lint, format, test, and pre-commit rules for all of them
```

Each app's dev server proxies `/api` to the server, so the apps are same-origin with the API, as in production.

Schema changes are made through committed migrations; `drizzle-kit push` is not part of the workflow. Migrations are generated, and a hand-written one says at its top why it had to be:

```bash
bun run --cwd apps/server auth:generate   # Better Auth tables -> packages/db/schema/auth.ts
bun run db:generate                       # schema diff -> packages/db/migrations/
```

Read the generated SQL before committing it, and commit schema and migration together ([ADR 0005](docs/adr/0005-postgresql-drizzle.md)).

The design system is a shadcn/ui project, generated from a [shadcn preset](https://ui.shadcn.com/create?pointer=true&base=radix&preset=b4aRK5K0fb) ([ADR 0012](docs/adr/0012-shadcn-preset.md)). Run the shadcn CLI from `packages/ui`, where `components.json` is; `AGENTS.md` has the update workflow and the rule that keeps Braivo's marked edits through an upstream change.

## Docs

- [Product](docs/product.md) — users, core jobs, principles, and non-goals
- [Architecture](docs/architecture.md) — the modules, their boundaries, and the dependency rules between them
- [Glossary](docs/glossary.md) — the terms the code and the docs both use
- [Decisions](docs/adr/README.md) — what was decided, and why
- [Specifications](docs/specs/README.md) — behavior stated precisely and pinned by tests

## License

Copyright © 2026 Konstantin Tarkus. Braivo's own code is licensed under [AGPL-3.0-only](LICENSE): if you modify Braivo and offer it to users over a network, you must offer those users the complete corresponding source of the version they are using, under the same license.

Third-party code, such as the shadcn/ui components, keeps its upstream license, as `REUSE.toml` records. A commercial license for Braivo's code is available for use that cannot comply with the AGPL: hello@braivo.app. A separate application does not become subject to Braivo's AGPL solely because it communicates with Braivo over its HTTP API.

The repository follows [REUSE](https://reuse.software); `bun run license:check` verifies it (needs [uv](https://docs.astral.sh/uv/)). Rationale in [ADR 0002](docs/adr/0002-agpl-only.md).
