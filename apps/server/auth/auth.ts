// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";

import { organizationOwnsLearningContent } from "../persistence/index.ts";

type AuthOptions = {
  database: Database;
  /** Signs sessions and tokens. Rotating it invalidates every one already issued. */
  secret: string;
  /** Public origin this installation is served from, used to build callback URLs. */
  baseURL: string;
};

/**
 * Identity and organization membership for a standalone installation
 * ([ADR 0006](../../../docs/adr/0006-better-auth.md)).
 *
 * A factory rather than a module-level instance, so nothing reads the
 * environment at import time and a test can open its own database.
 */
export function createAuth(options: AuthOptions) {
  return betterAuth({
    // `transaction` is off by default. Better Auth's organization delete
    // removes members before the organization, so without it a Braivo foreign
    // key refusing that last step leaves the organization with no members.
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: authTables,
      transaction: true,
    }),
    secret: options.secret,
    baseURL: options.baseURL,

    // Passwords need no external identity provider to register with.
    emailAndPassword: { enabled: true },

    // An organization owns content and learners; membership is what Braivo's
    // authorization rules are built on.
    plugins: [
      organization({
        organizationHooks: {
          /**
           * Refuses deleting an organization that still owns learning content,
           * as a 409 rather than the 500 naming a constraint that the
           * restricted foreign keys produce. Those keys stay underneath as the
           * race-safe guarantee ([ADR 0006](../../../docs/adr/0006-better-auth.md)).
           */
          beforeDeleteOrganization: async ({ organization: owner }) => {
            if (await organizationOwnsLearningContent(options.database, owner.id)) {
              throw new APIError("CONFLICT", {
                code: "ORGANIZATION_OWNS_LEARNING_CONTENT",
                message:
                  "This organization still owns objectives or courses, so it cannot be deleted.",
              });
            }
          },
        },
      }),
    ],

    // Stated, not left to a default: a self-hosted installation does not phone
    // home.
    telemetry: { enabled: false },

    // Better Auth skips its origin check when `NODE_ENV` is `test`, which would
    // let tests pass requests a deployment refuses.
    advanced: { disableOriginCheck: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
