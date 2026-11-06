// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import {
  account,
  attempt,
  group,
  groupMember,
  learnerEvidence,
  learnerHandoff,
  learnerSession,
  learnerSignInCode,
  member,
  oauthClient,
  oauthConsent,
  objective,
  organization,
  session,
  task,
  taskReport,
  user,
  verification,
} from "@braivo/db/schema";
import { clearLearningData, createTask, sharedDatabase } from "@braivo/db/testing";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

// The operator's command against a real database (access-47): what each scope
// holds, and what neither ever does.

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const prefix = "learner-export-test";
const fernwood = { id: `${prefix}-fernwood`, name: "Fernwood School" };
const birchwood = { id: `${prefix}-birchwood`, name: "Birchwood Tutoring" };
const cedarwood = { id: `${prefix}-cedarwood`, name: "Cedarwood Academy" };
const ada = { id: `${prefix}-ada`, name: "Ada Fernley", email: `${prefix}-ada@fernwood.example` };
const ben = { id: `${prefix}-ben`, name: "Ben Ashgrove", email: `${prefix}-ben@fernwood.example` };
const clientId = `${prefix}-client`;
const at = new Date("2026-09-01T08:00:00.000Z");
const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);

/** Strings seeded where no export may reach: each must be absent from every file's bytes. */
const secrets = [
  "SECRET-console-token",
  "203.0.113.7",
  "SecretAgent/1.0",
  "SECRET-learner-token-hash",
  "SECRET-access-token",
  "SECRET-refresh-token",
  "SECRET-id-token",
  "google-subject-4242",
  "SECRET-client-secret",
  "SECRET-code-seed",
  "SECRET-otp-value",
  "SECRET-nonce-hash",
  "SECRET-handoff-code",
  // A choice task's correct option and every explanation stay out.
  "SECRET-explanation",
  // A property some later writer adds to a response is not v1's.
  "SECRET-stray-response-field",
  // Ben's, the other learner at Fernwood.
  ben.name,
  ben.email,
  "Ben's typed answer",
  "Ben's report",
];

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: connectionString ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** Every key path in `value`, array items as `[]`: what an allowlist compares. */
function keyPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${path}[]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    return [here, ...keyPaths(child, here)];
  });
}

const organizationPaths = [
  "organizations",
  "organizations[].name",
  "organizations[].membership",
  "organizations[].membership.roles",
  "organizations[].membership.since",
  "organizations[].groups",
  "organizations[].groups[].name",
  "organizations[].groups[].role",
  "organizations[].attempts",
  "organizations[].attempts[].at",
  "organizations[].attempts[].task",
  "organizations[].attempts[].task.kind",
  "organizations[].attempts[].task.prompt",
  "organizations[].attempts[].task.options",
  "organizations[].attempts[].task.accepted",
  "organizations[].attempts[].response",
  "organizations[].attempts[].response.choice",
  "organizations[].attempts[].response.text",
  "organizations[].attempts[].reviewedTeaching",
  "organizations[].attempts[].response.reveal",
  "organizations[].attempts[].outcome",
  "organizations[].attempts[].report",
  "organizations[].attempts[].report.reason",
  "organizations[].attempts[].report.note",
  "organizations[].attempts[].report.at",
  "organizations[].attempts[].report.status",
  "organizations[].evidence",
  "organizations[].evidence[].at",
  "organizations[].evidence[].objective",
  "organizations[].evidence[].outcome",
  "organizations[].evidence[].origin",
];
const schoolScopePaths = [
  "format",
  "version",
  "scope",
  "exportedAt",
  "learner",
  "learner.name",
  "learner.email",
  ...organizationPaths,
];
const accountScopePaths = [
  ...schoolScopePaths,
  "account",
  "account.createdAt",
  "account.signInProviders",
  "account.connectedApps",
  "account.connectedApps[].name",
  "account.connectedApps[].scopes",
  "account.connectedApps[].connectedAt",
  "account.connectedApps[].updatedAt",
  "account.sessions",
  "account.sessions.console",
  "account.sessions.console[].createdAt",
  "account.sessions.console[].expiresAt",
  "account.sessions.learn",
  "account.sessions.learn[].organization",
  "account.sessions.learn[].hostname",
  "account.sessions.learn[].expiresAt",
];

async function clear() {
  const organizationIds = [fernwood.id, birchwood.id, cedarwood.id];
  for (const id of organizationIds) await clearLearningData(database, id);
  await database.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await database.delete(user).where(inArray(user.id, [ada.id, ben.id]));
  await database.delete(organization).where(inArray(organization.id, organizationIds));
  await database.delete(verification).where(like(verification.identifier, `%${prefix}%`));
}

async function seed() {
  await database.insert(user).values(
    [ada, ben].map((person) => ({
      ...person,
      emailVerified: true,
      createdAt: at,
      updatedAt: at,
    })),
  );
  await database
    .insert(organization)
    .values(
      [fernwood, birchwood, cedarwood].map((each) => ({ ...each, slug: each.id, createdAt: at })),
    );
  await database.insert(member).values([
    {
      id: `${prefix}-m1`,
      organizationId: fernwood.id,
      userId: ada.id,
      role: "member",
      createdAt: at,
    },
    {
      id: `${prefix}-m2`,
      organizationId: birchwood.id,
      userId: ada.id,
      role: "member,author",
      createdAt: later(1),
    },
    {
      id: `${prefix}-m3`,
      organizationId: fernwood.id,
      userId: ben.id,
      role: "member",
      createdAt: at,
    },
  ]);
  await database.insert(group).values({
    id: `${prefix}-group`,
    organizationId: fernwood.id,
    name: "Year 7 French",
    creationDigest: "x",
  });
  await database.insert(groupMember).values([
    { organizationId: fernwood.id, groupId: `${prefix}-group`, userId: ada.id, role: "learner" },
    { organizationId: fernwood.id, groupId: `${prefix}-group`, userId: ben.id, role: "learner" },
  ]);

  // One objective and its tasks per organization, under the same task-local
  // attempt IDs, so a join missing the organization or the learner shows.
  const objectives = new Map<string, string>();
  for (const each of [fernwood, birchwood, cedarwood]) {
    const id = `${each.id}-objective`;
    objectives.set(each.id, id);
    await database
      .insert(objective)
      .values({ id, organizationId: each.id, title: `${each.name}: greetings` });
  }
  const choice = (organizationId: string) =>
    createTask(database, {
      organizationId,
      objectiveId: objectives.get(organizationId)!,
      body: {
        kind: "choice",
        prompt: `${organizationId}: How do you say hello?`,
        options: ["Merci", "Bonjour"],
        answer: 1,
        explanation: "SECRET-explanation",
      },
      createdAt: at,
    });
  const typed = (organizationId: string) =>
    createTask(database, {
      organizationId,
      objectiveId: objectives.get(organizationId)!,
      body: {
        kind: "typed",
        prompt: `${organizationId}: Hello in French`,
        accepted: ["bonjour"],
        explanation: "SECRET-explanation",
      },
      createdAt: at,
    });
  const fernChoice = await choice(fernwood.id);
  const fernTyped = await typed(fernwood.id);
  const birchTyped = await typed(birchwood.id);
  const cedarChoice = await choice(cedarwood.id);

  const attempts = [
    {
      learnerId: ada.id,
      organizationId: fernwood.id,
      id: "a1",
      taskId: fernChoice,
      response: { choice: 1 },
      at: later(10),
      outcome: "success" as const,
    },
    {
      learnerId: ada.id,
      organizationId: fernwood.id,
      id: "a2",
      taskId: fernTyped,
      response: { text: "bonjour", stray: "SECRET-stray-response-field" },
      at: later(11),
      outcome: "success" as const,
    },
    {
      learnerId: ada.id,
      organizationId: fernwood.id,
      id: "a3",
      taskId: fernTyped,
      response: { reveal: true },
      reviewedTeaching: true,
      at: later(12),
      outcome: "failure" as const,
    },
    // Ben's, under Ada's IDs.
    {
      learnerId: ben.id,
      organizationId: fernwood.id,
      id: "a1",
      taskId: fernChoice,
      response: { choice: 0 },
      at: later(13),
      outcome: "failure" as const,
    },
    {
      learnerId: ben.id,
      organizationId: fernwood.id,
      id: "a2",
      taskId: fernTyped,
      response: { text: "Ben's typed answer" },
      at: later(14),
      outcome: "failure" as const,
    },
    {
      learnerId: ada.id,
      organizationId: birchwood.id,
      id: "a1",
      taskId: birchTyped,
      response: { text: "salut" },
      at: later(20),
      outcome: "failure" as const,
    },
    {
      learnerId: ada.id,
      organizationId: cedarwood.id,
      id: "a1",
      taskId: cedarChoice,
      response: { choice: 1 },
      at: later(30),
      outcome: "success" as const,
    },
  ];
  for (const { outcome, ...row } of attempts) {
    await database.insert(attempt).values(row);
    await database.insert(learnerEvidence).values({
      id: `attempt:${row.id}:${objectives.get(row.organizationId)}`,
      learnerId: row.learnerId,
      organizationId: row.organizationId,
      objectiveId: objectives.get(row.organizationId)!,
      outcome,
      at: row.at,
    });
  }
  // Reports, each of its attempt (ADR 0052): Ada's open, dismissed, and
  // dismissed then closed by its task's retirement, which wins; Ben's on his
  // attempt under Ada's ID.
  const tasks = new Map(
    attempts.map((row) => [`${row.learnerId}/${row.organizationId}/${row.id}`, row.taskId]),
  );
  const report = (
    learnerId: string,
    organizationId: string,
    attemptId: string,
    fields: Partial<typeof taskReport.$inferInsert>,
  ) =>
    database.insert(taskReport).values({
      learnerId,
      organizationId,
      attemptId,
      id: `${prefix}-report-${learnerId}-${organizationId}-${attemptId}`,
      taskId: tasks.get(`${learnerId}/${organizationId}/${attemptId}`)!,
      reason: "other",
      createdAt: later(50),
      ...fields,
    });
  await report(ada.id, fernwood.id, "a2", { reason: "key-wrong", note: "Bonjour! is right too" });
  await report(ada.id, fernwood.id, "a3", { reason: "confusing", dismissedAt: later(55) });
  await report(ada.id, birchwood.id, "a1", { note: "salut means hello", dismissedAt: later(52) });
  await database
    .update(task)
    .set({ retiredAt: later(56) })
    .where(eq(task.id, birchTyped));
  await report(ben.id, fernwood.id, "a1", { note: "Ben's report" });

  // A result recorded from outside Braivo, under the same ID for both learners.
  for (const learnerId of [ada.id, ben.id]) {
    await database.insert(learnerEvidence).values({
      id: "quiz-1",
      learnerId,
      organizationId: fernwood.id,
      objectiveId: objectives.get(fernwood.id)!,
      outcome: learnerId === ada.id ? "success" : "failure",
      at: later(40),
    });
  }

  // The account layer: a console session switched between schools, tokens, a
  // learn domain's session, a connection, codes, a handoff.
  await database.insert(session).values({
    id: `${prefix}-session`,
    userId: ada.id,
    token: "SECRET-console-token",
    ipAddress: "203.0.113.7",
    userAgent: "SecretAgent/1.0",
    activeOrganizationId: fernwood.id,
    expiresAt: later(60 * 24 * 7),
    createdAt: later(5),
    updatedAt: later(5),
  });
  await database
    .update(session)
    .set({ activeOrganizationId: birchwood.id })
    .where(eq(session.id, `${prefix}-session`));
  await database.insert(account).values({
    id: `${prefix}-account`,
    userId: ada.id,
    providerId: "google",
    accountId: "google-subject-4242",
    accessToken: "SECRET-access-token",
    refreshToken: "SECRET-refresh-token",
    idToken: "SECRET-id-token",
    createdAt: at,
    updatedAt: at,
  });
  await database.insert(learnerSession).values({
    tokenHash: "SECRET-learner-token-hash",
    userId: ada.id,
    organizationId: fernwood.id,
    hostname: "fernwood.localhost",
    expiresAt: later(60 * 24 * 7),
  });
  await database.insert(oauthClient).values({
    id: clientId,
    clientId,
    clientSecret: "SECRET-client-secret",
    name: "Claude",
    redirectUris: ["https://client.fernwood.example/callback"],
  });
  await database.insert(oauthConsent).values({
    id: `${prefix}-consent`,
    clientId,
    userId: ada.id,
    referenceId: fernwood.id,
    scopes: ["braivo:author"],
    createdAt: later(6),
    updatedAt: later(6),
  });
  await database.insert(learnerSignInCode).values({
    hostname: "fernwood.localhost",
    email: ada.email,
    organizationId: fernwood.id,
    codeSeed: "SECRET-code-seed",
    expiresAt: later(10),
    resendAt: later(1),
  });
  await database.insert(verification).values({
    id: `sign-in-otp-${ada.email}`,
    identifier: `sign-in-otp-${ada.email}`,
    value: "SECRET-otp-value",
    expiresAt: later(10),
    createdAt: at,
    updatedAt: at,
  });
  await database.insert(learnerHandoff).values({
    id: `${prefix}-handoff`,
    organizationId: fernwood.id,
    hostname: "fernwood.localhost",
    returnPath: "/",
    nonceHash: "SECRET-nonce-hash",
    userId: ada.id,
    codeHash: "SECRET-handoff-code",
    expiresAt: later(15),
  });
}

describe.skipIf(!connectionString)("learner export", () => {
  let directory: string;

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await clear();
    await seed();
    directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  });

  afterAll(async () => {
    await clear();
    await rm(directory, { recursive: true, force: true });
  });

  async function exported(args: string[]) {
    const out = join(directory, `${crypto.randomUUID()}.json`);
    const result = await run(["learner", "export", ...args, "--out", out]);
    expect(result).toMatchObject({ code: 0, stdout: "" });
    const bytes = await readFile(out, "utf8");
    return { out, bytes, document: JSON.parse(bytes), stderr: result.stderr };
  }

  test("one school's export holds that school's attempts and evidence alone", async () => {
    const { out, bytes, document, stderr } = await exported([
      "--email",
      ` ${ada.email.toUpperCase()} `,
      "--organization",
      fernwood.id,
    ]);

    expect(stderr).toContain(out);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(document).toEqual({
      format: "braivo-learner-export",
      version: 1,
      scope: "organization",
      exportedAt: expect.any(String),
      learner: { name: ada.name, email: ada.email },
      organizations: [
        {
          name: fernwood.name,
          membership: { roles: ["member"], since: at.toISOString() },
          groups: [{ name: "Year 7 French", role: "learner" }],
          attempts: [
            {
              at: later(10).toISOString(),
              task: {
                kind: "choice",
                prompt: `${fernwood.id}: How do you say hello?`,
                options: ["Merci", "Bonjour"],
              },
              response: { choice: 1 },
              outcome: "success",
              reviewedTeaching: false,
              report: null,
            },
            {
              at: later(11).toISOString(),
              task: {
                kind: "typed",
                prompt: `${fernwood.id}: Hello in French`,
                accepted: ["bonjour"],
              },
              response: { text: "bonjour" },
              outcome: "success",
              reviewedTeaching: false,
              report: {
                reason: "key-wrong",
                note: "Bonjour! is right too",
                at: later(50).toISOString(),
                status: "open",
              },
            },
            {
              at: later(12).toISOString(),
              task: {
                kind: "typed",
                prompt: `${fernwood.id}: Hello in French`,
                accepted: ["bonjour"],
              },
              response: { reveal: true },
              outcome: "failure",
              reviewedTeaching: true,
              report: {
                reason: "confusing",
                note: null,
                at: later(50).toISOString(),
                status: "dismissed",
              },
            },
          ],
          evidence: [
            {
              at: later(10).toISOString(),
              objective: `${fernwood.name}: greetings`,
              outcome: "success",
              origin: "attempt",
            },
            {
              at: later(11).toISOString(),
              objective: `${fernwood.name}: greetings`,
              outcome: "success",
              origin: "attempt",
            },
            {
              at: later(12).toISOString(),
              objective: `${fernwood.name}: greetings`,
              outcome: "failure",
              origin: "attempt",
            },
            {
              at: later(40).toISOString(),
              objective: `${fernwood.name}: greetings`,
              outcome: "success",
              origin: "outside",
            },
          ],
        },
      ],
    });
    expect([...new Set(keyPaths(document))].sort()).toEqual([...schoolScopePaths].sort());
    for (const absent of [
      ...secrets,
      birchwood.name,
      cedarwood.name,
      birchwood.id,
      cedarwood.id,
      "fernwood.localhost",
      "Claude",
    ]) {
      expect(bytes).not.toContain(absent);
    }
  });

  test("the account's export holds every school's, a departed one's history included, and the account", async () => {
    const { bytes, document } = await exported(["--email", ada.email, "--account"]);

    expect(document.scope).toBe("account");
    expect(document.organizations.map((each: { name: string }) => each.name)).toEqual([
      birchwood.name,
      cedarwood.name,
      fernwood.name,
    ]);
    const [birch, cedar, fern] = document.organizations;
    expect(birch).toMatchObject({
      membership: { roles: ["member", "author"], since: later(1).toISOString() },
      groups: [],
      // Its task retired after the report's dismissal: the attempt kept, its report closed.
      attempts: [
        {
          response: { text: "salut" },
          outcome: "failure",
          report: {
            reason: "other",
            note: "salut means hello",
            at: later(50).toISOString(),
            status: "closed",
          },
        },
      ],
      evidence: [{ origin: "attempt", outcome: "failure" }],
    });
    // Left Cedarwood: its history is kept, without a membership or groups.
    expect(cedar).toMatchObject({
      membership: null,
      groups: [],
      attempts: [{ response: { choice: 1 }, outcome: "success", report: null }],
      evidence: [{ origin: "attempt" }],
    });
    expect(fern.attempts).toHaveLength(3);
    expect(fern.evidence).toHaveLength(4);
    expect(document.account).toEqual({
      createdAt: at.toISOString(),
      signInProviders: ["google"],
      connectedApps: [
        {
          name: "Claude",
          scopes: ["braivo:author"],
          connectedAt: later(6).toISOString(),
          updatedAt: later(6).toISOString(),
        },
      ],
      sessions: {
        console: [
          { createdAt: later(5).toISOString(), expiresAt: later(60 * 24 * 7).toISOString() },
        ],
        learn: [
          {
            organization: fernwood.name,
            hostname: "fernwood.localhost",
            expiresAt: later(60 * 24 * 7).toISOString(),
          },
        ],
      },
    });
    expect([...new Set(keyPaths(document))].sort()).toEqual([...accountScopePaths].sort());
    for (const absent of secrets) expect(bytes).not.toContain(absent);
  });

  test("refuses a file that exists, leaving it as it was", async () => {
    const out = join(directory, "existing.json");
    await writeFile(out, "kept");

    const result = await run([
      "learner",
      "export",
      "--email",
      ada.email,
      "--account",
      "--out",
      out,
    ]);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("exists");
    expect(await readFile(out, "utf8")).toBe("kept");
  });

  test("refuses a school with no record of the learner, an unknown account, and either scope or both", async () => {
    const out = join(directory, "refused.json");
    const cases = [
      // Ben was never at Birchwood: its export would hand it his name and email.
      ["--email", ben.email, "--organization", birchwood.id],
      ["--email", `${prefix}-nobody@fernwood.example`, "--account"],
      ["--email", ada.email, "--organization", `${prefix}-missing`],
      ["--email", ada.email],
      ["--email", ada.email, "--account", "--organization", fernwood.id],
    ];
    for (const args of cases) {
      const result = await run(["learner", "export", ...args, "--out", out]);
      expect(result).toMatchObject({ code: 1, stdout: "" });
    }
    expect(await stat(out).catch(() => undefined)).toBeUndefined();
    // Five processes in turn: past the default timeout while the whole suite loads the machine.
  }, 30_000);
});
