// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { toFumadocsSource } from "@fumadocs/astro/source";
import { getCollection } from "astro:content";
import { loader } from "fumadocs-core/source";

import { base } from "./base.ts";

/** One tree: a page's path under `content/` is its URL, so each section is a folder. */
export const source = loader({
  source: toFumadocsSource(await getCollection("docs"), await getCollection("meta")),
  baseUrl: base,
});
