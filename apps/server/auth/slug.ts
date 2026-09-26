// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The console's root-level paths, which `/<slug>` would shadow (ADR 0004).
 * Marketing lives on another host, so only application routes are here; a new
 * one joins before it ships, which slug.test.ts checks against the console's
 * route tree. `invitations` is ADR 0018's, reserved ahead of its route.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "invitations",
  "login",
  "organizations",
  "signup",
]);

/**
 * Lowercase words joined by single hyphens, at most a DNS label long. One
 * spelling per address: without it `Login` would shadow `/login` wherever
 * paths match case-insensitively, and a slug needing percent-encoding would
 * make an unreadable URL.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 63;

/** Why a slug cannot name an organization, or `undefined` when it can. */
export function slugProblem(slug: string): string | undefined {
  if (slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
    return `An organization slug is up to ${MAX_SLUG_LENGTH} lowercase letters, digits, and single hyphens between them.`;
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved and cannot name an organization.`;
  return undefined;
}
