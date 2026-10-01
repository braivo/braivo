// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { directoryStore } from "./directory.ts";

const bytes = new TextEncoder().encode("%PDF-1.7 hola");

describe("a directory of files", () => {
  test("keeps bytes under a key, in folders it makes, and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "braivo-files-"));
    const store = directoryStore(root);

    await store.put("organizations/o/files/abc", bytes, "application/pdf");

    expect(await (await store.get("organizations/o/files/abc"))?.text()).toBe("%PDF-1.7 hola");
    expect(await store.get("organizations/o/files/missing")).toBeUndefined();
    // No partial file left beside it.
    expect(await readdir(join(root, "organizations/o/files"))).toEqual(["abc"]);
  });

  test.each(["../escape", "a/../../escape", "/absolute", "a//b", "a/./b", "a b", ""])(
    "refuses the key %j, which could name something outside it",
    async (key) => {
      const store = directoryStore(await mkdtemp(join(tmpdir(), "braivo-files-")));

      await expect(store.put(key, bytes, "application/pdf")).rejects.toThrow("Not a storage key");
      await expect(store.get(key)).rejects.toThrow("Not a storage key");
    },
  );
});
