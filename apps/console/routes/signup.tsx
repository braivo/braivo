// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, safeRedirect } from "@braivo/auth-client";
import { Heading } from "@braivo/ui";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/signup")({
  validateSearch: (search): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  component: SignUp,
});

function SignUp() {
  const { auth } = Route.useRouteContext();
  const { redirect } = Route.useSearch();
  const router = useRouter();

  return (
    <>
      <Heading>Braivo Console</Heading>
      <EmailSignIn
        auth={auth}
        mode="sign-up"
        // Carries `redirect` across, so switching does not lose where to go.
        switchMode={
          <Link to="/login" search={{ redirect }} className="text-sm underline">
            Have an account? Sign in
          </Link>
        }
        // Not to `redirect`: a new account is in no organization, so that page
        // would be not found.
        onSignedIn={() => router.navigate({ to: "/" })}
      />
    </>
  );
}
