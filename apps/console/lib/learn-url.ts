// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

declare global {
  interface ImportMetaEnv {
    /** The learn app's port, on the console's dev server alone (`vite.config.ts`). */
    readonly BRAIVO_LEARN_PORT?: string;
  }
}

/**
 * `path` on an organization's learn domain, what its links copy and open: over
 * HTTPS, or, on the dev server, a `.localhost` one over HTTP at the learn app's
 * port, where it is served (ADR 0043); any other keeps HTTPS. The hostname is
 * kept, as the server tells organizations apart by it.
 */
export function learnUrl(hostname: string, path = ""): string {
  const port = import.meta.env.BRAIVO_LEARN_PORT;
  return port && (hostname === "localhost" || hostname.endsWith(".localhost"))
    ? `http://${hostname}:${port}${path}`
    : `https://${hostname}${path}`;
}

/**
 * A learn domain's own sign-in start: it sets its nonce cookie there and comes
 * back to `/login?handoff=`, which offers the account signed in here
 * ("Continue as Ada"), then hands it over without another code (ADR 0018,
 * access-12 to 15).
 */
export function learnSignInUrl(hostname: string): string {
  return learnUrl(hostname, "/api/session/sign-in");
}
