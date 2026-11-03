// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles.css";
import { BraivoError, type BraivoClient } from "@braivo/server/client";
import { screen } from "@testing-library/react";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { typedActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

// The graded answer's foot as it changes size: what a steady layout's tests miss.

/** Whether `element` shows, in part at least, in the viewport. */
function inView(element: Element) {
  const { top, bottom } = element.getBoundingClientRect();
  return bottom > 0 && top < window.innerHeight;
}

test("keeps the focused Continue on screen when a failure grows the foot past half the screen", async () => {
  await page.viewport(320, 400);
  const nextActivity = vi
    .fn<BraivoClient["nextActivity"]>()
    .mockResolvedValueOnce(typedActivity)
    .mockRejectedValue(new BraivoError(500, "unavailable"));
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity,
    submitAttempt: async () => ({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      explanation: "Sein: ich bin, du bist, er ist. ".repeat(12),
    }),
  });

  await userEvent.type(await screen.findByRole("textbox"), "ben{Enter}");
  const next = await screen.findByRole("button", { name: "Continue" });
  expect(getComputedStyle(next.parentElement!).position).toBe("sticky");
  await userEvent.click(next);

  // The failure's alert takes the foot past half the screen: it scrolls with the
  // page now, and the control the learner is on, to try again, is brought into view.
  expect(await screen.findByText("Could not load the next question. Try again.")).toBeTruthy();
  await expect.poll(() => getComputedStyle(next.parentElement!).position).toBe("static");
  await expect.poll(() => inView(next)).toBe(true);
  expect(document.activeElement).toBe(next);
});

test("keeps the focused Continue on screen when a failure grows a foot already let go", async () => {
  await page.viewport(320, 568);
  // Twice the app's text: the foot is past half the screen, scrolling with the page, from the start.
  document.documentElement.style.fontSize = "225%";
  onTestFinished(() => {
    document.documentElement.style.fontSize = "";
  });
  const nextActivity = vi
    .fn<BraivoClient["nextActivity"]>()
    .mockResolvedValueOnce(typedActivity)
    .mockRejectedValue(new BraivoError(500, "unavailable"));
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity,
    submitAttempt: async () => ({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      explanation: "Sein: ich bin, du bist, er ist. ".repeat(12),
    }),
  });

  await userEvent.type(await screen.findByRole("textbox"), "ben{Enter}");
  const next = await screen.findByRole("button", { name: "Continue" });
  await expect.poll(() => getComputedStyle(next.parentElement!).position).toBe("static");
  await expect.poll(() => inView(next)).toBe(true);

  // Each failure grows the foot again: the focused retry stays in view every time.
  for (let failure = 1; failure <= 2; failure++) {
    await userEvent.click(next);
    expect(await screen.findByText("Could not load the next question. Try again.")).toBeTruthy();
    await expect.poll(() => next.textContent).toBe("Continue");
    await expect.poll(() => inView(next)).toBe(true);
    expect(document.activeElement).toBe(next);
  }
});

test("leaves the page where it is when the foot unpins while the focus is elsewhere", async () => {
  await page.viewport(320, 400);
  renderAt("/c/4732", {
    signedIn: true,
    nextActivity: async () => typedActivity,
    submitAttempt: async () => ({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      explanation: "Sein: ich bin, du bist, er ist. ".repeat(12),
    }),
  });

  await userEvent.type(await screen.findByRole("textbox"), "ben{Enter}");
  const next = await screen.findByRole("button", { name: "Continue" });
  // The learner reading from the top, the focus off the foot.
  next.blur();
  window.scrollTo(0, 0);
  // Larger text unpins the foot.
  document.documentElement.style.fontSize = "225%";
  try {
    await expect.poll(() => getComputedStyle(next.parentElement!).position).toBe("static");
    expect(window.scrollY).toBe(0);
  } finally {
    document.documentElement.style.fontSize = "";
  }
});
