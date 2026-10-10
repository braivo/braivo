// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { needsName, safeRedirect, SignIn } from "@braivo/auth-client";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { Notice } from "#components/notice";
import { READ_DEADLINE_MS, withDeadline } from "#lib/deadline";

export const Route = createFileRoute("/login")({
  // `failed`: the handoff came back unredeemable (`/api/session/handoff`).
  validateSearch: (search): { redirect?: string; failed?: true } => ({
    redirect: safeRedirect(search.redirect),
    failed: search.failed ? true : undefined,
  }),
  beforeLoad: async ({ context, search, preload, abortController }) => {
    // These reads decide how to sign in: unanswered in time, the page fails,
    // offering Try again, rather than stay blank.
    const signal = withDeadline(abortController.signal, READ_DEADLINE_MS);
    // An organization's domain signs in on the installation's origin, which
    // hands a learner session back here (ADR 0018). A host serving no
    // organization looks like the installation's and gets the code form,
    // which works only there.
    if (await context.braivo.hostOrganization({ signal })) {
      // Signed in already (Back, a bookmark): no second handoff. Unnamed, it
      // hands off again, where the console asks for the name.
      const user = await context.braivo.session({ signal });
      if (user?.name.trim()) throw redirect({ href: search.redirect ?? "/" });
      // After a failure, only a click hands off again: one that fails each
      // time (cookies blocked) must not cycle unseen.
      if (search.failed) return { view: "failed" as const };
      // A preload only looks ahead: leaving the app is the navigation's.
      if (!preload) context.visit(signInUrl(search.redirect));
      return { view: "handoff" as const };
    }
    // Unread in time, as unread at all, it counts as no session: the form shows.
    const auth = { getSession: () => context.auth.getSession({ fetchOptions: { signal } }) };
    return { view: "form" as const, needsName: await needsName(auth) };
  },
  component: Login,
});

function signInUrl(redirect = "/") {
  return `/api/session/sign-in?redirect=${encodeURIComponent(redirect)}`;
}

function Login() {
  const context = Route.useRouteContext();
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const { t } = useLingui();

  if (context.view === "handoff") return <Spinner aria-label={t`Signing in`} />;
  if (context.view === "failed") {
    return (
      <Notice title={t`This sign-in did not finish.`} description={t`It may have expired.`}>
        <Button onClick={() => context.visit(signInUrl(redirect))}>
          <Trans>Sign in again</Trans>
        </Button>
      </Notice>
    );
  }
  return (
    <SignIn
      auth={context.auth}
      needsName={context.needsName}
      // In `/login`'s place, so Back does not return to it.
      onSignedIn={() => router.navigate({ href: redirect ?? "/", replace: true })}
    />
  );
}
