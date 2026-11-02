// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { BraivoClient } from "@braivo/server/client";

import type { ConsoleAuth } from "./auth.ts";
import type { ReadPdf } from "./pdf/read.ts";

/**
 * What every route reaches the outside world through. Handed to the router
 * rather than imported, so a test can render any route against stubs.
 */
export type AppContext = {
  braivo: BraivoClient;
  auth: ConsoleAuth;
  /** Loads a page outside the app, as handing sign-in to a learn domain does. */
  visit: (href: string) => void;
  /** Reads a PDF's text layer in a worker (docs/adr/0055-pdf-text-in-the-browser.md). */
  readPdf: ReadPdf;
};
