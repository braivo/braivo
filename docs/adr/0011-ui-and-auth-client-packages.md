# 0011: `packages/ui` for presentation, `packages/auth-client` for signing in, and Storybook as an app

Status: accepted (2026-09-16)

## Context

Both apps render the same components and sign people in the same way. Shared browser code needs a home, and a package for whatever both apps share becomes wherever shared browser code lands, design and session logic alike.

The product promises that others can run Braivo under their own brand ([product.md](../product.md)), so nothing an app renders may hard-code Braivo's colours.

A component's states and variants should be visible without finding a screen that happens to use them, or reading its source.

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
packages/auth-client/         @braivo/auth-client
apps/storybook/               Storybook, consuming @braivo/ui
└── .storybook/
```

- **Code is shared when both apps need it identical**, as a security check copied twice is one that gets fixed once — never merely because both might use it someday. It goes to the package that matches what it is.
- **`@braivo/ui` is presentation only**: components, their CSS and tokens, and `cn`. It knows nothing about sessions, routing, or Braivo's API, and imports no other Braivo package. Components use only semantic tokens (`bg-primary`, `text-muted-foreground`), so a brand restyles Braivo by overriding CSS variables. Its layout is shadcn's monorepo template's; how its components are generated and updated is [ADR 0012](0012-shadcn-preset.md)'s. "Braivo Design System" names the whole — this package, its tokens, Storybook, and the conventions around them — and is Storybook's title.
- **`components/` holds shadcn-derived primitives and components; `compositions/` holds reusable components Braivo writes, built from them.** shadcn-derived files are kept as its CLI writes them and licensed MIT, and both are set by directory; Braivo's files mixed into `components/` would each be a hand-kept exception, in `vite.config.ts` and `REUSE.toml` both. In `components.json`, `ui` is `components/` and `components` is `compositions/`, so a registry block added with the CLI lands beside Braivo's.
- **Stories sit beside the component they show**, as `<name>.stories.tsx`, so reading a component shows its intended states too — concise usage examples for people and agents. They are the one exception in `components/`, matched by name rather than listed: formatted, linted, and AGPL like the rest of Braivo's code.
- **One stylesheet.** shadcn's `styles/globals.css` carries Braivo's `@source` lines under a `Braivo:` comment, rather than a second file importing it; shadcn's guidance is to edit that file, never to add one.
- **Inside the package, imports use the `#components`, `#compositions`, `#lib`, and `#hooks` subpath aliases.** Consumers use the package name.
- **`@braivo/auth-client` is signing in, for the browser** — named after Better Auth's client, which it wraps: `createBrowserAuth`, which requires an explicit `baseURL`; `EmailSignIn`, which wires `@braivo/ui`'s `SignInForm` to Better Auth; `requireSession`, which a signed-in layout calls in `beforeLoad`; and `safeRedirect`, which keeps a post-sign-in redirect on the app's own origin. The server's Better Auth configuration stays in `apps/server/auth`, because it needs the database. Where sign-in is served and which methods it offers is [ADR 0018](0018-sign-in-and-invitations.md)'s.
- **Storybook is `apps/storybook`**, a runnable app with its own dependencies, dev server, and build, reaching the components through `@braivo/ui`'s exports as the apps do. Its stories glob points into `packages/ui`. `bun run storybook` starts it; `bun run dev` leaves it out; `vp run -r build` builds it, which checks the package's exports.
- **`@braivo/ui` has one Storybook dev dependency**, `@storybook/react-vite`, because a colocated story imports its types and Bun's isolated installs resolve a package only from where it is declared. The runtime — the Storybook CLI and the builder — belongs to `apps/storybook`.

## Alternatives rejected

- **One `packages/ui` for everything both apps share** (replaced), holding the sign-in form and `safeRedirect`. Presentation would then depend on Better Auth and the router, and the package would collect whatever browser code two apps happen to share.
- **`packages/design-system`, with hand-written components** (replaced). Its components are shadcn's now ([ADR 0012](0012-shadcn-preset.md)), and the name claimed the whole design system for one React implementation of it, at the cost of longer imports.
- **`apps/auth`, a sign-in app of its own at `/auth/`.** Worth it once sign-in is a product surface of its own. Until then it costs a third dev server, a full page load on every sign-in, and a redirect check that has to allow sibling origins in development. Moving there later is cheap, since the form and helpers would move unchanged.
- **One flat `components/` for shadcn's files and Braivo's**, as the shadcn template does. Both oxfmt and REUSE honour exceptions, but each new Braivo component would need entries in two config files to stay formatted and correctly licensed, and nothing would fail if it did not.
- **`packages/ui/.storybook`.** Fits a repository that is a component library. This one is apps around a shared package, and Storybook is one more app.
- **`.storybook` at the root.** Puts an app's dependencies and build output among workspace-wide tooling.
- **`apps/design-system`.** Invites the question of which one is the source.
- **Stories in `apps/storybook`.** Keeps Storybook out of `@braivo/ui` entirely, at the cost of separating each component from its examples, which is where people and agents look for them.

## Consequences

- Apps import `@braivo/ui/globals.css` instead of Tailwind, and name `packages/auth-client` as a Tailwind source, since its components are rendered there.
- Palette classes (`text-gray-600`, `bg-black`) do not belong in app code; a missing token is added to `globals.css`.
- A new shared component Braivo writes goes in `compositions/` and is exported from `index.ts`, which stays a curated API: shadcn's are imported by subpath and never re-exported there. One that shadcn provides is added with its CLI into `components/`.
- A reusable component gets a story when it has visual, interactive, responsive, accessibility, or theming states worth inspecting in isolation — `SignInForm`, or a shadcn component Braivo has restyled — and not otherwise. No docs pages, interaction tests, or visual regression until a need for them appears.
- Storybook's first run in development pre-bundles its dependencies, which takes a few seconds.
- Storybook 10.6 lists `vite-plus` 0.1–0.2 as a peer, and this repository is on 0.3; the build and dev server work, and the peer range is worth watching on upgrades.
