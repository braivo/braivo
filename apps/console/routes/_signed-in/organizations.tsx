// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";

import { OrganizationSetup } from "#components/organization-setup";

export const Route = createFileRoute("/_signed-in/organizations")({
  loader: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    const organizations = await context.braivo.listOrganizations(options);
    // Asked only of someone it can concern, so a page of organizations never
    // waits on, or fails with, onboarding's endpoint.
    const setupDomain =
      organizations.length === 0 ? await context.braivo.organizationSetupDomain(options) : null;
    return { organizations, setupDomain };
  },
  component: Organizations,
});

function Organizations() {
  const { organizations, setupDomain } = Route.useLoaderData();
  const { braivo, user } = Route.useRouteContext();

  // Someone new where anyone may set one up (ADR 0018); a learner who came
  // here instead of their school's site is still told where to go.
  if (organizations.length === 0 && setupDomain !== null) {
    return (
      <>
        <OrganizationSetup braivo={braivo} domain={setupDomain} />
        <div className="mt-8 flex max-w-md flex-col gap-2">
          <MutedText>Learning? Open the site your school or training provider gave you.</MutedText>
          <MutedText>
            Expected to manage one? Ask its owner, or whoever set Braivo up for you, to add you.
          </MutedText>
          <MutedText className="wrap-anywhere">Signed in as {user.email}.</MutedText>
        </div>
      </>
    );
  }

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
