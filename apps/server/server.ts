// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server, built from its settings and what depends on where it runs —
 * databases, files, how mail leaves — which the host passes in. `serve` and a
 * Worker both build it here, so the wiring has one copy (ADR 0034).
 */
import type { Database } from "@braivo/db";

import { anthropicModel } from "./ai/index.ts";
import { createApi } from "./api/index.ts";
import { createAuth } from "./auth/index.ts";
import type { ServerConfig } from "./config.ts";
import type { SendMail } from "./mail/index.ts";
import type { FileStore } from "./storage/index.ts";

export { readServerConfig } from "./config.ts";
export { type SendMail, smtpMail } from "./mail/index.ts";
export type { FileStore } from "./storage/index.ts";

export function createServer(options: {
  config: ServerConfig;
  database: Database;
  /** Behind a query cache, for reads whose cached answer equals a fresh one; defaults to `database`. */
  cachedDatabase?: Database;
  /** Where uploaded files are kept; without one, the file routes answer 501. */
  files?: FileStore;
  /** Sends sign-in codes. */
  sendMail: SendMail;
}) {
  const { config, database } = options;
  return createApi({
    database,
    cachedDatabase: options.cachedDatabase,
    files: options.files,
    baseUrl: config.baseUrl,
    selfServeDomain: config.selfServeDomain,
    ai: config.ai && {
      model: anthropicModel(config.ai),
      organizations: config.ai.organizations,
      monthlyLimit: config.ai.monthlyLimit,
    },
    auth: createAuth({
      database,
      secret: config.secret,
      baseURL: config.baseUrl,
      sendMail: options.sendMail,
      google: config.google,
    }),
  });
}
