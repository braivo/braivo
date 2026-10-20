// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { typedActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** Where `element`'s text starts and ends, its padding aside. */
function textEdges(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const { left, right } = range.getBoundingClientRect();
  return { left, right };
}

test("on a phone, lines up Show answer's text with the question's, and Sign out's with the page's edge", async () => {
  await page.viewport(320, 568);
  renderAt("/c/4732", { signedIn: true, nextActivity: async () => typedActivity });

  const showAnswer = await screen.findByRole("button", { name: "Show answer" });
  const { left } = textEdges(screen.getByText("I am tired: Ich ___ müde."));
  const signOut = screen.getByRole("button", { name: "Sign out" });
  const { right } = signOut.parentElement!.getBoundingClientRect();
  // Within a button's transparent 1px border.
  expect(Math.abs(textEdges(showAnswer).left - left)).toBeLessThanOrEqual(1);
  expect(Math.abs(textEdges(signOut).right - right)).toBeLessThanOrEqual(1);
});
