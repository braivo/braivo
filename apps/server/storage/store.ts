// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bytes by key, and nothing else: what a file is, and whose, lives in the
 * database (docs/adr/0028-original-files.md). Two operations, so any store a
 * self-hoster brings — a disk, R2, Google Cloud Storage, MinIO, S3 — fits.
 */
export type FileStore = {
  /** Stores bytes under a key, replacing whatever was there. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes under a key, read lazily, or `undefined` when nothing is there. */
  get(key: string): Promise<Blob | undefined>;
};

/**
 * Slash-separated segments of letters, digits, `.`, `_`, and `-`, none of them
 * `.` or `..`: a key names an object in a bucket and a path under a directory
 * alike, and can never climb out of either.
 */
export function assertKey(key: string): void {
  const segments = key.split("/");
  const valid = segments.every(
    (segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..",
  );
  if (!valid) throw new Error(`Not a storage key: ${JSON.stringify(key.slice(0, 200))}`);
}
