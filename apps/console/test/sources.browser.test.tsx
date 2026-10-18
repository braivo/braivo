// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { renderAt } from "./render.tsx";

test("on a phone, sets the status under Add material apart from the button, at its own line height", async () => {
  await page.viewport(320, 568);
  renderAt("/example/sources", { braivo: { listSources: async () => [] } });

  const status = await screen.findByRole("status");
  const button = screen.getByRole("button", { name: "Add material" });
  // The `Field`'s gap, as a hint's under its control.
  expect(status.getBoundingClientRect().top - button.getBoundingClientRect().bottom).toBe(12);

  const range = document.createRange();
  range.selectNodeContents(status.firstChild!);
  const lineTops = [...new Set([...range.getClientRects()].map(({ top }) => Math.round(top)))];
  expect(lineTops.length).toBeGreaterThan(1);
  expect(lineTops[1]! - lineTops[0]!).toBe(parseFloat(getComputedStyle(status).lineHeight));
});
