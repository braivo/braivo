// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { members } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** The tops of the lines on which `element` draws `text`. */
function lineTops(element: Element, text: string): Set<number> {
  const range = document.createRange();
  let offset = element.textContent!.indexOf(text);
  if (offset < 0) throw new Error(`No "${text}" in "${element.textContent}"`);
  let end = offset + text.length;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (offset >= 0 && offset <= length) range.setStart(node, offset);
    if (end <= length) {
      range.setEnd(node, end);
      break;
    }
    offset -= length;
    end -= length;
  }
  return new Set([...range.getClientRects()].map(({ top }) => Math.round(top)));
}

test("on a phone, wraps a learner's evidence between its date and time, not inside the time", async () => {
  await page.viewport(320, 568);
  // In local time, so it shows 5:28 PM in any time zone.
  const at = new Date(2026, 9, 18, 17, 28).toISOString();
  renderAt("/example/courses/course-1/learners/u2", {
    braivo: {
      listCourses: async () => [
        { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
      ],
      listMembers: async () => members,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        objectives: [
          {
            objectiveId: "o1",
            title: "Greetings",
            phase: "acquiring",
            lastEvidenceAt: at,
            evidence: [{ outcome: "success", at }],
          },
        ],
      }),
    },
  });

  const counted = await screen.findByText("1 success");
  fireEvent.click(counted);
  const entry = counted.closest("details")!.querySelector("li")!;
  await document.fonts.ready;
  // As rendered, with whichever space ICU puts before PM.
  const time = entry.textContent!.match(/5:28\sPM/)![0];
  // On a line below the date's end, and on one line.
  const [timeTop, ...rest] = lineTops(entry, time);
  expect(timeTop).toBeGreaterThan(Math.max(...lineTops(entry, "2026")));
  expect(rest).toEqual([]);
});
