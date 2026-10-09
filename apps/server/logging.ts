// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shapes of SQLSTATE (`23505`) and of Node's and Nodemailer's codes
 * (`ECONNREFUSED`, `EAUTH`); not six digits, a sign-in code's.
 */
const CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,31})$/;
const CLASS_NAME = /^\w{1,64}$/;

/**
 * An error as a log may hold it: each class down its causes, with its code,
 * such as `DrizzleQueryError < DatabaseError 23505`. Never a message, a stack,
 * or any other field: Drizzle's message carries the query's parameters, and a
 * mail transport's names the recipient, so either can hold an email, a
 * learner's answer, or a token.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let at = error, depth = 0; at !== undefined && depth < 5; depth++) {
    if (!(at instanceof Error)) {
      parts.push(at === null ? "null" : typeof at);
      break;
    }
    const code = (at as { code?: unknown }).code;
    // The class's, as pg names each of its errors `error`.
    const name = CLASS_NAME.test(at.constructor.name) ? at.constructor.name : "Error";
    parts.push(typeof code === "string" && CODE.test(code) ? `${name} ${code}` : name);
    at = at.cause;
  }
  return parts.join(" < ");
}

/**
 * A library's log call as a log may hold it: each error described, whether an
 * argument or an argument's `error` field, and no string. Better Auth
 * interpolates URLs into its messages and passes request input, such as a
 * callback's `error`, as an argument.
 */
export function describeLogCall(message: unknown, args: readonly unknown[]): string {
  const errors = [message, ...args]
    .map((part) => (part instanceof Error ? part : (part as { error?: unknown } | null)?.error))
    .filter((part) => part instanceof Error);
  return errors.length > 0 ? errors.map(describeError).join(" ") : "message withheld";
}
