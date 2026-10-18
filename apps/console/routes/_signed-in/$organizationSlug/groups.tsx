// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Group } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { Disclosure } from "#components/disclosure";
import { LearnersSite } from "#components/learners-site";
import { NameTag } from "#components/name-tag";
import { sharedNameTags } from "#lib/name-tags";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * Where teaching starts (ADR 0042): the groups someone teaches, every group to
 * an administrator, each with its teachers, learners, and courses, a course
 * leading to its learners' progress. Read-only: groups are changed in
 * settings, by an administrator.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/groups")({
  loader: async ({ context, abortController }) => ({
    groups: await orNotFound(
      context.braivo.listGroups(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, t`Groups`),
  component: TeachingGroups,
});

function TeachingGroups() {
  const { groups } = Route.useLoaderData();
  const { organization } = Route.useRouteContext();
  const { t } = useLingui();
  const { administers, slug: organizationSlug } = organization;
  // Across every group shown: a name two of their learners share is told apart.
  const tags = sharedNameTags(groups.flatMap(({ learners }) => learners));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <Heading className="mb-0">
          <Trans>Groups</Trans>
        </Heading>
        {administers && groups.length > 0 && (
          <Button asChild variant="outline">
            <Link to="/$organizationSlug/settings/groups" params={{ organizationSlug }}>
              <Trans>Manage groups</Trans>
            </Link>
          </Button>
        )}
      </div>
      {/* Where learners are sent to practise, once there is one: nothing a teacher can change. */}
      <LearnersSite learnDomain={organization.learnDomain} at={t`Learners practise at`} />
      {groups.length === 0 ? (
        // Only an administrator sees none: a teacher is here for a group they teach.
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              <Trans>No groups yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Create a group to give teachers access to the learners they teach.</Trans>
            </EmptyDescription>
          </EmptyHeader>
          {administers && (
            <EmptyContent>
              <Button asChild>
                <Link to="/$organizationSlug/settings/groups/new" params={{ organizationSlug }}>
                  <Trans>Create group</Trans>
                </Link>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <GroupSection key={group.id} group={group} tags={tags} />
          ))}
        </div>
      )}
    </>
  );
}

/** One group: who teaches it, its learners on request, and its courses' progress. */
function GroupSection({ group, tags }: { group: Group; tags: Map<string, string> }) {
  const { organization } = Route.useRouteContext();
  const { i18n, t } = useLingui();
  const organizationSlug = organization.slug;
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  const headingId = `group-${group.id}`;
  const learners = t({
    message: plural(group.learners.length, { one: "# learner", other: "# learners" }),
  });

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <Heading level={2} id={headingId} className="mb-1">
          {group.name}
        </Heading>
        {organization.administers && (
          <Link
            to="/$organizationSlug/settings/groups/$groupId"
            params={{ organizationSlug, groupId: group.id }}
            className="text-sm text-muted-foreground underline"
            aria-label={t`Edit ${group.name}`}
          >
            <Trans>Edit</Trans>
          </Link>
        )}
      </div>
      <MutedText className="block wrap-break-word">
        {group.teachers.length === 0 ? (
          <Trans>No teachers.</Trans>
        ) : (
          <Trans>Taught by {list.format(group.teachers.map(({ name }) => name))}.</Trans>
        )}
      </MutedText>
      {/* Names already read with the group: no member list, which a teacher may not read. */}
      {group.learners.length === 0 ? (
        <MutedText className="block">
          <Trans>No learners yet.</Trans>
        </MutedText>
      ) : (
        <Disclosure
          className="text-sm text-muted-foreground"
          summary={learners}
          // Named with its group: a toggle reached on its own is not read with its card.
          label={t`${group.name}: ${learners}`}
        >
          <ul className="mt-1 columns-1 gap-6 sm:columns-2">
            {group.learners.map(({ userId, name }) => (
              <li key={userId} className="wrap-anywhere">
                {name}
                <NameTag tag={tags.get(userId)} />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {group.courses.length === 0 ? (
        <MutedText className="mt-3 block wrap-break-word">
          {organization.administers ? (
            <Trans>No courses assigned: edit the group to add one.</Trans>
          ) : (
            <Trans>No courses assigned. Ask your administrator to add one.</Trans>
          )}
        </MutedText>
      ) : (
        <ul className="mt-3 divide-y overflow-hidden rounded-xl border">
          {group.courses.map((course) => (
            <li key={course.id}>
              <Link
                to="/$organizationSlug/courses/$courseId/progress"
                params={{ organizationSlug, courseId: course.id }}
                search={{ from: "groups" }}
                className="flex min-h-11 items-center justify-between gap-2 px-3 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-9"
              >
                <span className="wrap-anywhere">{course.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Trans>Progress</Trans>
                  <ChevronRightIcon className="size-4" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
