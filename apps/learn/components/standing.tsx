// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type CourseStanding,
  countStandings,
  type LearnerProgressSummary,
  type Standing,
  standingOf,
} from "@braivo/server/client";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/**
 * Each standing (`standingOf`) in words, in the summary's order: alone, beside
 * an objective's title, and counted, a count's words agreeing with it, in
 * three forms in Polish. Typed by `Standing`, so one Braivo adds has words.
 */
const STANDING_LABELS: Record<
  Standing,
  { alone: MessageDescriptor; counted: (count: number) => MessageDescriptor }
> = {
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
/** `counts` in words, in the summary's order, those with none left out: ["2 retained", "1 learning"]. */
export function formatCounts(counts: CourseStanding, t: ReturnType<typeof useLingui>["t"]) {
  return (Object.keys(STANDING_LABELS) as Standing[])
    .filter((label) => counts[label] > 0)
    .map((label) => t(STANDING_LABELS[label].counted(counts[label])));
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
const STANDING_FILLS: Record<Standing, string> = {
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
      {(Object.keys(STANDING_LABELS) as Standing[]).map((label) =>
        counts[label] > 0 ? (
          <span
            key={label}
            className={STANDING_FILLS[label]}
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
              {standing.title}: {t(STANDING_LABELS[standingOf(standing)].alone)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
