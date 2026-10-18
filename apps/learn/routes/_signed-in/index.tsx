// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { courseRef } from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { Notice } from "#components/notice";
import { READ_DEADLINE_MS, withDeadline } from "#lib/deadline";

export const Route = createFileRoute("/_signed-in/")({
  loader: async ({ context, abortController }) => ({
    courses: await context.braivo.learnerCourses({
      signal: withDeadline(abortController.signal, READ_DEADLINE_MS),
    }),
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

const root = getRouteApi("__root__");

function Courses() {
  const { courses } = Route.useLoaderData();
  // A number names a course on its organization's domain alone; elsewhere, or
  // with the domain's organization unknown, its ID does.
  const { organization } = root.useLoaderData();

  return (
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
          {/* `ItemGroup` is a list, and a link is not a list item. A chevron and
            a press's fill mark each as a link on a phone, where nothing hovers. */}
          {courses.map((course) => (
            <div key={course.id} role="listitem">
              <Item variant="outline" className="flex-nowrap active:bg-muted" asChild>
                <Link
                  to="/c/$courseRef"
                  params={{ courseRef: organization ? courseRef(course) : course.id }}
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none wrap-anywhere">{course.title}</ItemTitle>
                  </ItemContent>
                  <ItemActions className="shrink-0">
                    <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                  </ItemActions>
                </Link>
              </Item>
            </div>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
