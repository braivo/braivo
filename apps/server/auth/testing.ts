// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support: sessions made the way people make them, with a code from their
// email. Nothing here is part of the server's behaviour.

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

/** Better Auth's handler, or an API mounting it, given a path below `/api/auth`. */
export type AuthRequest = (path: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Signs `email` in by the code mailed to it, making its account, named `name`,
 * if there is none. Answers the session as a cookie and as a bearer token, and
 * the account's ID.
 */
export async function signInWithCode(
  request: AuthRequest,
  outbox: Outbox,
  input: { email: string; name?: string },
): Promise<{ cookie: string; token: string; id: string }> {
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const sent = await post("/email-otp/send-verification-otp", {
    email: input.email,
    type: "sign-in",
  });
  if (!sent.ok) throw new Error(`Sending a code answered ${sent.status}: ${await sent.text()}`);
  const signedIn = await post("/sign-in/email-otp", {
    email: input.email,
    otp: codeSentTo(outbox, input.email),
    name: input.name,
  });
  if (!signedIn.ok)
    throw new Error(`Signing in answered ${signedIn.status}: ${await signedIn.text()}`);

  const { token, user } = (await signedIn.json()) as { token: string; user: { id: string } };
  // What a browser sends back: `name=value` pairs, without the attributes.
  const cookie = signedIn.headers
    .getSetCookie()
    .map((set) => set.split(";", 1)[0])
    .join("; ");
  return { cookie, token, id: user.id };
}
