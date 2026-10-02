// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { signInCodeMail } from "./sign-in-code.ts";

test("the code, its lifetime, and the disclaimer are in both the text and the HTML", () => {
  const mail = signInCodeMail({ to: "a@example.com", code: "123456", minutes: 10 });

  expect(mail.to).toBe("a@example.com");
  expect(mail.subject).toBe("123456 is your sign-in code");
  for (const body of [mail.text, mail.html]) {
    expect(body).toContain("123456");
    expect(body).toContain("10 minutes");
    expect(body).toContain("ignore this email");
  }
});
