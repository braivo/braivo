// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CourseStanding,
  LearnerProgressStanding,
  LearnerProgressSummary,
} from "@braivo/server/client";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/**
 * In the summary's order, each alone, beside an objective's title, and
 * counted: a count's words agree with it, in three forms in Polish.
 */
const PROGRESS_LABELS = {
  retained: {
    alone: msg({ message: "retained", comment: "After an objective's title: a form fitting any" }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# retained", other: "# retained" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  dueForReview: {
    alone: msg({
      message: "due for review",
      comment: "After an objective's title: a form fitting any",
    }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# due for review", other: "# due for review" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  learning: {
    alone: msg({ message: "learning", comment: "After an objective's title: a form fitting any" }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# learning", other: "# learning" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  notStarted: {
    alone: msg({
      message: "not started",
      comment: "After an objective's title: a form fitting any",
    }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# not started", other: "# not started" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
};
type ProgressLabel = keyof typeof PROGRESS_LABELS;

/**
 * The model's phases, with `due` splitting retaining, so the summary claims no
 * more than the model does: "retained", not "mastered", which Braivo does not define.
 */
export function labelOf(standing: LearnerProgressStanding): ProgressLabel {
  if (standing.phase === "unseen") return "notStarted";
  if (standing.phase === "acquiring") return "learning";
  return standing.due ? "dueForReview" : "retained";
}

/** `standings` counted by label: as Braivo counts a course in a list (`CourseStanding`). */
export function countStandings(standings: LearnerProgressStanding[]): CourseStanding {
  const counts: CourseStanding = { retained: 0, dueForReview: 0, learning: 0, notStarted: 0 };
  for (const standing of standings) counts[labelOf(standing)]++;
  return counts;
}

/** `counts` in words, in the summary's order, those with none left out: ["2 retained", "1 learning"]. */
export function formatCounts(counts: CourseStanding, t: ReturnType<typeof useLingui>["t"]) {
  return (Object.keys(PROGRESS_LABELS) as ProgressLabel[])
    .filter((label) => counts[label] > 0)
    .map((label) => t(PROGRESS_LABELS[label].counted(counts[label])));
}

/** `standings` counted by label, in words: `formatCounts` of `countStandings`. */
export function formatStandingCounts(
  standings: LearnerProgressStanding[],
  t: ReturnType<typeof useLingui>["t"],
) {
  return formatCounts(countStandings(standings), t);
}

/**
 * Counts as one line, each count whole where it fits, so a phone wraps between
 * counts, not at "1 not" / "started": "2 retained · 1 learning".
 */
export function countsLine(counts: CourseStanding, t: ReturnType<typeof useLingui>["t"]): string {
  return formatCounts(counts, t)
    .map((count) => count.replaceAll(" ", "\u00a0"))
    .join(" · ");
}

/**
 * A segment's fill by standing, strongest for retained; not started is the
 * track. The brand's primary, so an organization's theme carries it (ADR 0011);
 * decoration only, the counts said in words.
 */
const METER_FILLS: Record<ProgressLabel, string> = {
  retained: "bg-primary",
  dueForReview: "bg-primary/60",
  learning: "bg-primary/30",
  notStarted: "",
};

/**
 * The meter: each standing a segment in proportion to its objectives. Hidden
 * from assistive technology: its caller says the counts in words.
 */
export function StandingBar({ counts }: { counts: CourseStanding }) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return (
    <span aria-hidden="true" className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
      {(Object.keys(PROGRESS_LABELS) as ProgressLabel[]).map((label) =>
        counts[label] > 0 ? (
          <span
            key={label}
            className={METER_FILLS[label]}
            style={{ width: `${(counts[label] / total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

/**
 * Where the learner stands (progress-8): a meter, each standing a segment in
 * proportion to its objectives, over its counts, which open into each objective
 * by title. Nothing for a report with no objectives.
 */
export function StandingMeter({ report }: { report: LearnerProgressSummary }) {
  const { t } = useLingui();
  if (report.objectives.length === 0) return null;
  const counts = countStandings(report.objectives);
  const line = countsLine(counts, t);

  return (
    <div className="flex w-full flex-col gap-2 text-left text-sm">
      <StandingBar counts={counts} />
      <details className="wrap-break-word text-muted-foreground">
        {/* Padded to a touch target, keeping the browser's marker, which flex would drop. */}
        <summary className="cursor-pointer py-3">{line}</summary>
        <ul className="flex flex-col gap-1">
          {report.objectives.map((standing) => (
            <li key={standing.objectiveId}>
              {standing.title}: {t(PROGRESS_LABELS[labelOf(standing)].alone)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
