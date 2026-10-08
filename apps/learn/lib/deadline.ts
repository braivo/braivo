// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How long the learn app waits for Braivo before offering a way out, since
// school wifi can stall a request with no error at all. Its body counts: the
// client reads it under the same signal.

/** A read a question waits for: the activity, the session. */
export const READ_DEADLINE_MS = 10_000;

/**
 * A read the page shows without, the brand, the title, the progress summary:
 * short, since a question that is ready waits for it to keep the layout still.
 */
export const OPTIONAL_READ_DEADLINE_MS = 3_000;

/** An answer, which also records it: longer, since resending costs the learner a press. */
export const ANSWER_DEADLINE_MS = 20_000;

/**
 * `signal`, also aborted after `ms` with a `TimeoutError`. A caller tells the
 * two apart by checking `signal` itself: aborted, the learner left; otherwise
 * the request ran out of time, and may be offered again.
 */
export function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = new AbortController();
  // A timer rather than `AbortSignal.timeout`, which test fake timers cannot advance.
  setTimeout(() => deadline.abort(new DOMException("Braivo did not answer.", "TimeoutError")), ms);
  return signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
}
