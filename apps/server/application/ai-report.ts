// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { DraftCounts } from "../ai/index.ts";
import { readAiRequests, readOrganizationBySlug } from "../persistence/index.ts";

/**
 * The AI requests of one kind, model, and prompt version, and how they went:
 * the operator's view of the ledger, numbers only. `model` and
 * `promptVersion` are null for requests recorded before the ledger kept them.
 */
export type AiReportRow = {
  kind: string;
  model: string | null;
  promptVersion: string | null;
  requests: number;
  succeeded: number;
  /** By failure kind. */
  failed: Record<string, number>;
  aborted: number;
  /** Never completed: under way, or its process ended first. */
  unknown: number;
  /** Over succeeded drafts: what was proposed and what was kept. */
  draftCounts?: Pick<DraftCounts, "proposed" | "kept">;
  /** Over succeeded drafts, the most frequent first. */
  refusals: [code: string, count: number][];
};

/**
 * The ledger from `since`, for the organization `organizationSlug` names or
 * every organization, a row per kind, model, and prompt version.
 */
export async function readAiReport(input: {
  database: Database;
  since: Date;
  organizationSlug?: string;
}): Promise<AiReportRow[]> {
  const { database, since, organizationSlug } = input;
  let organizationId: string | undefined;
  if (organizationSlug !== undefined) {
    const organization = await readOrganizationBySlug(database, organizationSlug);
    if (!organization) throw new Error(`No organization has the slug ${organizationSlug}.`);
    organizationId = organization.id;
  }

  const rows = new Map<string, AiReportRow>();
  for (const request of await readAiRequests(database, { since, organizationId })) {
    const key = JSON.stringify([request.kind, request.model, request.promptVersion]);
    let row = rows.get(key);
    if (!row) {
      row = {
        kind: request.kind,
        model: request.model,
        promptVersion: request.promptVersion,
        requests: 0,
        succeeded: 0,
        failed: {},
        aborted: 0,
        unknown: 0,
        refusals: [],
      };
      rows.set(key, row);
    }
    row.requests += 1;
    if (request.outcome === "failed") {
      const failure = request.failure ?? "unknown";
      row.failed[failure] = (row.failed[failure] ?? 0) + 1;
    } else if (request.outcome === "succeeded" || request.outcome === "aborted") {
      row[request.outcome] += 1;
    } else {
      row.unknown += 1;
    }
    if (request.outcome === "succeeded" && request.kind === "draft" && request.counts) {
      addDraftCounts(row, request.counts as DraftCounts);
    }
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      refusals: row.refusals.sort(([a, x], [b, y]) => y - x || a.localeCompare(b)),
    }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        // Recorded before the ledger kept them, last.
        Number(a.model === null) - Number(b.model === null) ||
        (a.model ?? "").localeCompare(b.model ?? "") ||
        (a.promptVersion ?? "").localeCompare(b.promptVersion ?? ""),
    );
}

function addDraftCounts(row: AiReportRow, counts: DraftCounts): void {
  const draftCounts = (row.draftCounts ??= {
    proposed: { objectives: 0, tasks: 0 },
    kept: { objectives: 0, tasks: 0 },
  });
  for (const side of ["proposed", "kept"] as const) {
    draftCounts[side].objectives += counts[side].objectives;
    draftCounts[side].tasks += counts[side].tasks;
  }
  for (const [code, count] of Object.entries(counts.refusals)) {
    const known = row.refusals.find(([seen]) => seen === code);
    if (known) known[1] += count ?? 0;
    else row.refusals.push([code, count ?? 0]);
  }
}
