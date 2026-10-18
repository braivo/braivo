// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { DesktopAgentLink } from "#components/desktop-agent-link";
import { LearnersSite } from "#components/learners-site";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/")({
  // A teacher's home is their groups: courses are an administrator's.
  beforeLoad: ({ context, params }) => {
    if (!context.organization.administers) {
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
    return { courses, objectives };
  },
  head: (head) => pageHead(head, "Courses"),
  component: Courses,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

/** "1 task needs review", "3 tasks need review". */
const formatReviewCount = (count: number) =>
  `${count} ${count === 1 ? "task needs" : "tasks need"} review`;

function Courses() {
  const { courses, objectives } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();
  const { learnDomain, aiEnabled } = Route.useRouteContext().organization;
  // What needs review, each task once (ADR 0039): under its course when its
  // objective is in that course alone, else under its objective, whose page
  // reviews it for every course it is in, or for none.
  const waitingTaskCounts = new Map<string, number>();
  for (const { courseIds, waitingTaskCount } of objectives) {
    if (courseIds.length !== 1) continue;
    const courseId = courseIds[0]!;
    waitingTaskCounts.set(courseId, (waitingTaskCounts.get(courseId) ?? 0) + waitingTaskCount);
  }
  // One in no course is listed even with nothing waiting: no course page
  // leads to it, and its published tasks are edited and retired there.
  const otherObjectives = objectives.filter(
    ({ courseIds, waitingTaskCount }) =>
      courseIds.length === 0 || (courseIds.length > 1 && waitingTaskCount > 0),
  );

  return (
    <>
      {/* Beside the heading once there are courses, so a returning owner still
          finds where a new one starts: its material (the empty state says so). */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <Heading className="mb-0">Courses</Heading>
        {courses.length > 0 && (
          <Button asChild>
            <Link to="/$organizationSlug/sources" params={{ organizationSlug }} hash="add-material">
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add material
            </Link>
          </Button>
        )}
      </div>
      <LearnersSite
        learnDomain={learnDomain}
        at="Learners practise at"
        none="Learners have no site to practise on yet. Ask whoever set Braivo up for you to add one."
      />
      {courses.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No courses yet</EmptyTitle>
            <EmptyDescription>
              {aiEnabled === false ? (
                <>
                  Braivo's AI is off for this organization. You can still add material under
                  Sources. To draft a course from it, ask whoever runs Braivo for you to turn the AI
                  on, or use <DesktopAgentLink />.
                </>
              ) : (
                <>
                  Add material under Sources and draft a course from it there, or with{" "}
                  <DesktopAgentLink />.
                </>
              )}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/$organizationSlug/sources" params={{ organizationSlug }}>
                Open Sources
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="list-disc pl-6">
          {courses.map((course) => {
            // A tool's course, or a published one's new tasks, reached by no
            // learner until published on its page.
            const waiting = waitingTaskCounts.get(course.id) ?? 0;
            const review = !course.published
              ? "Needs review"
              : waiting > 0
                ? formatReviewCount(waiting)
                : undefined;
            return (
              <li key={course.id}>
                <Link
                  to="/$organizationSlug/courses/$courseId"
                  params={{ organizationSlug, courseId: course.id }}
                  className="underline wrap-anywhere"
                >
                  {course.title}
                  {/* In the link's name, so it is heard while moving from link to link. */}
                  {review && <span className="sr-only"> ({review.toLowerCase()})</span>}
                </Link>
                {review && (
                  <Badge variant="outline" className="ms-2" aria-hidden="true">
                    {review}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {otherObjectives.length > 0 && (
        <section aria-labelledby="other-objectives" className="mt-8">
          <Heading level={2} id="other-objectives">
            Other objectives
          </Heading>
          <MutedText className="mb-3 block">
            In no course, or in several with tasks to review: each is listed here once, its tasks
            reviewed on its page.
          </MutedText>
          <ul className="list-disc pl-6">
            {otherObjectives.map((objective) => {
              const review =
                objective.waitingTaskCount > 0
                  ? formatReviewCount(objective.waitingTaskCount)
                  : undefined;
              const placed = objective.courseIds.length;
              return (
                <li key={objective.id}>
                  <Link
                    to="/$organizationSlug/objectives/$objectiveId"
                    params={{ organizationSlug, objectiveId: objective.id }}
                    className="underline wrap-anywhere"
                  >
                    {objective.title}
                    {review && <span className="sr-only"> ({review})</span>}
                  </Link>
                  {review && (
                    <Badge variant="outline" className="ms-2" aria-hidden="true">
                      {review}
                    </Badge>
                  )}
                  <MutedText className="ms-2">
                    {placed === 0 ? "In no course" : `In ${placed} courses`}
                  </MutedText>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
