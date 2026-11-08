// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { open, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { assertKey, assertPrefix, type FileStore } from "./store.ts";

/** Written beside its key, then renamed over it: never a key itself. */
const PARTIAL = ".partial";

async function read(root: string, key: string): Promise<Blob | undefined> {
  assertKey(key);
  const file = Bun.file(join(root, key));
  return (await file.exists()) ? file : undefined;
}

/**
 * Files under the folder, as keys, relative to the root however it is spelled:
 * a write still partial is none yet. `recursive: false` lists the folder's own
 * files alone, so a subfolder it cannot read fails nothing.
 */
async function list(root: string, prefix: string, recursive = true): Promise<string[]> {
  assertPrefix(prefix);
  const base = resolve(root);
  const entries = await readdir(join(base, prefix), { recursive, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(PARTIAL))
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

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
      const partial = `${path}.${crypto.randomUUID()}${PARTIAL}`;
      await Bun.write(partial, bytes, { createPath: true });
      await rename(partial, path);
    },

    get: (key) => read(root, key),

    list: (prefix) => list(root, prefix),

    async deletePrefix(prefix) {
      assertKey(prefix);
      await rm(join(root, prefix), { recursive: true, force: true });
    },
  };
}

/**
 * Writes under an existing directory that survive a machine's crash once they
 * resolve, for what must outlive the database it was deleted from
 * (docs/adr/0053-learners-data.md): `directoryStore` renames without syncing,
 * enough for a file its database row can find again, not for this. Readable by
 * the operator alone, each file naming a person. A missing directory fails the
 * write rather than creating one where nobody restricted access. Read back, and
 * listed, to find erasures left pending (ADR 0060); never deleted from.
 */
export function durableDirectoryStore(root: string): Pick<FileStore, "put" | "get" | "list"> {
  return {
    async put(key, bytes) {
      assertKey(key);
      const path = join(root, key);
      const partial = `${path}.${crypto.randomUUID()}${PARTIAL}`;
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

    get: (key) => read(root, key),

    // Its records sit at the top, one file each.
    list: (prefix) => list(root, prefix, false),
  };
}
