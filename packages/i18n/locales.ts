// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The languages Braivo's copy is in, English first: the source and the fallback
 * (ADR 0035). Apart from `index.tsx`, so `lingui.config.ts` reads it without
 * React or catalogs.
 */
export const LOCALES = ["en", "pl"] as const;

export type Locale = (typeof LOCALES)[number];
