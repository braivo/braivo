// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite-plus/client" />
import "../styles/globals.css";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { SignInForm } from "./sign-in-form.tsx";

afterEach(cleanup);

/** The box of the text node in `root` whose text `matches`. */
function textBox(root: Node, matches: (text: string) => boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!matches(node.textContent!)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  }
  throw new Error(`No matching text in "${root.textContent}"`);
}

// Both resend buttons: the link, and the main button once the code is spent.
test.each([false, true])(
  "on a phone, puts a space between Send a new code and its countdown, not a wider gap (spent: %s)",
  async (spent) => {
    await page.viewport(320, 568);
    render(
      <I18nProvider i18n={i18n}>
        <SignInForm
          step={{
            step: "code",
            email: "sam@fernwood.example",
            resendAt: Date.now() + 60_000,
            spent,
          }}
          onSubmit={() => {}}
          onResend={() => {}}
        />
      </I18nProvider>,
    );

    const button = screen.getByRole("button", { name: "Send a new code" });
    const label = textBox(button, (text) => text === "Send a new code");
    const countdown = textBox(button, (text) => text.startsWith("in "));
    const gap = countdown.left - label.right;
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = getComputedStyle(button).font;
    expect(gap).toBeCloseTo(context.measureText(" ").width, 0);
  },
);
