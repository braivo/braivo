// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, preferredLocale } from "@braivo/i18n";
import { createClient } from "@braivo/server/client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createLearnAuth } from "./lib/auth.ts";
import { createLearnRouter } from "./router.tsx";

// Chosen before React renders: a menu's stored choice, else the browser's (ADR 0035).
await activateLocale(preferredLocale(navigator.languages));

// Braivo's API is always served from this app's own origin; see ADR 0004.
const origin = window.location.origin;

const router = createLearnRouter({
  context: {
    braivo: createClient(),
    auth: createLearnAuth(origin),
    // Replacing `/login`, which only ever leaves: Back from the installation's
    // sign-in returns to where the learner was, not to another handoff.
    visit: (href) => window.location.replace(href),
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
