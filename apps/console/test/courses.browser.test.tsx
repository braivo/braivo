// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { renderAt } from "./render.tsx";

/** Lines a node's text takes; pass a text node, as a link's `sr-only` text adds lines of its own. */
function lineCount(node: Node): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  return new Set([...range.getClientRects()].map(({ top }) => Math.round(top))).size;
}

const left = (element: Element) => element.getBoundingClientRect().left;
const top = (element: Element) => element.getBoundingClientRect().top;

/** A listed row's title, its link being the whole row. */
const title = (link: HTMLElement) => link.querySelector(".wrap-anywhere")!;

test("on a phone, puts a listed title's marks beside it, or below from where it starts, and keeps a note on one line", async () => {
  await page.viewport(320, 568);
  renderAt("/example", {
    braivo: {
      listCourses: async () => [
        { id: "c1", number: 1001, title: "Spanish", urlLabel: "spanish", published: false },
        {
          id: "c2",
          number: 1002,
          title: "German for travellers, from the airport to the hotel",
          urlLabel: "german",
          published: true,
          hidden: true,
        },
      ],
      listObjectives: async () => [
        { id: "o1", title: "Greetings", courseIds: ["c2"], waitingTaskCount: 3 },
        {
          id: "o2",
          title: "Thank someone who has helped you, and answer when someone thanks you",
          courseIds: [],
          waitingTaskCount: 2,
        },
      ],
    },
  });

  // A short title keeps its mark beside it.
  const spanish = title(await screen.findByRole("link", { name: "Spanish (needs review)" }));
  const needsReview = spanish.closest("li")!.querySelector("[data-slot=badge]")!;
  expect(top(needsReview)).toBeLessThan(spanish.getBoundingClientRect().bottom);
  expect(left(needsReview)).toBeGreaterThan(spanish.getBoundingClientRect().right);

  // A title that wraps puts its marks on the lines below, from where it starts.
  const german = title(screen.getByRole("link", { name: /^German for travellers/ }));
  expect(lineCount(german.firstChild!)).toBeGreaterThan(1);
  const [hidden, toReview] = german.closest("li")!.querySelectorAll("[data-slot=badge]");
  expect(hidden!.textContent).toBe("Hidden");
  expect(toReview!.textContent).toBe("3 tasks need review");
  expect(left(hidden!)).toBe(left(german));
  expect(top(hidden!)).toBeGreaterThanOrEqual(german.getBoundingClientRect().bottom - 1);

  // An objective's mark too, and its note on one line.
  const objective = title(screen.getByRole("link", { name: /^Thank someone/ }));
  const item = objective.closest("li")!;
  expect(left(item.querySelector("[data-slot=badge]")!)).toBe(left(objective));
  const note = [...item.querySelectorAll("span")].find(
    ({ textContent }) => textContent === "In no course",
  )!;
  expect(lineCount(note.firstChild!)).toBe(1);
});

test("lists courses and objectives as rows of one bordered list, each row its link", async () => {
  await page.viewport(320, 568);
  renderAt("/example", {
    braivo: {
      listCourses: async () => [
        { id: "c1", number: 1001, title: "Spanish", urlLabel: "spanish", published: true },
        { id: "c2", number: 1002, title: "German", urlLabel: "german", published: true },
      ],
      listObjectives: async () => [
        { id: "o1", title: "Greetings", courseIds: [], waitingTaskCount: 0 },
        { id: "o2", title: "Thanks", courseIds: [], waitingTaskCount: 1 },
      ],
    },
  });

  await screen.findByRole("link", { name: "Spanish" });
  for (const name of ["Spanish", "German", "Greetings", /^Thanks/]) {
    const link = screen.getByRole("link", { name });
    const list = link.closest("ul")!;
    expect(getComputedStyle(list).borderTopWidth).toBe("1px");
    // Unclipped, or forced colours' focus, drawn outside a row, is hidden.
    expect(getComputedStyle(list).overflow).toBe("visible");
    // A line between rows: each but the last has one below it.
    const row = link.closest("li")!;
    expect(getComputedStyle(row).borderBottomWidth).toBe(row.nextElementSibling ? "1px" : "0px");
    // The whole row is the link, so a tap anywhere on it opens the page.
    expect(link.getBoundingClientRect().width).toBe(list.clientWidth);
    expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
});
