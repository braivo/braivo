// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";

import { organizationOwnsLearningContent, readOrganizationSlug } from "../persistence/index.ts";
import { isOrganizationOrigin } from "./origin.ts";
import { slugProblem } from "./slug.ts";

/**
 * The programs that may ask to act for a user through the device flow: Braivo's
 * CLI, whose MCP server is one of its commands. The approval page names the
 * client, so an unknown ID is refused rather than shown to someone deciding
 * whether to trust it (docs/adr/0022-machine-access.md).
 */
export const DEVICE_CLIENTS: ReadonlySet<string> = new Set(["braivo-cli"]);

type AuthOptions = {
  database: Database;
  /** Signs sessions and tokens. Rotating it invalidates every one already issued. */
  secret: string;
  /** Public origin this installation is served from, used to build callback URLs. */
  baseURL: string;
};

/** Refuses a slug that cannot address an organization, as a 400 carrying the reason. */
function assertSlugAllowed(slug: string): void {
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    throw new APIError("BAD_REQUEST", { code: "ORGANIZATION_SLUG_NOT_ALLOWED", message: problem });
  }
}

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
    // `baseURL` is trusted regardless. Beyond it, only the request's own origin
    // and only while it is an organization's domain, so the answer is per
    // request and fails closed (ADR 0004).
    trustedOrigins: async (request) => {
      const origin = request?.headers.get("origin");
      if (!origin) return [];
      return (await isOrganizationOrigin(options.database, origin)) ? [origin] : [];
    },

    // Passwords need no external identity provider to register with.
    emailAndPassword: { enabled: true },

    // An organization owns content, and its members may learn from it; membership
    // is what Braivo's authorization rules are built on. A learner's history is
    // kept per learner, not per organization (ADR 0032).
    plugins: [
      organization({
        // The operator creates organizations (`createOrganization`), not the
        // console, until self-serve onboarding is wanted (ADR 0018).
        allowUserToCreateOrganization: false,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: created }) => {
            // Typed optional although the endpoint requires it; absent fails
            // as malformed rather than skipping the check.
            assertSlugAllowed(created.slug ?? "");
          },
          /**
           * Refuses changing a slug until the console's rename, with its
           * warning that links break, exists (ADR 0004). Resending the current
           * slug is not a change, so a form sending every field works.
           */
          beforeUpdateOrganization: async ({ organization: changes, member }) => {
            if (changes.slug === undefined) return;
            const current = await readOrganizationSlug(options.database, member.organizationId);
            if (changes.slug !== current) {
              throw new APIError("BAD_REQUEST", {
                code: "ORGANIZATION_SLUG_IMMUTABLE",
                message: "An organization's slug cannot be changed yet.",
              });
            }
          },
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
                  "This organization still owns learning content — objectives, courses, sources, or files — so it cannot be deleted.",
              });
            }
          },
        },
      }),
      // A content owner's own tools — a CLI, an MCP server a desktop agent runs —
      // act as the content owner: the CLI asks for a code, the content owner
      // approves it in a signed-in browser, and the CLI receives a session
      // token it sends as `Authorization: Bearer`. No separate credential to
      // authorize: the token is the user, with their memberships and roles
      // (docs/adr/0022-machine-access.md).
      deviceAuthorization({
        // Short, since a code is only ever typed moments after it is shown, and
        // a pending one is what device-code phishing needs to stay alive.
        expiresIn: "10m",
        validateClient: (clientId) => DEVICE_CLIENTS.has(clientId),
        // The console's approval page, not Better Auth's JSON endpoint of the
        // same name: approving takes a person reading who is asking. Resolved
        // against this origin, where the console serves it (ADR 0004).
        verificationUri: "/device",
      }),
      // Unsigned tokens accepted, since the device flow hands out the session
      // token itself; it is as secret as the cookie it stands in for.
      bearer(),
    ],

    // Better Auth's invitations are off until ADR 0018 guards them: with no
    // verified email, whoever signs up with an invited address joins, and
    // nothing checks the learn domain. The plugin has no switch of its own;
    // this one misses direct `auth.api` calls, which Braivo never makes.
    disabledPaths: [
      "/organization/invite-member",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/cancel-invitation",
      "/organization/get-invitation",
      "/organization/list-invitations",
      "/organization/list-user-invitations",
    ],

    // A CLI polls for its token until the code expires, and the generic limit
    // cuts it off first — sooner for teachers sharing a school's one address.
    // The device flow paces each code itself (`slow_down` to a poll within its
    // interval), and a device code is too random to guess, so this limit would
    // add nothing but that failure.
    rateLimit: { customRules: { "/device/token": false } },

    // Stated, not left to a default: a self-hosted installation does not phone
    // home.
    telemetry: { enabled: false },

    // Better Auth skips its origin check when `NODE_ENV` is `test`, which would
    // let tests pass requests a deployment refuses.
    advanced: { disableOriginCheck: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
