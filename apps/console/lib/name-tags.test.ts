// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { sharedNameTags } from "./name-tags.ts";

test("tags only names two people share, long enough to tell them apart", () => {
  const tags = sharedNameTags([
    { userId: "aaaa-123456", name: "Ana" },
    { userId: "bbbb-123456", name: "Ana" },
    { userId: "bbbb-123456", name: "Ana" },
    { userId: "cccc-999999", name: "Lee" },
  ]);
  expect(Object.fromEntries(tags)).toEqual({
    "aaaa-123456": "a-123456",
    "bbbb-123456": "b-123456",
  });
});
