// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LearnerProgressReport, LearnerProgressStanding } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { cn } from "@braivo/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, notFound, useLocation } from "@tanstack/react-router";
import { Fragment, type ReactNode, useLayoutEffect } from "react";

import { AsOf } from "#components/as-of";
import { Disclosure } from "#components/disclosure";
import { LastPractised } from "#components/last-practised";
import { MissesSince } from "#components/misses-since";
import { nameWithTag, sharedNameTags } from "#lib/name-tags";
import { validateProgressSearch } from "#lib/progress-search";
import { orNotFound, readCourseForProgress } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * One learner's standing on each objective of a course, and the evidence each
 * was replayed from: for an administrator, any member; for a teacher, a
 * learner of a group they teach the course to (access-39), found among those
 * groups before anything about them is read.
 */
export const Route = createFileRoute(
  "/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId",
)({
  // The progress page's, carried back to it.
  validateSearch: validateProgressSearch,
  loaderDeps: () => ({}),
  loader: async ({ context, params, abortController }) => {
    const signal = abortController.signal;
    const { course, groups } = await readCourseForProgress(context.braivo, {
      organization: context.organization,
      courseId: params.courseId,
      signal,
    });
    const read = () =>
      orNotFound(
        context.braivo.learnerProgress(
          { courseId: params.courseId, learnerId: params.learnerId },
          { signal },
        ),
      );

    // Named, and tagged where another shares the name (as the overview tags
    // them), by the groups, which a teacher may read; the member list they may not.
    if (groups) {
      const learners = groups.flatMap(({ learners }) => learners);
      const learner = learners.find(({ userId }) => userId === params.learnerId);
      if (!learner) throw notFound();
      const tag = sharedNameTags(learners).get(learner.userId);
      return { report: await read(), learnerName: learner.name, tag, courseTitle: course.title };
    }
    const [report, members] = await Promise.all([
      read(),
      orNotFound(context.braivo.listMembers(context.organization.id, { signal })),
    ]);
    const learner = members.find(({ userId }) => userId === params.learnerId);
    const tag = sharedNameTags(members).get(params.learnerId);
    return {
      report,
      learnerName: learner?.name ?? params.learnerId,
      tag,
      courseTitle: course.title,
    };
  },
  // With the course, so one learner's tabs in two courses differ.
  head: (head) =>
    pageHead(
      head,
      head.loaderData &&
        `${nameWithTag(head.loaderData.learnerName, head.loaderData.tag)} · ${head.loaderData.courseTitle}`,
    ),
  component: LearnerProgress,
  notFoundComponent: () => (
    <p>
      <Trans>This learner does not exist, or their progress is not yours to see.</Trans>
    </p>
  ),
});

function LearnerProgress() {
  const { report, learnerName, tag, courseTitle } = Route.useLoaderData();
  const { organizationSlug, courseId } = Route.useParams();
  const search = Route.useSearch();
  const { i18n } = useLingui();
  const when = (at: string) => dated(at, i18n.locale);
  const hash = useLocation({ select: ({ hash }) => hash });
  // Arriving at an objective (the overview links its repeated misses here), the
  // browser scrolls to it; a screen reader starts there too.
  useLayoutEffect(() => {
    if (hash.startsWith("objective-")) document.getElementById(hash)?.focus();
  }, [hash]);
  const threshold = report.repeatedMissesThreshold;
  // The fields' names, in each objective and in the columns' header.
  const labels = {
    standing: <Trans>Standing</Trans>,
    lastEvidence: <Trans>Last evidence</Trans>,
    evidence: <Trans>Evidence</Trans>,
    reviewDue: <Trans>Review due</Trans>,
  };

  return (
    <>
      {/* Back to the course's other learners, found and ordered as they were. */}
      <Link
        to="/$organizationSlug/courses/$courseId/progress"
        params={{ organizationSlug, courseId }}
        search={search}
        className="mb-2 inline-block text-sm text-muted-foreground underline wrap-anywhere"
      >
        {courseTitle}
      </Link>
      <Heading id="learner">
        {learnerName}
        {tag && (
          <span className="ms-2 font-mono text-sm font-normal text-muted-foreground">{tag}</span>
        )}
      </Heading>
      <MutedText className="mb-4 flex flex-col gap-1">
        <span>
          <AsOf at={report.asOf} />
        </span>
        {/* Practice (progress-17), beside the standings it does not change. */}
        {report.objectives.length > 0 && (
          <span>
            <LastPractised at={report.lastPractisedAt} asOf={report.asOf} detailed />
          </span>
        )}
      </MutedText>
      {/* A course is open to learners even before it has objectives. */}
      {report.objectives.length === 0 ? (
        <MutedText>
          <Trans>This course has no objectives yet, so there is no progress to report.</Trans>
        </MutedText>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-1 text-sm text-muted-foreground">
            <p>
              <Trans>
                Estimated recall is a model estimate, not a test score. Estimates include learning
                across this organization's courses that cover these objectives.
              </Trans>
            </p>
            <p>
              <Trans>
                Not started means no evidence yet. Learning means practice has begun; one missed{" "}
                {threshold} or more times since the last correct answer says so under it. Show
                answer counts as a miss.
              </Trans>
            </p>
            {/* Or a standing earned elsewhere reads as practice gone missing. */}
            <p>
              <Trans>
                Last practised counts questions answered here, Show answer included. Results
                recorded elsewhere count toward standings, not practice.
              </Trans>
            </p>
          </div>
          {/* A list, not a table, whose last columns start off screen on a
              phone: each objective's fields stacked beside their names, or,
              where five columns fit, aligned under one header. */}
          <div className="@container">
            <div className="@2xl:grid @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] @2xl:gap-x-4">
              {/* Each value is named already; this only draws the columns. */}
              <div
                aria-hidden="true"
                className="hidden border-b pb-2 text-sm font-medium @2xl:col-span-5 @2xl:grid @2xl:grid-cols-subgrid"
              >
                <span>
                  <Trans>Objective</Trans>
                </span>
                {Object.entries(labels).map(([key, label]) => (
                  <span key={key}>{label}</span>
                ))}
              </div>
              {/* `list`: Safari drops the role of a list styled without markers. */}
              <ul
                role="list"
                aria-labelledby="learner"
                className="@2xl:col-span-5 @2xl:grid @2xl:grid-cols-subgrid"
              >
                {report.objectives.map((standing) => (
                  <li
                    key={standing.objectiveId}
                    className="border-b py-3 @2xl:col-span-5 @2xl:grid @2xl:grid-cols-subgrid"
                  >
                    {/* A heading, so each objective can be found and its fields read under it. */}
                    <Heading
                      level={2}
                      id={`objective-${standing.objectiveId}`}
                      tabIndex={-1}
                      className="scroll-mt-4 wrap-anywhere @2xl:mb-0 @2xl:self-start"
                    >
                      {standing.title}
                    </Heading>
                    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm @2xl:col-span-4 @2xl:grid-cols-subgrid">
                      <Field label={labels.standing}>
                        <Standing standing={standing} threshold={threshold} />
                      </Field>
                      <Field label={labels.lastEvidence}>
                        {standing.phase !== "unseen" && when(standing.lastEvidenceAt)}
                      </Field>
                      <Field label={labels.evidence}>
                        {standing.evidence.length > 0 && (
                          <Evidence objective={standing.title} evidence={standing.evidence} />
                        )}
                      </Field>
                      {/* Only what is retained falls due; what is learning comes back first. */}
                      <Field label={labels.reviewDue}>
                        {standing.phase === "retaining" && when(standing.dueAt)}
                      </Field>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * A field of an objective, its name shown beside it only where the fields
 * stack. One with no value is a dash in its column, and left out where the
 * fields stack: under "Not started", three dashes would say nothing more.
 */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  const none = children === false;
  return (
    <>
      <dt className={cn("text-muted-foreground @2xl:sr-only", none && "@max-2xl:hidden")}>
        {label}
      </dt>
      <dd className={cn("min-w-0 wrap-break-word", none && "@max-2xl:hidden")}>
        {none ? "—" : children}
      </dd>
    </>
  );
}

/**
 * What a standing was replayed from, counted, and dated on request: one failure
 * and many both read "Learning", and only this tells them apart. Newest first,
 * since a long history is read for its end.
 */
function Evidence({
  objective,
  evidence,
}: {
  objective: string;
  evidence: LearnerProgressReport["objectives"][number]["evidence"];
}) {
  const { t, i18n } = useLingui();
  const successes = evidence.filter(({ outcome }) => outcome === "success").length;
  const failures = evidence.length - successes;
  const counts = [
    successes > 0 && t({ message: plural(successes, { one: "# success", other: "# successes" }) }),
    failures > 0 && t({ message: plural(failures, { one: "# failure", other: "# failures" }) }),
  ].filter((count) => count !== false);
  const counted = counts.join(", ");

  return (
    <Disclosure
      // Each count whole, so a narrow column wraps between them, not inside one.
      summary={
        <span>
          {counts.map((count, index) => (
            <Fragment key={count}>
              {index > 0 && ", "}
              <span className="whitespace-nowrap">{count}</span>
            </Fragment>
          ))}
        </span>
      }
      // Named with its objective: a toggle reached on its own is not read with its row.
      label={t`${objective}: ${counted}`}
    >
      <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
        {evidence.toReversed().map(({ outcome, at }, index) => (
          // Stable for this report: evidence never changes once recorded.
          <li key={index}>
            {dated(at, i18n.locale)}:{" "}
            {outcome === "success" ? <Trans>success</Trans> : <Trans>failure</Trans>}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/**
 * A moment as a table can fit it, "Oct 4, 2026, 12:00 PM": a narrow column
 * wraps it between its date and its time, never inside the time.
 */
function dated(at: string, locale: string): ReactNode {
  const parts = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).formatToParts(new Date(at));
  const isTime = ({ type }: Intl.DateTimeFormatPart) =>
    type === "hour" || type === "minute" || type === "dayPeriod";
  const start = parts.findIndex(isTime);
  const end = parts.findLastIndex(isTime) + 1;
  const text = (from: number, to?: number) =>
    parts
      .slice(from, to)
      .map(({ value }) => value)
      .join("");
  return (
    <>
      {text(0, start)}
      <span className="whitespace-nowrap">{text(start, end)}</span>
      {text(end)}
    </>
  );
}

/**
 * A standing in words; under one still learning, its repeated misses
 * (progress-16), and under a retained one, its recall: predicted, never a grade.
 */
function Standing({
  standing,
  threshold,
}: {
  standing: LearnerProgressStanding;
  threshold: number;
}) {
  switch (standing.phase) {
    case "unseen":
      return <Trans context="A learner's standing on an objective">Not started</Trans>;
    case "acquiring":
      return (
        <>
          <span className="block">
            <Trans context="A learner's standing on an objective">Learning</Trans>
          </span>
          {standing.misses && standing.misses.count >= threshold && (
            <MutedText className="block">
              <MissesSince {...standing.misses} />
            </MutedText>
          )}
        </>
      );
    case "retaining": {
      const recall = Math.round(standing.retrievability * 100);
      return (
        <>
          <span className="block">
            {standing.due ? (
              <Trans context="A learner's standing on an objective">Due for review</Trans>
            ) : (
              <Trans context="A learner's standing on an objective">Retained</Trans>
            )}
          </span>
          <MutedText className="block">
            <Trans>Estimated recall now: {recall}%</Trans>
          </MutedText>
        </>
      );
    }
    default:
      return standing satisfies never;
  }
}
