// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Membership } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@braivo/ui/components/item";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { OrganizationSetupForm } from "#components/organization-setup-form";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { organizationToOpen } from "#lib/last-organization";
import { learnSignInUrl } from "#lib/learn-url";

/**
 * Setting up an organization, for whoever owns none (ADR 0018), and where
 * someone managing none lands (ADR 0004): the schools they learn at, each on
 * to its learn domain (access-59). Whoever may not set one up but works in
 * one is sent to it, as from `/`, so an owner reloading after an unclear
 * setup finds it. In `beforeLoad`, which every navigation runs; a loader's
 * result a preload may reuse.
 */
export const Route = createFileRoute("/_signed-in/join")({
  beforeLoad: async ({ context, abortController }) => {
    // Unanswered in time, as unanswered at all, the page fails and offers
    // Try again, rather than leave someone just signed in waiting.
    const options = { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) };
    const [organizations, setup] = await Promise.all([
      context.braivo.listOrganizations(options),
      context.braivo.organizationSetup(options),
    ]);
    const organization = organizationToOpen(organizations);
    if (organization && !setup?.maySetUp) {
      throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
    }
    const managesNone = organizations.length === 0;
    // Read apart from the list: a form only where Braivo says it may be used.
    // The schools only for whoever manages none, so no one else's page waits
    // on, or fails with, a read it does not show.
    return {
      setup: setup?.maySetUp ? setup : null,
      managesNone,
      // Those it can open first, so the usable choice is on top; by name within each.
      memberships: managesNone
        ? (await context.braivo.listMemberships(options)).sort(
            (a, b) => Number(!a.learnDomain) - Number(!b.learnDomain),
          )
        : [],
    };
  },
  // Braivo's, not the console's, while it speaks to a learner; otherwise the
  // console's own title stands.
  head: ({ match }) =>
    match.status === "success" && match.context.memberships.length > 0
      ? { meta: [{ title: `${t`Where you learn`} · Braivo` }] }
      : {},
  component: Join,
});

function Join() {
  const { braivo, user, setup, managesNone, memberships } = Route.useRouteContext();
  // Managing none, setting one up is asked for, not the page's default: most
  // who land here came to learn.
  const [settingUp, setSettingUp] = useState(false);
  // Back from the form, focus returns to what opened it.
  const [returned, setReturned] = useState(false);
  // Named, so a translator sees what the placeholder holds.
  const { email } = user;

  // Onboarding's width, 560px: one short form, not a table.
  if (setup !== null && (!managesNone || settingUp)) {
    return (
      <div className="mx-auto max-w-140 sm:py-10">
        {/* Asked for, so it can be put down again. */}
        <OrganizationSetupForm
          braivo={braivo}
          {...setup}
          onBack={
            managesNone
              ? () => {
                  setSettingUp(false);
                  setReturned(true);
                }
              : undefined
          }
        />
      </div>
    );
  }

  // Who lands here: a learner who came to Braivo's origin, someone awaiting
  // the organization the operator creates for them (ADR 0018), or someone
  // signed in with another email than they meant, which is why it is shown.
  return (
    <div className="mx-auto max-w-140">
      {memberships.length > 0 ? (
        <Schools memberships={memberships} email={email} />
      ) : (
        <>
          <Heading>
            <Trans>Organizations</Trans>
          </Heading>
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
                  Expected to manage one? Ask its owner, or whoever set Braivo up for you, to add
                  you.
                </Trans>
              </EmptyDescription>
              <EmptyDescription className="wrap-anywhere">
                <Trans>Signed in as {email}.</Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      )}
      {setup !== null && (
        <div className="mt-8 flex flex-col items-center gap-2 text-center">
          <MutedText>
            <Trans>Running courses of your own? Set up an organization for them.</Trans>
          </MutedText>
          <Button variant="outline" autoFocus={returned} onClick={() => setSettingUp(true)}>
            <Trans>Set up an organization</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The schools someone learns at, by name, each on to its learn domain's own
 * sign-in start (`learnSignInUrl`); one without a learn domain says so.
 */
function Schools({ memberships, email }: { memberships: Membership[]; email: string }) {
  return (
    <>
      <Heading>
        <Trans>Where you learn</Trans>
      </Heading>
      <MutedText className="mb-6 block wrap-anywhere">
        <Trans>Choose a school to continue there. Signed in as {email}.</Trans>
      </MutedText>
      {/* Each in a list item of its own: on the link, the role would hide it. */}
      <ItemGroup role="list" className="gap-2">
        {memberships.map(({ id, name, learnDomain }) => (
          <div key={id} role="listitem">
            {learnDomain ? (
              <Item variant="outline" asChild>
                <a href={learnSignInUrl(learnDomain)}>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="wrap-anywhere">{name}</ItemTitle>
                    <ItemDescription className="wrap-anywhere">{learnDomain}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRightIcon aria-hidden="true" className="size-4" />
                  </ItemActions>
                </a>
              </Item>
            ) : (
              <Item variant="outline">
                <ItemContent className="min-w-0">
                  <ItemTitle className="wrap-anywhere">{name}</ItemTitle>
                  <ItemDescription>
                    <Trans>Its site for learners is not available yet.</Trans>
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
          </div>
        ))}
      </ItemGroup>
    </>
  );
}
