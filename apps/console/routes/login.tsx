// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, needsName, safeRedirect } from "@braivo/auth-client";
import { Heading } from "@braivo/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  validateSearch: (search): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  beforeLoad: async ({ context }) => ({ needsName: await needsName(context.auth) }),
  component: SignIn,
});

function SignIn() {
  const { auth, needsName } = Route.useRouteContext();
  const { redirect } = Route.useSearch();
  const router = useRouter();

  return (
    <>
      <Heading>Braivo Console</Heading>
      <EmailSignIn
        auth={auth}
        needsName={needsName}
        onSignedIn={() => router.navigate({ href: redirect ?? "/" })}
      />
    </>
  );
}
