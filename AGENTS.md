# Braivo

Adaptive learning powered by AI: Braivo turns existing educational content into a personal AI tutor.

Before making product or feature decisions, read `docs/product.md` in the `braivo` repository. It defines users, principles, non-goals, and the repository boundary. Shared terms are defined in `docs/glossary.md`. Before changing an area, read its spec in `docs/specs/` and, if there is one, its plan, `local/plans/<area>.md`, gitignored. Update the spec in the same change when behavior, rules, boundaries, or gaps change, not for a refactor; the plan as work goes on. How to write each: `docs/specs/README.md`.

## Working in checkpoints

Work too large for one reviewable commit goes as ordered checkpoints in its plan (format: `docs/specs/README.md`, Plans), one at a time, so the maintainer reviews each before the next builds on it. Each leaves the repository valid and makes one observable thing true: a slice through the layers it needs, not a layer (schema, then API, then UI). The maintainer's instruction for a task overrides these defaults.

1. Before the code, know what proves the checkpoint: an observation that would fail if it were wrong, an automated test where possible. A reproducible bug gets a test that fails first, when practical; a refactor proves the rules it touches still hold.
2. Implement, running `bunx vp check --fix` as you go. Gates: the proof, the focused tests, `bunx vp check`, and for UI a look at the rendered page. A skipped proof leaves the checkpoint unfinished.
3. A risky, large, or uncertain checkpoint (access, migrations or data integrity, a public contract, the learning model) gets one review of its diff against the specs, ADRs, and these rules from a context that did not write it; others wait for the final review. Findings are evidence, not orders: fix each material one, reject it with a reason, or raise it when it changes scope or meaning, then rerun the gates. A preference with no concrete cost does not block.
4. Commit and stop, reporting the commit, what now works, the checks that ran, and what is uncertain. Tick the checkpoint once the maintainer accepts it. Only a batch the maintainer approved runs on without stopping.

Ask the maintainer before deciding or changing behavior or architecture no spec or ADR settles, and before running anything destructive or hard to undo on data worth keeping; implementing what is settled needs no approval. Only the maintainer grants approval, for what they approved: writing it in the plan records it, never creates it, and a batch approval skips the stops between its checkpoints, not a decision found along the way.

After the last checkpoint, a context that did not write the change reviews its whole diff; resolve its material findings, then run the final gates on the result: `bun run test` (skipped only for a documentation-only change, as the report says), `bunx vp check`, and `bun run license:check`. The change is done when the applicable specs describe the resulting behavior and each material decision follows an accepted ADR or is recorded as `docs/adr/README.md` says. A correction the maintainer repeats because this guidance is missing or unclear goes into the narrowest lasting place, not the next prompt: here, `docs/architecture.md`, a spec, a test, or an ADR.

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
- App routes mirror the URL in folders, and signed-in pages go under `routes/_signed-in/`, whose `route.tsx` is the guard (`docs/adr/0016-route-files.md`). A new route file needs its app's `routeTree.gen.ts` regenerated (`bunx vp build` in the app), or `vp check` fails.
- `packages/ui` is a shadcn/ui project (`docs/adr/0012-shadcn-preset.md`, layout in `docs/adr/0011-ui-and-auth-client-packages.md`). For UI work, load the shadcn skill (`npx skills use https://github.com/shadcn-ui/ui --skill shadcn`) and follow its rules, with these differences for this repository:
  - Run the CLI as `bunx shadcn` from `packages/ui`, where `components.json` is. That is the locked version; `@latest` only when deliberately upgrading.
  - `components/` holds shadcn-derived primitives and components; `compositions/` holds reusable components Braivo writes from them, exported from `index.ts` (never re-export shadcn's there). Apps import `@braivo/ui/components/<name>`, `@braivo/ui/lib/utils`, and Braivo's own from `@braivo/ui`.
  - A reusable component with visual, interactive, responsive, accessibility, or theming states worth inspecting in isolation gets a story beside it, `<name>.stories.tsx`; others do not. `bun run storybook` shows them.
  - Prefer wrapping a generated component in one of Braivo's own over editing it. An edit you must make gets a `// Braivo:` comment saying why: upstream diffs have no common ancestor, and the marker is how the next update knows to keep it.
  - To update from upstream: `bunx shadcn add --all --dry-run` lists what differs, `bunx shadcn add <name> --diff <file>` shows how (keep the name before `--diff`, which otherwise takes it as the file). Apply upstream's changes and keep every `// Braivo:` edit. Never `--overwrite` without the maintainer's approval.
  - Switching the preset rewrites the design: ask the maintainer first whether to overwrite (`bunx shadcn apply <preset>`, which reinstalls every component), change only theme and fonts (`apply <preset> --only theme,font`), or merge component by component.
- A source file Braivo writes (`.ts`, `.tsx`, `.css`, shell) starts with the two-line SPDX header in `docs/adr/0002-agpl-only.md`; never add or change one in shadcn's files under `packages/ui`. `bun run license:check` fails on a missing one.
