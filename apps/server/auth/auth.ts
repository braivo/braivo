// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cimd } from "@better-auth/cimd";
import { defineRequestState } from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { mcp } from "@better-auth/mcp";
import type { Database } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { bearer, deviceAuthorization, emailOTP, jwt, organization } from "better-auth/plugins";
import { adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import * as z from "zod";

import { mayAuthor } from "../application/permission.ts";
import { describeLogCall } from "../logging.ts";
import { mailLocale, type SendMail, signInCodeMail } from "../mail/index.ts";
import {
  claimSignInCode,
  organizationOwnsLearningContent,
  readOrganizationSlug,
} from "../persistence/index.ts";
import { type ClientMetadataFetch, fetchPinned, fetchStrictlyPublic } from "./client-metadata.ts";
import { slugProblem } from "./slug.ts";

/**
 * The programs that may ask to act for a user through the device flow: Braivo's
 * CLI, whose MCP server is one of its commands. The approval page names the
 * client, so an unknown ID is refused rather than shown to someone deciding
 * whether to trust it (docs/adr/0022-machine-access.md).
 */
export const DEVICE_CLIENTS: ReadonlySet<string> = new Set(["braivo-cli"]);

/**
 * What a remote MCP connection may be granted (ADR 0045): `braivo:author`,
 * an organization's material, objectives, and courses. `braivo:progress`,
 * learners' data, waits for its tools.
 */
export const AUTHOR_SCOPE = "braivo:author";

/** The access token's claim naming the organization its grant is for. */
export const ORGANIZATION_CLAIM = "organization_id";

type AuthOptions = {
  database: Database;
  /** Signs sessions and tokens. Rotating it invalidates every one already issued. */
  secret: string;
  /** Public origin this installation is served from, used to build callback URLs. */
  baseURL: string;
  /** Sends sign-in codes. */
  sendMail: SendMail;
  /** Google's OAuth client, offering sign-in with Google; without one, codes alone. */
  google?: { clientId: string; clientSecret: string };
  /**
   * How an unregistered client is found by its client ID metadata document
   * (CIMD), its ID that document's URL (ADR 0045):
   *
   * - unset, its host resolved once and only the public addresses checked
   *   connected to (`fetchPinned`, over `node:https`);
   * - `"strictly-public"`, through a Worker's `fetch`, with the
   *   `global_fetch_strictly_public` compatibility flag (`fetchStrictlyPublic`);
   * - `false`, not at all: only registered clients sign in, CIMD still
   *   advertised for those registered by their document's URL. Better Auth
   *   fetches a registered client's `jwks_uri` with the global `fetch`, so
   *   clients are registered public, with PKCE and no keys.
   */
  clientIdMetadataDocuments?: "strictly-public" | false;
  /**
   * Wraps the fetch chosen above, for a client's document and its `jwks_uri`
   * alike, with a host's own limits or cache (ADR 0045). The wrapper is
   * trusted: every network request goes through the fetch it is given, with
   * the input and options it got (headers, abort signal), never the global
   * `fetch`, which would skip the refusal of private addresses; a cached answer
   * is one that fetch returned, kept no longer than its `Cache-Control`
   * allows. Unused where nothing is fetched.
   */
  wrapClientMetadataFetch?: (fetch: ClientMetadataFetch) => ClientMetadataFetch;
  /**
   * The accounts that may sign in with a password, lowercased: an app
   * directory's reviewers, who cannot receive a code (ADR 0018). Empty or
   * unset, no password signs in.
   */
  reviewerEmails?: ReadonlySet<string>;
};

/**
 * Sign-in codes, chosen rather than Better Auth's defaults (ADR 0018). Ten
 * minutes leave time to switch to a mail app and back; five guesses at a
 * six-digit code leave an attacker one chance in 200,000 per code, and the
 * address's minute between codes bounds how many codes they get. A learn
 * domain's own codes keep the same (`application/learner-sign-in.ts`).
 */
export const SIGN_IN_CODE = { digits: 6, seconds: 600, attempts: 5, cooldownSeconds: 60 };

/**
 * A reviewer's password (ADR 0018): set by the operator alone, so long enough
 * that the sign-in limit below, not its length, is never what stops a guess.
 * Better Auth's own maximum, 128, stays.
 */
export const MIN_REVIEWER_PASSWORD_LENGTH = 16;

/**
 * Better Auth's answer to a wrong email or password, given as well to an
 * address `reviewerEmails` does not list, so the two read alike.
 */
const INVALID_EMAIL_OR_PASSWORD = {
  // In Better Auth's order, so even the bytes match.
  message: "Invalid email or password",
  code: "INVALID_EMAIL_OR_PASSWORD",
};

/**
 * The most members an organization holds, staff included: a guard against
 * runaway enrollment, not a pricing limit. Better Auth's default, 100, is
 * below a school's.
 */
export const MEMBERSHIP_LIMIT = 1_000;

/**
 * Carries a failed send to the after hook, which refuses the request: Better
 * Auth only logs a throw from `sendVerificationOTP` and answers that the code
 * was sent (ADR 0033). Per request, as requests run at once. Holds while the
 * send is awaited, that is while `advanced.backgroundTasks` is unset.
 */
const signInCodeSendFailed = defineRequestState(() => false);

/**
 * Whether this request is a client's `/oauth2/authorize`, the first pass of an
 * authorization, which always asks which organization to grant: one chosen
 * for an earlier grant stays on the session. The passes after choosing
 * (`/oauth2/continue`, `/oauth2/consent`) do not ask.
 */
const authorizing = defineRequestState(() => false);

/** What a Better Auth hook is given. */
type AuthContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The organization `session` chose for a connection, if its user still authors in it (ADR 0048). */
async function chosenOrganization(
  database: Database,
  user: { id: string } | undefined,
  session: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const organizationId = session?.activeOrganizationId;
  if (typeof organizationId !== "string" || !user) return undefined;
  return (await mayAuthor(database, { organizationId, userId: user.id }))
    ? organizationId
    : undefined;
}

/**
 * Refuses granting an organization other than the one the page showed: the
 * console sends the one it names with `/oauth2/continue` and an accepting
 * `/oauth2/consent`, and the session's choice, which Better Auth binds the
 * grant to, may have changed since in another tab.
 */
async function refuseAnotherOrganization(context: AuthContext): Promise<void> {
  const body = (context.body ?? {}) as Record<string, unknown>;
  const granting =
    (context.path === "/oauth2/continue" && body.postLogin === true) ||
    (context.path === "/oauth2/consent" && body.accept === true);
  if (!granting) return;
  const session = await getSessionFromCtx(context);
  // Signed out since the page was shown, as Better Auth's own check would say:
  // the console then sends them to sign in, not blaming another tab.
  if (!session) throw new APIError("UNAUTHORIZED");
  const chosen = (session.session as Record<string, unknown>).activeOrganizationId;
  if (typeof body.organizationId === "string" && body.organizationId === chosen) return;
  throw new APIError("FORBIDDEN", {
    // Read by the console: only this refusal is another tab's doing.
    code: "ACTIVE_ORGANIZATION_CHANGED",
    error: "access_denied",
    error_description: "The organization chosen has changed. Start again in the app.",
  });
}

/**
 * Whether `error` is PostgreSQL refusing a second account with an email
 * (`user`'s inline `UNIQUE`), as Drizzle wraps it: what another sign-in made
 * first causes, and nothing else.
 */
function isTakenEmail(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; constraint?: unknown } })?.cause;
  return cause?.code === "23505" && cause.constraint === "user_email_key";
}

/**
 * The account of an email Braivo proved itself, by a learn domain's own code
 * (ADR 0018), made if there is none, as Better Auth's code sign-in makes one,
 * its hooks run. Server-only: no route reaches it, and it opens no session.
 */
const verifiedAccounts = {
  id: "braivo-verified-accounts",
  endpoints: {
    verifiedAccount: createAuthEndpoint(
      "/braivo/verified-account",
      { method: "POST", body: z.object({ email: z.email() }), metadata: { SERVER_ONLY: true } },
      async (context) => {
        const email = context.body.email.toLowerCase();
        const { internalAdapter } = context.context;
        const found = async () => (await internalAdapter.findUserByEmail(email))?.user;
        // Every account's email is verified already: by a code, or by Google.
        // Another sign-in at once (another tab) may make it first, and the
        // email's uniqueness refuse this one: that account is the one.
        const user =
          (await found()) ??
          (await internalAdapter
            .createUser({ email, name: "", emailVerified: true }, { method: "email-otp" })
            .catch(async (error: unknown) => {
              const made = isTakenEmail(error) && (await found());
              if (!made) throw error;
              return made;
            }));
        return context.json({ user: { id: user.id, name: user.name } });
      },
    ),
  },
} satisfies BetterAuthPlugin;

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
  const metadataFetch =
    options.clientIdMetadataDocuments === "strictly-public" ? fetchStrictlyPublic : fetchPinned;
  const reviewerEmails = options.reviewerEmails ?? new Set<string>();
  const auth = betterAuth({
    // `transaction` is off by default. Better Auth's organization delete
    // removes members before the organization, so without it a Braivo foreign
    // key refusing that last step leaves the organization with no members.
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: authTables,
      transaction: true,
    }),
    secret: options.secret,
    // The one trusted origin: Better Auth serves the installation's host alone,
    // and a learn domain holds Braivo's learner sessions instead (ADR 0018).
    baseURL: options.baseURL,

    // An account is made, and signed in to, by proving its email (ADR 0018).
    // A password signs in only an account `reviewerEmails` lists (the before
    // hook), with one the operator set (`reviewer.ts`); it makes none, and
    // nothing over HTTP sets, changes, or resets one (`disabledPaths`). Off
    // with no reviewers, so `/sign-in/email` refuses every request.
    emailAndPassword: {
      enabled: reviewerEmails.size > 0,
      disableSignUp: true,
      minPasswordLength: MIN_REVIEWER_PASSWORD_LENGTH,
    },

    // Google's callback is `<baseURL>/api/auth/callback/google`, the redirect
    // URI its OAuth client must list. Asked to choose an account every time,
    // since on a shared device the one Google remembers may be someone else's;
    // by redirect alone, as nothing of Braivo's signs in with a Google ID
    // token directly.
    socialProviders: options.google && {
      google: { ...options.google, prompt: "select_account", disableIdTokenSignIn: true },
    },
    // Braivo calls no Google API, so the access and refresh tokens kept are
    // encrypted: a database leak then yields none that works. The ID token,
    // kept as is, signs in nowhere, ID-token sign-in being off.
    account: { encryptOAuthTokens: true },
    onAPIError: {
      // An unexpected error reaches the API's `onError`, which logs it
      // described, instead of Better Auth logging it whole. Its `APIError`s
      // still answer as before.
      throw: true,
      // A Google sign-in whose saved state is gone, and with it where to
      // return on failure, comes back to `/login` with an error, rather than
      // to Better Auth's own error page.
      ...(options.google && { errorURL: "/login" }),
    },
    // Its messages interpolate URLs and errors, which may carry an email or a
    // token. One bypass remains: its adapter prints a failed fallback join's
    // error whole, whose only value is the join's key, an ID.
    logger: {
      log: (level, message, ...args) =>
        console[level](`[Better Auth] ${describeLogCall(message, args)}`),
    },
    user: {
      // Only a provider-verified email (ADR 0018): an unverified one could make
      // or reach the account of whoever owns the address. Checked on every
      // sign-in, as Google answers afresh each time, and for every OAuth
      // provider, Google's being the one today, so one added later fails closed.
      validateUserInfo: async ({ user, source }, context) => {
        if (source.method !== "oauth") return undefined;
        if (user.emailVerified !== true) {
          return {
            error: "email_not_verified",
            errorDescription: "The sign-in provider has not verified this email.",
          };
        }
        // An account is whoever controls its email (ADR 0018): a provider
        // account now under another address, as after a school renames one,
        // no longer proves it. Changing an account's email waits for a flow
        // of its own.
        if (source.action === "sign-in" && user.id !== undefined) {
          const stored = await context.context.internalAdapter.findUserById(user.id);
          if (stored && stored.email !== user.email) {
            return {
              error: "email_changed",
              errorDescription: "This account's email differs from the sign-in provider's.",
            };
          }
        }
        return undefined;
      },
    },

    hooks: {
      before: createAuthMiddleware(async (context) => {
        // The client's own request, not the provider resuming it from
        // `/oauth2/continue` or `/oauth2/consent` under the same path.
        if (
          context.request &&
          new URL(context.request.url).pathname.endsWith("/oauth2/authorize")
        ) {
          await authorizing.set(true);
        }
        await refuseAnotherOrganization(context);
        if (context.path === "/sign-in/email") {
          const { email, password } = (context.body ?? {}) as {
            email?: unknown;
            password?: unknown;
          };
          // A password Better Auth would refuse for its form (past its
          // maximum, 128) is refused here for every email alike, before the
          // list is read: its own answer, a 400, would tell listed emails apart.
          if (typeof email !== "string" || typeof password !== "string" || password.length > 128) {
            throw new APIError("UNAUTHORIZED", INVALID_EMAIL_OR_PASSWORD);
          }
          if (reviewerEmails.has(email.toLowerCase())) return;
          // Hashed as Better Auth does for an unknown email, so the answer's
          // time differs from a listed email's by one database lookup alone:
          // a residual hint, accepted for a list of reviewers (ADR 0018).
          await context.context.password.hash(password);
          throw new APIError("UNAUTHORIZED", INVALID_EMAIL_OR_PASSWORD);
        }
        if (context.path !== "/email-otp/send-verification-otp") return;
        const { email, type } = (context.body ?? {}) as { email?: unknown; type?: unknown };
        // Its other kinds serve flows that are off (`disabledPaths`).
        if (type !== "sign-in") {
          throw new APIError("BAD_REQUEST", {
            code: "SIGN_IN_CODES_ONLY",
            message: "Only sign-in codes are sent.",
          });
        }
        // Normalized as the endpoint does; what it would refuse is left to it.
        const address = typeof email === "string" ? email.toLowerCase() : "";
        if (!z.email().safeParse(address).success) return;
        // One code a minute per address, whoever asks: a client limit alone
        // lets a few addresses flood one inbox. Every address gets codes, so
        // this says nothing about which have accounts.
        const claimed = await claimSignInCode(options.database, {
          email: address,
          at: new Date(),
          seconds: SIGN_IN_CODE.cooldownSeconds,
        });
        if (!claimed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "SIGN_IN_CODE_COOLDOWN",
            message: "Wait a minute before asking for a code again.",
          });
        }
      }),
      after: createAuthMiddleware(async (context) => {
        if (context.path !== "/email-otp/send-verification-otp") return;
        // The address still waits its minute: hence "in a minute".
        if (await signInCodeSendFailed.get()) {
          throw new APIError("SERVICE_UNAVAILABLE", {
            code: "SIGN_IN_CODE_SEND_FAILED",
            message: "The code could not be sent. Try again in a minute.",
          });
        }
      }),
    },

    plugins: [
      // Proving an email signs someone in, making their account if needed, so
      // asking for a code never says whether one exists (ADR 0018).
      emailOTP({
        otpLength: SIGN_IN_CODE.digits,
        expiresIn: SIGN_IN_CODE.seconds,
        allowedAttempts: SIGN_IN_CODE.attempts,
        // A database leak then yields no live code.
        storeOTP: "hashed",
        // Code requests and sign-ins, each counted per client address, in
        // production only, as all of Better Auth's limits. Sized for a
        // school's classes behind one address; the per-address minute above
        // protects an inbox. Better Auth restarts the minute at each request
        // it admits, so this is 120 until a minute passes without one, not
        // 120 a minute.
        rateLimit: { window: 60, max: 120 },
        // `ctx` is absent when the server asks itself: English (localization-6).
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          try {
            await options.sendMail(
              signInCodeMail({
                to: email,
                code: otp,
                site: new URL(options.baseURL).host,
                expiresInMinutes: SIGN_IN_CODE.seconds / 60,
                locale: mailLocale(ctx?.headers?.get("accept-language")),
              }),
            );
          } catch (error) {
            await signInCodeSendFailed.set(true);
            // Rethrown for Better Auth to log.
            throw error;
          }
        },
      }),
      // An organization owns content, and its members may learn from it;
      // membership is what Braivo's authorization rules are built on. A
      // learner's history is kept per learner, not per organization (ADR 0032).
      organization({
        // Refuses sessions only: the operator's command and self-serve setup
        // call it naming the user (`createOwnedOrganization`, ADR 0018).
        allowUserToCreateOrganization: false,
        membershipLimit: MEMBERSHIP_LIMIT,
        // Better Auth's own roles, and `author` (ADR 0048) with a member's
        // permissions, none over the organization: authoring is Braivo's to
        // check, so none of Better Auth's routes lets an author change a role,
        // a member, or the organization.
        roles: { owner: ownerAc, admin: adminAc, member: memberAc, author: memberAc },
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
      // A content owner's own tools — the `braivo` command, and an agent running
      // it — act as the content owner: the CLI asks for a code, the content owner
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
      // The OAuth 2.1 authorization server remote MCP clients (ADR 0045)
      // sign in through, its access tokens JWTs bound to `/mcp`. Only OAuth
      // signs JWTs: a session gets none, so signing in never needs the
      // signing key, which the auth secret encrypts.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        // Braivo's, which hand the request to the console's `/consent`, to
        // choose an organization or to consent; under its signed-in layout,
        // someone signed out signs in on the way, then chooses.
        loginPage: "/api/oauth/organization",
        consentPage: "/api/oauth/consent",
        resource: new URL("/mcp", options.baseURL).href,
        // Better Auth's defaults, and Braivo's own.
        scopes: ["openid", "profile", "email", "offline_access", AUTHOR_SCOPE],
        // A grant is to one organization (ADR 0045), chosen before consent
        // and kept on the session (the organization plugin's `set-active`):
        // `consentReferenceId` is given no request to read it from. Each
        // authorization asks again, so a second grant can name another
        // organization. Read from the database: the session cookie cache,
        // which would answer an old choice, is off.
        postLogin: {
          page: "/api/oauth/organization",
          shouldRedirect: async ({ user, session }) =>
            (await authorizing.get()) ||
            !(await chosenOrganization(options.database, user, session)),
          // The consent's reference ID, so consents, codes, and refresh
          // tokens are per organization; refused, not left out, for an
          // organization the person may not author in (ADR 0048).
          consentReferenceId: async ({ user, session }) => {
            const organizationId = await chosenOrganization(options.database, user, session);
            if (organizationId) return organizationId;
            throw new APIError("FORBIDDEN", {
              error: "access_denied",
              error_description: "Choose an organization whose content you manage.",
            });
          },
        },
        // Where `/mcp` reads which organization the token's grant is for.
        customAccessTokenClaims: ({ referenceId }) =>
          referenceId ? { [ORGANIZATION_CLAIM]: referenceId } : {},
        // A person signs each client in; `client_credentials`, a client acting
        // as no one, waits for its own decision (ADR 0022).
        grantTypes: ["authorization_code", "refresh_token"],
        // How the consent page names the client: only for a request whose
        // signature verifies, so nothing is shown for one Braivo never made.
        allowPublicClientPrelogin: true,
        // No DPoP: `/mcp` takes bearer tokens alone, so the metadata offers no
        // algorithm and the token endpoint refuses a proof, rather than issue
        // a token `/mcp` would refuse.
        dpop: { signingAlgorithms: [] },
        // Only so the metadata offers `none`, every client's token endpoint
        // method (public, with PKCE): Better Auth 1.7.11 offers it with this
        // flag or `cimd()`, left out where nothing is fetched. It registers no
        // one: registration over HTTP is off, its path disabled below.
        allowUnauthenticatedClientRegistration: true,
      }),
      // A registered client is found before this runs, a URL-shaped ID
      // included; without this plugin, `createAuth` still advertises CIMD.
      ...(options.clientIdMetadataDocuments === false
        ? []
        : [
            // Per instance, so per request on Workers, refetching each time:
            // shared, it would hand one request a discovery another started,
            // I/O Workers refuse across requests.
            cimd({
              fetchClientMetadataResource:
                options.wrapClientMetadataFetch?.(metadataFetch) ?? metadataFetch,
              metadataProfile: "mcp-2026-07-28",
            }),
          ]),
      verifiedAccounts,
    ],

    // Off where the plugin has no switch of its own. Direct `auth.api` calls
    // bypass it; Braivo makes none to these.
    disabledPaths: [
      // `jwt()`'s session-for-JWT exchange: only OAuth issues JWTs.
      "/token",
      // Clients name themselves by their metadata document (`cimd()`), or
      // the operator registers one (`oauth-client.ts`). Over HTTP, anyone, a
      // learner too, could put a client of their naming on a consent page.
      "/oauth2/register",
      "/oauth2/create-client",
      "/oauth2/get-client",
      "/oauth2/get-clients",
      "/oauth2/update-client",
      "/oauth2/delete-client",
      "/oauth2/client/rotate-secret",
      "/oauth2/client/rotate-keys",
      // Google signs in, making or finding the account by its email; nothing
      // links a provider to an account by hand.
      "/link-social",
      // Nor unlinks one: a reviewer would drop their password, outliving
      // `reviewer remove-password`'s look for it (ADR 0018). Nothing of Braivo's calls it.
      "/unlink-account",
      // A password is the operator's to set and remove (`reviewer.ts`): none
      // is made, changed, reset, or checked over HTTP. `/set-password` is
      // server-only already; `/reset-password/:token`, a pattern this list
      // cannot name, is refused by the API (`app.ts`).
      "/sign-up/email",
      "/change-password",
      "/request-password-reset",
      "/reset-password",
      "/verify-password",
      // Email codes sign in and nothing else: resetting a password would give
      // an account made by code a password, and the rest serve flows Braivo
      // does not offer.
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
      // These answer any member, not only owners and admins: a learner would
      // read members' and invitations' emails, another's role, or, from
      // `remove-member`'s error, whether an email is a member's; a role change
      // needs a member-row ID nothing left lists. Braivo serves the roster;
      // changing another member takes the database until ADR 0018.
      "/organization/list-members",
      "/organization/get-full-organization",
      "/organization/get-active-member-role",
      "/organization/remove-member",
      "/organization/update-member-role",
      // Invitations, until ADR 0018 guards them: with no verified email,
      // whoever signs up with an invited address joins, and nothing checks the
      // learn domain.
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
    //
    // A password, by contrast, is one reviewer's (ADR 0018): ten tries a
    // minute per client address, not the 120 a class needs for codes.
    rateLimit: {
      customRules: { "/device/token": false, "/sign-in/email": { window: 60, max: 10 } },
    },

    // Stated, not left to a default: a self-hosted installation does not phone
    // home.
    telemetry: { enabled: false },

    // Better Auth skips its origin check when `NODE_ENV` is `test`, which would
    // let tests pass requests a deployment refuses.
    advanced: { disableOriginCheck: false },
  });
  if (options.clientIdMetadataDocuments !== false) return auth;
  const { handler } = auth;
  return Object.assign(auth, {
    handler: async (request: Request) =>
      advertiseRegisteredUrlClients(request, await handler(request)),
  });
}

/** Where Better Auth answers its authorization server's metadata. */
const OAUTH_METADATA_PATHS = new Set([
  "/api/auth/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/openid-configuration",
]);

/**
 * The authorization server's metadata without `cimd()`, rewritten: Better
 * Auth 1.7.11 has no option for either change, and its after hooks skip these
 * responses. CIMD advertised, so ChatGPT and Claude send their documents'
 * URLs, which the operator registered, rather than ask a teacher for a client
 * ID. `private_key_jwt` withdrawn, since ChatGPT signs with a key wherever it
 * is offered, and registered clients have none.
 */
async function advertiseRegisteredUrlClients(
  request: Request,
  response: Response,
): Promise<Response> {
  // GET alone: Better Auth answers HEAD with no body to rewrite.
  if (request.method !== "GET" || response.status !== 200) return response;
  if (!OAUTH_METADATA_PATHS.has(new URL(request.url).pathname)) return response;
  const metadata = (await response.json()) as { token_endpoint_auth_methods_supported: string[] };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    {
      ...metadata,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported.filter(
        (method) => method !== "private_key_jwt",
      ),
    },
    { status: response.status, headers },
  );
}

export type Auth = ReturnType<typeof createAuth>;
