// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_signed-in/")({
  loader: async ({ context, abortController }) => ({
    courses: await context.braivo.learnerCourses({ signal: abortController.signal }),
  }),
  component: Courses,
});

function Courses() {
  const { courses } = Route.useLoaderData();

  if (courses.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No courses yet</EmptyTitle>
          <EmptyDescription>
            Courses will appear here when they're available to you.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section>
      <Heading>Your courses</Heading>
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
    </section>
  );
}
