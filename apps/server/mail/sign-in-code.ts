// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Locale, supportedLocale } from "@braivo/i18n/locales";

import type { Mail } from "./transport.ts";

/** The words of the sign-in mail, one entry per language the apps speak (ADR 0035). */
const COPY: Record<
  Locale,
  {
    subject: (code: string) => string;
    textIntro: (code: string, site: string) => string;
    htmlIntro: (site: string) => string;
    expiry: (minutes: number) => string;
    ignore: string;
  }
> = {
  en: {
    subject: (code) => `${code} is your sign-in code`,
    textIntro: (code, site) => `Enter ${code} at ${site} to sign in.`,
    htmlIntro: (site) => `Enter this code at ${site} to sign in:`,
    expiry: (minutes) =>
      `This code expires in ${minutes} ${plural("en", minutes, { one: "minute", other: "minutes" })} and can be used once.`,
    ignore: "If you did not ask for it, ignore this email: nothing happens without the code.",
  },
  // Addresses the reader without the gendered past tense ("prosiłeś/prosiłaś").
  pl: {
    subject: (code) => `${code} to Twój kod logowania`,
    textIntro: (code, site) => `Wpisz ${code} na stronie ${site}, aby się zalogować.`,
    htmlIntro: (site) => `Wpisz ten kod na stronie ${site}, aby się zalogować:`,
    expiry: (minutes) =>
      `Kod wygasa za ${minutes} ${plural("pl", minutes, { one: "minutę", few: "minuty", many: "minut", other: "minuty" })} i można go użyć tylko raz.`,
    ignore: "Jeśli to nie Ty prosisz o kod, zignoruj tę wiadomość: bez kodu nic się nie stanie.",
  },
};

/** The form of a counted word `count` takes in `locale`, by CLDR's plural categories. */
function plural(
  locale: Locale,
  count: number,
  forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string },
): string {
  return forms[new Intl.PluralRules(locale).select(count)] ?? forms.other;
}

/**
 * The language of a sign-in mail: the supported one `Accept-Language` weighs
 * highest, by primary subtag, else English. Equal weights go to the earlier
 * range, as HTTP sets no order; `q=0`, `*`, or a malformed range picks nothing.
 */
export function mailLocale(acceptLanguage: string | null | undefined): Locale {
  let chosen: Locale = "en";
  let best = 0;
  for (const range of (acceptLanguage ?? "").split(",")) {
    // RFC 9110's language range, with at most one weight.
    const parsed =
      /^([a-z]{1,8})(?:-[a-z\d]{1,8})*(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(
        range.trim(),
      );
    const locale = parsed && supportedLocale(parsed[1]!);
    if (!locale) continue;

    const weight = Number(parsed[2] ?? 1);
    // Strictly greater, so the earlier of two equal weights wins, and q=0 never does.
    if (weight > best) {
      chosen = locale;
      best = weight;
    }
  }
  return chosen;
}

/**
 * The email carrying a sign-in code, in `locale`, naming `site`, the host
 * where it signs in: a learn domain's code works there alone, and a code
 * typed anywhere else may be someone fishing for it (ADR 0018).
 */
export function signInCodeMail(input: {
  to: string;
  code: string;
  site: string;
  expiresInMinutes: number;
  locale: Locale;
}): Mail {
  const { to, code, site, expiresInMinutes, locale } = input;
  if (!/^\d+$/.test(code)) throw new TypeError("A sign-in code is digits only.");
  // A host as `URL#host` gives it, a name or a bracketed IPv6 address with
  // any port: nothing to escape in the HTML.
  if (!/^(?:[a-z\d.-]+|\[[\da-f:.]+\])(?::\d+)?$/.test(site)) {
    throw new TypeError("A site is a host.");
  }
  const copy = COPY[locale];
  const expiry = copy.expiry(expiresInMinutes);
  return {
    to,
    subject: copy.subject(code),
    text: `${copy.textIntro(code, site)} ${expiry}\n\n${copy.ignore}`,
    html: `<!doctype html>
<html lang="${locale}">
  <body style="margin:0;padding:32px 16px;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#32325d">
    <div style="max-width:420px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;text-align:center">
      <p style="margin:0 0 16px;font-size:16px;line-height:24px">${copy.htmlIntro(site)}</p>
      <p style="margin:0 0 16px;font-size:36px;font-weight:600;letter-spacing:0.25em;font-family:Menlo,Consolas,monospace">${code}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#525f7f">${expiry}</p>
      <p style="margin:0;font-size:14px;line-height:20px;color:#525f7f">${copy.ignore}</p>
    </div>
  </body>
</html>`,
  };
}
