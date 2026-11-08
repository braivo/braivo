// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { BraivoClient, Host } from "@braivo/server/client";

import { OPTIONAL_READ_DEADLINE_MS, withDeadline } from "./deadline.ts";

const reads = new WeakMap<BraivoClient, Promise<Host>>();

/**
 * What this host serves (`GET /api/host`), read once while the app runs, as a
 * host serves the same thing until it is reloaded: the root's brand and what
 * opens on the installation's origin (ADR 0059) share it. Within an optional
 * read's deadline; a failure is not kept, so trying again asks again. A
 * caller deciding what to open fails with it, as not knowing whether this is
 * the origin must never open a school's course there; the brand alone goes
 * without.
 */
export function readHost(braivo: BraivoClient): Promise<Host> {
  let read = reads.get(braivo);
  if (!read) {
    read = braivo.host({ signal: withDeadline(undefined, OPTIONAL_READ_DEADLINE_MS) });
    reads.set(braivo, read);
    read.catch(() => reads.delete(braivo));
  }
  return read;
}
