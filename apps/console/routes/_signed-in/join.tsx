// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { OrganizationSetupForm } from "#components/organization-setup-form";
import { organizationToOpen } from "#lib/last-organization";

/**
 * Setting up an organization, for whoever owns none (ADR 0018), and where
 * someone managing none lands (ADR 0004). Whoever may not set one up but
 * works in one is sent to it, as from `/`, so an owner reloading after an
 * unclear setup finds it. In `beforeLoad`, which every navigation runs; a
 * loader's result a preload may reuse.
 */
export const Route = createFileRoute("/_signed-in/join")({
  beforeLoad: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    const [organizations, setup] = await Promise.all([
      context.braivo.listOrganizations(options),
      context.braivo.organizationSetup(options),
    ]);
    const organization = organizationToOpen(organizations);
    if (organization && !setup?.maySetUp) {
      throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
    }
    // Read apart from the list: a form only where Braivo says it may be used.
    return { setup: setup?.maySetUp ? setup : null, managesNone: organizations.length === 0 };
  },
  component: Join,
});

function Join() {
  const { braivo, user, setup, managesNone } = Route.useRouteContext();
  // Named, so a translator sees what the placeholder holds.
  const { email } = user;

  // Whoever may set one up; someone new among them, a learner who came here
  // instead of their school's site included, is also told where to go.
  // Onboarding's width, 560px: one short form, not a table. Two quiet lines
  // below it, not to compete with its button; the email in them, so someone
  // signed in with another than they meant sees so before setting up.
  if (setup !== null) {
    return (
      <div className="mx-auto max-w-140 sm:py-10">
        <OrganizationSetupForm braivo={braivo} {...setup} />
        {managesNone && (
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
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-140">
      <Heading>
        <Trans>Organizations</Trans>
      </Heading>
      {/* Who lands here: a learner who came to Braivo's origin, someone
          awaiting the organization the operator creates for them (ADR 0018),
          or someone signed in with another email than they meant. */}
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
    </div>
  );
}
