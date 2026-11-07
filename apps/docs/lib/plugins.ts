// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { MdastPluginDefinition } from "satteri";

import { alerts } from "./alerts.ts";
import { pageLinks } from "./page-links.ts";

/** What each page goes through as it compiles, in order: `astro.config.ts`'s, and its tests'. */
export function mdastPlugins(contentDir: string, base: string): MdastPluginDefinition[] {
  return [alerts(), pageLinks(contentDir, base)];
}
