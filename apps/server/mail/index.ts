// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createTransport } from "nodemailer";

/** One message to one address, with equivalent plain-text and HTML bodies. */
export type Mail = { to: string; subject: string; text: string; html: string };

/** Hands a message to the mail transport, or throws if that fails. */
export type SendMail = (mail: Mail) => Promise<void>;

/**
 * Through an SMTP server, which nearly every mail provider offers and a
 * self-hosted machine can run, so an installation needs no particular vendor.
 */
export function smtpMail(options: { url: string; from: string }): SendMail {
  const transport = createTransport(options.url);
  return async (mail) => {
    // Field by field, so a `Mail` carrying more (a `from`, say) cannot reach Nodemailer.
    await transport.sendMail({
      from: options.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  };
}

/**
 * Into the server's log instead, which only an installation no one else can
 * reach may do: what it sends are sign-in codes (`cli/config.ts`).
 */
export const logMail: SendMail = async (mail) => {
  console.log(`Mail to ${mail.to}: ${mail.subject}\n${mail.text}`);
};
