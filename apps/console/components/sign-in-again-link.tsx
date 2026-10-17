// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/** Signing in in a new tab, for a page that alone holds what was entered (docs/apps.md). */
export function SignInAgainLink() {
  return (
    <a href="/login" target="_blank" rel="noopener" className="underline">
      Sign in again in a new tab
    </a>
  );
}
