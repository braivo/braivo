// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Signing in, for the browser apps: the Better Auth client, the sign-in form,
// the signed-in check, and where it is safe to go afterwards. Browser-side
// only — the server's Better Auth configuration is `apps/server/auth`, which
// needs the database. Visuals come from `@braivo/ui`.
// See docs/adr/0011-design-system-and-auth-packages.md.

export { createBrowserAuth } from "./client.ts";
export { type EmailAuth, EmailSignIn } from "./email-sign-in.tsx";
export { safeRedirect } from "./redirect.ts";
export { requireSession, type SessionAuth } from "./require-session.ts";
