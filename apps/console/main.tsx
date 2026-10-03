// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createClient } from "@braivo/server/client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createConsoleAuth } from "./lib/auth.ts";
import { createConsoleRouter } from "./router.tsx";

import "./styles.css";

// Braivo's API is always served from this app's own origin; see ADR 0004.
const origin = window.location.origin;

const router = createConsoleRouter({
  context: {
    braivo: createClient(),
    auth: createConsoleAuth(origin),
    visit: (href) => window.location.assign(href),
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
