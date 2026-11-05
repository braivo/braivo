// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createTransport } from "nodemailer";

/** One message to one address, with equivalent plain-text and HTML bodies. */
export type Mail = { to: string; subject: string; text: string; html: string };

/** Hands a message to the mail transport, or throws if that fails. */
export type SendMail = (mail: Mail) => Promise<void>;

/**
 * How long one message may take to hand over before it counts as failed
 * (ADR 0033): within what the console waits for one invitation (12 s) and
 * sign-in for a code (10 s), so a slow server is said as such, not as a lost
 * request, and 100 invitations, five at once, end within the console's wait.
 */
const DEADLINE_MS = 8_000;

/**
 * Through an SMTP server, which nearly every mail provider offers and a
 * self-hosted machine can run, so an installation needs no particular vendor.
 */
export function smtpMail(options: { url: string; from: string; deadlineMs?: number }): SendMail {
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  // Each phase's timeout ends a stalled connection, rather than Nodemailer's
  // minutes; the URL's own settings win.
  const transport = createTransport({
    url: options.url,
    connectionTimeout: deadlineMs,
    greetingTimeout: deadlineMs,
    socketTimeout: deadlineMs,
  });
  return async (mail) => {
    // Field by field, so a `Mail` carrying more (a `from`, say) cannot reach Nodemailer.
    const sent = transport.sendMail({
      from: options.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    // The whole send, however its phases add up. Given up on, it may still
    // be delivered: its failure, later, is nobody's to handle.
    sent.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The mail server did not answer within ${deadlineMs} ms.`)),
        deadlineMs,
      );
    });
    try {
      await Promise.race([sent, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Into the server's log instead, which only an installation no one else can
 * reach may do: what it sends are sign-in codes (`../config.ts`).
 */
export const logMail: SendMail = async (mail) => {
  console.log(`Mail to ${mail.to}: ${mail.subject}\n${mail.text}`);
};
