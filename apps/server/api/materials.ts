// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";

import {
  addSource,
  type Ai,
  draftFromSource,
  getSource,
  listSources,
  openFile,
  readFileText,
  uploadFile,
} from "../application/index.ts";
import type { FileStore } from "../storage/index.ts";
import { type Guards, jsonBody, limitBody, noStore } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

/**
 * Reads a source out of a request body: a title, and exactly one of `text`, a
 * recording's `cues`, or a document's `pages`. Only the types: what makes each
 * value valid is `content`'s rule, applied by the use case. `url`, `language`,
 * and `original` are optional, and absent is the only way to leave one out.
 */
function parseSource(
  body: unknown,
):
  | ({ title: string; url?: string; language?: string; original?: string } & (
      | { text: string }
      | { cues: { at: number; text: string }[] }
      | { pages: { page: string; text: string }[] }
    ))
  | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { title, text, cues, pages, url, language, original } = body as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  if (url !== undefined && typeof url !== "string") return undefined;
  if (language !== undefined && typeof language !== "string") return undefined;
  if (original !== undefined && typeof original !== "string") return undefined;
  const common = { title, url, language, original };

  const sent = [text, cues, pages].filter((value) => value !== undefined);
  if (sent.length !== 1) return undefined;
  if (typeof text === "string") return { ...common, text };

  if (Array.isArray(cues)) {
    const parsed: { at: number; text: string }[] = [];
    for (const cue of cues) {
      if (typeof cue !== "object" || cue === null) return undefined;
      const { at, text: said } = cue as Record<string, unknown>;
      if (typeof at !== "number" || typeof said !== "string") return undefined;
      parsed.push({ at, text: said });
    }
    return { ...common, cues: parsed };
  }

  if (Array.isArray(pages)) {
    const parsed: { page: string; text: string }[] = [];
    for (const each of pages) {
      if (typeof each !== "object" || each === null) return undefined;
      const { page, text: written } = each as Record<string, unknown>;
      if (typeof page !== "string" || typeof written !== "string") return undefined;
      parsed.push({ page, text: written });
    }
    return { ...common, pages: parsed };
  }

  return undefined;
}

/**
 * A JSON object's fields, or `undefined` for any other body. For a body whose
 * fields are all optional, which no field's check would refuse.
 */
function parseObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/**
 * A file is buffered whole, to be hashed before it is stored: a textbook's
 * PDF, a worksheet's scan, a slide deck. Video, larger, needs a direct
 * upload to the store instead (ADR 0028).
 */
const MAX_FILE_BYTES = 50_000_000;

/**
 * A source is one document's text, and a textbook's runs to a few megabytes.
 * Larger material is split into several sources, which is also the grain a
 * citation is easiest to review at.
 */
const MAX_SOURCE_BYTES = 10_000_000;

/**
 * Lifts Bun's idle timeout from this request, for a call to the installation's
 * model. Bun, Hono's `env` here, closes a connection idle for ten seconds, and
 * a model reading a chapter takes longer: the request waits instead for as long
 * as the model may take (`ai`'s own timeout). Last before the use case, once
 * the request is known valid. Elsewhere `env` is something else, such as a
 * Worker's bindings, so `timeout` is called only if callable: a binding is a
 * value or a resource object, never a bare function. Not `typeof Bun`, which
 * `bunFree` refuses here.
 */
function disableBunIdleTimeout(context: Context): void {
  const server = context.env as { timeout?: unknown } | undefined;
  if (typeof server?.timeout === "function") server.timeout(context.req.raw, 0);
}

/** What the materials routes use of `ApiOptions`, with `cachedDatabase` resolved. */
type MaterialsOptions = {
  database: Database;
  cachedDatabase: Database;
  files?: FileStore;
  ai?: Ai;
};

/**
 * What a content owner teaches from: sources as text, the files they came
 * from, and drafts and text the installation's model makes of them.
 */
export function materialsRoutes(
  { trustedJsonWrite, trustedUpload, requireAccount }: Guards,
  { database, cachedDatabase, files, ai }: MaterialsOptions,
) {
  const routes = new Hono();

  /**
   * Adds material a content owner provides, as text. Extracting that text from
   * a file is the caller's business, which is what lets a content owner's own
   * tools do it (ADR 0020).
   */
  routes.post(
    "/api/organizations/:organizationId/sources",
    ...trustedJsonWrite(MAX_SOURCE_BYTES),
    requireAccount,
    async (context) => {
      const source = parseSource(await jsonBody(context));
      if (source === undefined) return context.body(null, 400);

      try {
        const sourceId = await addSource({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          ...source,
          now: new Date(),
        });

        return context.json({ sourceId }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /** Every source an organization has, without their text, for whoever administers it. */
  routes.get(
    "/api/organizations/:organizationId/sources",
    noStore,
    requireAccount,
    async (context) => {
      try {
        const sources = await listSources({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
        });

        return context.json({ sources });
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /** One source, text included, for whoever administers its organization. */
  routes.get(
    "/api/organizations/:organizationId/sources/:sourceId",
    noStore,
    requireAccount,
    async (context) => {
      try {
        const source = await getSource({
          database,
          cachedDatabase,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          sourceId: context.req.param("sourceId"),
        });

        // Reached only by an administrator, so a 404 confirms nothing they could
        // not already list.
        return source ? context.json(source) : context.body(null, 404);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * A course drafted from a source by the installation's own model, checked
   * against the source and returned for review — never stored (ADR 0029).
   * Slow: the model reads the whole source.
   */
  routes.post(
    "/api/organizations/:organizationId/sources/:sourceId/draft",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const body = parseObject(await jsonBody(context));
      if (body === undefined) return context.body(null, 400);
      const { audience } = body;
      if (audience !== undefined && typeof audience !== "string") return context.body(null, 400);

      disableBunIdleTimeout(context);
      try {
        const draft = await draftFromSource({
          database,
          cachedDatabase,
          ai,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          sourceId: context.req.param("sourceId"),
          audience,
          now: new Date(),
          signal: context.req.raw.signal,
        });
        return draft ? context.json(draft) : context.body(null, 404);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * Keeps a file a content owner uploads — the original a source's text was
   * extracted from — as the request's body, typed by its `Content-Type`.
   */
  routes.post(
    "/api/organizations/:organizationId/files",
    limitBody(MAX_FILE_BYTES),
    trustedUpload,
    requireAccount,
    async (context) => {
      try {
        const file = await uploadFile({
          database,
          files,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          bytes: new Uint8Array(await context.req.arrayBuffer()),
          contentType: context.req.header("content-type") ?? "",
          now: new Date(),
        });

        const { sha256, contentType, size } = file;
        return context.json({ fileId: sha256, contentType, size }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * A file's text, page by page, read by the installation's model and returned
   * for the caller to add as a source (ADR 0030). Slow, as drafting is.
   */
  routes.post(
    "/api/organizations/:organizationId/files/:fileId/text",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      if (parseObject(await jsonBody(context)) === undefined) return context.body(null, 400);

      disableBunIdleTimeout(context);
      try {
        const pages = await readFileText({
          database,
          ai,
          files,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          fileId: context.req.param("fileId"),
          now: new Date(),
          signal: context.req.raw.signal,
        });
        return pages ? context.json({ pages }) : context.body(null, 404);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * A file's bytes, for whoever administers its organization. Always a
   * download, never rendered: an uploaded HTML file served inline from this
   * origin would run as Braivo.
   */
  routes.get(
    "/api/organizations/:organizationId/files/:fileId",
    noStore,
    requireAccount,
    async (context) => {
      try {
        const opened = await openFile({
          database,
          files,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          fileId: context.req.param("fileId"),
        });
        if (!opened) return context.body(null, 404);

        // A stream, not the blob: Bun refuses a bucket's file with response
        // options. `context.body`, not a `Response`, which would drop the
        // renewed session's cookie `requireAccount` set on the context.
        return context.body(opened.bytes.stream(), 200, {
          "content-type": opened.file.contentType,
          "content-length": String(opened.file.size),
          "content-disposition": "attachment",
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
        });
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  return routes;
}
