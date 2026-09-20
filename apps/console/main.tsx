// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createClient } from "@braivo/server/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createConsoleAuth } from "./lib/auth.ts";
import { routeTree } from "./routeTree.gen.ts";

import "./styles.css";

// Braivo's API is always served from this app's own origin; see ADR 0003.
const origin = window.location.origin;

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  context: {
    braivo: createClient(),
    auth: createConsoleAuth(origin),
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
