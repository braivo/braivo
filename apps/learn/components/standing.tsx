// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LearnerProgressStanding, LearnerProgressSummary } from "@braivo/server/client";
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

/** `standings` counted by label, in the summary's order, those with none left out: ["2 retained", "1 learning"]. */
export function formatStandingCounts(
  standings: LearnerProgressStanding[],
  t: ReturnType<typeof useLingui>["t"],
) {
  const labels = standings.map(labelOf);
  return (Object.keys(PROGRESS_LABELS) as ProgressLabel[])
    .map((label) => [label, labels.filter((each) => each === label).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => t(PROGRESS_LABELS[label].counted(count)));
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

/** Beside an objective's title, for one a session just brought to retained. */
const NEWLY_RETAINED = msg({
  message: "newly retained",
  comment: "After an objective's title: a form fitting any",
});

/**
 * Where the learner stands (progress-8): a meter, each standing a segment in
 * proportion to its objectives, over its counts, which open into each objective
 * by title, those in `newlyRetained` (IDs) said so. Nothing for a report with
 * no objectives.
 */
export function StandingMeter({
  report,
  newlyRetained,
}: {
  report: LearnerProgressSummary;
  newlyRetained?: ReadonlySet<string>;
}) {
  const { t } = useLingui();
  const counts = formatStandingCounts(report.objectives, t);
  if (counts.length === 0) return null;
  // Each count whole where it fits, so a phone wraps between counts, not at "1 not" / "started".
  const line = counts.map((count) => count.replaceAll(" ", " ")).join(" · ");
  const total = report.objectives.length;

  return (
    <div className="flex w-full flex-col gap-2 text-left text-sm">
      <span aria-hidden="true" className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {(Object.keys(PROGRESS_LABELS) as ProgressLabel[]).map((label) => {
          const count = report.objectives.filter((each) => labelOf(each) === label).length;
          return count > 0 ? (
            <span
              key={label}
              className={METER_FILLS[label]}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ) : null;
        })}
      </span>
      <details className="wrap-break-word text-muted-foreground">
        {/* Padded to a touch target, keeping the browser's marker, which flex would drop. */}
        <summary className="cursor-pointer py-3">{line}</summary>
        <ul className="flex flex-col gap-1">
          {report.objectives.map((standing) => (
            <li key={standing.objectiveId}>
              {standing.title}:{" "}
              {t(
                newlyRetained?.has(standing.objectiveId)
                  ? NEWLY_RETAINED
                  : PROGRESS_LABELS[labelOf(standing)].alone,
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
