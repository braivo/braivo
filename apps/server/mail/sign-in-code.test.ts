// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { mailLocale, signInCodeMail } from "./sign-in-code.ts";

test("the text and the HTML both carry the code, its lifetime, and the disclaimer", () => {
  const mail = signInCodeMail({
    to: "a@example.com",
    code: "123456",
    site: "braivo.example",
    expiresInMinutes: 10,
    locale: "en",
  });

  expect(mail.to).toBe("a@example.com");
  expect(mail.subject).toBe("123456 is your sign-in code");
  expect(mail.text).toBe(
    "Enter 123456 at braivo.example to sign in. This code expires in 10 minutes and can be used once.\n\n" +
      "If you did not ask for it, ignore this email: nothing happens without the code.",
  );
  for (const part of [
    '<html lang="en">',
    "Enter this code at braivo.example to sign in:",
    "123456",
    "This code expires in 10 minutes and can be used once.",
    "If you did not ask for it, ignore this email: nothing happens without the code.",
  ]) {
    expect(mail.html).toContain(part);
  }
  // White-label: the installation's organization, not Braivo, is who people think they sign in to.
  expect(mail.html).not.toContain("Braivo");

  const once = signInCodeMail({
    to: "a@example.com",
    code: "1",
    site: "braivo.example",
    expiresInMinutes: 1,
    locale: "en",
  });
  expect(once.text).toContain("expires in 1 minute and");
});

test("in Polish, the same mail, its lifetime counted in Polish's plural forms", () => {
  const mail = signInCodeMail({
    to: "a@example.com",
    code: "123456",
    site: "braivo.example",
    expiresInMinutes: 10,
    locale: "pl",
  });

  expect(mail.subject).toBe("123456 to Twój kod logowania");
  expect(mail.text).toBe(
    "Wpisz 123456 na stronie braivo.example, aby się zalogować. Kod wygasa za 10 minut i można go użyć tylko raz.\n\n" +
      "Jeśli to nie Ty prosisz o kod, zignoruj tę wiadomość: bez kodu nic się nie stanie.",
  );
  for (const part of [
    '<html lang="pl">',
    "Wpisz ten kod na stronie braivo.example, aby się zalogować:",
    "Kod wygasa za 10 minut i można go użyć tylko raz.",
    "Jeśli to nie Ty prosisz o kod, zignoruj tę wiadomość: bez kodu nic się nie stanie.",
  ]) {
    expect(mail.html).toContain(part);
  }

  const lifetime = (expiresInMinutes: number) =>
    signInCodeMail({
      to: "a@example.com",
      code: "1",
      site: "braivo.example",
      expiresInMinutes,
      locale: "pl",
    }).text.match(/za (\d+ \S+)/)?.[1];
  expect([1, 2, 5, 12, 22].map(lifetime)).toEqual([
    "1 minutę",
    "2 minuty",
    "5 minut",
    "12 minut",
    "22 minuty",
  ]);
});

test("refuses a code that is not digits, which goes into the HTML as is", () => {
  expect(() =>
    signInCodeMail({
      to: "a@example.com",
      code: "12345a",
      site: "braivo.example",
      expiresInMinutes: 10,
      locale: "en",
    }),
  ).toThrow(TypeError);
});

test.each([
  ["pl-PL,pl;q=0.9", "pl"],
  ["PL", "pl"],
  ["en;q=0.5, pl;q=0.8", "pl"],
  ["pl;q=0.8, en;q=0.5", "pl"],
  ["en, pl", "en"],
  ["pl, en", "pl"],
  ["de, pl;q=0.5", "pl"],
  ["pl;q=0, en;q=0.1", "en"],
  ["pl;q=0", "en"],
  ["en;q=0", "en"],
  ["de", "en"],
  ["*", "en"],
  ["pl;q=2", "en"],
  ["pl;q=abc", "en"],
  ["pl;q=0;q=1", "en"],
  ["pl-@", "en"],
  ["pl ; q=1.000", "pl"],
  ["pl;q=0., en;q=0.5", "en"],
  ["pl-Latn-PL;q=0.7, en;q=0.6", "pl"],
  ["", "en"],
  [null, "en"],
  [undefined, "en"],
])("the mail for Accept-Language %j is in %s", (header, locale) => {
  expect(mailLocale(header)).toBe(locale);
});

test.each(["braivo.example", "localhost:5174", "[::1]:5174", "127.0.0.1:3000"])(
  "names the site %s, any host `URL#host` gives",
  (site) => {
    const mail = signInCodeMail({
      to: "a@example.com",
      code: "1",
      site,
      expiresInMinutes: 1,
      locale: "en",
    });
    expect(mail.html).toContain(`at ${site} to sign in`);
  },
);

test.each(["<b>", "a b", 'x"y'])("refuses a site %j that is not a host", (site) => {
  expect(() =>
    signInCodeMail({ to: "a@example.com", code: "1", site, expiresInMinutes: 1, locale: "en" }),
  ).toThrow(TypeError);
});
