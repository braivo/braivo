// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How long the console waits for Braivo before offering a way out, since
// school wifi can stall a request with no error at all.

/** Signing in and out, and a page an action waits to reload. */
export const REQUEST_DEADLINE_MS = 10_000;

/**
 * A read the page works without, as whether Google is offered (codes alone
 * still sign in): short.
 */
export const OPTIONAL_READ_DEADLINE_MS = 3_000;

/** The slowest upload waited for: 100 KB/s. */
const MIN_BYTES_PER_MS = 100;

/**
 * For a request sending `bytes`: {@link REQUEST_DEADLINE_MS}, plus their time at
 * the slowest upload waited for, so 50 MB gets about eight minutes.
 */
export const bodyDeadline = (bytes: number) => REQUEST_DEADLINE_MS + bytes / MIN_BYTES_PER_MS;

/** `signal`, also aborted after `ms`; a timer, which test fake timers advance. */
export function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = new AbortController();
  setTimeout(() => deadline.abort(new DOMException("Braivo did not answer.", "TimeoutError")), ms);
  return signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
}
