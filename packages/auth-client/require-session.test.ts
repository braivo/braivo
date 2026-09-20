// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isRedirect } from "@tanstack/react-router";
import { describe, expect, test } from "vite-plus/test";

import { requireSession } from "./require-session.ts";

const at = { href: "/courses/c1?tab=next" };

describe("requireSession", () => {
  test("returns the signed-in user", async () => {
    const auth = { getSession: async () => ({ data: { user: { name: "Ada" } }, error: null }) };

    expect(await requireSession(auth, at)).toEqual({ user: { name: "Ada" } });
  });

  test("sends someone signed out to sign in, and back here afterwards", async () => {
    const auth = { getSession: async () => ({ data: null, error: null }) };

    const thrown = await requireSession(auth, at).catch((error: unknown) => error);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: unknown }).options).toMatchObject({
      to: "/sign-in",
      search: { redirect: "/courses/c1?tab=next" },
    });
  });

  test("fails rather than signing out when the session cannot be checked", async () => {
    const auth = {
      getSession: async () => ({ data: null, error: { message: "Service unavailable" } }),
    };

    await expect(requireSession(auth, at)).rejects.toThrow("Service unavailable");
  });
});
