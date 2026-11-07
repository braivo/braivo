// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Spinner } from "@braivo/ui/components/spinner";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { organizationToOpen } from "#lib/last-organization";
import { learnUrl } from "#lib/learn-url";

/**
 * Where `/` sends someone signed in (ADR 0004, access-59): the organization
 * last opened here, else the first they administer, author, or teach in;
 * managing none, a learner of one school with a learn domain on to it;
 * anyone else to `/join`, which says where to go. Read in that order, so the
 * console's own never waits on the second read.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    const organization = organizationToOpen(await context.braivo.listOrganizations(options));
    if (organization) {
      throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
    }
    const memberships = await context.braivo.listMemberships(options);
    const [only] = memberships;
    if (memberships.length !== 1 || !only?.learnDomain) throw redirect({ to: "/join" });
    return { school: { name: only.name, learnDomain: only.learnDomain } };
  },
  component: ToSchool,
});

/**
 * On to the school's learn domain, through its own sign-in start, which comes
 * back to `/login?handoff=` offering this account, then hands it over without
 * another code (ADR 0018, access-12 to 14). In `/`'s place in the history, so
 * Back does not land here only to be sent on again. The link, should leaving
 * not happen.
 */
function ToSchool() {
  const { school, visit } = Route.useRouteContext();
  const href = learnUrl(school.learnDomain, "/api/session/sign-in");
  // Once, as Strict Mode runs an effect twice.
  const left = useRef(false);
  useEffect(() => {
    if (left.current) return;
    left.current = true;
    visit(href, { replace: true });
  }, [href, visit]);
  const { name } = school;
  return (
    <div className="mx-auto flex max-w-140 flex-col items-center gap-4 py-10 text-center">
      <Spinner aria-hidden="true" />
      <p role="status" className="wrap-anywhere">
        <Trans>Taking you to {name}…</Trans>
      </p>
      <a href={href} className="text-sm underline underline-offset-4 wrap-anywhere">
        <Trans>Continue to {name}</Trans>
      </a>
    </div>
  );
}
