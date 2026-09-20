// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_signed-in/")({
  component: () => <p>Open the course link you were given to see what to learn next.</p>,
});
