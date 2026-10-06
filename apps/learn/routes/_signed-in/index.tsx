// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";

import { Notice } from "#components/notice";

export const Route = createFileRoute("/_signed-in/")({
  loader: async ({ context, abortController }) => ({
    courses: await context.braivo.learnerCourses({ signal: abortController.signal }),
  }),
  component: Courses,
  errorComponent: CoursesError,
});

/** A list that may only have failed to load for now. Trying again reloads it. */
function CoursesError() {
  const router = useRouter();
  const { t } = useLingui();
  return (
    <Notice title={t`Your courses could not be loaded.`}>
      <Button onClick={() => router.invalidate()}>
        <Trans>Try again</Trans>
      </Button>
    </Notice>
  );
}

function Courses() {
  const { courses } = Route.useLoaderData();

  return (
    <section>
      <Heading>
        <Trans>Your courses</Trans>
      </Heading>
      {courses.length === 0 ? (
        <Empty>
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
          {/* `ItemGroup` is a list, and a link is not a list item. */}
          {courses.map((course) => (
            <div key={course.id} role="listitem">
              <Item variant="outline" asChild>
                <Link to="/courses/$courseId" params={{ courseId: course.id }}>
                  <ItemContent>
                    <ItemTitle>{course.title}</ItemTitle>
                  </ItemContent>
                </Link>
              </Item>
            </div>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
