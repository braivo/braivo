// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { file } from "@braivo/db/schema";
import { and, eq } from "drizzle-orm";

/** An uploaded file as the database knows it; its bytes are the file store's. */
export type StoredFile = { sha256: string; contentType: string; size: number; createdAt: Date };

/**
 * Records a file whose bytes are already stored. The same bytes recorded again
 * keep their first record, but take the content type they were last uploaded
 * as, which the store was just given too: a PDF first sent as
 * `application/octet-stream` is fixed by sending it again as what it is
 * (docs/adr/0028-original-files.md).
 */
export async function recordFile(
  database: Database,
  input: StoredFile & { organizationId: string },
): Promise<void> {
  await database
    .insert(file)
    .values(input)
    .onConflictDoUpdate({
      target: [file.organizationId, file.sha256],
      set: { contentType: input.contentType },
    });
}

/** One of an organization's files, or `undefined` when it has none with those bytes. */
export async function readFile(
  database: Database,
  organizationId: string,
  sha256: string,
): Promise<StoredFile | undefined> {
  const [row] = await database
    .select({
      sha256: file.sha256,
      contentType: file.contentType,
      size: file.size,
      createdAt: file.createdAt,
    })
    .from(file)
    .where(and(eq(file.organizationId, organizationId), eq(file.sha256, sha256)))
    .limit(1);
  return row;
}
