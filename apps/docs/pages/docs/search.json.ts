// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRoute } from "astro";
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "#lib/source";

const server = createFromSource(source, { language: "english" });

/** Built once, into a file the browser searches itself (ADR 0057). */
export const GET: APIRoute = () => server.staticGET();
