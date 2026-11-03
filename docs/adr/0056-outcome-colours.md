# 0056: Right and wrong have fixed colours, never the brand's

Status: accepted (2026-11-03)

## Context

A graded answer is marked right or wrong in colour as well as in words and an icon. Wrong was always `--destructive`, a red; right was the brand's `--primary`. An organization's learn domain wears its own brand ([ADR 0011](0011-ui-and-auth-client-packages.md)), and a brand's primary may be near black, as the neutral theme's is: a right answer's mark then read as grey, as selected rather than as right, beside a vivid red for wrong. The verdict beside Continue made the mismatch larger.

## Decision

- `--success`, a green defined in `@braivo/ui`'s theme beside `--destructive`, marks a right answer: the correct option, a correct typed answer, and the verdict. Light and dark each set one.
- No outcome takes the brand's colour, and an organization's theme does not override `--success` or `--destructive`. The brand keeps the main action, focus, and the progress meters.
- Each mark keeps its word and icon: colour alone never says right or wrong (WCAG 1.4.1).
- `--success` reads at 4.5:1 as text on its own 10% tint over the page, so at 3:1 as an edge; `packages/ui/contrast.browser.test.tsx` measures it under a brand whose primary is the ink.

## Consequences

- Right reads as right on every school's domain; the two outcomes are told apart by hue, not by brand.
- A brand whose own colour is green sits close to `--success`; the word and icon still tell a mark from the main action.
- A school cannot restyle outcomes. If one needs to (a colour-blind palette, say), that is a theme setting for all outcomes, decided then.
