// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Course,
  type CourseStanding,
  type CourseWaiting,
  courseRef,
} from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@braivo/ui/components/item";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useId } from "react";

import { AccountHeader } from "#components/account-header";
import { Notice } from "#components/notice";
import { waitingLine } from "#components/standing";
import { OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS, withDeadline } from "#lib/deadline";

export const Route = createFileRoute("/_signed-in/")({
  // The list, and beside it where the learner stands in each and what waits
  // there, read together: those replay their evidence, so they are optional,
  // within their own shorter deadline, the list shown without them rather than
  // failing. Awaited with the list, as the course page awaits its optional
  // reads, so the cards never grow under a tap; a slow one holds the list back
  // no longer than its deadline.
  // Dropped on leaving: practice changes what waits, and a kept list would show
  // again, then reorder under a tap once read again.
  gcTime: 0,
  loader: async ({ context, abortController }) => {
    const left = abortController.signal;
    const [courses, details] = await Promise.all([
      context.braivo.learnerCourses({ signal: withDeadline(left, READ_DEADLINE_MS) }),
      context.braivo
        .learnerCoursesWithStanding({ signal: withDeadline(left, OPTIONAL_READ_DEADLINE_MS) })
        .then(
          (listed) =>
            new Map(listed.map(({ id, standing, waiting }) => [id, { standing, waiting }])),
        )
        .catch(() => undefined),
    ]);
    return { courses, details };
  },
  component: Courses,
  errorComponent: CoursesError,
});

/** A list that may only have failed to load for now. Trying again reloads it. */
function CoursesError() {
  const router = useRouter();
  const { t } = useLingui();
  // With the header, so a learner whose list fails can still sign out.
  return (
    <>
      <AccountHeader />
      <Notice title={t`Your courses could not be loaded.`}>
        <Button onClick={() => router.invalidate()}>
          <Trans>Try again</Trans>
        </Button>
      </Notice>
    </>
  );
}

const root = getRouteApi("__root__");

function Courses() {
  const { courses, details } = Route.useLoaderData();
  // A number names a course on its organization's domain alone; elsewhere, or
  // with the domain's organization unknown, its ID does.
  const { organization } = root.useLoaderData();
  // Weak and fading knowledge first, then new material, then the rest; a stable
  // sort, so by title within each. Unread, the list's order alone: nothing can be
  // said of what waits.
  const ordered = courses.toSorted(
    (a, b) => rank(details?.get(a.id)?.waiting) - rank(details?.get(b.id)?.waiting),
  );

  return (
    <>
      <AccountHeader />
      <section>
        <Heading>
          <Trans>Your courses</Trans>
        </Heading>
        {courses.length === 0 ? (
          <Empty className="max-sm:p-6">
            <EmptyHeader>
              <EmptyTitle>
                <Trans>No courses yet</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>Courses will appear here when they're available to you.</Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {ordered.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                courseRef={organization ? courseRef(course) : course.id}
                details={details?.get(course.id)}
              />
            ))}
          </ItemGroup>
        )}
      </section>
    </>
  );
}

/** Where a course lists, first to last: learning or reviews waiting, only new material, nothing or unread. */
function rank(waiting: CourseWaiting | undefined) {
  if (waiting === undefined) return 2;
  if (waiting.learning + waiting.dueForReview > 0) return 0;
  return waiting.new > 0 ? 1 : 2;
}

/** How many objectives a course's standing counts. */
function totalOf(standing: CourseStanding) {
  return Object.values(standing).reduce((sum, count) => sum + count, 0);
}

/** Whether practice would offer anything in a course now. */
function hasWaiting({ learning, dueForReview, new: fresh }: CourseWaiting) {
  return learning + dueForReview + fresh > 0;
}

/**
 * A course, the whole card its link, a tap away from practice: its title and one
 * line, what waits there now or that nothing does, the reason left to the course
 * page. Where the learner stands shows where practice pauses (progress-8), not
 * here: beside what waits it would count other things, unexplained. Without
 * those read, or for a course with no objectives, the title alone. Named by its
 * title, the line its description.
 */
function CourseCard({
  course,
  courseRef,
  details,
}: {
  course: Course;
  courseRef: string;
  details: { standing: CourseStanding; waiting: CourseWaiting } | undefined;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const lineId = useId();
  const waits = details !== undefined && hasWaiting(details.waiting);
  const line =
    details === undefined || totalOf(details.standing) === 0
      ? undefined
      : waits
        ? waitingLine(details.waiting, t)
        : t`Nothing to practise right now`;
  return (
    // `ItemGroup` is a list, and a link is not a list item. A chevron and a
    // press's fill mark it as a link on a phone, where nothing hovers.
    <div role="listitem">
      <Item variant="outline" className="flex-nowrap active:bg-muted" asChild>
        <Link
          to="/c/$courseRef"
          params={{ courseRef }}
          aria-labelledby={titleId}
          aria-describedby={line ? lineId : undefined}
        >
          <ItemContent className="min-w-0 gap-2">
            <ItemTitle id={titleId} className="line-clamp-none wrap-anywhere">
              {course.title}
            </ItemTitle>
            {line && (
              <ItemDescription
                id={lineId}
                className={cn("line-clamp-none", waits && "text-foreground")}
              >
                {line}
              </ItemDescription>
            )}
          </ItemContent>
          <ItemActions className="shrink-0">
            <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </ItemActions>
        </Link>
      </Item>
    </div>
  );
}
