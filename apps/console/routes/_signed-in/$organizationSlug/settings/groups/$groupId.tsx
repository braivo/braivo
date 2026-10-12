// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Trans } from "@lingui/react/macro";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { GroupForm } from "#components/group-form";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * One group, to change: what the form changes is sent, over the group as read
 * here, never the whole roster (access-38).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/groups/$groupId")({
  beforeLoad: administratorsOnly,
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    // Bounded: a save waits for this read, and would otherwise wait forever.
    const options = { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) };
    // No read of one group: it is found among the organization's.
    const [groups, members, courses] = await Promise.all([
      orNotFound(context.braivo.listGroups(organizationId, options)),
      orNotFound(context.braivo.listMembers(organizationId, options)),
      orNotFound(context.braivo.listCourses(organizationId, options)),
    ]);
    const group = groups.find(({ id }) => id === params.groupId);
    if (!group) throw notFound();
    return { group, members, courses };
  },
  head: (head) => pageHead(head, head.loaderData?.group.name),
  // A form per group: nothing changed in one carries over to another.
  remountDeps: ({ params }) => params,
  component: EditGroup,
  notFoundComponent: () => (
    <p>
      <Trans>This group does not exist, or is not yours to change.</Trans>
    </p>
  ),
});

function EditGroup() {
  const { group, members, courses } = Route.useLoaderData();
  const { braivo, organization } = Route.useRouteContext();

  return (
    <GroupForm
      braivo={braivo}
      organization={organization}
      members={members}
      courses={courses}
      group={group}
    />
  );
}
