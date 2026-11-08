// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Card, CardContent, CardHeader } from "@braivo/ui/components/card";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { ConnectAiApp } from "#components/connect-ai-app";
import { LearnersSite } from "#components/learners-site";
import { LinkList, linkRow } from "#components/link-list";
import { PersonalCoursesNote } from "#components/personal-courses";
import { readReports, ReportedTasks } from "#components/task-reports";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * A listed course's or objective's title, then its marks and note, spaced by a
 * gap, not a margin, so a mark that wraps starts where the title does.
 */
const titleRow = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1";

export const Route = createFileRoute("/_signed-in/$organizationSlug/")({
  // Courses are an author's (ADR 0048); someone who only teaches lands on their groups.
  beforeLoad: ({ context, params }) => {
    if (!context.organization.authors) {
      throw redirect({ to: "/$organizationSlug/groups", params, replace: true });
    }
  },
  loader: async ({ context, abortController }) => {
    const { id } = context.organization;
    // Bounded, since a Delete opening this page waits for it.
    const signal = withDeadline(abortController.signal, REQUEST_DEADLINE_MS);
    const [courses, objectives] = await Promise.all([
      orNotFound(context.braivo.listCourses(id, { signal })),
      orNotFound(context.braivo.listObjectives(id, { signal })),
    ]);
    // Unawaited: read beside the page, never holding it back (ADR 0052).
    const reports = readReports(context.braivo, context.organization, {}, abortController.signal);
    return { courses, objectives, reports };
  },
  head: (head) => pageHead(head, t`Courses`),
  component: Courses,
  notFoundComponent: () => (
    <p>
      <Trans>This organization does not exist, or you do not manage it.</Trans>
    </p>
  ),
});

function Courses() {
  const { courses, objectives, reports } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();
  const { learnDomain, aiEnabled, name, personal } = Route.useRouteContext().organization;
  const id = useId();
  const { t } = useLingui();
  /** "1 task needs review", "3 tasks need review". */
  const reviewCount = (count: number) =>
    t({ message: plural(count, { one: "# task needs review", other: "# tasks need review" }) });
  // What needs review, each task once (ADR 0039): under its course when its
  // objective is in that course alone, else under its objective, whose page
  // reviews it for every course it is in, or for none.
  const pendingTaskCounts = new Map<string, number>();
  for (const { courseIds, pendingTaskCount } of objectives) {
    if (courseIds.length !== 1) continue;
    const courseId = courseIds[0]!;
    pendingTaskCounts.set(courseId, (pendingTaskCounts.get(courseId) ?? 0) + pendingTaskCount);
  }
  // A tool's citations, under every course their objective is in: any of
  // their pages publishes them, and no objective's page does.
  const pendingPassages = new Set(
    objectives.flatMap(({ courseIds, pendingPassageCount }) =>
      pendingPassageCount > 0 ? courseIds : [],
    ),
  );
  // One in no course is listed even with nothing pending: no course page
  // leads to it, and its published tasks are edited and retired there.
  const otherObjectives = objectives.filter(
    ({ courseIds, pendingTaskCount }) =>
      courseIds.length === 0 || (courseIds.length > 1 && pendingTaskCount > 0),
  );

  return (
    <>
      {/* Beside the heading once there are courses, so a returning owner still
          finds where a new one starts: its material (the empty state says so). */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <Heading className="mb-0">
          <Trans>Courses</Trans>
        </Heading>
        {courses.length > 0 && (
          <Button asChild>
            <Link to="/$organizationSlug/sources" params={{ organizationSlug }} hash="add-material">
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              <Trans>Add material</Trans>
            </Link>
          </Button>
        )}
      </div>
      {personal ? (
        <PersonalCoursesNote />
      ) : (
        <LearnersSite
          learnDomain={learnDomain}
          at={t`Learners practise at`}
          none={t`Learners have no site to practise on yet. Ask whoever set Braivo up for you to add one.`}
        />
      )}
      {/* Keyed, so another organization's page never shows this one's list while it reads. */}
      <ReportedTasks key={organizationSlug} reports={reports} organizationSlug={organizationSlug} />
      {courses.length === 0 ? (
        <section aria-labelledby={`${id}-none`}>
          <Heading id={`${id}-none`} level={2}>
            <Trans>No courses yet</Trans>
          </Heading>
          {/* Two equal ways to start. Top-aligned, so the short one does not stretch. */}
          <div className="grid items-start gap-4 md:grid-cols-2">
            <StartOption title={<Trans>Add material</Trans>}>
              <MutedText className="mb-4 block wrap-break-word">
                {aiEnabled === false ? (
                  <Trans>
                    Braivo's AI is off for this organization. You can still add material under
                    Sources. To draft a course from it, ask whoever runs Braivo for you to turn the
                    AI on, or build it with your own AI app.
                  </Trans>
                ) : (
                  <Trans>Add material under Sources and draft a course from it there.</Trans>
                )}
              </MutedText>
              <Button asChild>
                <Link to="/$organizationSlug/sources" params={{ organizationSlug }}>
                  <Trans>Open Sources</Trans>
                </Link>
              </Button>
            </StartOption>
            <StartOption title={<Trans>Build with your AI app</Trans>}>
              <MutedText className="mb-4 block wrap-break-word">
                {/* True whether or not Braivo's AI is on (generation-19). */}
                <Trans>
                  Your app builds the course with its own model and your account with it, not
                  Braivo's AI.
                </Trans>
              </MutedText>
              <ConnectAiApp organization={{ name, personal }} />
            </StartOption>
          </div>
        </section>
      ) : (
        <LinkList>
          {courses.map((course) => {
            // A tool's course, or a published one's new tasks or passages,
            // reached by no learner until published on its page.
            const pending = pendingTaskCounts.get(course.id) ?? 0;
            const review =
              !course.published || (pending === 0 && pendingPassages.has(course.id))
                ? t`Needs review`
                : pending > 0
                  ? reviewCount(pending)
                  : undefined;
            // Hidden from learners since it was published, first: what they meet now.
            const hidden = t({
              comment: "A course's mark: hidden from learners",
              message: "Hidden",
            });
            const marks = [...(course.hidden ? [hidden] : []), ...(review ? [review] : [])];
            return (
              <li key={course.id}>
                <Link
                  to="/$organizationSlug/courses/$courseId"
                  params={{ organizationSlug, courseId: course.id }}
                  className={linkRow}
                >
                  <span className={titleRow}>
                    <span className="wrap-anywhere">
                      {course.title}
                      {/* In the link's name, so it is heard while moving from link to link. */}
                      {marks.length > 0 && (
                        <span className="sr-only"> ({marks.join(", ").toLowerCase()})</span>
                      )}
                    </span>
                    {marks.map((mark) => (
                      <Badge key={mark} variant="outline" aria-hidden="true">
                        {mark}
                      </Badge>
                    ))}
                  </span>
                  <Chevron />
                </Link>
              </li>
            );
          })}
        </LinkList>
      )}
      {otherObjectives.length > 0 && (
        <section aria-labelledby="other-objectives" className="mt-8">
          <Heading level={2} id="other-objectives">
            <Trans>Other objectives</Trans>
          </Heading>
          <MutedText className="mb-3 block">
            <Trans>
              In no course, or in several with tasks to review: each is listed here once, its tasks
              reviewed on its page.
            </Trans>
          </MutedText>
          <LinkList>
            {otherObjectives.map((objective) => {
              const review =
                objective.pendingTaskCount > 0
                  ? reviewCount(objective.pendingTaskCount)
                  : undefined;
              const placed = objective.courseIds.length;
              const noteId = `${id}-${objective.id}`;
              return (
                <li key={objective.id}>
                  <Link
                    to="/$organizationSlug/objectives/$objectiveId"
                    params={{ organizationSlug, objectiveId: objective.id }}
                    className={linkRow}
                    aria-describedby={noteId}
                  >
                    <span className={titleRow}>
                      <span className="wrap-anywhere">
                        {objective.title}
                        {review && <span className="sr-only"> ({review})</span>}
                      </span>
                      {review && (
                        <Badge variant="outline" aria-hidden="true">
                          {review}
                        </Badge>
                      )}
                      {/* The link's description, so its name stays the title and what waits. */}
                      <MutedText id={noteId} aria-hidden="true" className="font-normal">
                        {placed === 0
                          ? t`In no course`
                          : t({
                              message: plural(placed, {
                                one: "In # course",
                                other: "In # courses",
                              }),
                            })}
                      </MutedText>
                    </span>
                    <Chevron />
                  </Link>
                </li>
              );
            })}
          </LinkList>
        </section>
      )}
    </>
  );
}

/** One way to start a first course, named for a screen reader's list of regions. */
function StartOption(props: { title: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id} className="min-w-0">
      <CardHeader>
        <Heading id={id} level={3} className="mb-0">
          {props.title}
        </Heading>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

const Chevron = () => (
  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
);
