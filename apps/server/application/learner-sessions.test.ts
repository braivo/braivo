// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import { runMigrations } from "@braivo/db";
import { learnerHandoff, learnerSession, organizationDomain } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { and, eq, lte } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  resumeLearnerSession,
  redeemHandoff,
  startHandoff,
} from "./learner-sessions.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const school = "learner-sessions-test-school";
const otherSchool = "learner-sessions-test-other-school";
const learner = "learner-sessions-test-learner";
const outsider = "learner-sessions-test-outsider";
const hostname = "learner-sessions-test.example.com";
const at = new Date("2026-01-01T00:00:00.000Z");
const after = (seconds: number) => new Date(at.getTime() + seconds * 1000);

/** A handoff started on the school's domain and completed by its learner. */
async function issued(returnPath = "/courses/c1") {
  const started = await startHandoff({ database, hostname, returnPath, now: at });
  if (!started) throw new Error("The school's domain started no handoff.");
  const completed = await completeHandoff({
    database,
    handoffId: started.handoffId,
    userId: learner,
    now: at,
  });
  if (completed.kind !== "issued") throw new Error(`Completing answered ${completed.kind}.`);
  return { ...started, code: completed.code };
}

const redeem = (input: { code: string; nonce: string }, now = at, on = hostname) =>
  redeemHandoff({ database, hostname: on, now, ...input });

describe.skipIf(!connectionString)("a learn domain's sign-in, handed over", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await seedOrganization(database, { organizationId: school, learnerIds: [learner], at });
    await seedOrganization(database, { organizationId: otherSchool, learnerIds: [outsider], at });
    await database.delete(organizationDomain).where(eq(organizationDomain.hostname, hostname));
    await database.insert(organizationDomain).values({ hostname, organizationId: school });
  });

  test("opens a learner session for a member, once, returning where they started", async () => {
    const { handoffId, nonce, code } = await issued("/courses/c1?tab=next");
    expect(await describeHandoff({ database, handoffId, now: at })).toEqual({
      organization: { name: school },
      hostname,
    });

    // A code shortens the handoff to its own minute.
    expect(await describeHandoff({ database, handoffId, now: after(60) })).toBeUndefined();

    const redeemed = await redeem({ code, nonce });
    expect(redeemed?.returnPath).toBe("/courses/c1?tab=next");
    expect(
      await resumeLearnerSession({ database, hostname, token: redeemed!.token, now: at }),
    ).toEqual({
      user: { id: learner, name: learner },
    });
    expect(await redeem({ code, nonce })).toBeUndefined();
  });

  test("spends nothing on a code redeemed without its nonce, or elsewhere, and nothing late", async () => {
    const { nonce, code } = await issued();

    expect(await redeem({ code, nonce: "another browser's" })).toBeUndefined();
    expect(
      await redeem({ code, nonce }, at, "learner-sessions-test-other.example.com"),
    ).toBeUndefined();
    expect(await redeem({ code, nonce }, after(60))).toBeUndefined();
    expect(await redeem({ code, nonce }, after(59))).toBeDefined();
  });

  test("replaces a code completed again, and never outlives the handoff's fifteen minutes", async () => {
    const started = await startHandoff({ database, hostname, returnPath: "/", now: at });
    const { handoffId, nonce } = started ?? expect.fail("not started");
    const complete = async (now: Date) => {
      const completed = await completeHandoff({ database, handoffId, userId: learner, now });
      return completed.kind === "issued" ? completed.code : expect.fail(completed.kind);
    };

    // Completed with fifteen seconds left: the code has those, not a minute.
    const first = await complete(after(15 * 60 - 15));
    const second = await complete(after(15 * 60 - 10));
    expect(await redeem({ code: first, nonce }, after(15 * 60 - 5))).toBeUndefined();
    expect(await redeem({ code: second, nonce }, after(15 * 60))).toBeUndefined();
    expect(await redeem({ code: second, nonce }, after(15 * 60 - 1))).toBeDefined();
  });

  test("hands a session only to a member, and only of the organization the domain serves", async () => {
    const started = await startHandoff({ database, hostname, returnPath: "/", now: at });
    const complete = (userId: string, handoffId = started!.handoffId) =>
      completeHandoff({ database, handoffId, userId, now: at });

    expect(await complete(outsider)).toEqual({ kind: "not-member" });
    expect(await complete(learner, "no-such-handoff")).toEqual({ kind: "unavailable" });
    expect(
      await startHandoff({ database, hostname: "unserved.example.com", returnPath: "/", now: at }),
    ).toBeUndefined();
  });

  test("hands nothing over once the domain stops serving the organization, and ends its sessions", async () => {
    const { handoffId, nonce, code } = await issued();
    const { token } = (await redeem(await issued())) ?? expect.fail("not redeemed");

    await database
      .update(organizationDomain)
      .set({ organizationId: otherSchool })
      .where(eq(organizationDomain.hostname, hostname));

    expect(await describeHandoff({ database, handoffId, now: at })).toBeUndefined();
    expect(await redeem({ code, nonce })).toBeUndefined();
    expect(await resumeLearnerSession({ database, hostname, token, now: at })).toBeUndefined();
  });

  test("refuses a session on the organization's later domain", async () => {
    const { token } = (await redeem(await issued())) ?? expect.fail("not redeemed");
    const next = "learner-sessions-test-next.example.com";
    const move = (from: string, to: string) =>
      database
        .update(organizationDomain)
        .set({ hostname: to })
        .where(eq(organizationDomain.hostname, from));

    await move(hostname, next);
    try {
      // A token kept by the old domain's operator opens nothing on the new one.
      expect(
        await resumeLearnerSession({ database, hostname: next, token, now: at }),
      ).toBeUndefined();
    } finally {
      await move(next, hostname);
    }
  });

  test("keeps only each secret's SHA-256, which redeems nothing itself", async () => {
    const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");
    const { handoffId, nonce, code } = await issued();
    const [handoff] = await database
      .select()
      .from(learnerHandoff)
      .where(eq(learnerHandoff.id, handoffId));
    expect(handoff).toMatchObject({ nonceHash: sha256(nonce), codeHash: sha256(code) });
    expect(JSON.stringify(handoff)).not.toContain(nonce);
    expect(JSON.stringify(handoff)).not.toContain(code);
    expect(await redeem({ code: handoff!.codeHash!, nonce: handoff!.nonceHash })).toBeUndefined();

    const { token } = (await redeem({ code, nonce })) ?? expect.fail("not redeemed");
    const [session] = await database
      .select()
      .from(learnerSession)
      .where(eq(learnerSession.tokenHash, sha256(token)));
    expect(JSON.stringify(session)).not.toContain(token);
    expect(
      await resumeLearnerSession({ database, hostname, token: session!.tokenHash, now: at }),
    ).toBeUndefined();

    // URL-safe as they are, in a URL and a cookie, and long enough for 256 bits.
    for (const value of [nonce, code, token]) expect(value).toMatch(/^[\w-]{43}$/);
  });

  test("forgets a handoff once expired, as the next one starts", async () => {
    const { handoffId } =
      (await startHandoff({ database, hostname, returnPath: "/", now: at })) ??
      expect.fail("not started");
    const kept = () => database.$count(learnerHandoff, eq(learnerHandoff.id, handoffId));

    await startHandoff({ database, hostname, returnPath: "/", now: after(15 * 60 - 1) });
    expect(await kept()).toBe(1);
    await startHandoff({ database, hostname, returnPath: "/", now: after(15 * 60) });
    expect(await kept()).toBe(0);
  });

  test("returns only within the domain", async () => {
    for (const away of [
      undefined,
      "",
      "courses",
      "//evil.example",
      "https://evil.example",
      "/\t/evil.example",
      "/\\evil.example",
      // Leaving only once normalized.
      "/x/..//evil.example",
      "/x/..\\/evil.example",
    ]) {
      const started = await startHandoff({ database, hostname, returnPath: away, now: at });
      const { code } = (await completeHandoff({
        database,
        handoffId: started!.handoffId,
        userId: learner,
        now: at,
      })) as { code: string };
      expect((await redeem({ code, nonce: started!.nonce }))?.returnPath).toBe("/");
    }
  });

  test("lasts a week, renewed by use once a day old, until signed out", async () => {
    const { token } = (await redeem(await issued())) ?? expect.fail("not redeemed");
    const read = (now: Date) => resumeLearnerSession({ database, hostname, token, now });
    const day = 24 * 60 * 60;

    expect((await read(after(day - 1)))?.renewedUntil).toBeUndefined();
    expect((await read(after(day + 1)))?.renewedUntil).toEqual(after(8 * day + 1));
    // Past the week it began with, kept by that use.
    expect(await read(after(8 * day))).toBeDefined();

    const { token: unused } = (await redeem(await issued())) ?? expect.fail("not redeemed");
    expect(
      await resumeLearnerSession({ database, hostname, token: unused, now: after(7 * day) }),
    ).toBe(undefined);

    // Expired ones are gone once another session is opened.
    const later = after(8 * day);
    const started = await startHandoff({ database, hostname, returnPath: "/", now: later });
    const { code } = (await completeHandoff({
      database,
      handoffId: started!.handoffId,
      userId: learner,
      now: later,
    })) as { code: string };
    await redeem({ code, nonce: started!.nonce }, later);
    const expired = and(eq(learnerSession.userId, learner), lte(learnerSession.expiresAt, later));
    expect(await database.$count(learnerSession, expired)).toBe(0);

    const { token: ended } = (await redeem(await issued())) ?? expect.fail("not redeemed");
    await endLearnerSession({ database, token: ended });
    expect(
      await resumeLearnerSession({ database, hostname, token: ended, now: at }),
    ).toBeUndefined();
  });
});
