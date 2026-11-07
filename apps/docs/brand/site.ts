// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Site } from "#lib/brand";

/** The neutral brand: no hosted installation, no analytics (ADR 0057). */
const site: Site = {
  name: "Braivo",
  githubUrl: "https://github.com/braivo/braivo",
};

export default site;
