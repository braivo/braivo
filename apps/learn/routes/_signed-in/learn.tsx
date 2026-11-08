// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { rememberLastUsed } from "@braivo/auth-client";
import { Button } from "@braivo/ui/components/button";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { AccountHeader } from "#components/account-header";
import { Notice } from "#components/notice";
import { OwnLearning } from "#components/own-learning";
import { OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { readHost } from "#lib/host";
import { pageHead } from "#lib/title";

/**
 * My learning, Braivo's own learn app's home on the installation's origin
 * (ADR 0059): the same for whoever is signed in. Its own courses, and the
 * consoles of the schools they work in and, with no course of their own, the
 * sites of the schools they belong to, both optional, as the page stands
 * without them. Reads only, so opening it creates nothing. On a school's domain, its home.
 */
export const Route = createFileRoute("/_signed-in/learn")({
  // Dropped on leaving, as the course list is: practice changes what is there.
  gcTime: 0,
  loader: async ({ context, abortController }) => {
    // My learning is the origin's alone: a school's domain sends `/learn` to its own home.
    // Unread, the page fails, offering Try again, rather than guess.
    if (!(await readHost(context.braivo)).installation) throw redirect({ to: "/", replace: true });
    const left = abortController.signal;
    const [courses, organizations, schools] = await Promise.all([
      context.braivo.personalCourses({ signal: withDeadline(left, READ_DEADLINE_MS) }),
      context.braivo
        .listOrganizations({ signal: withDeadline(left, OPTIONAL_READ_DEADLINE_MS) })
        .then((listed) => listed.filter(({ personal }) => !personal))
        .catch(() => undefined),
      // The schools whose sites a learner with nothing of their own goes on to;
      // a personal organization never has a learn domain.
      context.braivo
        .listMemberships({ signal: withDeadline(left, OPTIONAL_READ_DEADLINE_MS) })
        .then((listed) => listed.filter(({ learnDomain }) => learnDomain !== null))
        .catch(() => undefined),
    ]);
    return { courses, organizations, schools };
  },
  head: (head) => pageHead(head, t`My learning`),
  component: MyLearning,
  errorComponent: MyLearningError,
});

function MyLearning() {
  const { courses, organizations, schools } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  // The area a bare `/` resumes (ADR 0059): once shown, never by a preload.
  useEffect(() => rememberLastUsed(user.id, { area: "learning" }), [user.id]);
  return <OwnLearning courses={courses} organizations={organizations} schools={schools} />;
}

/** A list that may only have failed to load for now. Trying again reloads it. */
function MyLearningError() {
  const router = useRouter();
  const { t } = useLingui();
  // With the header, so someone whose list fails can still sign out.
  return (
    <>
      <AccountHeader />
      <Notice title={t`Your learning could not be loaded.`}>
        <Button onClick={() => router.invalidate()}>
          <Trans>Try again</Trans>
        </Button>
      </Notice>
    </>
  );
}
