# 0012: shadcn/ui from a preset, updated with shadcn's own CLI

Status: accepted (2026-09-16)

## Context

Braivo's look is designed on ui.shadcn.com/create, which describes a whole design — component library, style, colors, fonts, icons — as one URL:

```text
https://ui.shadcn.com/create?pointer=true&base=radix&preset=b27GcrRo
```

The components have to be generated from it, upstream improvements pulled in at any time, and the design replaced by another preset, without losing what Braivo changes.

## Decision

- **`packages/ui` is a shadcn project**, driven by the CLI directly; its layout is [ADR 0011](0011-ui-and-auth-client-packages.md)'s. `components.json`, `styles/globals.css`, `components/`, `hooks/`, and `lib/` are what the CLI writes. The package has an empty `vite.config.ts` of its own, which is what lets `shadcn init` and `shadcn apply` recognize it.
- **The preset is recorded by what it generated**, not by a script. `components.json` holds the style (which names the base, `radix-rhea`), colors, icons, and menu settings, and `styles/globals.css` the theme, fonts, and the pointer cursor; `shadcn preset resolve` reads the preset code back. The package was created once with `shadcn init --base radix --preset <code> --pointer --no-monorepo` and `shadcn add --all`.
- **Generated files stay exactly as the CLI writes them.** What Braivo changes lives where the CLI keeps it: a section of `styles/globals.css` marked `Braivo:`, which `shadcn apply` and `shadcn add` leave in place, or a composition of Braivo's own that wraps a component. CSS there selects a component by its `data-slot`, and a variable set there, after the theme's, overrides it. What one app alone changes, such as its colours or root font size, goes the same way in that app's `styles.css`, after its import of `@braivo/ui/globals.css`, a file the CLI never writes.
- **So every refresh is the CLI overwriting, and a review of `git diff`:**

  ```bash
  bunx shadcn add --all --overwrite --yes   # pull upstream's components
  bunx shadcn apply <preset> --yes          # change the design, reinstalling every component
  ```

  `apply --only theme,font` changes the design without touching components; changing the base or the pointer is `shadcn init --force --reinstall`, which `apply` does not do. Afterwards: remove what the old preset left behind, font imports the theme no longer names and dependencies nothing imports (a dependency that looks foreign to the base may still be used: the Radix `combobox` imports `@base-ui/react`), and run the gates.

- **An edit no CSS or wrapper can make** goes in the generated file with a `// Braivo:` comment saying why, and is restored from `git diff` after each refresh. There are none today.
- **All components are generated**, not only those in use, and each is imported on its own, as `@braivo/ui/components/<name>`.
- **Generated files are shadcn's**: MIT, and annotated so in `REUSE.toml`. They are not reformatted, so a refresh shows only real differences. They are type-checked and linted, less two style rules shadcn's code does not follow.
- **The CLI version is the locked `shadcn` dependency**, which the generated CSS needs at runtime anyway. The registry is shadcn's live one, so the same CLI can report new differences on a later day. That `apply` and `add --overwrite` keep the `Braivo:` section is that version's behavior, checked when it was adopted: after upgrading the CLI, check it again.

## Alternatives rejected

- **Marked edits in generated files, merged by hand on each update** (replaced): `shadcn add --dry-run` and `--diff` per component, applying upstream's changes around Braivo's. Every update and every preset change was a judgment per file, and `apply` silently undid the edits. Moving them into CSS made the overwrite safe.
- **A custom three-way merge with a committed snapshot** (replaced): a scratch project, a snapshot of the last upstream output, and a merge. A second tool to maintain beside shadcn's own, duplicating the generated files in the repository.
- **Only the components in use.** Every new screen would start with a CLI run, and the design would be only as complete as the screens built so far.

## Consequences

- Updating or replacing the design is one CLI command; `git diff` shows all of what changed.
- A Braivo change to a component's look is CSS beside the theme, keyed on `data-slot`, rather than in its classes, so it is the one place to look. It goes in `@layer components`, where a caller's utilities still win, unless it must override the component's own utilities, which only unlayered CSS does.
- Storybook shows the shared theme, not an app's; an app's look is checked in the app.
- The apps' stylesheets carry every generated component's classes, about 27 kB gzipped, because Tailwind cannot know which components an app imports.
