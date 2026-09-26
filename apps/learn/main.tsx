// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { createClient } from "@braivo/server/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen.ts";

import "./styles.css";

// Braivo's API is always served from this app's own origin; see ADR 0004.
const origin = window.location.origin;

const router = createRouter({
  routeTree,
  context: {
    braivo: createClient(),
    auth: createBrowserAuth({ baseURL: origin }),
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
