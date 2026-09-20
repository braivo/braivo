# 0011: A design system package, and sign-in in its own package

Status: accepted (2026-09-16). Replaces `packages/ui` from [ADR 0003](0003-workspace-layout.md). Its component choices are superseded by [ADR 0012](0012-shadcn-preset.md): the components are now generated from a shadcn preset. The package is `packages/ui` since [ADR 0013](0013-ui-package-and-storybook.md), and its stylesheet `@braivo/ui/globals.css`.

## Context

`packages/ui` held what both apps share: a sign-in form wired to Better Auth, and `safeRedirect`. Neither is visual design, and a package called `ui` becomes wherever shared browser code lands. Meanwhile the apps styled themselves with raw Tailwind palette classes, which cannot be rebranded, although the product promises that others can run Braivo under their own brand ([product.md](../product.md)).

The visual layer is also meant to be kept in sync with a claude.ai design-system project through the /design-sync skill, which works on a local component library one component at a time.

## Decision

- **`packages/design-system`** (`@braivo/design-system`) is presentation only: `styles.css` with Tailwind and the design tokens, and brand-neutral components built on them (`Button`, `Input`, `Alert`, `Heading`, `MutedText`, and a presentational `SignInForm`). One component per file, which is the unit /design-sync works in. Components use only semantic tokens (`bg-primary`, `text-danger`), so a brand restyles Braivo by overriding CSS variables on `:root`. Nothing in it knows about sessions, routing, or Braivo's API.
- **`packages/auth-client`** (`@braivo/auth-client`) is signing in, for the browser — named after Better Auth's client, which it wraps: `createBrowserAuth`, which requires an explicit `baseURL`; `EmailSignIn`, which wires the design system's form to Better Auth; `requireSession`, which a signed-in layout calls in `beforeLoad`; and `safeRedirect`. It is browser-side only; the server's Better Auth configuration stays in `apps/server/auth`, because it needs the database.
- Each app keeps its own `/sign-in` route and its own heading, so learners and content owners can come to sign in differently later.
- Headless primitives such as Radix or Base UI are added when a component needs behaviour that plain elements lack — a dialog, a menu — and not before.

## Alternatives rejected

- **`apps/auth`, a sign-in app of its own at `/auth/`.** Worth it once sign-in is a product surface: password reset, verification, invitations, SSO. Until then it costs a third dev server, a full page load on every sign-in, and a redirect check that has to allow sibling origins in development instead of only its own. Moving there later is cheap, since the form and helpers would move unchanged.
- **Auth helpers inside the design system.** The design system would then depend on Better Auth and the router, and /design-sync would sync session logic as if it were a component.

## Consequences

- Apps import `@braivo/design-system/styles.css` instead of Tailwind, and name `packages/auth-client` as a Tailwind source, since its components are rendered there.
- Palette classes (`text-gray-600`, `bg-black`) no longer belong in app code; a missing token is added to `styles.css`.
- Preview cards for /design-sync are produced when the skill is run, not kept by hand.
