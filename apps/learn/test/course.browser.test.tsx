// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { activateLocale } from "@braivo/i18n";
import { screen } from "@testing-library/react";
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

test("on a phone, keeps Continue in view below feedback longer than the screen", async () => {
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
