// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import "../styles/globals.css";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { ChoiceQuestion } from "./choice-question.tsx";

afterEach(() => {
  cleanup();
  document.documentElement.style.fontSize = "";
});

/**
 * In Chromium, with the apps' styles: happy-dom lays nothing out, so only
 * here does an answered option's label show where it falls.
 */
describe("an answered choice question, in a browser", () => {
  test("puts a label below an option's text that leaves it no room, at the end", () => {
    const long = "Do widzenia, miłego dnia i do zobaczenia jutro";
    // The learn app's root size (apps/learn/styles.css), which sets every rem here.
    document.documentElement.style.fontSize = "112.5%";
    render(
      <I18nProvider i18n={i18n}>
        {/* A 320px phone's content width. */}
        <div style={{ width: 272 }}>
          <ChoiceQuestion
            prompt="Someone helps you. What do you say?"
            options={[
              { choice: 1, text: "Thank you" },
              { choice: 2, text: long },
            ]}
            chosen={2}
            correctChoice={1}
            onChoose={() => {}}
          />
        </div>
      </I18nProvider>,
    );
    const [short, wrong] = screen.getAllByRole("button");
    const box = (element: Element) => element.getBoundingClientRect();

    // Room beside a short text: the label shares its line.
    const correct = box(within(short!).getByText("Correct"));
    expect(correct.top).toBeLessThan(box(within(short!).getByText("Thank you")).bottom);

    // None beside a long one: the label wraps below it, at the option's end,
    // rather than squeezing the text into a narrow column beside it.
    const text = box(within(wrong!).getByText(long));
    const label = box(within(wrong!).getByText("Your answer"));
    expect(label.top).toBeGreaterThanOrEqual(text.bottom - 1);
    expect(box(wrong!).right - label.right).toBeLessThan(box(wrong!).width / 4);
    expect(text.width).toBeGreaterThan(box(wrong!).width / 2);
  });
});
