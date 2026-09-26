# Braivo

Adaptive learning powered by AI: turn existing educational content into a personal AI tutor.

Braivo is an open-source platform for educators, schools, training providers, and the products they build. It keeps an estimate of what each learner knows and answers one question from it — what should this learner do next — so a course adapts to the person taking it instead of running the same sequence for everyone.

- **Your content, not a generated course.** Braivo sequences and schedules what a content owner already teaches, and keeps the source material authoritative.
- **Decisions that can be explained.** What comes next follows from recorded evidence and a [specified selection rule](docs/specs/learning-model.md), not from an opaque prompt.
- **Self-hostable.** This repository is the whole platform: API, learning model, database schema, learner app, and console. Braivo Cloud adds managed-service concerns and nothing here depends on it.
- **White-label.** An organization runs the learner experience under its own brand and at its own address, with no Braivo branding. For now that is a hostname the operator controls, such as `school.braivo.app`; a domain the organization owns waits on sign-in scoped to that organization ([ADR 0004](docs/adr/0004-one-application-origin.md)).
- **An HTTP API.** Anything the apps do, another application can do.

## Status

Early development, before any release. The HTTP API, the database schema, and both apps change without deprecation or a compatibility layer.

Working end to end: accounts and organizations, objectives arranged into courses, multiple-choice tasks, and the learner loop — the learn app asks the next question, Braivo grades the answer, records it as evidence, and chooses what comes next from it. Also a learner's progress report, and recording evidence graded elsewhere.

Not built yet: content derived from source material, since tasks are written by hand; AI-generated practice and feedback, and task kinds beyond multiple choice; authoring in the console; enrolling learners in a course, which organization membership stands in for; and any deployment packaging ([below](#deployment)).

## How it works

```text
browser apps ──▶ same-origin /api ──▶ Bun server ──▶ PostgreSQL
```

1. A content owner names **objectives**, arranges them into a **course**, and gives each objective **tasks** to practise it with. Position in the course is the order learners meet them in.
2. A learner answers a task, and Braivo grades the answer into **evidence**: which objective, when, and whether it went right. An application that grades elsewhere can record evidence directly.
3. The **learning model** replays that evidence into a knowledge estimate per objective. It is a pure function of the history, so the same evidence always yields the same estimate and a replaced model recomputes rather than migrates.
4. A request for what comes next picks one objective and an intent — introduce, reteach, or review — from those estimates and the course's order, and one of that objective's tasks for the learner to answer.

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
bun run dev        # API on :3000, learn app on :5173, console on :5174

# Sign up in the console, then give that account an organization to manage.
bun apps/server/cli/index.ts organization create \
  --name "My School" --slug my-school --owner you@example.com
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

# Sign up, then have the operator create an organization for that account to
# own the content (ADR 0018): browsers cannot create one.
curl -sc jar.txt -X POST $BRAIVO/api/auth/sign-up/email -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"correct horse battery","name":"Owner"}' >/dev/null

LEARNER=$(curl -sb jar.txt $BRAIVO/api/auth/get-session | field 'r.user.id')

bun apps/server/cli/index.ts organization create \
  --name "Example School" --slug example-school --owner owner@example.com
ORG=$(curl -sb jar.txt $BRAIVO/api/organizations | field 'r.organizations[0].id')

# Name what is taught, then arrange it into a course. Position in objectiveIds
# is the order learners meet them in.
OBJECTIVES=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/objectives \
  -H 'content-type: application/json' -d '{"titles":["Greetings","Numbers"]}' \
  | field 'JSON.stringify(r.objectiveIds)')
FIRST=$(echo "$OBJECTIVES" | field 'r[0]')
SECOND=$(echo "$OBJECTIVES" | field 'r[1]')

COURSE=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/courses \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Beginners\",\"objectiveIds\":$OBJECTIVES}" | field 'r.courseId')

# Give each objective questions with one right answer. Greetings gets two: a
# task rests for ten minutes once answered, because the grade reveals the answer, so
# a learner who misses one is asked the other in the meantime.
curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/tasks \
  -H 'content-type: application/json' -d "{\"tasks\":[
    {\"objectiveId\":\"$FIRST\",\"kind\":\"choice\",\"prompt\":\"Hello, in Spanish?\",
     \"options\":[\"Hola\",\"Adiós\"],\"answer\":0,\"explanation\":\"Adiós is goodbye.\"},
    {\"objectiveId\":\"$FIRST\",\"kind\":\"choice\",\"prompt\":\"Goodbye, in Spanish?\",
     \"options\":[\"Hola\",\"Adiós\"],\"answer\":1},
    {\"objectiveId\":\"$SECOND\",\"kind\":\"choice\",\"prompt\":\"Three, in Spanish?\",
     \"options\":[\"Dos\",\"Tres\"],\"answer\":1}]}" >/dev/null

# Ask what to do next: an objective, and a task to practise it.
ACTIVITY=$(curl -sb jar.txt $BRAIVO/api/courses/$COURSE/activity)
echo "$ACTIVITY"
# {"decision":{"objectiveId":"…","modelVersion":"v1","intent":"introduce"},
#  "task":{"id":"…","kind":"choice","prompt":"Hello, in Spanish?",
#          "options":[{"choice":1,"text":"Adiós"},{"choice":0,"text":"Hola"}]}}
# Options come shuffled; each carries the `choice` that answers with it.

# Answer it, wrongly. Braivo grades the answer and records it as evidence.
TASK=$(echo "$ACTIVITY" | field 'r.task.id')
curl -sb jar.txt -X POST $BRAIVO/api/courses/$COURSE/attempts \
  -H 'content-type: application/json' \
  -d "{\"id\":\"attempt-1\",\"taskId\":\"$TASK\",\"response\":{\"choice\":1}}"
# {"outcome":"failure","correctChoice":0,"explanation":"Adiós is goodbye."}

# What comes next follows from that answer: greetings again, with the other task.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/activity
# {"decision":{…,"intent":"reteach","lastEvidenceAt":"…"},"task":{…,"prompt":"Goodbye, in Spanish?",…}}

# See where the learner stands on each objective, as the organization's owner.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/learners/$LEARNER/progress
# {"modelVersion":"v1","objectives":[{…,"phase":"acquiring",…},{…,"phase":"unseen"}]}
```

The same loop runs in the learn app: with `bun run dev`, sign in at `http://localhost:5173` as `owner@example.com` and choose the course.

A few things that shape how this behaves:

- **The learner is whoever the session belongs to.** `activity` and `attempts` take no learner, so there is no second identity to authorize — the course still is: one in an organization the signed-in user is not in answers 404. One account plays every part above: the organization was created for it, so it is the owner, and owners may practise too.
- **Braivo grades, so a learner may answer for themselves.** They choose the answer, never the outcome. Each attempt carries an ID of the client's choosing, unique per learner, so resending one after a lost answer records it once.
- **Evidence graded elsewhere is a content owner's to record.** An application with its own tasks uses `GET /api/courses/<id>/next` for the bare decision, and `POST /api/organizations/<id>/learners/<id>/evidence` to record outcomes, which needs `owner` or `admin`: a `member` could otherwise grade themselves.
- **Progress is for the people who run the organization.** Reading a learner's standing needs `owner` or `admin`, and the learner has to belong to the organization. Above, the owner reads their own; a `member` asking about anyone, themselves included, gets a 404 — the same answer as a course that does not exist.
- **`at` must be exactly what `Date#toISOString` produces.** Braivo refuses looser formats, because a timestamp is what it orders replay by.
- **New material waits.** While anything in the course is still being acquired, none of its unseen objectives is introduced — so a learner who keeps failing stays within what they have already met instead of being handed more. Above, with one objective started, that means greetings come back until they are passed, and numbers wait; where several are in progress, re-teaching moves between them, oldest first. That is how content order sequences a course, and it is [specified and tested](docs/specs/learning-model.md#selection-rule) rather than incidental.

## An organization's domain

The learn app presents itself as the organization whose domain serves it, per an `organization_domain` row mapping the hostname to the organization; Braivo trusts that origin only while the row exists ([ADR 0004](docs/adr/0004-one-application-origin.md)). There is no API for it yet. Register only a hostname you control, in DNS and in what it serves: learners sign in there with their installation-wide account. Locally, a `*.localhost` name stands in for the domain (it resolves to this machine, and the dev server passes `Host` through); plain `localhost` stays the installation's own. Continuing the walkthrough above, with `DATABASE_URL` from `.env`:

```bash
psql "$DATABASE_URL" -c "insert into organization_domain (hostname, organization_id) values ('example.localhost', '$ORG')"

curl -s http://example.localhost:3000/api/organization
# {"name":"Example School"}
```

The learn app at `http://example.localhost:5173` now wears that name. There the API serves that organization's courses only, answering 404 for others; a hostname that is neither an organization's nor the installation's gets none. In production the hostname is trusted only over HTTPS.

## Deployment

```bash
bun run serve
```

That serves the API and nothing else. **There is no deployment packaging yet** — no image, no static serving, no supported proxy configuration. Self-hosting is what Braivo is for and this repository holds everything an installation runs, but building the apps and putting them in front of the API is currently yours to arrange: each is served at the root of an origin that also serves `/api` from this server ([ADR 0004](docs/adr/0004-one-application-origin.md)). `apps/console` goes on `BRAIVO_URL`'s origin; `apps/learn` goes on a domain serving one organization, which Braivo trusts only while an `organization_domain` row maps that hostname to the organization, and a proxy in front must pass the `Host` header through unchanged. ADR 0004 is only partly implemented, so a procedure written today would describe a layout still changing.

Organizations are created by the operator, for an account that has signed in once, with `bun apps/server/cli/index.ts organization create` and the same environment as `serve`; the console creates none ([ADR 0018](docs/adr/0018-sign-in-and-invitations.md)).

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
