// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { rename } from "node:fs/promises";
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
