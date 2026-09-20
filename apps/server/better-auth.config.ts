// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase } from "@braivo/db";

import { createAuth } from "./auth/index.ts";

/**
 * Read by `bun run auth:generate` to write `@braivo/db`'s `schema/auth.ts`.
 * It builds the real `createAuth`, so the generated tables match the server's
 * configuration. Generation only inspects the config: these are placeholders,
 * never credentials.
 */
export const auth = createAuth({
  database: createDatabase("postgres://schema-generation/none"),
  secret: "schema-generation-only-never-signs-anything",
  baseURL: "http://localhost",
});
