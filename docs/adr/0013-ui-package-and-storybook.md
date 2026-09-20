# 0013: `packages/ui`, and Storybook as an app

Status: accepted (2026-09-16). Renames the package from [ADR 0011](0011-design-system-and-auth-packages.md) and moves the files [ADR 0012](0012-shadcn-preset.md) describes.

## Context

The shared React components lived in `packages/design-system`, with shadcn's under `components/ui/` and imported as `@braivo/design-system/ui/<name>`. Two things were off:

- **The name claimed more than the package holds.** A design system is tokens, typography, brand, accessibility standards, guidelines, and perhaps several implementations. The package is one of those implementations: React components, their CSS, and `cn`.
- **Nothing showed the components** outside the screens that happen to use them, so a component's states and variants were visible only by reading its source.

## Decision

```text
packages/ui/                  @braivo/ui
├── components/               shadcn's, as its CLI writes them   @braivo/ui/components/<name>
│   ├── button.tsx
│   └── button.stories.tsx    Braivo's story, beside what it shows
├── compositions/             Braivo's own, built from components   @braivo/ui
├── hooks/, lib/              shadcn's                          @braivo/ui/lib/utils
├── styles/globals.css        shadcn's CSS, with marked edits   @braivo/ui/globals.css
└── components.json
apps/storybook/               Storybook, consuming @braivo/ui
└── .storybook/
```

- **`@braivo/ui`, laid out as shadcn's monorepo template lays out `packages/ui`.** Imports read `@braivo/ui/components/button` and `@braivo/ui/lib/utils`. "Braivo Design System" stays the name of the whole — this package, its tokens, Storybook, and the conventions around them — and is what Storybook shows as its title.
- **`components/` holds shadcn-derived primitives and components; `compositions/` holds reusable components Braivo writes, built from them.** That is the rule, and the tooling follows from it: shadcn-derived files are kept as its CLI writes them and licensed MIT, and both are set by directory. Mixing Braivo's files into `components/` would turn each into a hand-kept list of exceptions, in `vite.config.ts` and `REUSE.toml` both. In `components.json`, `ui` is `components/` and `components` is `compositions/`, so a registry block added with the CLI lands beside Braivo's.
- **Stories sit beside the component they show**, as `<name>.stories.tsx`, so reading a component shows its intended states too — which also makes them concise usage examples for people and agents. They are the one exception in `components/`, matched by name rather than listed: formatted, linted, and AGPL like the rest of Braivo's code.
- **One stylesheet.** shadcn's CSS file is `styles/globals.css` and carries Braivo's two `@source` lines under a `Braivo:` comment, rather than a second file importing it; shadcn's guidance is to edit that file, never to add one.
- **Inside the package, imports use the `#components`, `#compositions`, `#lib`, and `#hooks` subpath aliases** already in place. Consumers use the package name.
- **Storybook is `apps/storybook`**, a runnable app with its own dependencies, dev server, and build, and it reaches the components through `@braivo/ui`'s exports as the apps do. Its stories glob points into `packages/ui`. `bun run storybook` starts it; `bun run dev` leaves it out; `vp run -r build` builds it, which is a check on the package's exports.
- **`@braivo/ui` has one Storybook dev dependency**, `@storybook/react-vite`, because a colocated story imports its types and Bun's isolated installs resolve a package only from where it is declared. The runtime — the Storybook CLI and the builder — belongs to `apps/storybook`.

## Alternatives rejected

- **Keep `packages/design-system`.** Longer imports, and a name the package would have to share with every other part of the design system as those appear.
- **One flat `components/` for shadcn's files and Braivo's**, as the shadcn template does. It works — both oxfmt and REUSE honour exceptions — but each new Braivo component would need entries in two config files to stay formatted and correctly licensed, and nothing would fail if it did not.
- **`packages/ui/.storybook`.** Fits a repository that is a component library. This one is apps around a shared package, and Storybook is one more app.
- **`.storybook` at the root.** Puts an app's dependencies and build output among workspace-wide tooling.
- **`apps/design-system`.** Invites the question of which one is the source.
- **Stories in `apps/storybook`.** Keeps Storybook out of `@braivo/ui` entirely, at the cost of separating each component from its examples, which is where people and agents look for them.

## Consequences

- A new shared component Braivo writes goes in `compositions/` and is exported from `index.ts`, which stays a curated API: shadcn's primitives are imported by subpath and never re-exported there. One that shadcn provides is added with its CLI into `components/`.
- A reusable component gets a story when it has visual, interactive, responsive, accessibility, or theming states worth inspecting in isolation — `SignInForm`, or a shadcn component Braivo has restyled — and not otherwise. No story is required by policy, and no docs pages, interaction tests, or visual regression are added until a need for them appears.
- Storybook's first run in development pre-bundles its dependencies, which takes a few seconds.
- Storybook 10.6 lists `vite-plus` 0.1–0.2 as a peer, and this repository is on 0.3; the build and dev server work, and the peer range is worth watching on upgrades.
