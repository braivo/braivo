// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { EmailSignIn, safeRedirect } from "@braivo/auth-client";
import { BraivoError } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

const expiredTitle = "This sign-in has expired";

/**
 * Signing in on the installation's origin: to the console, or, with
 * `?handoff=`, to the learn domain that sent the person here (ADR 0018).
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search): { redirect?: string; handoff?: string } => ({
    redirect: safeRedirect(search.redirect),
    handoff: typeof search.handoff === "string" && search.handoff ? search.handoff : undefined,
  }),
  beforeLoad: async ({ context }) => {
    // One read for both, so they describe the same session. One that cannot be
    // checked counts as none: signing in is how to find out.
    const { data } = await context.auth.getSession().catch(() => ({ data: null }));
    const user = data?.user;
    return {
      needsName: user !== undefined && user.name.trim() === "",
      // Whoever is signed in, for a learn domain's sign-in to offer: by name,
      // or by email while unnamed.
      account: user && (user.name.trim() || user.email),
    };
  },
  loaderDeps: ({ search }) => ({ handoff: search.handoff }),
  // `null` for a handoff asked for and gone, `undefined` for none asked for.
  loader: async ({ context, deps, abortController }) => ({
    handoff:
      deps.handoff === undefined
        ? undefined
        : ((await context.braivo.handoff(deps.handoff, { signal: abortController.signal })) ??
          null),
  }),
  // A learn domain's sign-in never wears Braivo's name, expired included.
  head: ({ loaderData }) =>
    loaderData?.handoff === undefined
      ? {}
      : {
          meta: [
            {
              title: loaderData.handoff
                ? `Sign in to ${loaderData.handoff.organization.name}`
                : expiredTitle,
            },
          ],
        },
  component: SignIn,
});

function SignIn() {
  const { auth, needsName } = Route.useRouteContext();
  const { redirect, handoff } = Route.useSearch();
  const router = useRouter();

  if (handoff !== undefined) return <LearnDomainSignIn handoffId={handoff} />;
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

/**
 * Signing in for a learn domain, under its organization's name rather than
 * Braivo's, then handing the account over as a learner there. An account
 * already signed in is offered, not used: on a shared device it may be
 * someone else's.
 */
function LearnDomainSignIn({ handoffId }: { handoffId: string }) {
  const { auth, braivo, visit, needsName, account } = Route.useRouteContext();
  const { handoff } = Route.useLoaderData();
  const [view, setView] = useState<"account" | "form" | "leaving" | "refused" | "expired">(
    account ? "account" : "form",
  );
  // Once the account the page opened with is named, signed out, or found
  // signed out, what was read about it no longer holds.
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  if (!handoff) return <Expired />;
  if (view === "expired") return <Expired hostname={handoff.hostname} />;
  const { name } = handoff.organization;

  /** From the account offered, or one just signed in to; failing, back to the former. */
  async function handOver() {
    setView("leaving");
    setError(undefined);
    try {
      // Leaving stays shown until the page is gone.
      visit(await braivo.completeHandoff(handoffId));
    } catch (thrown) {
      const status = thrown instanceof BraivoError ? thrown.status : undefined;
      if (status === 404) setView("expired");
      else if (status === 403) setView("refused");
      else if (status === 401) {
        setStale(true);
        setView("form");
        setError("You were signed out. Sign in again.");
      } else {
        setView("account");
        setError(
          thrown instanceof BraivoError
            ? "Something went wrong. Try again."
            : "Could not connect. Check your connection and try again.",
        );
      }
    }
  }

  async function switchAccount() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const { error } = await auth.signOut().catch(() => ({ error: true }));
    setPending(false);
    if (error) setError("Could not sign out. Try again.");
    else {
      setStale(true);
      setView("form");
    }
  }

  // aria-disabled, not disabled, so that they keep the focus meanwhile.
  const another = (
    <Button variant="link" aria-disabled={pending} onClick={switchAccount}>
      Use another account
    </Button>
  );
  return (
    <>
      <Heading>Sign in to {name}</Heading>
      <MutedText className="mb-6 block">You will continue at {handoff.hostname}.</MutedText>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {view === "form" && (
        <EmailSignIn
          auth={auth}
          needsName={!stale && needsName}
          onSignedIn={() => {
            setStale(true);
            void handOver();
          }}
        />
      )}
      {view === "leaving" && <Spinner aria-label="Signing in" />}
      {view === "account" && (
        <div className="flex flex-col items-center gap-2">
          <Button
            className="w-full"
            aria-disabled={pending}
            // An account still without a name is named first.
            onClick={() => !pending && (!stale && needsName ? setView("form") : handOver())}
          >
            {account && !stale ? `Continue as ${account}` : "Continue"}
          </Button>
          {another}
        </div>
      )}
      {view === "refused" && (
        <div className="flex flex-col items-center gap-2">
          <Alert variant="destructive">
            <AlertDescription>This account is not a member of {name}.</AlertDescription>
          </Alert>
          {another}
        </div>
      )}
    </>
  );
}

/**
 * Titled here, as `head` still holds what the loader found. Mid-sign-in the
 * domain is known: the heading takes focus from the button that is gone (on
 * load there is none, and focusing would only draw a ring), and the domain's
 * `/login` starts a new handoff, as only it can set the nonce cookie.
 */
function Expired({ hostname }: { hostname?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    document.title = expiredTitle;
    if (hostname) heading.current?.focus();
  }, [hostname]);
  return (
    <>
      <Heading ref={heading} tabIndex={-1}>
        {expiredTitle}
      </Heading>
      {hostname ? (
        <Button asChild className="mt-6 w-full">
          <a href={`https://${hostname}/login`}>Sign in again</a>
        </Button>
      ) : (
        <MutedText>Go back to the site you came from and sign in again.</MutedText>
      )}
    </>
  );
}
