# 0037: The console wears midnight navy and lime, in a light and a dark theme

Status: accepted (2026-10-09)

## Context

The console wore Braivo Purple on shadcn's neutral theme ([ADR 0011](0011-ui-and-auth-client-packages.md)), light only. Its sign-in, a teacher's first look at Braivo, read as stock shadcn. The maintainer chose a theme for the whole console, light and dark, not its sign-in alone (2026-10-09), one that holds up over long sessions. A learn domain wears its organization's brand, never Braivo's ([ADR 0018](0018-sign-in-and-invitations.md)), and an organization's brand is its name alone so far (white-label spec), so the learn app shows the neutral theme.

## Decision

- **Braivo's theme is the console's, on every page**, as CSS variables in `apps/console/styles.css`. Dark is the reference: a near-neutral midnight navy, so content, charts, and states carry the colour, and lime only for the main action, focus, and "retained". Light is its counterpart: cool white pages, navy ink and actions. Lime fails as text on a light ground, so there an olive from it marks focus and "retained". Success is teal, apart from the brand's lime, so "done" and "act here" never look alike. The components keep their semantic tokens. The console sets every colour token the shadcn theme sets, the sidebar's included before any page has one, grouped apart from Braivo's own; `apps/console/styles.test.ts` fails when a shadcn update adds one it does not set, which would otherwise show neutral in the console. A learn domain's sign-in keeps the neutral theme: `<html>` is marked `data-learn-domain` before the first paint by `index.html`, then by the root route.
- **The shared system gains what the theme needs, neutral by default:** in `@braivo/ui`'s stylesheet, a field is bounded by `--input` on its own fill (`--input-background`), the main action shifts colour on hover (`--primary-hover`) rather than fading and turns solid muted while locked, and corners are about 9px. Both apps get these; only the console sets Braivo's values.
- **More tokens, the console's:** success (teal), warning (amber), and info (blue) with their surfaces; the standings as `--chart-1` to `--chart-4` (retained, due for review, learning, not started; progress spec); and `--brand-panel-*`, the `/login` story panel, a darker navy in both themes so its lime accent never changes, its texture faint.
- **Light, dark, or the system's,** chosen per browser: `ThemeProvider` and `ModeToggle` in `@braivo/ui`, after shadcn's Vite recipe, put `.dark` on `<html>`, kept in `localStorage` (`braivo-theme`); the system's is followed until a choice is made, and a choice in another tab is followed too. `index.html` applies it before the first paint, so a dark page never flashes light; every colour then switches at once, with transitions off for the change, and `color-scheme` follows, so the browser's scrollbars and autofill match. The toggle is on `/login` and in the signed-in header.
- **Braivo's logo and faces are the console's alone.** The logo is drawn in one place, `apps/console/components/braivo-logo.tsx`, and the favicon and touch icon are files in `apps/console/public/`. Which mark, wordmark, and faces they are is a brand choice, kept outside this repository, which may change without a new ADR. The faces (the wordmark's in `--font-logo`, the headings' in `--font-heading`; body and controls stay Inter) are self-hosted variable fonts, never fetched from a font service. Like the colours, the branding is withheld from a learn domain's sign-in: it gets neither the icons nor the heading face.

## Alternatives rejected

- **Forest, ivory, and citron.** Warmer and more distinctive, but a green ground blurs green states ("retained", success) and dims the pale citron action, and a strongly tinted dark ground grows heavy over hours of editing.
- **The palette in `@braivo/ui`'s theme, for both apps.** Every school's learn site would wear Braivo's colours, which white-label forbids.
- **A preset change (`shadcn apply`).** The body keeps Inter, the preset's font; colours, a field's border, and the main action's states are CSS variables and rules on `data-slot`, which leave the generated components untouched.
- **A dark theme following the system only.** Simplest, but a teacher projecting the console in a bright classroom needs light whatever the laptop's setting.
