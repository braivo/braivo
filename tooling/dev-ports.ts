// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where `bun run dev` serves, read from the variables its servers already
 * take, so no list of ports is kept apart from them. Each linked worktree sets
 * its own in `.env.development.local` (docs/adr/0014-worktree-setup.md). Bun
 * and Node only: worktree setup runs it before `node_modules` exists.
 */

export type DevPorts = { server: number; learn: number; console: number };

/** The main checkout's. */
export const DEFAULT_PORTS: DevPorts = { server: 3000, learn: 5173, console: 5174 };

/** Apart enough for a worktree's demo, `DEMO_OFFSET` above its dev servers, to fit between. */
const STRIDE = 20;
const DEMO_OFFSET = 10;

/**
 * `PORT` for the server, `BRAIVO_LEARN_PORT` for the learn app, and for the
 * console `BRAIVO_URL`'s port, as `BRAIVO_URL` is locally the console's dev
 * server; each unset or blank means its default.
 */
export function readDevPorts(env: Readonly<Record<string, string | undefined>>): DevPorts {
  const url = env.BRAIVO_URL?.trim();
  return {
    server: readPort("PORT", env.PORT, DEFAULT_PORTS.server),
    learn: readPort("BRAIVO_LEARN_PORT", env.BRAIVO_LEARN_PORT, DEFAULT_PORTS.learn),
    // A URL with its scheme's default port, as a tunnel's, names no dev server's.
    console: readPort("BRAIVO_URL's port", url && new URL(url).port, DEFAULT_PORTS.console),
  };
}

/** A worktree's demo's, from its dev servers' (docs/adr/0043-development-demo.md). */
export function demoPorts(ports: DevPorts): DevPorts {
  return {
    server: ports.server + DEMO_OFFSET,
    learn: ports.learn + DEMO_OFFSET,
    console: ports.console + DEMO_OFFSET,
  };
}

/** The `slot`th worktree's ports, `STRIDE` apart; slot 0 is the main checkout's. */
export function worktreePorts(slot: number): DevPorts {
  return {
    server: DEFAULT_PORTS.server + slot * STRIDE,
    learn: DEFAULT_PORTS.learn + slot * STRIDE,
    console: DEFAULT_PORTS.console + slot * STRIDE,
  };
}

function readPort(name: string, value: string | undefined, fallback: number): number {
  value = value?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535, got "${value}".`);
  }
  return port;
}
