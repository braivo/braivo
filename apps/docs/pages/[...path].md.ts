// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from "astro";

import { docsLlms, markdownPath } from "#lib/llms";
import { source } from "#lib/source";

/** Each page as Markdown, `guides/faq.md` beside `guides/faq.html` (ADR 0057). */
export const getStaticPaths = (() =>
  source.getPages().map((page) => ({
    params: { path: markdownPath(page).replace(/\.md$/, "") },
    props: { page },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<InferGetStaticPropsType<typeof getStaticPaths>> = async ({ props }) =>
  // No headers: a static host types the file by its extension.
  new Response(await docsLlms.page(props.page));
