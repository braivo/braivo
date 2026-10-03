// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { extractPages } from "../ai/index.ts";
import type { Page } from "../content/index.ts";
import { readFile, recordFile, type StoredFile } from "../persistence/index.ts";
import type { FileStore } from "../storage/index.ts";
import { type Ai, InvalidAiRequest, modelFor } from "./ai.ts";
import { assertMayAdminister } from "./permission.ts";

/** This installation was started without a file store, so keeps no files. */
export class FilesUnavailable extends Error {
  constructor() {
    super("This Braivo installation stores no files: its operator has not set BRAIVO_FILES.");
    this.name = "FilesUnavailable";
  }
}

/** A file that cannot be stored as sent. Nothing was stored. */
export class InvalidFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFile";
  }
}

/** `type/subtype`, the media type alone: parameters describe text, which a file here is not. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Lowercase hex SHA-256: the only thing a file is named by. */
export const FILE_ID = /^[0-9a-f]{64}$/;

/** Where an organization's file lives in the store: only its bytes decide. */
function keyOf(organizationId: string, sha256: string): string {
  return `organizations/${organizationId}/files/${sha256}`;
}

/**
 * Stores a file a content owner uploads — the PDF a source's text was
 * extracted from, say — and answers with what Braivo recorded, its SHA-256 the
 * ID to name it by (docs/adr/0028-original-files.md). The same bytes uploaded
 * again keep one record, which takes the content type last sent.
 */
export async function uploadFile(input: {
  database: Database;
  files: FileStore | undefined;
  organizationId: string;
  actingAs: string;
  bytes: Uint8Array;
  /** The request's `Content-Type`; only its media type is kept. */
  contentType: string;
  now: Date;
}): Promise<StoredFile> {
  const { database, files, organizationId, actingAs, bytes, now } = input;
  if (files === undefined) throw new FilesUnavailable();

  const contentType = (input.contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (!MEDIA_TYPE.test(contentType)) {
    throw new InvalidFile("A file needs its media type as Content-Type, such as application/pdf.");
  }
  if (bytes.length === 0) throw new InvalidFile("The file is empty.");

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // Bytes before the record, which promises they are there. Written even when
  // already stored, so uploading again repairs a store that lost them.
  await files.put(keyOf(organizationId, sha256), bytes, contentType);
  await recordFile(database, {
    organizationId,
    sha256,
    contentType,
    size: bytes.length,
    createdAt: now,
  });
  // A writer racing this one with the same bytes may have recorded them first.
  const recorded = await readFile(database, organizationId, sha256);
  if (!recorded) throw new Error("A file was recorded and then was not there.");
  return recorded;
}

/**
 * One of an organization's files with its bytes, for whoever administers it,
 * or `undefined` when it has no file by that ID.
 */
export async function openFile(input: {
  database: Database;
  files: FileStore | undefined;
  organizationId: string;
  actingAs: string;
  fileId: string;
}): Promise<{ file: StoredFile; bytes: Blob } | undefined> {
  const { database, files, organizationId, actingAs, fileId } = input;
  if (files === undefined) throw new FilesUnavailable();

  await assertMayAdminister(database, { organizationId, userId: actingAs });
  if (!FILE_ID.test(fileId)) return undefined;

  const file = await readFile(database, organizationId, fileId);
  if (!file) return undefined;
  const bytes = await files.get(keyOf(organizationId, fileId));
  if (!bytes) throw new Error(`File ${fileId} is recorded, and missing from the file store.`);
  return { file, bytes };
}

/**
 * What the model reads, and at most how much of each: the Anthropic API's
 * limits, 32 MB a request and 10 MB an image, less the third base64 adds.
 */
const READABLE: Record<string, number> = {
  "application/pdf": 24_000_000,
  "image/png": 7_500_000,
  "image/jpeg": 7_500_000,
  "image/gif": 7_500_000,
  "image/webp": 7_500_000,
};

/**
 * One of an organization's files read into text, page by page, by the
 * installation's model — for a content owner who cannot extract it
 * themselves — or `undefined` when it has no such file. Returned, not stored:
 * adding it as a source, naming the file as its original, is the caller's
 * next step (docs/adr/0030-server-extraction.md).
 */
export async function readFileText(input: {
  database: Database;
  ai: Ai | undefined;
  files: FileStore | undefined;
  organizationId: string;
  actingAs: string;
  fileId: string;
  now: Date;
  /** The request's: the model is not kept reading for someone who left. */
  signal?: AbortSignal;
}): Promise<Page[] | undefined> {
  const { database, ai, files, organizationId, actingAs, fileId } = input;
  if (files === undefined) throw new FilesUnavailable();

  const { model, charge } = await modelFor(database, ai, { organizationId, actingAs });
  if (!FILE_ID.test(fileId)) return undefined;
  const file = await readFile(database, organizationId, fileId);
  if (!file) return undefined;

  const limit = READABLE[file.contentType];
  if (limit === undefined) {
    throw new InvalidAiRequest(
      "Braivo's AI reads PDFs and images (PNG, JPEG, GIF, WebP); extract the text of other files yourself.",
    );
  }
  if (file.size > limit) {
    throw new InvalidAiRequest(
      file.contentType === "application/pdf"
        ? `Braivo's AI reads a PDF of at most ${limit / 1_000_000} MB; send it a chapter at a time.`
        : `Braivo's AI reads an image of at most ${limit / 1_000_000} MB; photograph a page at a time, or save it smaller.`,
    );
  }

  const blob = await files.get(keyOf(organizationId, fileId));
  if (!blob) throw new Error(`File ${fileId} is recorded, and missing from the file store.`);
  // Read before charging: a store failing here has asked no model anything.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await charge("read", input.now);
  return extractPages(model, { mediaType: file.contentType, bytes }, input.signal);
}
