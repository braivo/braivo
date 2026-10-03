// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createClient } from "@braivo/server/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createLearnAuth } from "./lib/auth.ts";
import { routeTree } from "./routeTree.gen.ts";

import "./styles.css";

// Braivo's API is always served from this app's own origin; see ADR 0004.
const origin = window.location.origin;

const router = createRouter({
  routeTree,
  context: {
    braivo: createClient(),
    auth: createLearnAuth(origin),
    // Replacing `/login`, which only ever leaves: Back from the installation's
    // sign-in returns to where the learner was, not to another handoff.
    visit: (href) => window.location.replace(href),
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
