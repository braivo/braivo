// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, needsName, safeRedirect } from "@braivo/auth-client";
import { Heading } from "@braivo/ui";
import { Spinner } from "@braivo/ui/components/spinner";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  validateSearch: (search): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  beforeLoad: async ({ context, search, preload }) => {
    // An organization's domain signs in on the installation's origin, which
    // hands a learner session back here (ADR 0018). A host serving no
    // organization looks like the installation's and gets the code form,
    // which works only there.
    if (await context.braivo.hostOrganization()) {
      // Signed in already (Back, a bookmark): no second handoff. Unnamed, it
      // hands off again, where the console asks for the name.
      const user = await context.braivo.session();
      if (user?.name.trim()) throw redirect({ href: search.redirect ?? "/" });
      // A preload only looks ahead: leaving the app is the navigation's.
      if (!preload) {
        const back = encodeURIComponent(search.redirect ?? "/");
        context.visit(`/api/session/sign-in?redirect=${back}`);
      }
      return { handingOff: true, needsName: false };
    }
    return { handingOff: false, needsName: await needsName(context.auth) };
  },
  component: SignIn,
});

function SignIn() {
  const { auth, handingOff, needsName } = Route.useRouteContext();
  const { redirect } = Route.useSearch();
  const router = useRouter();

  if (handingOff) return <Spinner aria-label="Signing in" />;
  return (
    <>
      <Heading>Sign in</Heading>
      <EmailSignIn
        auth={auth}
        needsName={needsName}
        onSignedIn={() => router.navigate({ href: redirect ?? "/" })}
      />
    </>
  );
}
