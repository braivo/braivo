// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { open, rename } from "node:fs/promises";
import { join } from "node:path";

import { assertKey, type FileStore } from "./store.ts";

/**
 * Files under a directory on this machine: for development, and for a
 * self-hosted installation on one server. The content type is not kept — the
 * database has it — so a file is only its bytes.
 */
export function directoryStore(root: string): FileStore {
  return {
    async put(key, bytes) {
      assertKey(key);
      const path = join(root, key);
      // Written beside it, then renamed over it: a reader never sees half a file.
      const partial = `${path}.${crypto.randomUUID()}.partial`;
      await Bun.write(partial, bytes, { createPath: true });
      await rename(partial, path);
    },

    async get(key) {
      assertKey(key);
      const file = Bun.file(join(root, key));
      return (await file.exists()) ? file : undefined;
    },
  };
}

/**
 * Writes under an existing directory that survive a machine's crash once they
 * resolve, for what must outlive the database it was deleted from
 * (docs/adr/0053-learners-data.md): `directoryStore` renames without syncing,
 * enough for a file its database row can find again, not for this. Readable by
 * the operator alone, each file naming a person. A missing directory fails the
 * write rather than creating one where nobody restricted access.
 */
export function durableDirectoryStore(root: string): Pick<FileStore, "put"> {
  return {
    async put(key, bytes) {
      assertKey(key);
      const path = join(root, key);
      const partial = `${path}.${crypto.randomUUID()}.partial`;
      const file = await open(partial, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(partial, path);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  };
}
