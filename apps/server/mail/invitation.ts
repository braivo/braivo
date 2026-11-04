// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Locale } from "@braivo/i18n/locales";

import type { Mail } from "./transport.ts";

/** The roles an invitation carries, as the mail says what each lets them do. */
type InvitedRole = "author" | "admin";

/** The words of the invitation mail, one entry per language the apps speak (ADR 0035). */
const COPY: Record<
  Locale,
  {
    subject: (inviter: string, school: string) => string;
    intro: (inviter: string, school: string) => string;
    role: Record<InvitedRole, string>;
    action: string;
    expiry: (date: string) => string;
    signIn: string;
    ignore: string;
  }
> = {
  en: {
    subject: (inviter, school) => `${inviter} invites you to ${school}`,
    intro: (inviter, school) => `${inviter} invites you to join ${school}.`,
    role: {
      author: "As an author, you will manage and publish its learning content.",
      admin: "As an administrator, you will manage its people, settings, and learning content.",
    },
    action: "Accept the invitation",
    expiry: (date) => `The invitation expires on ${date}.`,
    signIn: "Sign in with this email address to accept it.",
    ignore: "If you were not expecting it, ignore this email.",
  },
  // Addresses the reader without the gendered past tense.
  pl: {
    subject: (inviter, school) => `${inviter} zaprasza Cię do organizacji „${school}”`,
    intro: (inviter, school) => `${inviter} zaprasza Cię do organizacji „${school}”.`,
    role: {
      author: "Jako autor zarządzasz materiałami do nauki i je publikujesz.",
      admin: "Jako administrator zarządzasz osobami, ustawieniami i materiałami do nauki.",
    },
    action: "Przyjmij zaproszenie",
    expiry: (date) => `Zaproszenie wygasa ${date}.`,
    signIn: "Aby je przyjąć, zaloguj się tym adresem e-mail.",
    ignore: "Jeśli się go nie spodziewasz, zignoruj tę wiadomość.",
  },
};

/** Text as HTML text: an organization or a person names itself freely. */
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/**
 * The email inviting `to` to an organization (ADR 0018): the school, the
 * inviter, the role in plain words, the link, and when it expires, in the
 * inviter's language, without Braivo's branding.
 */
export function invitationMail(input: {
  to: string;
  link: string;
  organization: string;
  inviter: string;
  role: InvitedRole;
  expiresAt: Date;
  locale: Locale;
}): Mail {
  const { to, link, organization, inviter, role, expiresAt, locale } = input;
  const copy = COPY[locale];
  // A date, not a time: in UTC, as the server cannot know the reader's zone.
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    expiresAt,
  );
  const intro = copy.intro(inviter, organization);
  const details = `${copy.role[role]} ${copy.expiry(date)} ${copy.signIn}`;
  const html = (text: string) => escapeHtml(text);
  return {
    to,
    subject: copy.subject(inviter, organization),
    text: `${intro} ${copy.role[role]}\n\n${copy.action}: ${link}\n\n${copy.expiry(date)} ${copy.signIn}\n\n${copy.ignore}`,
    html: `<!doctype html>
<html lang="${locale}">
  <body style="margin:0;padding:32px 16px;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#32325d">
    <div style="max-width:420px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px">
      <p style="margin:0 0 16px;font-size:16px;line-height:24px">${html(intro)}</p>
      <p style="margin:0 0 24px;font-size:14px;line-height:20px;color:#525f7f">${html(details)}</p>
      <p style="margin:0 0 24px;text-align:center"><a href="${html(link)}" style="display:inline-block;padding:12px 20px;background:#32325d;color:#ffffff;border-radius:6px;font-size:16px;text-decoration:none">${html(copy.action)}</a></p>
      <p style="margin:0;font-size:14px;line-height:20px;color:#525f7f">${html(copy.ignore)}</p>
    </div>
  </body>
</html>`,
  };
}
