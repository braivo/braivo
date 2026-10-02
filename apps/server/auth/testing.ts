// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support: the mail Braivo sends, kept to read codes from as a person
// would. Nothing here is part of the server's behaviour.

import type { Mail, SendMail } from "../mail/index.ts";

/** Mail kept in memory, so a test reads its code as a person would. */
export type Outbox = { sendMail: SendMail; sent: Mail[] };

export function createOutbox(): Outbox {
  const sent: Mail[] = [];
  return { sent, sendMail: async (mail) => void sent.push(mail) };
}

/** The code in the latest mail to `email`. */
export function codeSentTo(outbox: Outbox, email: string): string {
  const mail = outbox.sent.findLast((sent) => sent.to === email);
  const code = mail?.text.match(/\b\d{6}\b/)?.[0];
  if (code === undefined) throw new Error(`No code was sent to ${email}.`);
  return code;
}
