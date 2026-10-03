// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { signInCodeMail } from "./sign-in-code.ts";

test("the text and the HTML both carry the code, its lifetime, and the disclaimer", () => {
  const mail = signInCodeMail({ to: "a@example.com", code: "123456", expiresInMinutes: 10 });

  expect(mail.to).toBe("a@example.com");
  expect(mail.subject).toBe("123456 is your sign-in code");
  expect(mail.text).toBe(
    "Enter 123456 to sign in. This code expires in 10 minutes and can be used once.\n\n" +
      "If you did not ask for it, ignore this email: nothing happens without the code.",
  );
  for (const part of [
    "Enter this code to sign in:",
    "123456",
    "This code expires in 10 minutes and can be used once.",
    "ignore this email",
  ]) {
    expect(mail.html).toContain(part);
  }
});

test("refuses a code that is not digits, which goes into the HTML as is", () => {
  expect(() =>
    signInCodeMail({ to: "a@example.com", code: "12345a", expiresInMinutes: 10 }),
  ).toThrow(TypeError);
});
