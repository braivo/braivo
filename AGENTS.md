# Braivo

Adaptive learning powered by AI: Braivo turns existing educational content into a personal AI tutor.

Before making product or feature decisions, read `docs/product.md` in the `braivo` repository. It defines users, principles, non-goals, and the repository boundary. Shared terms are defined in `docs/glossary.md`.

## Where things live

```text
apps/server            API, use cases, learning model, auth, queries, CLI (one Bun process)
  api/                 Hono routes; api/client.ts is the browser client (@braivo/server/client)
  application/         use cases: resolve scope, check access, then call learning and persistence
  learning/            pure learning model; spec in docs/specs/learning-model.md
  persistence/         queries; tables live in packages/db
  auth/                Better Auth server config
  cli/                 process entry point (serve, db migrate)
apps/learn             learner app (white-label, per organization; demo.braivo.app)
apps/console           content owners' app
apps/storybook         catalog of @braivo/ui
packages/db            schema, migrations, database client, test seeding
packages/ui            components/ from shadcn, compositions/ by Braivo
packages/auth-client   browser sign-in: auth client, form, session guard
tooling/               shared dev tooling: dev proxy, Bun test guard, worktree setup
docs/                  product, architecture, glossary, adr/, specs/
```

## Workspace

One Vite+ workspace; layout and rationale in `docs/adr/0003-workspace-layout.md`.

- Zed worktrees, and linked worktrees where a new Claude Code session starts, are bootstrapped automatically (`docs/adr/0014-worktree-setup.md`). In any other linked worktree, run `bun tooling/worktree-setup.ts` before development commands.
- `bunx vp check --fix` formats, lints, and type-checks everything. Run it before finishing a change.
- `bun run test` runs every test. Not `vp test`: the server needs Bun, and `vp test` starts Node.
- Lint, format, and test settings live only in the root `vite.config.ts`.
- App routes mirror the URL in folders, and signed-in pages go under `routes/_signed-in/`, whose `route.tsx` is the guard (`docs/adr/0016-route-files.md`).
- `packages/ui` is a shadcn/ui project (`docs/adr/0012-shadcn-preset.md`, layout in `docs/adr/0013-ui-package-and-storybook.md`). For UI work, load the shadcn skill (`npx skills use https://github.com/shadcn-ui/ui --skill shadcn`) and follow its rules, with these differences for this repository:
  - Run the CLI as `bunx shadcn` from `packages/ui`, where `components.json` is. That is the locked version; `@latest` only when deliberately upgrading.
  - `components/` holds shadcn-derived primitives and components; `compositions/` holds reusable components Braivo writes from them, exported from `index.ts` (never re-export shadcn's there). Apps import `@braivo/ui/components/<name>`, `@braivo/ui/lib/utils`, and Braivo's own from `@braivo/ui`.
  - A reusable component with visual, interactive, responsive, accessibility, or theming states worth inspecting in isolation gets a story beside it, `<name>.stories.tsx`; others do not. `bun run storybook` shows them.
  - Prefer wrapping a generated component in one of Braivo's own over editing it. An edit you must make gets a `// Braivo:` comment saying why: upstream diffs have no common ancestor, and the marker is how the next update knows to keep it.
  - To update from upstream: `bunx shadcn add --all --dry-run` lists what differs, `bunx shadcn add <name> --diff <file>` shows how (keep the name before `--diff`, which otherwise takes it as the file). Apply upstream's changes and keep every `// Braivo:` edit. Never `--overwrite` without the maintainer's approval.
  - Switching the preset rewrites the design: ask the maintainer first whether to overwrite (`bunx shadcn apply <preset>`, which reinstalls every component), change only theme and fonts (`apply <preset> --only theme,font`), or merge component by component.
- A source file Braivo writes (`.ts`, `.tsx`, `.css`, shell) starts with the two-line SPDX header in `docs/adr/0002-agpl-only.md`; never add or change one in shadcn's files under `packages/ui`. `bun run license:check` fails on a missing one.
