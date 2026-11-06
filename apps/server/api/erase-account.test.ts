// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// An account erased while its person is signed in (access-49), through the real
// sign-in, so Better Auth's rows are as it writes them: what each session answers
// after, and what signing in again finds.

import { runMigrations } from "@braivo/db";
import {
  attempt,
  invitation,
  invitationMailClaim,
  learnerEvidence,
  member,
  organizationDomain,
  user,
  verification,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { eraseAccount, previewAccountErasure } from "../application/erase-account.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { baseUrl, connectionString, createTestApi, learnerSessionOn } from "./testing.ts";

const { database, api, outbox, signUpAs } = createTestApi();

const organizationId = "erase-account-api-test";
const hostname = "erase-account-api-test.example";
const origin = `https://${hostname}`;
const log = {
  hmacKey: "erasure-log-test-key-that-is-long-enough",
  store: { put: async () => {} },
};

const erase = async (email: string) => {
  const { target } = await previewAccountErasure({ database, email });
  return eraseAccount({ database, target, log });
};

describe.skipIf(!connectionString)("an account erased while signed in", () => {
  let courseId = "";
  let taskId = "";

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    await database
      .insert(organizationDomain)
      .values({ hostname, organizationId })
      .onConflictDoNothing();
    const objectiveIds = await createObjectives(database, organizationId, ["Greetings"]);
    taskId = await testing.createTask(database, {
      organizationId,
      objectiveId: objectiveIds[0]!,
      body: { kind: "choice", prompt: "Hello?", options: ["Yes", "No"], answer: 0 },
      createdAt: new Date(Date.now() - 86_400_000),
    });
    ({ id: courseId } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Greetings",
      objectiveIds,
    }));
  });

  async function signedIn() {
    const email = `erase-account-api-${crypto.randomUUID()}@fernwood.example`;
    const person = await signUpAs(email, "Ada Fernley");
    await database.insert(member).values({
      id: `${organizationId}:${person.id}`,
      organizationId,
      userId: person.id,
      role: "member",
      createdAt: new Date(),
    });
    return { ...person, learner: await learnerSessionOn(api, origin, person.cookie) };
  }

  const practise = (cookie: string, host = origin) =>
    api.request(`${host}/api/courses/${courseId}/next`, { headers: { cookie } });

  test("ends every session, and the minute between codes is gone", async () => {
    const person = await signedIn();
    const answer = await api.request(`${origin}/api/courses/${courseId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: person.learner },
      body: JSON.stringify({ id: "a1", taskId, response: { choice: 0 }, historyEpoch: 0 }),
    });
    expect(answer.status).toBe(200);
    expect((await practise(person.learner)).ok).toBe(true);
    expect((await api.request("/api/session", { headers: { cookie: person.cookie } })).status).toBe(
      200,
    );
    const before = await database
      .select({ identifier: verification.identifier })
      .from(verification);
    expect(before.map(({ identifier }) => identifier)).toContain(
      `sign-in-code-sent:${person.email}`,
    );

    await erase(person.email);

    expect((await practise(person.learner)).status).toBe(401);
    const credentials: Record<string, string>[] = [
      { cookie: person.cookie },
      { authorization: `Bearer ${person.token}` },
    ];
    for (const headers of credentials) {
      expect((await api.request("/api/session", { headers })).status).toBe(401);
    }
    const after = await database.select({ identifier: verification.identifier }).from(verification);
    expect(after.filter(({ identifier }) => identifier.includes(person.email))).toEqual([]);
  });

  test("a code asked for before and unused goes too", async () => {
    const email = `erase-account-api-${crypto.randomUUID()}@fernwood.example`;
    const asked = await api.request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(asked.status).toBe(200);
    const identifiers = async () =>
      (await database.select({ identifier: verification.identifier }).from(verification))
        .map(({ identifier }) => identifier)
        .filter((identifier) => identifier.includes(email));
    expect((await identifiers()).toSorted()).toEqual([
      `sign-in-code-sent:${email}`,
      `sign-in-otp-${email}`,
    ]);

    const { target, counts } = await previewAccountErasure({ database, email });
    expect(target.userId).toBeNull();
    expect(counts.verifications).toBe(2);
    await eraseAccount({ database, target, log });
    expect(await identifiers()).toEqual([]);
    // And the old code signs no one in.
    const old = outbox.sent.findLast((mail) => mail.to === email)?.text.match(/\b\d{6}\b/)?.[0];
    const refused = await api.request("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp: old }),
    });
    expect(refused.ok).toBe(false);
    expect(await database.$count(user, eq(user.email, email))).toBe(0);
  });

  test("an invitation made through the route goes with either person, its link dead", async () => {
    const admin = await signedIn();
    await database.update(member).set({ role: "admin" }).where(eq(member.userId, admin.id));
    const invite = async (email: string) => {
      const made = await api.request(`/api/organizations/${organizationId}/invitations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: admin.cookie,
          origin: baseUrl,
        },
        body: JSON.stringify({ emails: [email], role: "author" }),
      });
      expect(made.status).toBe(200);
      const { results } = (await made.json()) as {
        results: { outcome: string; invitation: { id: string } }[];
      };
      expect(results[0]?.outcome).toBe("invited");
      return results[0]!.invitation.id;
    };
    const link = (id: string) => api.request(`/api/invitations/${id}`);
    const toErased = `erase-account-invited-${crypto.randomUUID()}@fernwood.example`;
    const toKept = `erase-account-invited-${crypto.randomUUID()}@fernwood.example`;
    const [erasedId, keptId] = [await invite(toErased), await invite(toKept)];
    expect((await link(erasedId)).status).toBe(200);

    // To the address: gone, though no account ever had it; the other stays.
    await erase(toErased);
    expect(await database.$count(invitation, eq(invitation.id, erasedId))).toBe(0);
    expect(
      await database.$count(invitationMailClaim, eq(invitationMailClaim.email, toErased)),
    ).toBe(0);
    expect(await database.$count(invitationMailClaim, eq(invitationMailClaim.email, toKept))).toBe(
      1,
    );
    expect((await link(erasedId)).status).toBe(404);
    expect((await link(keptId)).status).toBe(200);

    // From the account: what it sent goes with it.
    await erase(admin.email);
    expect(await database.$count(invitation, eq(invitation.id, keptId))).toBe(0);
    expect((await link(keptId)).status).toBe(404);
  });

  test("a mail claim alone reaches its school, and one whose school is gone reaches none", async () => {
    const email = `erase-account-claim-${crypto.randomUUID()}@fernwood.example`;
    const claimedAt = new Date();
    await database.insert(invitationMailClaim).values([
      { email, organizationId, claimedAt },
      { email, claimedAt },
    ]);

    const { target, counts } = await previewAccountErasure({ database, email });
    expect(target.organizations.map(({ id }) => id)).toEqual([organizationId]);
    expect(counts.mailClaims).toBe(2);

    await eraseAccount({ database, target, log });
    expect(await database.$count(invitationMailClaim, eq(invitationMailClaim.email, email))).toBe(
      0,
    );
  });

  test("signing in again makes a fresh account, with nothing of the old", async () => {
    const person = await signedIn();
    await api.request(`${origin}/api/courses/${courseId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: person.learner },
      body: JSON.stringify({ id: "a1", taskId, response: { choice: 0 }, historyEpoch: 0 }),
    });
    await erase(person.email);

    const again = await signUpAs(person.email, "Ada Fernley");
    expect(again.id).not.toBe(person.id);
    expect(await database.$count(attempt, eq(attempt.learnerId, again.id))).toBe(0);
    expect(await database.$count(learnerEvidence, eq(learnerEvidence.learnerId, again.id))).toBe(0);
    // Not a member: membership went with the account, and only the school adds it again.
    expect(await database.$count(attempt, eq(attempt.learnerId, person.id))).toBe(0);
    const course = await api.request(`/api/courses/${courseId}/next`, {
      headers: { cookie: again.cookie },
    });
    expect(course.status).toBe(404);
  });
});
