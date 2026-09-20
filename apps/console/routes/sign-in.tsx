// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, safeRedirect } from "@braivo/auth-client";
import { Heading } from "@braivo/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  component: SignIn,
});

function SignIn() {
  const { auth } = Route.useRouteContext();
  const { redirect } = Route.useSearch();
  const router = useRouter();

  return (
    <>
      <Heading>Braivo Console</Heading>
      {/* `href`, like `redirect`, is relative to the router's base path; the
          history's own `push` is not, and would leave the console for `/`. */}
      <EmailSignIn auth={auth} onSignedIn={() => router.navigate({ href: redirect ?? "/" })} />
    </>
  );
}
