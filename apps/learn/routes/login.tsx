// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { needsName, safeRedirect, SignIn } from "@braivo/auth-client";
import { SignInPage } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { learnDomainAuth } from "#lib/auth";
import { OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/login")({
  // `failed`: Google's round trip, by handoff, came back unredeemable
  // (`/api/session/handoff`).
  validateSearch: (search): { redirect?: string; failed?: true } => ({
    redirect: safeRedirect(search.redirect),
    failed: search.failed ? true : undefined,
  }),
  beforeLoad: async ({ context, search, abortController }) => {
    // These reads decide how to sign in: unanswered in time, the page fails,
    // offering Try again, rather than stay blank.
    const signal = withDeadline(abortController.signal, READ_DEADLINE_MS);
    // An organization's domain signs in here, by its own codes, under its
    // name (ADR 0018). A host serving no organization looks like the
    // installation's and gets Better Auth's code form, which works only there.
    const organization = await context.braivo.hostOrganization({ signal });
    if (!organization) {
      // Unread in time, as unread at all, it counts as no session: the form shows.
      const auth = { getSession: () => context.auth.getSession({ fetchOptions: { signal } }) };
      return { organization, needsName: await needsName(auth) };
    }

    // Not knowing what else it offers still leaves the code, so no reason to
    // fail the page, nor to keep it waiting: unread, it offers no Google and
    // links no legal pages.
    const settingsRead = context.braivo
      .signInSettings({ signal: withDeadline(abortController.signal, OPTIONAL_READ_DEADLINE_MS) })
      .catch(() => ({ google: false, legal: null }));
    const user = await context.braivo.session({ signal });
    // Signed in already (Back, a bookmark): on to where sign-in would lead.
    if (user?.name.trim()) throw redirect({ href: search.redirect ?? "/" });
    const settings = await settingsRead;
    return {
      organization,
      // Signed in here, unnamed: the form starts at the name.
      needsName: user !== undefined,
      offersGoogle: settings.google,
      legal: settings.legal ?? undefined,
    };
  },
  head: (match) => pageHead(match, t`Sign in`),
  component: Login,
});

function Login() {
  const context = Route.useRouteContext();
  const { redirect = "/", failed } = Route.useSearch();
  const router = useRouter();
  const { t } = useLingui();
  // In `/login`'s place, so Back does not return to it.
  const onSignedIn = () => router.navigate({ href: redirect, replace: true });

  if (!context.organization) {
    return (
      <SignInPage>
        <SignIn auth={context.auth} needsName={context.needsName} onSignedIn={onSignedIn} />
      </SignInPage>
    );
  }

  const { name: organizationName } = context.organization;
  return (
    // The organization in Braivo's place: no Braivo branding on its domain.
    <SignInPage brand={<span className="font-semibold wrap-anywhere">{organizationName}</span>}>
      {/* Apart from the form, which offers Google only while the installation
          says so: the failure is told even when it no longer does. */}
      {failed && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            {t`Could not sign in with Google. Try again, or sign in with a code.`}
          </AlertDescription>
        </Alert>
      )}
      <SignIn
        auth={learnDomainAuth(context.braivo, context.visit, redirect)}
        title={t`Sign in to ${organizationName}`}
        needsName={context.needsName}
        // Google's round trip is a handoff through the installation's origin,
        // back to `redirect` (`learnDomainAuth`), so these two go unused.
        google={
          context.offersGoogle ? { callbackURL: redirect, errorCallbackURL: "/login" } : undefined
        }
        legal={context.legal}
        onSignedIn={onSignedIn}
      />
    </SignInPage>
  );
}
