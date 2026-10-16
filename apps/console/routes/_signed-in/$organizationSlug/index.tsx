// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
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
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/")({
  // A teacher's home is their groups: courses are an administrator's.
  beforeLoad: ({ context, params }) => {
    if (!context.organization.administers) {
      throw redirect({ to: "/$organizationSlug/groups", params, replace: true });
    }
  },
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
  const { learnDomain, aiEnabled } = Route.useRouteContext().organization;

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
          {courses.map((course) => (
            <li key={course.id}>
              <Link
                to="/$organizationSlug/courses/$courseId"
                params={{ organizationSlug, courseId: course.id }}
                className="underline wrap-anywhere"
              >
                {course.title}
                {/* In the link's name, so it is heard while moving from link to link. */}
                {!course.published && <span className="sr-only"> (needs review)</span>}
              </Link>
              {/* A tool's course, reached by no learner until published on its page. */}
              {!course.published && (
                <Badge variant="outline" className="ms-2" aria-hidden="true">
                  Needs review
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
