# Architecture decision records

One file per material decision: context, the decision, and its consequences. Record a decision when it is made, not afterwards. Supersede an ADR with a new one instead of editing a decision that was actually taken; correcting or clarifying an existing one is fine.

A number is an identity, not a date: a new ADR takes the next free one. The list below is grouped by what the decision is about, and is the order to read them in.

## Repository

- [0001: Split licensing, copyleft core and permissive SDK](0001-licensing.md) — superseded by 0002
- [0002: AGPL-3.0-only for Braivo's code, with a commercial license, and no SDK package](0002-agpl-only.md)
- [0003: Two apps, a database package, and Vite+ as the one toolchain](0003-workspace-layout.md)
- [0004: One application origin, addressed by organization](0004-one-application-origin.md)

## Server

- [0005: PostgreSQL and Drizzle, with committed SQL migrations](0005-postgresql-drizzle.md)
- [0006: Better Auth for identity and organizations](0006-better-auth.md)
- [0007: One learning model, replaced rather than selected](0007-one-learning-model.md)
- [0008: Courses order objectives, and position stops at the module boundary](0008-courses-order-objectives.md)
- [0009: Evidence is read whole, not narrowed to the decision](0009-evidence-is-read-whole.md)
- [0010: Hono for the HTTP layer, and what a route is allowed to do](0010-hono-http-layer.md)

## Web

- [0011: A design system package, and sign-in in its own package](0011-design-system-and-auth-packages.md)
- [0012: shadcn/ui from a preset, updated with shadcn's own CLI](0012-shadcn-preset.md)
- [0013: `packages/ui`, and Storybook as an app](0013-ui-package-and-storybook.md)
