// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/** An origin nothing can be served from, so only a same-origin path resolves to it. */
const NOWHERE = "https://redirect.invalid";

/**
 * Where to go after signing in, if it stays within this app. A destination
 * taken from the URL is the attacker's to choose, so anything that could leave
 * the origin is dropped rather than followed.
 *
 * Resolved by the URL parser rather than matched against the shapes that escape
 * — `https://…`, `//host`, `/\host`. Listing those means keeping the list in
 * step with the parser, and it already was not: the parser strips tab, newline
 * and carriage return before anything else, so `/⇥/host` reads as `//host` to
 * the browser and read as an ordinary path here. Asking where the value
 * actually lands cannot fall behind that way.
 */
export function safeRedirect(value: unknown): string | undefined {
  // Still required: a relative `courses` resolves within the origin, but this
  // is for a destination, and a destination is absolute within the app.
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;

  try {
    return new URL(value, NOWHERE).origin === NOWHERE ? value : undefined;
  } catch {
    return undefined;
  }
}
