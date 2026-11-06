// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import * as schema from "@braivo/db/schema";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vite-plus/test";

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
    naming: ["tools_read_learner_data_changed_by"],
    why: "the export reads its name; who last changed a setting is the school's record",
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
