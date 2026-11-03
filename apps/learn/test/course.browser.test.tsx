// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { activateLocale } from "@braivo/i18n";
import { screen, within } from "@testing-library/react";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { typedActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** Where `element`'s text starts and ends, its padding aside. */
function textEdges(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const { left, right } = range.getBoundingClientRect();
  return { left, right };
}

test("on a phone, lines up Show answer's text and Close's icon with the question's", async () => {
  await page.viewport(320, 568);
  renderAt("/c/4732", { signedIn: true, nextActivity: async () => typedActivity });

  const showAnswer = await screen.findByRole("button", { name: "Show answer" });
  const { left } = textEdges(screen.getByText("I am tired: Ich ___ müde."));
  const close = screen.getByRole("link", { name: "Close" }).querySelector("svg")!;
  // Within a button's transparent 1px border; the icon's box, its glyph inset 2px of 24.
  expect(Math.abs(textEdges(showAnswer).left - left)).toBeLessThanOrEqual(1);
  expect(Math.abs(close.getBoundingClientRect().left - left)).toBeLessThanOrEqual(1);
});

test("on a phone, keeps the verdict and Continue in view below feedback longer than the screen", async () => {
  await page.viewport(320, 568);
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity: async () => typedActivity,
    submitAttempt: async () => ({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      explanation: "Sein: ich bin, du bist, er ist. ".repeat(20),
    }),
  });

  await userEvent.type(await screen.findByRole("textbox"), "ist{Enter}");
  const next = await screen.findByRole("button", { name: "Continue" });
  // The page scrolls, yet read from its top, as feedback is, Continue sits on
  // screen at its foot, with Check gone. From the top: focus alone scrolls to it.
  expect(document.documentElement.scrollHeight).toBeGreaterThan(568);
  window.scrollTo(0, 0);
  const { top, bottom } = next.getBoundingClientRect();
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(568);
  expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
  // The verdict just above it, where the eye goes to move on, the explanation's length aside.
  const verdict = screen.getByRole("alert").getBoundingClientRect();
  expect(verdict.top).toBeGreaterThanOrEqual(0);
  expect(top - verdict.bottom).toBeGreaterThanOrEqual(0);
  expect(top - verdict.bottom).toBeLessThanOrEqual(24);
});

test("on a phone, scrolls a passage's link focused above the pinned Continue, never beneath it", async () => {
  await page.viewport(320, 568);
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity: async () => typedActivity,
    submitAttempt: async () => ({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      passages: Array.from({ length: 6 }, (_, index) => ({
        quote: "Ich bin müde, und du bist es auch. ".repeat(3),
        source: { title: `Lesson ${index + 1}`, url: `https://example.com/${index + 1}` },
      })),
    }),
  });

  await userEvent.type(await screen.findByRole("textbox"), "ist{Enter}");
  const foot = (await screen.findByRole("button", { name: "Continue" })).parentElement!;
  window.scrollTo(0, 0);
  // Each link in turn, as Tab takes them, down the page.
  for (const link of screen.getAllByRole("link", { name: /^Lesson / })) {
    link.focus();
    expect(link.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      foot.getBoundingClientRect().top,
    );
  }
});

test("on a phone, in Polish, fits the answer field's placeholder whole, and Check below it, as wide", async () => {
  await activateLocale("pl");
  onTestFinished(() => activateLocale("en"));
  await page.viewport(320, 568);
  renderAt("/c/4732", { signedIn: true, nextActivity: async () => typedActivity });

  const field = (await screen.findByRole("textbox")) as HTMLInputElement;
  const check = screen.getByRole("button", { name: "Sprawdź" });
  const style = getComputedStyle(field);
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = style.font;
  const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  expect(field.placeholder).toBe("Wpisz odpowiedź");
  expect(context.measureText(field.placeholder).width).toBeLessThanOrEqual(room);
  const box = field.getBoundingClientRect();
  const { top, width } = check.getBoundingClientRect();
  expect(top).toBeGreaterThanOrEqual(box.bottom);
  expect(Math.abs(width - box.width)).toBeLessThanOrEqual(1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

test("on a phone, keeps a long correct answer in the page, the pinned foot short", async () => {
  await page.viewport(320, 568);
  const answer = "Ich bin heute sehr müde, weil ich gestern lange gearbeitet habe. "
    .repeat(4)
    .trim();
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity: async () => typedActivity,
    submitAttempt: async () => ({ kind: "typed", outcome: "failure", correctAnswer: answer }),
  });

  // A near miss, so its missed letters are marked: still read whole.
  await userEvent.type(
    await screen.findByRole("textbox"),
    `${answer.replace("müde", "mude")}{Enter}`,
  );
  const foot = (await screen.findByRole("button", { name: "Continue" })).parentElement!;
  expect(document.querySelectorAll("mark")).toHaveLength(1);
  // Named in full, never cut, outside the foot, which keeps to the verdict and Continue.
  expect(foot.contains(document.querySelector("mark"))).toBe(false);
  expect(within(foot).getByText("Not quite")).toBeTruthy();
  // Read as the focus lands on Continue, as the foot's answer is in its alert.
  expect(
    within(foot).getByRole("button", { name: "Continue", description: `The answer: ${answer}` }),
  ).toBe(document.activeElement);
  expect(foot.getBoundingClientRect().height).toBeLessThan(568 / 3);
  // A way to it from the verdict, wherever the page left it: on screen, clear of the foot.
  await userEvent.click(within(foot).getByRole("button", { name: "See the answer" }));
  const shown = document.querySelector("mark")!.closest("p")!.getBoundingClientRect();
  await expect
    .poll(() => document.querySelector("mark")!.closest("p")!.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(foot.getBoundingClientRect().top);
  expect(shown.top).toBeGreaterThanOrEqual(0);
});

test.each([
  [375, 667],
  [1280, 900],
])(
  "at %ix%i, puts Continue at the screen's foot after a short answer too, the report flag beside the verdict, after Continue",
  async (width, height) => {
    await page.viewport(width, height);
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      submitAttempt: async () => ({ kind: "typed", outcome: "failure", correctAnswer: "bin" }),
    });

    await userEvent.type(await screen.findByRole("textbox"), "ben{Enter}");
    const next = await screen.findByRole("button", { name: "Continue" });
    // In one place every question: the foot's padding from the screen's edge, however short the page.
    expect(height - next.getBoundingClientRect().bottom).toBeLessThanOrEqual(16);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
    // Beside the verdict, on its line, at the default text size.
    const flag = screen.getByRole("button", { name: "Report a problem" }).getBoundingClientRect();
    const verdict = screen.getByRole("alert").getBoundingClientRect();
    expect(flag.left).toBeGreaterThanOrEqual(verdict.right);
    expect(flag.top).toBeLessThan(verdict.bottom);
    // Tab leaves Continue for the flag: nothing between the learner and Continue.
    expect(document.activeElement).toBe(next);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Report a problem" }));
  },
);

test("on a phone, keeps a notice its own height in the screen-high course page", async () => {
  await page.viewport(375, 667);
  renderAt("/c/4732", { signedIn: true });

  const notice = await screen.findByRole("region", { name: "You're caught up" });
  // Not stretched to the screen's foot, its words floating in the middle.
  expect(notice.getBoundingClientRect().height).toBeLessThan(667 / 2);
});

/** Whether two boxes share any area. */
function intersects(one: DOMRect, other: DOMRect) {
  return (
    one.left < other.right &&
    other.left < one.right &&
    one.top < other.bottom &&
    other.top < one.bottom
  );
}

test.each(["en", "pl"] as const)(
  "on a phone with text twice as large, in %s, keeps the verdict, its flag, and the answer's link apart and on screen",
  async (locale) => {
    await activateLocale(locale);
    document.documentElement.style.fontSize = "225%";
    onTestFinished(async () => {
      document.documentElement.style.fontSize = "";
      await activateLocale("en");
    });
    await page.viewport(320, 568);
    const answer = "Ich bin heute sehr müde, weil ich gestern lange gearbeitet habe.";
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      submitAttempt: async () => ({ kind: "typed", outcome: "failure", correctAnswer: answer }),
    });

    await userEvent.type(await screen.findByRole("textbox"), "ist{Enter}");
    const alert = await screen.findByRole("alert");
    const title = alert.querySelector('[data-slot="alert-title"]')!;
    const flag = screen.getByRole("button", {
      name: locale === "pl" ? "Zgłoś problem" : "Report a problem",
    });
    const link = within(alert).getByRole("button");
    const range = document.createRange();
    range.selectNodeContents(title);
    for (const line of range.getClientRects()) {
      expect(intersects(flag.getBoundingClientRect(), line)).toBe(false);
    }
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      alert.getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    // The session's bar keeps a width beside its count.
    expect(screen.getByRole("progressbar").getBoundingClientRect().width).toBeGreaterThan(40);
    // Taller than half the screen, the foot scrolls with the page rather than covering it.
    const foot = screen.getByRole("button", {
      name: locale === "pl" ? "Dalej" : "Continue",
    }).parentElement!;
    const { position } = getComputedStyle(foot);
    expect(position === "sticky" ? foot.getBoundingClientRect().height <= 568 / 2 : true).toBe(
      true,
    );
    expect(["sticky", "static"]).toContain(position);
  },
);
