// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Signing in, for the browser apps: the Better Auth client, the sign-in form,
// the signed-in check, and where it is safe to go afterwards. Browser-side
// only — the server's Better Auth configuration is `apps/server/auth`, which
// needs the database. Visuals come from `@braivo/ui`.
// See docs/adr/0011-ui-and-auth-client-packages.md.

export { createBrowserAuth } from "./client.ts";
export { SignIn } from "./sign-in.tsx";
export { safeRedirect } from "./redirect.ts";
export { needsName, requireSession, type SessionAuth } from "./require-session.ts";
