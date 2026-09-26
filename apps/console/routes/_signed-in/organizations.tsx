// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_signed-in/organizations")({
  loader: async ({ context, abortController }) => ({
    organizations: await context.braivo.listOrganizations({ signal: abortController.signal }),
  }),
  component: Organizations,
});

function Organizations() {
  const { organizations } = Route.useLoaderData();
  const { user } = Route.useRouteContext();

  return (
    <>
      <Heading>Organizations</Heading>
      {organizations.length === 0 ? (
        // Who lands here: a learner who came to Braivo's origin, someone
        // awaiting the organization the operator creates for them (ADR 0018),
        // or someone signed in with another email than they meant.
        <Empty>
          <EmptyHeader>
            <EmptyTitle>You don't manage any organizations</EmptyTitle>
            <EmptyDescription>
              Learning? Open the site your school or training provider gave you.
            </EmptyDescription>
            <EmptyDescription>
              Expected to manage one? Ask its owner, or whoever set Braivo up for you, to add you.
            </EmptyDescription>
            <EmptyDescription>Signed in as {user.email}.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="list-disc pl-6">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                to="/$organizationSlug"
                params={{ organizationSlug: organization.slug }}
                className="underline"
              >
                {organization.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
