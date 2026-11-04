// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import { createFileRoute } from "@tanstack/react-router";

import { asSessionAuth } from "#lib/auth";

/**
 * Everything a learner sees once signed in. Checked before any child loads, so
 * no page asks Braivo anything on behalf of nobody. No layout: the course list
 * has the account's header (`AccountHeader`), practice a focused screen.
 */
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: ({ context, location }) => requireSession(asSessionAuth(context.braivo), location),
});
