# Architecture decision records

One file per material decision: context, the decision, and its consequences. Record a decision when it is made, not afterwards. An ADR states the decision in force, so the list reads as the current design: when a decision changes, amend its ADR in place, listing what it replaced among the alternatives rejected, marked "(replaced)". Git keeps the history. An amendment is accepted with the change that makes it, and the status keeps the date the decision was first accepted. A new decision gets a new ADR, which supersedes an old one only when it replaces it whole.

A number is an identity, not a date: a new ADR takes the next free one, and the number of a merged or removed ADR is never reused. The list below is grouped by what the decision is about, and is the order to read them in.

## Repository

- [0001: Split licensing, copyleft core and permissive SDK](0001-licensing.md) — superseded by 0002
- [0002: AGPL-3.0-only for Braivo's code, with a commercial license, and no SDK package](0002-agpl-only.md)
- [0003: Flat apps, a database package, and Vite+ as the one toolchain](0003-workspace-layout.md)
- [0004: Application origins and organization addressing](0004-one-application-origin.md)
- [0014: One worktree bootstrap script, called from agent tools' hooks](0014-worktree-setup.md)
- [0019: Local notes shared by every worktree through one link](0019-shared-local-notes.md)

## Server

- [0005: PostgreSQL and Drizzle, with committed SQL migrations](0005-postgresql-drizzle.md)
- [0006: Better Auth for identity and organizations](0006-better-auth.md)
- [0007: One learning model, replaced rather than selected](0007-one-learning-model.md)
- [0008: Courses order objectives, and position stops at the module boundary](0008-courses-order-objectives.md)
- [0009: An organization's evidence is read whole, never narrowed to the decision](0009-evidence-read-whole.md)
- [0010: Hono for the HTTP layer, and what a route is allowed to do](0010-hono-http-layer.md)
- [0015: Immutable tasks, graded by Braivo on the learner's submission](0015-tasks.md)
- [0017: A task rests after it is answered](0017-task-rest.md)
- [0018: One sign-in on Braivo's origin, invitations to organizations, and a learner session per learn domain](0018-sign-in-and-invitations.md)
- [0020: Source content is an immutable text snapshot, extracted by whoever holds the file](0020-source-content.md)
- [0021: Citations are quotes Braivo locates, stored as code-point ranges](0021-citations.md)
- [0022: A content owner's tools sign in through the device flow and act as them](0022-machine-access.md)
- [0023: `braivo mcp` serves Braivo's API as tools, through the official SDK](0023-mcp-server.md)
- [0024: Adding what is already there returns what is there](0024-idempotent-authoring.md)
- [0025: A recording enters as timed cues, and a passage cited from it names its moment](0025-timed-transcripts.md)
- [0026: A document enters page by page, and a passage cited from it names its page](0026-paged-documents.md)
- [0027: `braivo` ships as one compiled file per platform](0027-standalone-cli.md)
- [0028: Originals are content-addressed files in a store the installation chooses](0028-original-files.md)
- [0029: Braivo drafts a course from a source on request, checks it, and stores nothing](0029-server-drafting.md)
- [0030: Braivo reads a PDF or photo into pages on request, and the caller adds them](0030-server-extraction.md)
- [0031: Each AI request is recorded, and an operator may set an organization's monthly quota](0031-ai-limits.md)
- [0032: One history per learner, recorded and read per organization](0032-learner-history.md)
- [0033: Email goes out over SMTP, or to the log of an installation only its machine reaches](0033-email-over-smtp.md)

## Web

- [0011: `packages/ui` for presentation, `packages/auth-client` for signing in, and Storybook as an app](0011-ui-and-auth-client-packages.md)
- [0012: shadcn/ui from a preset, updated with shadcn's own CLI](0012-shadcn-preset.md)
- [0016: Route files mirror the URL, and a guard lives in its folder](0016-route-files.md)
