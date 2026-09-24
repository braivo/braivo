# 0016: Route files mirror the URL, and a guard lives in its folder

Status: accepted (2026-09-24).

## Context

The learn and console apps use TanStack Router's file routes. Each signed-in area was a pathless layout, `routes/_signed-in.tsx`, whose `beforeLoad` calls `requireSession`. Its pages sat beside it in `routes/_signed-in/` under dotted flat names such as `organizations.$organizationId.courses.$courseId.learners.$learnerId.tsx`. That put the guard outside the folder it guards, and the names grew with the URL, so they were hard to scan.

## Decision

- **A layout is its folder's `route.tsx`.** The guard is `routes/_signed-in/route.tsx`, so everything under `_signed-in/` is signed in and nothing outside that folder is.
- **Folders mirror the URL**, one segment per folder: `_signed-in/organizations/$organizationId/courses/$courseId/index.tsx`. A page with no children of its own is named after its last segment (`courses/$courseId.tsx`), not `index.tsx`.
- **Route files import app modules as `#lib/<name>`**, through each app's `package.json` `imports`, as `packages/ui` does. That way a file's depth never shows up in its imports.

`$` in these paths is TanStack's parameter marker. In a shell, single-quote any path that contains it.

## Alternatives rejected

- **Everything signed in by default, with public routes allowlisted in `__root`**, for example through `staticData`. It needs more machinery for a guard that is only UX: the server refuses every request without a session anyway (ADR 0010).
- **Dotted flat names.** They save folders, but make every page's name as long as its URL.
- **Route groups, `(signed-in)/`.** A group has no route of its own, so it cannot carry a `beforeLoad`.
