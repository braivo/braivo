// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRoute } from "astro";

import { docsLlms } from "#lib/llms";

/** Every page, linking its Markdown copy (ADR 0057). */
export const GET: APIRoute = () => new Response(docsLlms.index());
