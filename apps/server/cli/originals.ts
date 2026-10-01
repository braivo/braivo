// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { realpath } from "node:fs/promises";

import type { BraivoClient } from "@braivo/server/client";

/**
 * What an original may be: material a teacher holds — a document, a photo or
 * scan, a recording — typed by its extension. Anything else is refused before
 * it is read, so a mistyped `--original ~/.ssh/id_rsa` or `.env`, both
 * `application/octet-stream`, never leaves the machine. Text is not an
 * original either; it is sent as the source itself.
 */
const ORIGINAL_TYPES = [
  /^application\/pdf$/,
  /^application\/epub\+zip$/,
  /^application\/msword$/,
  /^application\/vnd\.ms-(powerpoint|excel)$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\./,
  // Not SVG, which is a script as much as an image.
  /^image\/(?!svg)/,
  /^audio\//,
  /^video\//,
];

/**
 * Uploads the file a source was extracted from and resolves to its `fileId`
 * (docs/adr/0028-original-files.md), or refuses one that is not a document,
 * image, recording, or video by its extension.
 */
export async function uploadOriginal(
  client: BraivoClient,
  organizationId: string,
  path: string,
): Promise<string> {
  const refused = new Error(
    `${path}: not a document, image, recording, or video by its extension, so not uploaded as an original.`,
  );
  if (!isMaterial(path)) throw refused;

  // The file that will be read, not the name given: `libro.pdf` may be a link
  // to `~/.ssh/id_rsa`, which a downloaded archive can carry.
  const target = await realpath(path).catch(() => undefined);
  if (target === undefined) throw new Error(`${path}: no such file.`);
  if (!isMaterial(target)) throw refused;

  const { fileId } = await client.uploadFile({ organizationId, file: Bun.file(target) });
  return fileId;
}

function isMaterial(path: string): boolean {
  const type = Bun.file(path).type.split(";")[0] ?? "";
  return ORIGINAL_TYPES.some((allowed) => allowed.test(type));
}
