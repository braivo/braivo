# 0012: shadcn/ui from a preset, updated with shadcn's own CLI

Status: accepted (2026-09-16). Supersedes the component choices in [ADR 0011](0011-design-system-and-auth-packages.md). Paths below are as moved by [ADR 0013](0013-ui-package-and-storybook.md).

## Context

Braivo's look is designed on ui.shadcn.com/create, which describes a whole design — component library, style, colors, fonts, icons — as one URL:

```text
https://ui.shadcn.com/create?pointer=true&base=radix&preset=b4aRK5K0fb
```

The components have to be generated from it, and upstream improvements pulled in later without losing the few edits Braivo makes to them.

A custom sync was built first: a scratch project, a committed snapshot of the last upstream output, and a three-way merge. It worked, and was replaced the same day. It was a second tool to maintain beside shadcn's own, and a snapshot to carry in the repository, to automate the part of an update that most needs judgment.

## Decision

- **`packages/ui` is a shadcn project**, driven by the CLI directly. `components.json`, `styles/globals.css`, `components/`, `hooks/`, and `lib/` are what the CLI writes. The package has its own `vite.config.ts` — its test settings — which is also what lets `shadcn init` and `shadcn apply` recognize it.
- **The preset is recorded by what it generated**, not by a script. `components.json` holds the style (which names the base, `radix-maia`), colors, icons, and menu settings, and `styles/globals.css` the theme, fonts, and the pointer cursor; `shadcn preset resolve` reads the preset code back. The package was created once with

  ```bash
  bunx shadcn init --base radix --preset b4aRK5K0fb --pointer --no-monorepo --yes
  bunx shadcn add --all --yes
  ```

  and a different design later is `shadcn apply <preset>` — which reinstalls every component, unless limited with `--only theme,font` — or the same `init` with `--force --reinstall` to change the base or the pointer, which `apply` does not.

- **Agents follow shadcn's own skill** (`npx skills use https://github.com/shadcn-ui/ui --skill shadcn`) for how to use and update the components; `AGENTS.md` adds only what differs here — the locked CLI, the import paths, and the `// Braivo:` markers.
- **Updates are reviewed, not merged by a tool.** `shadcn add --all --dry-run` lists every component that differs from upstream, and `shadcn add <name> --diff` shows how. A coding agent, or a person, applies what upstream changed and keeps what Braivo changed on purpose. `shadcn add <name> --overwrite` takes a component wholesale. The package has no scripts wrapping these: an agent already knows the CLI, `bunx` runs the locked version, and `AGENTS.md` says how to use them here.
- **Braivo's edits to generated files are marked** with a `// Braivo:` comment saying why. The diff has no common ancestor, so the marker is what tells an intentional change from an outdated line. Prefer a component of Braivo's own that wraps a generated one over an edit.
- **All components are generated**, not only those in use, and each is imported on its own, as `@braivo/ui/components/<name>`. Braivo's own components (`Heading`, `MutedText`, `SignInForm`) live in `compositions/` and are the package's root export.
- **Generated files are shadcn's**: MIT, and annotated so in `REUSE.toml`. Braivo's few marked edits to them are MIT too, so each file keeps upstream's single license. They are not reformatted, so a diff against upstream shows only real differences. They are type-checked and linted, less two style rules shadcn's code does not follow.
- **The CLI version is the locked `shadcn` dependency**, which the generated CSS needs at runtime anyway. The registry is shadcn's live one, so the same CLI can report new differences on a later day.

## Alternatives rejected

- **A custom three-way merge with a committed snapshot** — the first version of this decision. It preserved edits automatically, but duplicated the generated files in the repository and put a bespoke tool between Braivo and a CLI that already reports differences.
- **Overwrite and review `git diff`.** A deliberate fix is undone on every update and has to be found again among every upstream change. `shadcn apply` and `shadcn init --reinstall` do exactly this, which is why they are for changing the design rather than for routine updates.
- **Only the components in use.** Every new screen would start with a CLI run, and the design would be only as complete as the screens built so far.

## Consequences

- Changing the look is `shadcn apply` with a new preset, then restoring the marked edits it overwrote.
- Updating the components is a dry run, then a diff and a judgment per component. There is no one command that does it unattended, deliberately.
- The apps' stylesheets carry every generated component's classes, about 27 kB gzipped, because Tailwind cannot know which components an app imports.
