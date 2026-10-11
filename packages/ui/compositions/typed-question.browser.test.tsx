// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render as renderBare, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
// The Playwright provider's types, which give `cdp()` its `send`.
import type {} from "vite-plus/test/browser-playwright";
import { cdp, userEvent } from "vite-plus/test/browser/context";

import { TypedQuestion } from "./typed-question.tsx";

afterEach(cleanup);

const render = (ui: ReactNode) =>
  renderBare(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });

/**
 * In Chromium, with trusted key events: happy-dom neither submits a form on
 * Enter nor composes text, so only here does Enter's handling show.
 */
describe("a typed question, in a browser", () => {
  test("sends the text on Enter", async () => {
    const onSubmit = vi.fn();
    render(<TypedQuestion prompt="Ich ___ müde." onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("bin{Enter}");

    // Once: not again from a key handler of its own.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("bin");
  });

  test("does not send on Enter while the field is blank", async () => {
    const onSubmit = vi.fn();
    render(<TypedQuestion prompt="Ich ___ müde." onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("  {Enter}");

    // Two guards, either enough: Check is disabled, so Enter submits no form,
    // and the form sends no blank text.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("does not send on Enter while an input method is composing", async () => {
    const onSubmit = vi.fn();
    render(<TypedQuestion prompt="Japanese for cat?" onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("textbox"));

    // As a Japanese keyboard does: text composed but not yet committed.
    const session = cdp();
    await session.send("Input.imeSetComposition", {
      text: "ねこ",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    await session.send("Input.insertText", { text: "猫" });
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("猫");
  });
});
