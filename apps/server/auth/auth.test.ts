// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createObjectives } from "../persistence/index.ts";
import { createAuth } from "./auth.ts";

const connectionString = process.env.TEST_DATABASE_URL;

/** Signed up once per run, so each test can sign in on its own. */
const owner = {
  email: "auth-test-owner@example.com",
  password: "correct horse battery",
  name: "Owner",
};
/** Signed up by the test that checks signing up. */
const newcomer = "auth-test-newcomer@example.com";
/** Every organization this suite creates or tries to, by slug. */
const slugs = {
  school: "auth-test-school",
  foreignOrigin: "auth-test-foreign-origin",
  ownsContent: "auth-test-owns-content",
  halfDeleted: "auth-test-half-deleted",
  ownsNothing: "auth-test-owns-nothing",
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
async function signIn(): Promise<string> {
  const response = await post("/sign-in/email", { email: owner.email, password: owner.password });
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function createOrganization(slug: string, cookie: string): Promise<string> {
  const created = await post("/organization/create", { name: slug, slug }, { cookie });
  return ((await created.json()) as { id: string }).id;
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
  await database.delete(user).where(inArray(user.email, [owner.email, newcomer]));
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

  test("a signed-in user can own an organization", async () => {
    const cookie = await signIn();

    const created = await post(
      "/organization/create",
      { name: "Example School", slug: slugs.school },
      { cookie },
    );

    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ slug: slugs.school });
  });

  test("refuses an organization write from a foreign origin", async () => {
    // Pins `disableOriginCheck: false`: without it, Better Auth skips this check
    // whenever `NODE_ENV` is `test`, and this would pass.
    const cookie = await signIn();

    const created = await post(
      "/organization/create",
      { name: "Foreign Origin", slug: slugs.foreignOrigin },
      { cookie, origin: "https://evil.example" },
    );

    expect(created.status).toBe(403);
  });

  test("refuses to delete an organization that still owns learning content", async () => {
    // The 409 distinguishes the hook from the underlying foreign key's refusal.
    const cookie = await signIn();
    const id = await createOrganization(slugs.ownsContent, cookie);
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
    const cookie = await signIn();
    const id = await createOrganization(slugs.halfDeleted, cookie);
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
    const id = await createOrganization(slugs.ownsNothing, cookie);

    const deleted = await post("/organization/delete", { organizationId: id }, { cookie });

    expect(deleted.status).toBe(200);
    const { organization } = authTables;
    expect(await database.select().from(organization).where(eq(organization.id, id))).toEqual([]);
    expect(await membersOf(id)).toEqual([]);
  });
});
