// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Spinner } from "@braivo/ui/components/spinner";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { organizationToOpen } from "#lib/last-organization";
import { learnSignInUrl } from "#lib/learn-url";

/**
 * Where `/` sends someone signed in (ADR 0004, access-59): the organization
 * last opened here, else the first they administer, author, or teach in;
 * managing none, a learner of one school with a learn domain on to it;
 * anyone else to `/join`, which says where to go. Read in that order, so the
 * console's own never waits on the second read.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context, abortController }) => {
    // Unanswered in time, as unanswered at all, the page fails and offers
    // Try again, rather than leave someone just signed in waiting.
    const options = { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) };
    const organization = organizationToOpen(await context.braivo.listOrganizations(options));
    if (organization) {
      throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
    }
    const memberships = await context.braivo.listMemberships(options);
    const [only] = memberships;
    if (memberships.length !== 1 || !only?.learnDomain) throw redirect({ to: "/join" });
    return { learnsAt: { name: only.name, learnDomain: only.learnDomain } };
  },
  component: ToLearnDomain,
});

/**
 * On to the learn domain of the one organization someone learns at, through
 * its own sign-in start (`learnSignInUrl`). In `/`'s place in the history, so
 * Back does not land here only to be sent on again. The link, should leaving
 * not happen. Through `visit` from here rather than a `redirect({ href })`
 * from `beforeLoad`, which would replace history alike: tests stub `visit`,
 * and the page says where it is going meanwhile.
 */
function ToLearnDomain() {
  const { learnsAt, visit } = Route.useRouteContext();
  const href = learnSignInUrl(learnsAt.learnDomain);
  // Once, as Strict Mode runs an effect twice.
  const left = useRef(false);
  useEffect(() => {
    if (left.current) return;
    left.current = true;
    visit(href, { replace: true });
  }, [href, visit]);
  // Named, so a translator sees what the placeholder holds.
  const { name: school } = learnsAt;
  return (
    <div className="mx-auto flex max-w-140 flex-col items-center gap-4 py-10 text-center">
      <Spinner aria-hidden="true" />
      <p role="status" className="wrap-anywhere">
        <Trans>Taking you to {school}…</Trans>
      </p>
      <a href={href} className="text-sm underline underline-offset-4 wrap-anywhere">
        <Trans>Continue to {school}</Trans>
      </a>
    </div>
  );
}
