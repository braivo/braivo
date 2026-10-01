// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vite-plus/test";

import { uploadOriginal } from "./originals.ts";

let directory!: string;
const uploaded: string[] = [];
const client = {
  uploadFile: async ({ file }: { file: Blob }) => {
    uploaded.push(file.type);
    return { fileId: "f" };
  },
} as never;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "braivo-originals-"));
});

describe("what may be uploaded as an original", () => {
  test.each([
    ["libro.pdf", "application/pdf"],
    ["Unidad 1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["hoja.jpg", "image/jpeg"],
    ["canción.mp3", "audio/mpeg"],
    ["lección.mp4", "video/mp4"],
  ])("takes %s, as %s", async (name, type) => {
    const path = join(directory, name);
    await writeFile(path, "bytes");

    expect(await uploadOriginal(client, "o", path)).toBe("f");
    expect(uploaded.at(-1)).toBe(type);
  });

  test.each(["id_rsa", ".env", "notes.txt", "page.html", "diagram.svg", "data.json", "a.zip"])(
    "refuses %s, which is not material, without reading it",
    async (name) => {
      const before = uploaded.length;
      // Not even created: the extension alone refuses it.
      await expect(uploadOriginal(client, "o", join(directory, name))).rejects.toThrow(
        "not a document, image, recording, or video",
      );
      expect(uploaded).toHaveLength(before);
    },
  );

  test("refuses a document's name linked to what is not one", async () => {
    const key = join(directory, "id_rsa");
    await writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----");
    const lesson = join(directory, "lesson.pdf");
    await symlink(key, lesson);
    const before = uploaded.length;

    await expect(uploadOriginal(client, "o", lesson)).rejects.toThrow("not a document");
    expect(uploaded).toHaveLength(before);
  });

  test("follows a link to a document, uploading it as what it is", async () => {
    const book = join(directory, "book.pdf");
    await writeFile(book, "%PDF");
    const link = join(directory, "latest.pdf");
    await symlink(book, link);

    expect(await uploadOriginal(client, "o", link)).toBe("f");
    expect(uploaded.at(-1)).toBe("application/pdf");
  });

  test("says so when the file is not there", async () => {
    await expect(uploadOriginal(client, "o", join(directory, "missing.pdf"))).rejects.toThrow(
      "no such file",
    );
  });
});
