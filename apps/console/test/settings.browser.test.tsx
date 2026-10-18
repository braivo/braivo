// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { renderAt } from "./render.tsx";

test("on a phone, wraps a long name in its cell and puts the You badge below it, from where it starts", async () => {
  await page.viewport(320, 568);
  // Unhyphenated, as a hyphen would wrap it without `wrap-anywhere`.
  const name = "Olivia Ownertonwhitfieldhamiltonsmythe";
  renderAt("/example/settings/members", {
    name,
    braivo: { listMembers: async () => [{ userId: "u1", name, roles: ["owner"] }] },
  });

  const badge = await screen.findByText("You");
  const nameText = screen.getByText(name);
  const badgeBox = badge.getBoundingClientRect();
  const nameBox = nameText.getBoundingClientRect();
  expect(badgeBox.top).toBeGreaterThanOrEqual(nameBox.bottom - 1);
  expect(badgeBox.left).toBe(nameBox.left);
  // The name wraps rather than widening the table past the page.
  const table = nameText.closest("table")!;
  expect(table.offsetWidth).toBeLessThanOrEqual(table.parentElement!.clientWidth);
});
