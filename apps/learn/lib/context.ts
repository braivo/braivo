// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { createBrowserAuth } from "@braivo/auth-client";
import type { BraivoClient } from "@braivo/server/client";

/**
 * What every route reaches the outside world through. Handed to the router
 * rather than imported, so a test can render any route against stubs.
 */
export type AppContext = {
  braivo: BraivoClient;
  auth: ReturnType<typeof createBrowserAuth>;
};
