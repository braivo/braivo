// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { activateLocale } from "@braivo/i18n";
import { screen } from "@testing-library/react";
import { expect, onTestFinished, test } from "vite-plus/test";
// The Playwright provider's types, which give `cdp()` its `send`.
import type {} from "vite-plus/test/browser-playwright";
import { cdp, page } from "vite-plus/test/browser/context";

import { activity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** How many lines `text` takes in `element`'s only text node, U+00A0 matching a space. */
function lineCount(element: Element, text: string): number {
  const node = element.firstChild!;
  const start = node.textContent!.replace(/\s/g, " ").indexOf(text);
  if (start < 0) throw new Error(`No "${text}" in "${node.textContent}"`);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  return new Set([...range.getClientRects()].map(({ top }) => Math.round(top))).size;
}

test("on a phone, wraps the standing summary between its counts, never inside one", async () => {
  await page.viewport(320, 568);
  const at = new Date().toISOString();
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity: async () => activity,
    learnerProgress: async () => ({
      modelVersion: "v1",
      asOf: "2026-06-01T00:00:00.000Z",
      repeatedMissesThreshold: 3,
      lastPractisedAt: null,
      objectives: [
        { objectiveId: "a", title: "Greetings", phase: "acquiring", lastEvidenceAt: at },
        { objectiveId: "b", title: "Numbers", phase: "unseen" },
        {
          objectiveId: "c",
          title: "Colours",
          phase: "retaining",
          lastEvidenceAt: at,
          stability: 3,
          retrievability: 0.95,
          due: false,
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    }),
  });

  const counts = ["1 retained", "1 learning", "1 not started"];
  const line = counts.join(" · ");
  const summary = await screen.findByText(line);
  await document.fonts.ready;
  // Wider than a phone, so it wraps.
  expect(lineCount(summary, line)).toBeGreaterThan(1);
  expect(counts.map((count) => lineCount(summary, count))).toEqual([1, 1, 1]);
});

// In a browser, since Bun's Intl, where the page tests run, joins them with "o" already.
test("in Polish, joins a later review's date and its time with o", async () => {
  await activateLocale("pl");
  await cdp().send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Warsaw" });
  onTestFinished(async () => {
    await cdp().send("Emulation.setTimezoneOverride", { timezoneId: "" });
    await activateLocale("en");
  });
  renderAt("/c/4732", {
    signedIn: true,
    learnerProgress: async () => ({
      modelVersion: "v1",
      asOf: "2026-06-01T00:00:00.000Z",
      repeatedMissesThreshold: 3,
      lastPractisedAt: null,
      objectives: [
        {
          objectiveId: "a",
          title: "Powitania",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 3,
          retrievability: 0.95,
          due: false,
          dueAt: "2030-06-05T10:00:00.000Z",
        },
      ],
    }),
  });

  expect(
    await screen.findByText(/Następna powtórka: „Powitania”, środa, 5 czerwca 2030 o 12:00\.$/),
  ).toBeTruthy();
});
