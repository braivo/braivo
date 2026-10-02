// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createObjectives } from "../persistence/index.ts";
import { createAuth } from "./auth.ts";
import { createOrganization } from "./organization.ts";

const connectionString = process.env.TEST_DATABASE_URL;

/** Signed up once per run, so each test can sign in on its own. */
const owner = {
  email: "auth-test-owner@example.com",
  password: "correct horse battery",
  name: "Owner",
};
/** Signed up by the test that checks signing up. */
const newcomer = "auth-test-newcomer@example.com";
/** Signed up by the test that tries to answer invitations. */
const invitee = { ...owner, email: "auth-test-invitee@example.com", name: "Invitee" };
/** Every organization this suite creates or tries to, by slug. */
const slugs = {
  school: "auth-test-school",
  foreignOrigin: "auth-test-foreign-origin",
  ownsContent: "auth-test-owns-content",
  halfDeleted: "auth-test-half-deleted",
  ownsNothing: "auth-test-owns-nothing",
  renamed: "auth-test-renamed",
  renamedAgain: "auth-test-renamed-again",
  hasDomain: "auth-test-has-domain",
  noOwner: "auth-test-no-owner",
  selfServe: "auth-test-self-serve",
  taken: "auth-test-taken",
  invites: "auth-test-invites",
  // Listed so a regression that lets it through is cleaned up after itself.
  reserved: "login",
};

const database = testing.sharedDatabase(connectionString ?? "");
const auth = createAuth({
  database,
  secret: "test-secret-that-is-long-enough-32",
  baseURL: "http://localhost:3000",
});

/** Drives the same `Request` → `Response` surface an HTTP entry point mounts. */
function call(path: string, init?: RequestInit) {
  return auth.handler(new Request(`http://localhost:3000/api/auth${path}`, init));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, {
    method: "POST",
    // Better Auth checks the origin on its organization endpoints.
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Returns what a browser sends back: `name=value` pairs without the attributes
 * they arrived with. Replaying `Set-Cookie` verbatim parses, but is a header no
 * client sends.
 */
async function signIn(account = owner): Promise<string> {
  const { email, password } = account;
  const response = await post("/sign-in/email", { email, password });
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function createOwned(slug: string): Promise<string> {
  return (await createOrganization(auth, { name: slug, slug, ownerEmail: owner.email })).id;
}

const membersOf = (id: string) =>
  database.select().from(authTables.member).where(eq(authTables.member.organizationId, id));

/**
 * Removes this suite's rows and nothing else: its organizations, after the
 * content that would block deleting them, then its users, whose sessions and
 * memberships cascade.
 */
async function clearFixtures(): Promise<void> {
  const { organization, user } = authTables;
  const ours = inArray(organization.slug, Object.values(slugs));
  const leftovers = await database.select({ id: organization.id }).from(organization).where(ours);
  for (const { id } of leftovers) await testing.clearLearningData(database, id);
  await database.delete(organization).where(ours);
  await database.delete(user).where(inArray(user.email, [owner.email, newcomer, invitee.email]));
}

/** Requires TEST_DATABASE_URL: the point is that Better Auth runs on the real schema. */
describe.skipIf(!connectionString)("Better Auth against PostgreSQL", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await clearFixtures();
    await post("/sign-up/email", owner);
  });

  afterAll(clearFixtures);

  test("signing up answers with a session cookie", async () => {
    const response = await post("/sign-up/email", {
      email: newcomer,
      password: "correct horse battery",
      name: "Newcomer",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token");
  });

  test("the session resolves back to the signed-in user", async () => {
    const cookie = await signIn();

    const session = await call("/get-session", { headers: { cookie } });

    expect(await session.json()).toMatchObject({ user: { email: owner.email } });
  });

  test("the operator creates an organization owned by an existing account", async () => {
    // Emails are stored lowercased, and an operator may type one otherwise.
    const created = await createOrganization(auth, {
      name: "Example School",
      slug: slugs.school,
      ownerEmail: owner.email.toUpperCase(),
    });

    expect(created).toMatchObject({ name: "Example School", slug: slugs.school });
    expect(await membersOf(created.id)).toMatchObject([{ role: "owner" }]);
  });

  test("says which slug is taken", async () => {
    await createOwned(slugs.taken);

    const again = createOrganization(auth, {
      name: "Another School",
      slug: slugs.taken,
      ownerEmail: owner.email,
    });

    await expect(again).rejects.toThrow(`An organization already has the slug "${slugs.taken}".`);
  });

  test("refuses an organization for an email no account uses", async () => {
    const created = createOrganization(auth, {
      name: "Nobody's",
      slug: slugs.noOwner,
      ownerEmail: "auth-test-nobody@example.com",
    });

    await expect(created).rejects.toThrow("No account uses auth-test-nobody@example.com");
  });

  test("refuses creating an organization from a browser session", async () => {
    const created = await post(
      "/organization/create",
      { name: "Self-Serve", slug: slugs.selfServe },
      { cookie: await signIn() },
    );

    expect(created.status).toBe(403);
    expect(await created.json()).toMatchObject({
      code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
    });
  });

  test("refuses an HTTP request that names an owner instead of signing in", async () => {
    // The operator's call is trusted because it has no request; pins that
    // Better Auth still refuses one that does (ADR 0006's pinned version).
    const [stored] = await database
      .select({ id: authTables.user.id })
      .from(authTables.user)
      .where(eq(authTables.user.email, owner.email));

    const created = await post("/organization/create", {
      name: "Impostor",
      slug: slugs.selfServe,
      userId: stored?.id,
    });

    expect(created.status).toBe(401);
  });

  test("answers none of Better Auth's invitation endpoints, and stored invitations stay pending", async () => {
    // Each request, from the account it expects, succeeds without the switch,
    // so only the switch refuses it.
    const id = await createOwned(slugs.invites);
    const [inviter] = await membersOf(id);
    // Named once, so a request cannot drift from the invitation it answers.
    const invitationIds = {
      accept: "auth-test-accept",
      reject: "auth-test-reject",
      cancel: "auth-test-cancel",
      get: "auth-test-get",
    };
    await database.insert(authTables.invitation).values(
      Object.values(invitationIds).map((invitationId) => ({
        id: invitationId,
        organizationId: id,
        email: invitee.email,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        inviterId: inviter!.userId,
      })),
    );
    await post("/sign-up/email", invitee);
    // Listing one's own invitations takes a verified email, which no account
    // has until email codes (ADR 0018).
    const { user } = authTables;
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, invitee.email));
    const ownerHeaders = { cookie: await signIn() };
    const inviteeHeaders = { cookie: await signIn(invitee) };

    const answers = await Promise.all([
      post(
        "/organization/invite-member",
        { organizationId: id, email: newcomer, role: "member" },
        ownerHeaders,
      ),
      post("/organization/cancel-invitation", { invitationId: invitationIds.cancel }, ownerHeaders),
      call(`/organization/list-invitations?organizationId=${id}`, { headers: ownerHeaders }),
      post(
        "/organization/accept-invitation",
        { invitationId: invitationIds.accept },
        inviteeHeaders,
      ),
      post(
        "/organization/reject-invitation",
        { invitationId: invitationIds.reject },
        inviteeHeaders,
      ),
      call(`/organization/get-invitation?id=${invitationIds.get}`, { headers: inviteeHeaders }),
      call("/organization/list-user-invitations", { headers: inviteeHeaders }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual(Array(7).fill(404));
    const { invitation } = authTables;
    const stored = await database
      .select({ id: invitation.id, status: invitation.status })
      .from(invitation)
      .where(eq(invitation.organizationId, id));
    expect(stored.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
      Object.values(invitationIds)
        .toSorted()
        .map((invitationId) => ({ id: invitationId, status: "pending" })),
    );
    expect((await membersOf(id)).map((member) => member.userId)).toEqual([inviter!.userId]);
  });

  test("refuses a reserved slug", async () => {
    const created = createOrganization(auth, {
      name: "Login",
      slug: slugs.reserved,
      ownerEmail: owner.email,
    });

    await expect(created).rejects.toMatchObject({
      body: { code: "ORGANIZATION_SLUG_NOT_ALLOWED" },
    });
  });

  test("refuses changing a slug, but not resending it with other changes", async () => {
    const cookie = await signIn();
    const id = await createOwned(slugs.renamed);
    const update = (data: Record<string, string>) =>
      post("/organization/update", { organizationId: id, data }, { cookie });

    const changed = await update({ slug: slugs.renamedAgain });
    const resent = await update({ name: "Renamed School", slug: slugs.renamed });

    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ code: "ORGANIZATION_SLUG_IMMUTABLE" });
    expect(resent.status).toBe(200);
    const { organization } = authTables;
    const [stored] = await database.select().from(organization).where(eq(organization.id, id));
    expect(stored).toMatchObject({ name: "Renamed School", slug: slugs.renamed });
  });

  test("trusts sign-in from an organization's own domain as origin, not a foreign one", async () => {
    const id = await createOwned(slugs.hasDomain);
    await database
      .insert(organizationDomain)
      .values({ hostname: "auth-test.example.com", organizationId: id });

    const signedIn = await post(
      "/sign-in/email",
      { email: owner.email, password: owner.password },
      { origin: "https://auth-test.example.com" },
    );

    expect(signedIn.status).toBe(200);
    const foreign = await post(
      "/sign-in/email",
      { email: owner.email, password: owner.password },
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
  });

  test("refuses an organization write from a foreign origin", async () => {
    // Pins `disableOriginCheck: false`: without it, Better Auth skips this check
    // whenever `NODE_ENV` is `test`, and this would pass.
    const id = await createOwned(slugs.foreignOrigin);

    const updated = await post(
      "/organization/update",
      { organizationId: id, data: { name: "Foreign Origin" } },
      { cookie: await signIn(), origin: "https://evil.example" },
    );

    expect(updated.status).toBe(403);
  });

  test("refuses to delete an organization that still owns learning content", async () => {
    // The 409 distinguishes the hook from the underlying foreign key's refusal.
    const cookie = await signIn();
    const id = await createOwned(slugs.ownsContent);
    await createObjectives(database, id, ["Blocks deletion"]);
    const before = await membersOf(id);

    const deleted = await post("/organization/delete", { organizationId: id }, { cookie });

    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ code: "ORGANIZATION_OWNS_LEARNING_CONTENT" });
    expect(before).toHaveLength(1);
    expect(await membersOf(id)).toEqual(before);
  });

  test("the adapter createAuth configures rolls back a failed transaction", async () => {
    // Better Auth's organization delete runs its steps in this transaction, so
    // a foreign key refusing the last one leaves the members in place. That the
    // endpoint still uses it is a pinned-version assumption (ADR 0006).
    const id = await createOwned(slugs.halfDeleted);
    await createObjectives(database, id, ["Refuses the last step"]);
    const before = await membersOf(id);

    const { adapter } = await auth.$context;
    const refused = await adapter
      .transaction(async (tx) => {
        await tx.deleteMany({ model: "member", where: [{ field: "organizationId", value: id }] });
        await tx.delete({ model: "organization", where: [{ field: "id", value: id }] });
      })
      .catch((thrown: unknown) => thrown);

    // Named, not merely thrown: a mistyped model would also reject and roll back.
    expect(testing.violatedConstraint(refused)).toBe(
      "objective_organization_id_organization_id_fk",
    );
    expect(before).toHaveLength(1);
    expect(await membersOf(id)).toEqual(before);
  });

  test("deletes an organization that owns nothing", async () => {
    // Without this, a guard that refused every deletion would pass the tests
    // above.
    const cookie = await signIn();
    const id = await createOwned(slugs.ownsNothing);

    const deleted = await post("/organization/delete", { organizationId: id }, { cookie });

    expect(deleted.status).toBe(200);
    const { organization } = authTables;
    expect(await database.select().from(organization).where(eq(organization.id, id))).toEqual([]);
    expect(await membersOf(id)).toEqual([]);
  });
});
