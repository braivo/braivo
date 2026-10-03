# Braivo

Adaptive learning powered by AI: turn existing educational content into a personal AI tutor.

Braivo is an open-source platform for educators, schools, training providers, and the products they build. It keeps an estimate of what each learner knows and answers one question from it — what should this learner do next — so a course adapts to the person taking it instead of running the same sequence for everyone.

- **Your content, not a generated course.** Braivo sequences and schedules what a content owner already teaches, and keeps the source material authoritative.
- **Decisions that can be explained.** What comes next follows from recorded evidence and a [specified selection rule](docs/specs/learning-model.md), not from an opaque prompt.
- **Self-hostable.** This repository is the whole platform: API, learning model, database schema, learner app, and console. Braivo Cloud adds managed-service concerns and nothing here depends on it.
- **White-label.** An organization runs the learner experience under its own brand and at its own address, with no Braivo branding. That is a hostname such as `school.braivo.app` or one the organization owns: learners sign in on the installation's origin, which hands that domain a session reaching its organization alone ([ADR 0004](docs/adr/0004-one-application-origin.md), [ADR 0018](docs/adr/0018-sign-in-and-invitations.md)).
- **An HTTP API.** Anything the apps do, another application can do.

## Status

Early development, before any release. The HTTP API, the database schema, and both apps change without deprecation or a compatibility layer.

Working end to end: accounts and organizations, objectives arranged into courses, multiple-choice tasks, and the learner loop — the learn app asks the next question, Braivo grades the answer, records it as evidence, and chooses what comes next from it. Also progress: a learner's report and a course's overview, counted per member and per objective; and recording evidence graded elsewhere.

And a course from existing material ([below](#your-materials-a-tutor)): a teacher adds a PDF, a photo, or a video's captions; Braivo's AI drafts objectives and multiple-choice tasks that quote it, which the teacher reviews in the console — or the teacher's own desktop agent writes the course through the same API. A learner who answers wrongly is shown the passage the question came from, with its page or its moment in the video.

Not built yet: task kinds beyond multiple choice, and feedback generated per answer; enrolling learners in a course, which organization membership stands in for; and any deployment packaging ([below](#deployment)).

## How it works

```text
browser apps ──▶ same-origin /api ──▶ Bun server ──▶ PostgreSQL
```

1. A content owner adds **sources** — their material's text, from a PDF, a photo, or a video's captions — and names **objectives**, arranges them into a **course**, and gives each objective **tasks** to practise it with, each citing the passage it was written from. Braivo's AI or the owner's own agent may draft all of it; Braivo checks every quote against the source either way. Position in the course is the order learners meet objectives in.
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

# Sign in to the console with the code the API prints, then give that account
# an organization to manage.
bun apps/server/cli/index.ts organization create \
  --name "My School" --slug my-school --owner you@example.com
```

`.env` is gitignored. Tests that need a database skip themselves when `TEST_DATABASE_URL` is unset; point it at a database of its own, since tests create, modify, and delete fixture data. A linked worktree's tests use that name suffixed with the worktree's Git id (the last part of `git rev-parse --git-dir`), created on first use, which needs `CREATEDB` ([ADR 0014](docs/adr/0014-worktree-setup.md)).

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

# Sign in with a code sent to your email, which makes the account, then have
# the operator create an organization for it to own the content (ADR 0018):
# browsers cannot create one. A local server without BRAIVO_SMTP_URL prints
# the code in its log instead.
curl -s -X POST $BRAIVO/api/auth/email-otp/send-verification-otp -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","type":"sign-in"}' >/dev/null
read -r CODE  # type the code
curl -sc jar.txt -X POST $BRAIVO/api/auth/sign-in/email-otp -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"otp\":\"$CODE\",\"name\":\"Owner\"}" >/dev/null

LEARNER=$(curl -sb jar.txt $BRAIVO/api/auth/get-session | field 'r.user.id')

bun apps/server/cli/index.ts organization create \
  --name "Example School" --slug example-school --owner owner@example.com
ORG=$(curl -sb jar.txt $BRAIVO/api/organizations | field 'r.organizations[0].id')

# Name what is taught, then arrange it into a course. Position in objectiveIds
# is the order learners meet them in.
OBJECTIVES=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/objectives \
  -H 'content-type: application/json' -d '{"objectives":[{"title":"Greetings"},{"title":"Numbers"}]}' \
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
#  "objective":{"id":"…","title":"Greetings"},
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
# {"decision":{…,"intent":"reteach","lastEvidenceAt":"…"},"objective":{…,"title":"Greetings"},
#  "task":{…,"prompt":"Goodbye, in Spanish?",…}}

# See where the learner stands on each objective, as the organization's owner.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/learners/$LEARNER/progress
# {"modelVersion":"v1","objectives":[{…,"title":"Greetings","phase":"acquiring",…},
#  {…,"title":"Numbers","phase":"unseen"}]}

# Or the whole course, counted by standing per member and per objective.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/progress
# {"modelVersion":"v1","learners":[{"userId":"…","name":"Owner","roles":["owner"],
#  "standings":{"unseen":1,"acquiring":1,"retained":0,"due":0}}],
#  "objectives":[{"objectiveId":"…","title":"Greetings",
#  "standings":{"unseen":0,"acquiring":1,"retained":0,"due":0}},{…,"title":"Numbers",…}]}
```

The same loop runs in the learn app: with `bun run dev`, sign in at `http://localhost:5173` as `owner@example.com` and choose the course.

A few things that shape how this behaves:

- **The learner is whoever the session belongs to.** `activity` and `attempts` take no learner, so there is no second identity to authorize — the course still is: one in an organization the signed-in user is not in answers 404. One account plays every part above: the organization was created for it, so it is the owner, and owners may practise too.
- **Braivo grades, so a learner may answer for themselves.** They choose the answer, never the outcome. Each attempt carries an ID of the client's choosing, unique per learner within the course's organization, so resending one after a lost answer records it once.
- **Evidence graded elsewhere is a content owner's to record.** An application with its own tasks uses `GET /api/courses/<id>/next` for the bare decision, and `POST /api/organizations/<id>/learners/<id>/evidence` to record outcomes, which needs `owner` or `admin`: a `member` could otherwise grade themselves.
- **Progress is the learner's, and their organization's administrators'.** A learner reads their own standing — the learn app shows it above each question — and `owner` or `admin` reads any of its learners'. A `member` asking about someone else gets a 404, the same answer as a course that does not exist.
- **`at` must be exactly what `Date#toISOString` produces.** Braivo refuses looser formats, because a timestamp is what it orders replay by.
- **New material waits.** While anything in the course is still being acquired, none of its unseen objectives is introduced — so a learner who keeps failing stays within what they have already met instead of being handed more. Above, with one objective started, that means greetings come back until they are passed, and numbers wait; where several are in progress, re-teaching moves between them, oldest first. That is how content order sequences a course, and it is [specified and tested](docs/specs/learning-model.md#selection-rule) rather than incidental. It holds among objectives that have tasks to practise: one whose tasks are all retired drops out of what the learn app offers, and what follows it moves up.

## An organization's domain

The learn app presents itself as the organization whose domain serves it, per an `organization_domain` row mapping the hostname to the organization; Braivo trusts that origin only while the row exists ([ADR 0004](docs/adr/0004-one-application-origin.md)). The operator registers one per organization; DNS, TLS, and routing it to Braivo are set up outside Braivo. Learners sign in on `BRAIVO_URL`'s `/login`, which hands the domain a learner session of its own. Locally, a `*.localhost` name stands in for the domain (it resolves to this machine, and the dev server passes `Host` through); plain `localhost` stays the installation's own. Continuing the walkthrough above:

```bash
bun apps/server/cli/index.ts organization add-domain \
  --slug example-school --hostname example.localhost
# Registered example.localhost for Example School.

curl -s http://example.localhost:3000/api/organization
# {"name":"Example School"}
```

The learn app at `http://example.localhost:5173` now wears that name. There the API serves that organization's courses only, answering 404 for others; a hostname that is neither an organization's nor the installation's gets none. Signing in there does not work locally: it goes to `BRAIVO_URL`'s `/login` and back over HTTPS, which needs a proxy this repository does not set up. Sign in to the learn app at `http://localhost:5173` instead.

## Your materials, a tutor

Three roads lead from material a teacher already has to a course, and they meet at the same endpoints and the same checks: every quote located in its source and every task a valid one ([ADR 0021](docs/adr/0021-citations.md)). Reviewing before learners see a course is the console's workflow; the API and agents create courses as the person they act for ([ADR 0029](docs/adr/0029-server-drafting.md)).

- **In the console, with Braivo's AI.** Under an organization's Sources, add material with its PDF or a photo attached and no text: Braivo reads it page by page. On the source's page, describe the learners and draft a course; untick what is wrong, name the course, and create it. The course page then shows every objective's passages and tasks, and retires a wrong one. Needs `ANTHROPIC_API_KEY` ([ADR 0029](docs/adr/0029-server-drafting.md), [ADR 0030](docs/adr/0030-server-extraction.md)).
- **With your own desktop agent.** `braivo mcp` gives Claude Desktop, Codex, or Grok Braivo's authoring as tools — the drafting runs on your machine, at your AI's cost ([below](#let-your-desktop-agent-build-the-course)).
- **From the command line.** `braivo sources add` takes text, `pdftotext`'s pages, or a caption file, with its original; objectives and tasks then come from either road above, or from your own scripts over the API ([below](#your-own-material-from-your-own-machine)).

## Your own material, from your own machine

Braivo takes material as text, and extracting it — a PDF's, a video's transcript — can happen wherever you already have the tools: a desktop Claude, Codex, or Grok, `yt-dlp` for YouTube captions, Whisper for speech. The `braivo` command then adds it as you, over the API, to any installation.

Each [release](https://github.com/braivo/braivo/releases) carries `braivo` for your system — one file, nothing else to install ([ADR 0027](docs/adr/0027-standalone-cli.md)). Until the first one, run it from a clone, below.

```sh
curl -Lo braivo https://github.com/braivo/braivo/releases/latest/download/braivo-darwin-arm64
chmod +x braivo && mv braivo /usr/local/bin/
```

Builds exist for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64` (`braivo-windows-x64.exe`). From a clone, `bun apps/server/cli/index.ts` is the same command, and `bun run build` builds it as `apps/server/dist/braivo`.

```sh
# Sign in: open the link it prints, check the code, approve.
braivo login http://localhost:3000

# Fetch a video's Spanish captions.
yt-dlp --skip-download --write-auto-subs --sub-langs es --sub-format vtt -o lesson \
  "https://www.youtube.com/watch?v=…"

# Add the transcript to the organization at …/my-school in the console,
# keeping where it came from and its language.
braivo sources add lesson.es.vtt --organization my-school \
  --title "Los saludos" --url "https://www.youtube.com/watch?v=…" --language es
# prints the new source's ID
```

A `.vtt` or `.srt` file is read into timed lines — markup dropped, and the rolling repeats of auto-generated captions skipped, though a line really said twice is kept — so a passage cited from it opens the video where it is said ([ADR 0025](docs/adr/0025-timed-transcripts.md)). A book's text from `pdftotext`, whose form feeds separate its pages, is added page by page, so a passage names the page to turn to ([ADR 0026](docs/adr/0026-paged-documents.md)):

```sh
pdftotext libro.pdf - | braivo sources add - --organization my-school \
  --title "Mi primer libro" --language es --original libro.pdf
```

`--original` keeps the PDF itself with the text, so whoever reviews the source — or extracts it again, better — has what it came from.

Pages are numbered from 1 at the first page extracted. Where the book numbers it otherwise — after front matter, or for one chapter — give that page's number, even if it is blank:

```sh
pdftotext -f 40 -l 61 libro.pdf - | braivo sources add - --organization my-school \
  --title "Capítulo 3" --language es --first-page 28
```

Any other text is added as it reads. Running the same command again adds nothing: a source Braivo already has, word for word, answers with its ID ([ADR 0024](docs/adr/0024-idempotent-authoring.md)).

The session it keeps in `~/.config/braivo/credentials.json` is yours, with your roles ([ADR 0022](docs/adr/0022-machine-access.md)); `braivo logout` ends it on the server and deletes the file. Objectives and tasks can then cite the source's exact words, which Braivo checks ([ADR 0021](docs/adr/0021-citations.md)).

### Let your desktop agent build the course

`braivo mcp` gives an agent that speaks the Model Context Protocol — Claude Desktop, Codex, Grok — Braivo's authoring as tools, signed in as you. For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "braivo": {
      "command": "/usr/local/bin/braivo",
      "args": ["mcp"]
    }
  }
}
```

Then ask it, say, to "turn this PDF into a Braivo course for beginners". It reads the PDF, adds its text page by page, defines what it teaches, cites the words that teach each objective, writes questions that cite them too, and orders them into a course. Braivo checks every quote against the source and tells the agent which one it could not find, so a model's paraphrase never passes for the source's words ([ADR 0023](docs/adr/0023-mcp-server.md)). The drafting runs on your machine, at your AI's cost. The agent reads files but never uploads them, since the material it reads could steer it to any file on your machine: to keep the PDF with its source, add the source with `braivo sources add --original`, or in the console ([ADR 0028](docs/adr/0028-original-files.md)).

## Deployment

```bash
bun run serve
```

That serves the API and nothing else. **There is no deployment packaging yet** — no image, no static serving, no supported proxy configuration. Self-hosting is what Braivo is for and this repository holds everything an installation runs, but building the apps and putting them in front of the API is currently yours to arrange: each is served at the root of an origin that also serves `/api` from this server ([ADR 0004](docs/adr/0004-one-application-origin.md)). `apps/console` goes on `BRAIVO_URL`'s origin; `apps/learn` goes on a domain serving one organization, which Braivo trusts only while it is registered to the organization, and a proxy in front must pass the `Host` header through unchanged. ADR 0004 is only partly implemented, so a procedure written today would describe a layout still changing.

Organizations are created by the operator, for an account that has signed in once, with `bun apps/server/cli/index.ts organization create` and the same environment as `serve`; the console creates none ([ADR 0018](docs/adr/0018-sign-in-and-invitations.md)). `organization add-domain` registers an organization's learn domain the same way.

`BRAIVO_URL` is the public origin this installation is served from; Better Auth builds callback URLs from it, so it must match how the server is actually reached. `PORT` defaults to 3000.

People sign in with a code sent to their email, so an installation sends email: `BRAIVO_SMTP_URL` is an SMTP server as `smtps://user:password@host` (or `smtp://`, upgraded with STARTTLS where the server offers it), and `BRAIVO_MAIL_FROM` the sender, such as `Braivo <signin@example.com>`. Unset, codes are written to the server's log, but only while `BRAIVO_URL` is `localhost`, `127.0.0.1`, or `[::1]`, and the server then listens there alone; anywhere else `serve` refuses to start ([ADR 0033](docs/adr/0033-email-over-smtp.md)). An address gets one code a minute; per client, Better Auth's limits apply as below.

`ANTHROPIC_API_KEY` lets Braivo draft a course from a source itself, and read an uploaded PDF or photo into its text, for content owners without a desktop agent ([ADR 0029](docs/adr/0029-server-drafting.md), [ADR 0030](docs/adr/0030-server-extraction.md)); unset, those routes answer 501 and content owners draft with their own agents through `braivo mcp`. `BRAIVO_AI_MODEL` picks the model, `claude-sonnet-5` by default. `BRAIVO_AI_ORGANIZATIONS`, comma-separated organization IDs, limits who may spend the key; unset, every organization may, and set but empty or `*`, Braivo refuses to start. `BRAIVO_AI_MONTHLY_LIMIT` is a quota on the AI requests each organization may make in a calendar month — a count, not a spending cap, since one request costs more than another; every request is recorded in `ai_request` either way ([ADR 0031](docs/adr/0031-ai-limits.md)). A proxy in front of Braivo must let these requests run as long as the model may, up to five minutes, where nginx's `proxy_read_timeout` defaults to 60 seconds: one cut off shows the content owner a gateway error and still counts.

`BRAIVO_FILES` is where uploaded files — the PDFs sources were extracted from — are kept: an absolute path on this machine, or `s3://<bucket>` in any S3-compatible store, with `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_REGION` as Bun's S3 client reads them ([ADR 0028](docs/adr/0028-original-files.md)). For Cloudflare R2, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`; for Google Cloud Storage, `https://storage.googleapis.com` with an HMAC key. Unset, the installation keeps no files and its file routes answer 501. A proxy in front of Braivo must accept bodies as large as it does, 50 MB to upload a file and 10 MB to add a source, where nginx's `client_max_body_size` defaults to 1 MB.

**Set `NODE_ENV=production` when you deploy** — it is what enables Better Auth's rate limiting on its own endpoints, and worth knowing the shape of. The limit is keyed on `X-Forwarded-For` and `bun run serve` supplies no peer address, so with nothing in front of it every caller shares one bucket — ten code requests and ten sign-ins a minute across the whole installation — and any caller can sidestep it by sending that header themselves. It is real protection only behind a proxy that sets `X-Forwarded-For` itself and blocks direct access to the backend. Braivo's own routes are not rate limited in any environment.

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
