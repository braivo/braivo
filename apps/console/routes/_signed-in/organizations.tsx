// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Trans } from "@lingui/react/macro";
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
  // Named, so a translator sees what the placeholder holds.
  const { email } = user;

  // Someone new where anyone may set one up (ADR 0018); a learner who came
  // here instead of their school's site is still told where to go.
  // Onboarding's width, 560px: one short form, not a table. Two quiet lines
  // below it, not to compete with its button; the email in them, so someone
  // signed in with another than they meant sees so before setting up.
  if (organizations.length === 0 && setupDomain !== null) {
    return (
      <div className="mx-auto max-w-140 sm:py-10">
        <OrganizationSetup braivo={braivo} domain={setupDomain} />
        <div className="mt-8 flex flex-col gap-1 text-sm wrap-anywhere text-muted-foreground">
          <p>
            <Trans>Here to learn? Open the site your school or training provider gave you.</Trans>
          </p>
          <p>
            <Trans>
              Joining an organization? Ask its owner, or whoever set Braivo up for you, to add{" "}
              {email}.
            </Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-140">
      <Heading>
        <Trans>Organizations</Trans>
      </Heading>
      {organizations.length === 0 ? (
        // Who lands here: a learner who came to Braivo's origin, someone
        // awaiting the organization the operator creates for them (ADR 0018),
        // or someone signed in with another email than they meant.
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <Trans>You don't manage any organizations</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Learning? Open the site your school or training provider gave you.</Trans>
            </EmptyDescription>
            <EmptyDescription>
              <Trans>
                Expected to manage one? Ask its owner, or whoever set Braivo up for you, to add you.
              </Trans>
            </EmptyDescription>
            <EmptyDescription className="wrap-anywhere">
              <Trans>Signed in as {email}.</Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="list-disc pl-6">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                to="/$organizationSlug"
                params={{ organizationSlug: organization.slug }}
                className="wrap-anywhere underline"
              >
                {organization.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
