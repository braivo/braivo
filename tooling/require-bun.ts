// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refuses to run a server-side suite anywhere but Bun.
 *
 * Braivo's server runs on Bun, its test suites may use Bun's own APIs, and
 * `vp test` starts Vitest on Node. Without this, every suite that does fails
 * on its own with `Bun is not defined`, which reads as many bugs instead of
 * one wrong command. `bun run test` runs the same Vitest on Bun.
 */
export default function requireBun(): void {
  if (typeof Bun === "undefined") {
    throw new Error("These tests need the Bun runtime. Run `bun run test` instead of `vp test`.");
  }
}
