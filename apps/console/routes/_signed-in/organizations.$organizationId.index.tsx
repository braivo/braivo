// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";

import { orNotFound } from "../../lib/refusals.ts";

export const Route = createFileRoute("/_signed-in/organizations/$organizationId/")({
  loader: async ({ context, params, abortController }) => ({
    courses: await orNotFound(
      context.braivo.listCourses(params.organizationId, { signal: abortController.signal }),
    ),
  }),
  component: Courses,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

function Courses() {
  const { courses } = Route.useLoaderData();
  const { organizationId } = Route.useParams();

  if (courses.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No courses published yet</EmptyTitle>
          <EmptyDescription>Courses are published through the API for now.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <Heading>Courses</Heading>
      <ul className="list-disc pl-6">
        {courses.map((course) => (
          <li key={course.id}>
            <Link
              to="/organizations/$organizationId/courses/$courseId"
              params={{ organizationId, courseId: course.id }}
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
