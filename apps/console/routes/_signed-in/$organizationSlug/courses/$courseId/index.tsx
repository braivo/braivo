// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { createFileRoute, Link } from "@tanstack/react-router";

import { readCourseInOrganization, readMembers } from "#lib/refusals";

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    const course = await readCourseInOrganization(context.braivo, {
      organizationId,
      courseId: params.courseId,
      signal: abortController.signal,
    });
    const members = await readMembers(context.auth, organizationId);

    return { course, members };
  },
  component: Course,
  notFoundComponent: () => <p>This course does not exist, or you do not manage it.</p>,
});

function Course() {
  const { course, members } = Route.useLoaderData();
  const { organizationSlug, courseId } = Route.useParams();

  return (
    <>
      <Heading>{course.title}</Heading>
      <Heading level={2}>Members</Heading>
      <ul className="list-disc pl-6">
        {members.map((member) => (
          <li key={member.id}>
            <Link
              to="/$organizationSlug/courses/$courseId/learners/$learnerId"
              params={{ organizationSlug, courseId, learnerId: member.userId }}
              className="underline"
            >
              {member.user.name}
            </Link>{" "}
            <Badge variant="secondary">{member.role}</Badge>
          </li>
        ))}
      </ul>
    </>
  );
}
