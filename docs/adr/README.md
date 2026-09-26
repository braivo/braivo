# Architecture decision records

One file per material decision: context, the decision, and its consequences. Record a decision when it is made, not afterwards. Until a decision ships or something outside this repository depends on it, amend it in place, naming what it replaced among the alternatives rejected. Afterwards, supersede it with a new ADR. Corrections and clarifications may always be made in place.

A number is an identity, not a date: a new ADR takes the next free one. The list below is grouped by what the decision is about, and is the order to read them in.

## Repository

- [0001: Split licensing, copyleft core and permissive SDK](0001-licensing.md) — superseded by 0002
- [0002: AGPL-3.0-only for Braivo's code, with a commercial license, and no SDK package](0002-agpl-only.md)
- [0003: Two apps, a database package, and Vite+ as the one toolchain](0003-workspace-layout.md)
- [0004: Application origins and organization addressing](0004-one-application-origin.md)
- [0014: One worktree bootstrap script, called from agent tools' hooks](0014-worktree-setup.md)

## Server

- [0005: PostgreSQL and Drizzle, with committed SQL migrations](0005-postgresql-drizzle.md)
- [0006: Better Auth for identity and organizations](0006-better-auth.md)
- [0007: One learning model, replaced rather than selected](0007-one-learning-model.md)
- [0008: Courses order objectives, and position stops at the module boundary](0008-courses-order-objectives.md)
- [0009: Evidence is read whole, not narrowed to the decision](0009-evidence-is-read-whole.md)
- [0010: Hono for the HTTP layer, and what a route is allowed to do](0010-hono-http-layer.md)
- [0015: Immutable tasks, graded by Braivo on the learner's submission](0015-tasks.md)
- [0017: A task rests after it is answered](0017-task-rest.md)
- [0018: One sign-in on Braivo's origin, invitations to organizations, and a learner session per learn domain](0018-sign-in-and-invitations.md)

## Web

- [0011: A design system package, and sign-in in its own package](0011-design-system-and-auth-packages.md)
- [0012: shadcn/ui from a preset, updated with shadcn's own CLI](0012-shadcn-preset.md)
- [0013: `packages/ui`, and Storybook as an app](0013-ui-package-and-storybook.md)
- [0016: Route files mirror the URL, and a guard lives in its folder](0016-route-files.md)
