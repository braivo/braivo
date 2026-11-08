// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { S3Client } from "bun";

import { assertKey, assertPrefix, type FileStore } from "./store.ts";

/**
 * Files in an S3-compatible bucket, through Bun's own client: Cloudflare R2,
 * Google Cloud Storage's interoperability API, MinIO, and S3 itself differ only
 * in the endpoint and keys the client is given. The content type is set on
 * each object, so a link straight to the bucket serves it as what it is.
 */
export function bucketStore(
  client: Pick<S3Client, "write" | "file" | "list" | "delete">,
): FileStore {
  /** Every key under the folder, a page of ListObjectsV2 at a time. */
  async function list(prefix: string): Promise<string[]> {
    assertPrefix(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.list({
        prefix: prefix === "" ? undefined : `${prefix}/`,
        continuationToken,
      });
      for (const { key } of page.contents ?? []) keys.push(key);
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys.toSorted();
  }

  return {
    async put(key, bytes, contentType) {
      assertKey(key);
      await client.write(key, bytes, { type: contentType });
    },

    async get(key) {
      assertKey(key);
      const file = client.file(key);
      return (await file.exists()) ? file : undefined;
    },

    list,

    // Listed whole before deleting, so no page shifts under the listing.
    async deletePrefix(prefix) {
      assertKey(prefix);
      for (const key of await list(prefix)) await client.delete(key);
    },
  };
}
