// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, safeRedirect } from "@braivo/auth-client";
import { Heading } from "@braivo/ui";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
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
      <EmailSignIn
        auth={auth}
        mode="sign-in"
        // Carries `redirect` across, so switching does not lose where to go.
        switchMode={
          <Link to="/signup" search={{ redirect }} className="text-sm underline">
            New here? Create an account
          </Link>
        }
        onSignedIn={() => router.navigate({ href: redirect ?? "/" })}
      />
    </>
  );
}
