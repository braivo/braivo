// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vite-plus";

/**
 * Empty, and still required: it is what lets the shadcn CLI recognize the
 * package as a Vite project, which `shadcn init` and `shadcn apply` both want
 * (docs/adr/0012-shadcn-preset.md). Test settings are the root config's.
 */
export default defineConfig({});
