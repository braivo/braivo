// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";

import { orNotFound } from "#lib/refusals";

export const Route = createFileRoute("/_signed-in/$organizationSlug/")({
  loader: async ({ context, abortController }) => ({
    courses: await orNotFound(
      context.braivo.listCourses(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  component: Courses,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

function Courses() {
  const { courses } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();

  // Where a course starts: the material it is written from.
  const sources = (
    <p className="mb-4">
      <Link to="/$organizationSlug/sources" params={{ organizationSlug }} className="underline">
        Sources
      </Link>
    </p>
  );

  if (courses.length === 0) {
    return (
      <>
        {sources}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No courses published yet</EmptyTitle>
            <EmptyDescription>
              Add material under Sources and draft a course from it there, or with your desktop
              agent through braivo mcp.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      {sources}
      <Heading>Courses</Heading>
      <ul className="list-disc pl-6">
        {courses.map((course) => (
          <li key={course.id}>
            <Link
              to="/$organizationSlug/courses/$courseId"
              params={{ organizationSlug, courseId: course.id }}
              className="underline"
            >
              {course.title}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
