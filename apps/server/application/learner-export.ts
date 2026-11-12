// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { TaskBody } from "../content/index.ts";
import { readLearnerExport, readOrganizationBySlug } from "../persistence/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
import { readConfirmedUserIdByEmail } from "./unconfirmed-email.ts";

/**
 * A learner's data as one organization holds it, or as the account holds it
 * across every organization, for the operator to hand over
 * (docs/adr/0053-learners-data.md, access-47). Its fields are an allowlist,
 * built here field by field: a column only reaches it by being named. Its
 * format is the deployment guide's, versioned, so a recipient can tell a later
 * one apart.
 */
export type LearnerExport = {
  format: "braivo-learner-export";
  version: 1;
  scope: "organization" | "account";
  exportedAt: string;
  learner: { name: string; email: string };
  organizations: ExportedOrganization[];
  /** The account's scope alone: installation-wide, no school's to hand over. */
  account?: {
    createdAt: string;
    signInProviders: string[];
    connectedApps: {
      name: string | null;
      scopes: string[];
      connectedAt: string | null;
      updatedAt: string | null;
    }[];
    sessions: {
      console: { createdAt: string; expiresAt: string }[];
      /** Learn domains' sessions record no creation time. */
      learn: { organization: string; hostname: string; expiresAt: string }[];
    };
  };
};

type ExportedOrganization = {
  name: string;
  /** `null` once membership has ended, the history kept (ADR 0032). */
  membership: { roles: string[]; since: string } | null;
  groups: { name: string; role: "learner" | "teacher" }[];
  attempts: {
    at: string;
    /**
     * The prompt with a choice task's options, never which is correct, or with
     * a typed task's accepted answers; never the explanation.
     */
    task:
      | { kind: "choice"; prompt: string; options: string[] }
      | { kind: "typed"; prompt: string; accepted: string[] };
    /** Its own type, so a new kind of response joins v1 only by being added here. */
    response: { choice: number } | { text: string } | { reveal: true };
    outcome: "success" | "failure" | null;
    /** Whether the learner's app had shown them the objective's passages since their previous attempt on it (ADR 0054). */
    reviewedTeaching: boolean;
    /**
     * The learner's report of it (ADR 0052): open; dismissed by a reviewer; or
     * closed, its task withdrawn, which says nothing of whether it was right.
     * Its reasons are listed here, so a new one fails the type check until v1
     * is extended to carry it.
     */
    report: {
      reason: "answer-correct" | "key-wrong" | "confusing" | "unsupported" | "other";
      note: string | null;
      at: string;
      status: "open" | "dismissed" | "closed";
    } | null;
  }[];
  evidence: {
    at: string;
    objective: string;
    outcome: "success" | "failure";
    /** Graded from an attempt in Braivo, or recorded from outside it. */
    origin: "attempt" | "outside";
  }[];
};

/**
 * Builds the export, or throws an `Error` whose message the CLI prints: no
 * account has the email, no organization the slug, or, for one organization,
 * the account has no membership or history there, since a school's export of
 * a stranger would hand it their name and email.
 */
export async function exportLearner(input: {
  database: Database;
  email: string;
  scope: { organizationSlug: string } | "account";
  at: Date;
}): Promise<LearnerExport> {
  const { database } = input;
  // As sign-in stores it (access-1): Better Auth lowercases, after trimming here.
  const email = input.email.trim().toLowerCase();
  const slug = input.scope === "account" ? undefined : input.scope.organizationSlug;
  let organizationId: string | undefined;
  if (slug !== undefined) {
    const found = await readOrganizationBySlug(database, slug);
    if (found === undefined) throw new Error(`No organization has the slug ${slug}.`);
    organizationId = found.id;
  }

  // Refused before anything is read: whoever asks may not have made it (ADR 0063).
  await readConfirmedUserIdByEmail(database, email);
  const rows = await readLearnerExport(database, { email, organizationId });
  if (rows === undefined) throw new Error(`No account has the email ${email}.`);
  if (organizationId !== undefined && rows.organizations.length === 0) {
    throw new Error(`${email} has no membership or history at ${slug}.`);
  }

  const exported: LearnerExport = {
    format: "braivo-learner-export",
    version: 1,
    scope: organizationId === undefined ? "account" : "organization",
    exportedAt: input.at.toISOString(),
    learner: { name: rows.user.name, email: rows.user.email },
    organizations: rows.organizations.map(({ id, name }) => {
      const membership = rows.memberships.find((each) => each.organizationId === id);
      return {
        name,
        membership: membership
          ? {
              roles: membership.role.split(",").map((role) => role.trim()),
              since: membership.createdAt.toISOString(),
            }
          : null,
        groups: rows.groups
          .filter((each) => each.organizationId === id)
          .map(({ name, role }) => ({ name, role })),
        attempts: rows.attempts
          .filter((each) => each.organizationId === id)
          .map(({ at, body, response, outcome, reviewedTeaching, taskRetiredAt, report }) => ({
            at: at.toISOString(),
            task: taskContext(body as TaskBody),
            response: exportedResponse(response),
            outcome,
            reviewedTeaching,
            report: report && {
              reason: report.reason,
              note: report.note,
              at: report.at.toISOString(),
              // Retirement wins over a dismissal (ADR 0052).
              status: taskRetiredAt ? "closed" : report.dismissedAt ? "dismissed" : "open",
            },
          })),
        evidence: rows.evidence
          .filter((each) => each.organizationId === id)
          .map(({ id: evidenceId, at, objective, outcome }) => ({
            at: at.toISOString(),
            objective,
            outcome,
            origin: evidenceId.startsWith(ATTEMPT_EVIDENCE_PREFIX) ? "attempt" : "outside",
          })),
      };
    }),
  };

  if (rows.account !== undefined) {
    const { providers, connectedApps, consoleSessions, learnSessions } = rows.account;
    exported.account = {
      createdAt: rows.user.createdAt.toISOString(),
      signInProviders: providers,
      connectedApps: connectedApps.map(({ name, scopes, createdAt, updatedAt }) => ({
        name,
        scopes,
        connectedAt: createdAt?.toISOString() ?? null,
        updatedAt: updatedAt?.toISOString() ?? null,
      })),
      sessions: {
        console: consoleSessions.map(({ createdAt, expiresAt }) => ({
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        })),
        learn: learnSessions.map(({ organization, hostname, expiresAt }) => ({
          organization,
          hostname,
          expiresAt: expiresAt.toISOString(),
        })),
      },
    };
  }
  return exported;
}

type ExportedAttempt = ExportedOrganization["attempts"][number];

/** What the response answered: the prompt and the options or accepted answers. */
function taskContext(body: TaskBody): ExportedAttempt["task"] {
  return body.kind === "choice"
    ? { kind: "choice", prompt: body.prompt, options: body.options }
    : { kind: "typed", prompt: body.prompt, accepted: body.accepted };
}

/**
 * The stored response rebuilt field by field, as the columns are named: a
 * property a later writer adds stays out, and a shape v1 cannot express stops
 * the export rather than being guessed at.
 */
function exportedResponse(value: unknown): ExportedAttempt["response"] {
  const response = (value ?? {}) as Record<string, unknown>;
  if (typeof response.choice === "number") return { choice: response.choice };
  if (typeof response.text === "string") return { text: response.text };
  if (response.reveal === true) return { reveal: true };
  throw new Error("An attempt's response has a shape the export's format does not know.");
}
