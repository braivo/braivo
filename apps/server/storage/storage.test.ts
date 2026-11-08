// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { bucketStore } from "./bucket.ts";
import { directoryStore, durableDirectoryStore } from "./directory.ts";

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

describe("listing and deleting a folder (ADR 0060)", () => {
  test("a directory lists every key under a folder, not a partial write, and deletes one folder alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "braivo-files-"));
    const store = directoryStore(root);
    for (const key of [
      "organizations/a/files/2",
      "organizations/a/files/1",
      "organizations/b/files/1",
    ]) {
      await store.put(key, bytes, "application/pdf");
    }
    await Bun.write(join(root, "organizations/a/files/3.x.partial"), bytes);

    expect(await store.list("organizations/a")).toEqual([
      "organizations/a/files/1",
      "organizations/a/files/2",
    ]);
    expect(await store.list("")).toHaveLength(3);
    expect(await store.list("organizations/none")).toEqual([]);

    await store.deletePrefix("organizations/a");
    await store.deletePrefix("organizations/a");
    expect(await store.list("")).toEqual(["organizations/b/files/1"]);
    await expect(store.deletePrefix("")).rejects.toThrow("Not a storage key");
    await expect(store.list("../up")).rejects.toThrow("Not a storage key");
  });

  test("the erasure log's directory reads back what it wrote, its root however spelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "braivo-log-"));
    const log = durableDirectoryStore(`${root}/`);
    await log.put("r1.json", bytes, "application/json");
    expect(await log.list("")).toEqual(["r1.json"]);
    expect(await (await log.get("r1.json"))?.text()).toBe("%PDF-1.7 hola");
  });

  test("a bucket lists every page under the folder, and deletes each key listed", async () => {
    const keys = new Set([
      "organizations/a/files/1",
      "organizations/a/files/2",
      "organizations/a/files/3",
      "organizations/ab/files/1",
    ]);
    const asked: (string | undefined)[] = [];
    const client = {
      write: async () => 0,
      file: () => {
        throw new Error("not read here");
      },
      // Two keys a page, as a bucket pages by a thousand.
      list: async (input?: { prefix?: string; continuationToken?: string } | null) => {
        asked.push(input?.prefix);
        const matching = [...keys].filter((key) => key.startsWith(input?.prefix ?? "")).sort();
        const start = Number(input?.continuationToken ?? 0);
        const page = matching.slice(start, start + 2);
        const more = start + 2 < matching.length;
        return {
          contents: page.map((key) => ({ key })),
          isTruncated: more,
          nextContinuationToken: more ? String(start + 2) : undefined,
        };
      },
      delete: async (key: string) => void keys.delete(key),
    };
    const store = bucketStore(client as unknown as Parameters<typeof bucketStore>[0]);

    expect(await store.list("organizations/a")).toEqual([
      "organizations/a/files/1",
      "organizations/a/files/2",
      "organizations/a/files/3",
    ]);
    // The folder's own keys, never a sibling's that shares its start.
    expect(asked.every((prefix) => prefix === "organizations/a/")).toBe(true);
    await store.deletePrefix("organizations/a");
    expect([...keys]).toEqual(["organizations/ab/files/1"]);
  });
});
