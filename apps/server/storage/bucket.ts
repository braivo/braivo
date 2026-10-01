// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { S3Client } from "bun";

import { assertKey, type FileStore } from "./store.ts";

/**
 * Files in an S3-compatible bucket, through Bun's own client: Cloudflare R2,
 * Google Cloud Storage's interoperability API, MinIO, and S3 itself differ only
 * in the endpoint and keys the client is given. The content type is set on
 * each object, so a link straight to the bucket serves it as what it is.
 */
export function bucketStore(client: Pick<S3Client, "write" | "file">): FileStore {
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
  };
}
