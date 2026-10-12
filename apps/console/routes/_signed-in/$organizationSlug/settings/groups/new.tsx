// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import { GroupForm } from "#components/group-form";
import { NoSuchSetting } from "#components/no-such-setting";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/** A new group: its name, teachers, learners, and courses, chosen among the organization's. */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/groups/new")({
  beforeLoad: administratorsOnly,
  loader: async ({ context, abortController }) => {
    // Bounded: a save waits for this read, and would otherwise wait forever.
    const options = { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) };
    const [members, courses] = await Promise.all([
      orNotFound(context.braivo.listMembers(context.organization.id, options)),
      orNotFound(context.braivo.listCourses(context.organization.id, options)),
    ]);
    return { members, courses };
  },
  head: (head) => pageHead(head, t`New group`),
  // A form per organization: switching carries nothing typed over.
  remountDeps: ({ params }) => params.organizationSlug,
  component: NewGroup,
  notFoundComponent: NoSuchSetting,
});

function NewGroup() {
  const { members, courses } = Route.useLoaderData();
  const { braivo, organization } = Route.useRouteContext();

  return (
    <GroupForm braivo={braivo} organization={organization} members={members} courses={courses} />
  );
}
