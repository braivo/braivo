// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";

import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/")({
  loader: async ({ context, abortController }) => ({
    courses: await orNotFound(
      context.braivo.listCourses(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, "Courses"),
  component: Courses,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

function Courses() {
  const { courses } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();

  return (
    <>
      {/* Where a course starts: the material it is written from. */}
      <p className="mb-4">
        <Link to="/$organizationSlug/sources" params={{ organizationSlug }} className="underline">
          Sources
        </Link>
      </p>
      <Heading>Courses</Heading>
      {courses.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No courses published yet</EmptyTitle>
            <EmptyDescription>
              Add material under Sources and draft a course from it there, or with your desktop
              agent through braivo mcp.
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
      )}
    </>
  );
}
