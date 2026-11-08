// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import * as schema from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray, is, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { eraseAccount, previewAccountErasure } from "../application/erase-account.ts";
import { directoryStore } from "../storage/index.ts";

// Every table, classified (docs/adr/0053-learners-data.md), so a new table, a
// new column of a person's records, or a new column naming a person elsewhere
// fails here, in its own change, until someone decides whether the export
// (access-47) and erasure must cover it. It cannot see a person named inside
// JSON or free text (a task's body, a source), nor a reference reaching a
// person through a table that is not one of theirs.

/**
 * A column of a person's records: a field of the export ("exported"), one it
 * computes a field from ("derived: …"), an ID or reference it reads by and
 * never writes ("key"), a credential it never writes ("secret"), or why else
 * it stays out.
 */
type Classification = "exported" | `derived: ${string}` | "key" | "secret" | `withheld: ${string}`;

const housekeeping = "withheld: the row's own update time";
const personal = "withheld: personal metadata, never exported, to stop being stored (ADR 0053)";

/** Tables whose rows are a person's records, read by the export: every column. */
const recordTables: Record<string, Record<string, Classification>> = {
  user: {
    id: "key",
    name: "exported",
    email: "exported",
    email_verified: "withheld: Better Auth's flag, set for every account that signs in",
    image: "withheld: not in v1, Google's picture URL",
    created_at: "exported",
    updated_at: housekeeping,
  },
  account: {
    id: "key",
    account_id: "key",
    provider_id: "exported",
    user_id: "key",
    access_token: "secret",
    refresh_token: "secret",
    id_token: "secret",
    access_token_expires_at: "withheld: its secret token's expiry",
    refresh_token_expires_at: "withheld: its secret token's expiry",
    scope: "withheld: what its secret tokens may do",
    password: "secret",
    created_at: "withheld: not in v1, when the provider was linked",
    updated_at: housekeeping,
  },
  attempt: {
    id: "key",
    learner_id: "key",
    organization_id: "key",
    task_id: "key",
    response: "exported",
    at: "exported",
    reviewed_teaching: "exported",
  },
  group_member: { organization_id: "key", group_id: "key", user_id: "key", role: "exported" },
  learner_evidence: {
    id: "derived: whether an attempt or an outside result recorded it",
    learner_id: "key",
    organization_id: "key",
    objective_id: "key",
    outcome: "exported",
    at: "exported",
  },
  learner_history_state: {
    learner_id: "key",
    organization_id: "key",
    epoch: "withheld: the erasure's fence, the operator's bookkeeping, not in v1",
    erased_at: "withheld: when an erasure ran, the operator's register's, not in v1",
  },
  learner_session: {
    token_hash: "secret",
    user_id: "key",
    organization_id: "key",
    hostname: "exported",
    expires_at: "exported",
  },
  member: {
    id: "key",
    organization_id: "key",
    user_id: "key",
    role: "exported",
    created_at: "exported",
  },
  oauth_consent: {
    id: "key",
    client_id: "key",
    user_id: "key",
    reference_id: "withheld: not in v1, the organization it reaches",
    resources: "withheld: this server's own URL",
    requested_user_info_claims: "withheld: what the app asked of the profile, not granted scopes",
    scopes: "exported",
    created_at: "exported",
    updated_at: "exported",
  },
  session: {
    id: "key",
    token: "secret",
    ip_address: personal,
    user_agent: personal,
    user_id: "key",
    active_organization_id: "withheld: the console's last chosen organization, its state",
    created_at: "exported",
    expires_at: "exported",
    updated_at: housekeeping,
  },
  task_report: {
    learner_id: "key",
    organization_id: "key",
    attempt_id: "key",
    id: "key",
    task_id: "key",
    reason: "exported",
    note: "exported",
    created_at: "exported",
    dismissed_at: "derived: the report's status",
    dismissed_by: "withheld: the reviewer, another person",
  },
};

/**
 * Every other table: exactly the columns naming a person, and why none of it
 * is in the export, or what the export reads of it.
 */
const otherTables: Record<string, { naming: string[]; why: string }> = {
  account_erasure: { naming: [], why: "a random ID, naming no one without the replay log" },
  ai_request: {
    naming: ["user_id"],
    why: "not in v1: an author's AI usage, counts and no content",
  },
  course: { naming: [], why: "content" },
  course_objective: { naming: [], why: "content" },
  device_code: { naming: ["user_id"], why: "a sign-in grant's secret, minutes-lived" },
  file: { naming: [], why: "an uploaded file, content" },
  group: { naming: [], why: "the export reads its name" },
  group_course: { naming: [], why: "content" },
  invitation: {
    naming: ["email", "inviter_id"],
    why: "not in v1: an invitation to an email, the school's",
  },
  invitation_mail_claim: {
    naming: ["email"],
    why: "not in v1: a mail bound's count of sends to an email, over 24 hours; older rows pruned by later claims",
  },
  jwks: { naming: [], why: "the server's signing keys" },
  learner_handoff: { naming: ["user_id"], why: "a sign-in handoff's secret, minutes-lived" },
  learner_sign_in_code: { naming: ["email"], why: "a sign-in code's secret, minutes-lived" },
  oauth_access_token: { naming: ["session_id", "user_id"], why: "a connection's secret" },
  oauth_client: {
    naming: ["user_id"],
    why: "the export reads its name for a connection; who registered it is not the learner's",
  },
  oauth_client_assertion: { naming: [], why: "a client's replay guard" },
  oauth_client_resource: { naming: [], why: "an app's registration" },
  oauth_refresh_token: { naming: ["session_id", "user_id"], why: "a connection's secret" },
  oauth_resource: { naming: ["identifier"], why: "its identifier is a URL, naming no person" },
  objective: { naming: [], why: "the export reads its title" },
  objective_citation: { naming: [], why: "content" },
  organization: {
    naming: ["personal_owner_id", "tools_read_learner_data_changed_by"],
    why: "the export reads its name; who last changed a setting is the school's record, and whose personal organization it is, its own (ADR 0060)",
  },
  organization_domain: { naming: [], why: "a school's domain" },
  organization_domain_claim: { naming: [], why: "a school's domain" },
  source: { naming: [], why: "content" },
  task: { naming: [], why: "the export reads its prompt and options or accepted answers" },
  task_citation: { naming: [], why: "content" },
  verification: { naming: ["identifier"], why: "one-time sign-in values keyed by email, secrets" },
};

const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

/**
 * The columns naming a person: a reference to `user` or to one of a person's
 * records, or a name only such a column would have.
 */
function namingColumns(table: PgTable): string[] {
  const { columns, foreignKeys } = getTableConfig(table);
  const references = new Set(
    foreignKeys.flatMap((key) => {
      const reference = key.reference();
      const target = getTableConfig(reference.foreignTable).name;
      return target === "user" || target in recordTables
        ? reference.columns.map((column) => column.name)
        : [];
    }),
  );
  return columns
    .map((column) => column.name)
    .filter(
      (name) =>
        references.has(name) || /^(learner_id|user_id|email|identifier)$|_(by|email)$/.test(name),
    );
}

describe("learner data's inventory", () => {
  test("classifies every table, so a new one is classified before it ships", () => {
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual(
      [...Object.keys(recordTables), ...Object.keys(otherTables)].sort(),
    );
  });

  test("classifies every column of a person's records", () => {
    for (const table of tables) {
      const { name, columns } = getTableConfig(table);
      const classified = recordTables[name];
      if (classified === undefined) continue;
      expect([name, columns.map((column) => column.name).sort()]).toEqual([
        name,
        Object.keys(classified).sort(),
      ]);
    }
  });

  test("lists exactly the columns naming a person in every other table", () => {
    for (const table of tables) {
      const { name } = getTableConfig(table);
      const listed = otherTables[name];
      if (listed === undefined) continue;
      expect([name, namingColumns(table).sort()]).toEqual([name, [...listed.naming].sort()]);
    }
  });
});

// Erasure's side (access-49): how each column naming a person is emptied, and a
// row found by it. A foreign key's action is read from the schema, so one
// changed fails here; identifier formats and JSON, which no name reveals, are
// listed as entries of their own and seeded in the form they are stored in.

/** The two people seeded, so a delete missing its predicate takes the other's. */
type Person = { id: string; email: string };

type Erasure = {
  /** A foreign key's action, the row itself, or a delete by a predicate. */
  how: "cascade" | "set null" | "deleted" | "explicit" | "names no one";
  find: (person: Person) => SQL | undefined;
};

const {
  account,
  aiRequest,
  attempt,
  deviceCode,
  group,
  groupMember,
  invitation,
  invitationMailClaim,
  learnerEvidence,
  learnerHandoff,
  learnerHistoryState,
  learnerSession,
  learnerSignInCode,
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  objective,
  organization,
  session,
  taskReport,
  user,
  verification,
} = schema;

const inValue = (text: string) => sql`strpos(${verification.value}, ${text}) > 0`;

const erasures: Record<string, Erasure> = {
  "user.id": { how: "deleted", find: ({ id }) => eq(user.id, id) },
  "user.email": { how: "deleted", find: ({ email }) => eq(user.email, email) },
  "session.user_id": { how: "cascade", find: ({ id }) => eq(session.userId, id) },
  "account.user_id": { how: "cascade", find: ({ id }) => eq(account.userId, id) },
  "attempt.learner_id": { how: "cascade", find: ({ id }) => eq(attempt.learnerId, id) },
  "learner_evidence.learner_id": {
    how: "cascade",
    find: ({ id }) => eq(learnerEvidence.learnerId, id),
  },
  "learner_history_state.learner_id": {
    how: "cascade",
    find: ({ id }) => eq(learnerHistoryState.learnerId, id),
  },
  "learner_session.user_id": { how: "cascade", find: ({ id }) => eq(learnerSession.userId, id) },
  "learner_handoff.user_id": { how: "cascade", find: ({ id }) => eq(learnerHandoff.userId, id) },
  "member.user_id": { how: "cascade", find: ({ id }) => eq(member.userId, id) },
  // By its membership, a composite key.
  "group_member.user_id": { how: "cascade", find: ({ id }) => eq(groupMember.userId, id) },
  // By its attempt, a composite key.
  "task_report.learner_id": { how: "cascade", find: ({ id }) => eq(taskReport.learnerId, id) },
  "task_report.dismissed_by": { how: "set null", find: ({ id }) => eq(taskReport.dismissedBy, id) },
  "oauth_consent.user_id": { how: "cascade", find: ({ id }) => eq(oauthConsent.userId, id) },
  "oauth_access_token.user_id": {
    how: "cascade",
    find: ({ id }) => eq(oauthAccessToken.userId, id),
  },
  "oauth_refresh_token.user_id": {
    how: "cascade",
    find: ({ id }) => eq(oauthRefreshToken.userId, id),
  },
  "oauth_client.user_id": { how: "cascade", find: ({ id }) => eq(oauthClient.userId, id) },
  "device_code.user_id": { how: "cascade", find: ({ id }) => eq(deviceCode.userId, id) },
  "invitation.inviter_id": { how: "cascade", find: ({ id }) => eq(invitation.inviterId, id) },
  "ai_request.user_id": { how: "set null", find: ({ id }) => eq(aiRequest.userId, id) },
  "organization.tools_read_learner_data_changed_by": {
    how: "set null",
    find: ({ id }) => eq(organization.toolsReadLearnerDataChangedBy, id),
  },
  // Deleted with all it holds, before the account, which it restricts (ADR 0060).
  "organization.personal_owner_id": {
    how: "explicit",
    find: ({ id }) => eq(organization.personalOwnerId, id),
  },
  "invitation.email": { how: "explicit", find: ({ email }) => eq(invitation.email, email) },
  "invitation_mail_claim.email": {
    how: "explicit",
    find: ({ email }) => eq(invitationMailClaim.email, email),
  },
  "learner_sign_in_code.email": {
    how: "explicit",
    find: ({ email }) => eq(learnerSignInCode.email, email),
  },
  "oauth_resource.identifier": { how: "names no one", find: () => undefined },
  // Every format of `verification` that names someone.
  "verification.identifier": {
    how: "explicit",
    find: ({ id, email }) =>
      or(
        ...["sign-in", "email-verification", "forget-password"].map((type) =>
          eq(verification.identifier, `${type}-otp-${email}`),
        ),
        eq(verification.identifier, `sign-in-code-sent:${email}`),
        eq(verification.identifier, `change-email-otp-${id}:new-${email}`),
      ),
  },
  "verification.value": {
    how: "explicit",
    find: ({ id, email }) => or(inValue(id), inValue(email), inValue(encodeURIComponent(email))),
  },
};

/** Every `verification` row naming `person`, in the form Better Auth stores it. */
function verificationRows({ id, email }: Person) {
  const hint = new URLSearchParams({ client_id: "app", login_hint: email }).toString();
  const rows: [identifier: string, value: string][] = [
    [`sign-in-otp-${email}`, "encrypted:0"],
    [`email-verification-otp-${email}`, "encrypted:0"],
    [`forget-password-otp-${email}`, "encrypted:0"],
    [`sign-in-code-sent:${email}`, ""],
    [`change-email-otp-${id}:new-${email}`, "encrypted:0"],
    // A password reset's token, whose value is the account.
    [`reset-password:token-${id}`, id],
    // Google's state, while linking.
    [`state-link-${id}`, JSON.stringify({ oauthState: "s", link: { email, userId: id } })],
    // Google's state, signing in on the way through an OAuth client's request.
    [`state-hint-${id}`, JSON.stringify({ oauthState: "s", serverContext: { query: hint } })],
    // An OAuth authorization code.
    [
      `code-${id}`,
      JSON.stringify({ type: "authorization_code", query: {}, userId: id, sessionId: "s" }),
    ],
  ];
  const at = new Date();
  return rows.map(([identifier, value]) => ({
    id: identifier,
    identifier,
    value,
    expiresAt: new Date(at.getTime() + 600_000),
    createdAt: at,
    updatedAt: at,
  }));
}

const prefix = "erasure-inventory-test";
const organizations = [`${prefix}-fernwood`, `${prefix}-birchwood`];
const ada: Person = { id: `${prefix}-ada`, email: `${prefix}-ada+pupil@fernwood.example` };
const ben: Person = { id: `${prefix}-ben`, email: `${prefix}-ben@fernwood.example` };
const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

/** The columns naming a person directly: no reference through their records. */
function personColumns(table: PgTable): string[] {
  const { columns, foreignKeys } = getTableConfig(table);
  const toUser = foreignKeys.flatMap((key) => {
    const reference = key.reference();
    return getTableConfig(reference.foreignTable).name === "user"
      ? reference.columns.map((column) => column.name)
      : [];
  });
  return columns
    .map((column) => column.name)
    .filter(
      (name) =>
        toUser.includes(name) || /^(learner_id|user_id|email|identifier)$|_(by|email)$/.test(name),
    );
}

/** How many rows anywhere name `person`, column by column of the catalog. */
async function scanCatalog({ id, email }: Person): Promise<string[]> {
  const { rows: columns } = await database.execute<{ table_name: string; column_name: string }>(sql`
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t using (table_schema, table_name)
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and (c.data_type in ('text', 'character varying', 'json', 'jsonb', 'ARRAY'))
  `);
  const found: string[] = [];
  const texts = [id, email, encodeURIComponent(email)];
  for (const { table_name: table, column_name: column } of columns) {
    const where = sql.join(
      texts.map((text) => sql`strpos(${sql.identifier(column)}::text, ${text}) > 0`),
      sql` or `,
    );
    const { rows } = await database.execute<{ count: string }>(
      sql`select count(*) from ${sql.identifier(table)} where ${where}`,
    );
    if (Number(rows[0]?.count) > 0) found.push(`${table}.${column}`);
  }
  return found;
}

async function seedPerson(person: Person, organizationId: string, other: Person) {
  const { id, email } = person;
  const at = new Date("2026-09-01T08:00:00.000Z");
  const later = new Date(Date.now() + 600_000);
  const tag = `${id}-${organizationId}`;
  // On rows that outlive the person: nothing but their references may name them.
  const neutral = crypto.randomUUID();

  const [objectiveRow] = await database
    .select({ id: objective.id })
    .from(objective)
    .where(and(eq(objective.organizationId, organizationId), eq(objective.title, "Greetings")));
  const objectiveId = objectiveRow?.id ?? `${organizationId}-objective`;
  await database
    .insert(objective)
    .values({ id: objectiveId, organizationId, title: "Greetings" })
    .onConflictDoNothing();
  const taskId = await testing.createTask(database, {
    organizationId,
    objectiveId,
    body: { kind: "choice", prompt: `Hello ${neutral}?`, options: ["Yes", "No"], answer: 0 },
    createdAt: at,
  });
  // The same attempt and evidence IDs for both people, at both schools.
  await database.insert(attempt).values({
    id: "a1",
    learnerId: id,
    organizationId,
    taskId,
    response: { choice: 0 },
    at,
  });
  await database
    .insert(learnerEvidence)
    .values({ id: "e1", learnerId: id, organizationId, objectiveId, outcome: "success", at });
  await database.insert(taskReport).values({
    id: `report-${tag}`,
    learnerId: id,
    organizationId,
    attemptId: "a1",
    taskId,
    reason: "confusing",
    createdAt: at,
    // Dismissed by the other: a report of theirs that outlives this reviewer.
    dismissedAt: at,
    dismissedBy: other.id,
  });
  await database
    .insert(learnerHistoryState)
    .values({ learnerId: id, organizationId, epoch: 1, erasedAt: at });
  await database.insert(learnerSession).values({
    tokenHash: `hash-${tag}`,
    userId: id,
    organizationId,
    hostname: `${organizationId}.example`,
    expiresAt: later,
  });
  await database.insert(learnerHandoff).values({
    id: `handoff-${tag}`,
    organizationId,
    hostname: `${organizationId}.example`,
    returnPath: "/",
    nonceHash: `nonce-${tag}`,
    userId: id,
    expiresAt: later,
  });
  await database.insert(learnerSignInCode).values({
    hostname: `${organizationId}.example`,
    email,
    organizationId,
    codeSeed: "seed",
    expiresAt: later,
    resendAt: later,
  });
  const groupId = `group-${neutral}`;
  await database
    .insert(group)
    .values({ id: groupId, organizationId, name: groupId, creationDigest: groupId });
  await database
    .insert(groupMember)
    .values({ organizationId, groupId, userId: id, role: "learner" });
  await database.insert(invitationMailClaim).values({ email, organizationId, claimedAt: at });
  await database.insert(invitation).values([
    {
      id: `to-${tag}`,
      organizationId,
      // As sent, in another case: Better Auth keeps it so.
      email: email.toUpperCase(),
      expiresAt: later,
      createdAt: at,
      inviterId: other.id,
    },
    {
      id: `to-lower-${tag}`,
      organizationId,
      email,
      expiresAt: later,
      createdAt: at,
      inviterId: other.id,
    },
    {
      id: `from-${tag}`,
      organizationId,
      email: `${prefix}-invited-by-${id}@fernwood.example`,
      expiresAt: later,
      createdAt: at,
      inviterId: id,
    },
  ]);
  await database
    .insert(aiRequest)
    .values({ id: `ai-${neutral}`, organizationId, kind: "draft", userId: id, createdAt: at });
}

async function seedAccount(person: Person) {
  const { id } = person;
  const at = new Date("2026-09-01T08:00:00.000Z");
  const later = new Date(Date.now() + 600_000);
  await database.insert(session).values({
    id: `session-${id}`,
    token: `token-${id}`,
    userId: id,
    expiresAt: later,
    createdAt: at,
    updatedAt: at,
    activeOrganizationId: organizations[0],
  });
  await database.insert(account).values({
    id: `account-${id}`,
    accountId: id,
    providerId: "credential",
    userId: id,
    createdAt: at,
    updatedAt: at,
  });
  const clientId = `client-${id}`;
  await database
    .insert(oauthClient)
    .values({ id: clientId, clientId, userId: id, redirectUris: ["https://app.example/cb"] });
  await database.insert(oauthConsent).values({
    id: `consent-${id}`,
    clientId,
    userId: id,
    referenceId: organizations[0],
    scopes: ["braivo:author"],
    createdAt: at,
    updatedAt: at,
  });
  await database.insert(oauthRefreshToken).values({
    id: `refresh-${id}`,
    token: `refresh-token-${id}`,
    clientId,
    userId: id,
    sessionId: `session-${id}`,
    scopes: ["braivo:author"],
  });
  await database.insert(oauthAccessToken).values({
    id: `access-${id}`,
    token: `access-token-${id}`,
    clientId,
    userId: id,
    sessionId: `session-${id}`,
    refreshId: `refresh-${id}`,
    scopes: ["braivo:author"],
  });
  await database.insert(deviceCode).values({
    id: `device-${id}`,
    deviceCode: `device-code-${id}`,
    userCode: `user-code-${id}`,
    userId: id,
    expiresAt: later,
    status: "approved",
  });
  await database.insert(verification).values(verificationRows(person));
}

async function clear() {
  await database
    .delete(verification)
    .where(
      or(
        ...[ada, ben].flatMap(({ id, email }) => [
          inValue(id),
          inValue(email),
          inValue(encodeURIComponent(email)),
          sql`strpos(${verification.identifier}, ${email}) > 0`,
          sql`strpos(${verification.identifier}, ${id}) > 0`,
        ]),
      ),
    );
  // Each one's personal organization first, which restricts deleting them.
  for (const { id } of [ada, ben]) {
    const [own] = await database
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.personalOwnerId, id));
    if (own) await testing.clearLearningData(database, own.id);
  }
  await database
    .delete(organization)
    .where(inArray(organization.personalOwnerId, [ada.id, ben.id]));
  await database.delete(user).where(inArray(user.id, [ada.id, ben.id]));
  await database.delete(aiRequest).where(inArray(aiRequest.organizationId, organizations));
  await database
    .delete(learnerSignInCode)
    .where(inArray(learnerSignInCode.organizationId, organizations));
  await database.delete(invitation).where(inArray(invitation.organizationId, organizations));
  await database
    .delete(invitationMailClaim)
    .where(inArray(invitationMailClaim.email, [ada.email, ben.email]));
  for (const id of organizations) await testing.clearLearningData(database, id);
  await database.delete(organization).where(inArray(organization.id, organizations));
}

const tableOf = (name: string) =>
  tables.find((table) => getTableConfig(table).name === name) as PgTable;

async function counted(person: Person): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const [entry, { find }] of Object.entries(erasures)) {
    const where = find(person);
    if (where === undefined) continue;
    found[entry] = await database.$count(tableOf(entry.split(".")[0]!), where);
  }
  return found;
}

describe("an account's erasure, against the inventory", () => {
  test("says how every column naming a person is emptied", () => {
    const listed = Object.keys(erasures);
    for (const table of tables) {
      const { name } = getTableConfig(table);
      for (const column of personColumns(table)) expect(listed).toContain(`${name}.${column}`);
    }
  });

  test("a foreign key's action is what the inventory says", () => {
    for (const [entry, { how }] of Object.entries(erasures)) {
      if (how !== "cascade" && how !== "set null") continue;
      const [name, column] = entry.split(".") as [string, string];
      const { foreignKeys } = getTableConfig(tableOf(name));
      // Directly to `user`, or through the person's own record whose key holds it.
      const key = foreignKeys.find((candidate) =>
        candidate.reference().columns.some((referenced) => referenced.name === column),
      );
      expect([entry, key?.onDelete]).toEqual([entry, how]);
    }
  });

  describe.skipIf(!connectionString)("seeded, then erased", () => {
    beforeAll(async () => {
      await runMigrations(connectionString ?? "");
    });

    beforeEach(async () => {
      await clear();
      const at = new Date("2026-09-01T08:00:00.000Z");
      for (const organizationId of organizations) {
        await testing.seedOrganization(database, {
          organizationId,
          learnerIds: [],
          at,
        });
      }
      await database.insert(user).values(
        [ada, ben].map((person) => ({
          ...person,
          name: person.id,
          emailVerified: true,
          createdAt: at,
          updatedAt: at,
        })),
      );
      for (const organizationId of organizations) {
        await database.insert(member).values(
          [ada, ben].map(({ id }) => ({
            id: `${organizationId}:${id}`,
            organizationId,
            userId: id,
            role: "member",
            createdAt: at,
          })),
        );
        await seedPerson(ada, organizationId, ben);
        await seedPerson(ben, organizationId, ada);
      }
      await seedAccount(ada);
      await seedAccount(ben);
      // Each one's own, erased with them alone (ADR 0060).
      for (const { id } of [ada, ben]) {
        await database.insert(organization).values({
          id: `${id}-own`,
          name: id,
          slug: `${id}-own`,
          personalOwnerId: id,
          createdAt: at,
        });
        await database.insert(member).values({
          id: `${id}-own:${id}`,
          organizationId: `${id}-own`,
          userId: id,
          role: "owner",
          createdAt: at,
        });
      }
      await database
        .update(organization)
        .set({ toolsReadLearnerDataChangedBy: ada.id })
        .where(eq(organization.id, organizations[0]!));
      await database
        .update(organization)
        .set({ toolsReadLearnerDataChangedBy: ben.id })
        .where(eq(organization.id, organizations[1]!));
    });

    const erase = async () => {
      const { target } = await previewAccountErasure({ database, email: ada.email });
      const log = {
        hmacKey: "erasure-log-test-key-that-is-long-enough",
        store: { put: async () => {} },
      };
      // Their personal organization's files are the store's to delete (ADR 0060).
      const files = directoryStore(await mkdtemp(join(tmpdir(), "inventory-files-")));
      return eraseAccount({ database, target, log, files });
    };

    test("each predicate finds a row first, none after, and the other person's stay", async () => {
      const before = await counted(ada);
      const untouched = await counted(ben);
      // Seeded: a predicate finding nothing here would prove nothing below.
      for (const [entry, rows] of Object.entries(before)) {
        expect([entry, rows > 0]).toEqual([entry, true]);
      }

      // What the operator confirms: every kind, seeded here, is counted, and reported the same.
      const { counts } = await previewAccountErasure({ database, email: ada.email });
      expect(Object.entries(counts).filter(([, rows]) => rows === 0)).toEqual([]);
      const { removed } = await erase();
      expect(removed).toEqual(counts);

      const after = await counted(ada);
      expect(Object.entries(after).filter(([, rows]) => rows > 0)).toEqual([]);
      const kept = await counted(ben);
      // What the two share went with Ada: invitations between them, and Ada's
      // reports, which Ben dismissed.
      const shared = ["invitation.email", "invitation.inviter_id", "task_report.dismissed_by"];
      const without = (found: Record<string, number>) =>
        Object.fromEntries(Object.entries(found).filter(([entry]) => !shared.includes(entry)));
      expect(without(kept)).toEqual(without(untouched));
    });

    test("no column anywhere still names them, and the catalog scan sees the other person", async () => {
      expect(await scanCatalog(ada)).not.toEqual([]);
      await erase();
      expect(await scanCatalog(ada)).toEqual([]);
      expect(await scanCatalog(ben)).toContain("user.email");
    });

    test("AI usage counts are kept, with no user", async () => {
      const where = inArray(aiRequest.organizationId, organizations);
      const before = await database.$count(aiRequest, where);
      await erase();
      expect(await database.$count(aiRequest, where)).toBe(before);
      const { rows } = await database.execute<{ count: string }>(
        sql`select count(*) from ${aiRequest} where ${where} and ${aiRequest.userId} is null`,
      );
      expect(Number(rows[0]?.count)).toBe(before / 2);
    });

    test("a report of another's that they dismissed stays, its time kept, the reviewer gone", async () => {
      await erase();
      const [report] = await database
        .select({ at: taskReport.dismissedAt, by: taskReport.dismissedBy })
        .from(taskReport)
        .where(
          and(eq(taskReport.learnerId, ben.id), eq(taskReport.organizationId, organizations[0]!)),
        );
      expect(report?.at).toBeInstanceOf(Date);
      expect(report?.by).toBeNull();
    });
  });
});
