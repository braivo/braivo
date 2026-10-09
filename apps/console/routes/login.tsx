// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { safeRedirect, SignIn } from "@braivo/auth-client";
import { BraivoError } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

import { OPTIONAL_READ_DEADLINE_MS, REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

const expiredTitle = msg`This sign-in has expired`;

/**
 * Signing in on the installation's origin: to the console, or, with
 * `?handoff=`, to the learn domain that sent the person here (ADR 0018).
 */
export const Route = createFileRoute("/login")({
  // `error`: why Google's round trip came back here rather than signed in.
  validateSearch: (search): { redirect?: string; handoff?: string; error?: string } => ({
    redirect: safeRedirect(search.redirect),
    handoff: typeof search.handoff === "string" && search.handoff ? search.handoff : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ context, abortController }) => {
    const [{ data }, offersGoogle] = await Promise.all([
      // One read for both, so they describe the same session. One that cannot
      // be checked, in time or at all, counts as none: signing in is how to find out.
      context.auth
        .getSession({
          fetchOptions: { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) },
        })
        .catch(() => ({ data: null })),
      // Not knowing still leaves the code, so it is no reason to fail the page,
      // nor, on stalled wifi, to keep it waiting.
      context.braivo
        .signInMethods({ signal: withDeadline(abortController.signal, OPTIONAL_READ_DEADLINE_MS) })
        .then(
          (methods) => methods.google,
          () => false,
        ),
    ]);
    const user = data?.user;
    return {
      offersGoogle,
      needsName: user !== undefined && user.name.trim() === "",
      // Whoever is signed in, for a learn domain's sign-in to offer: by name,
      // or by email while unnamed.
      account: user && (user.name.trim() || user.email),
    };
  },
  loaderDeps: ({ search }) => ({ handoff: search.handoff }),
  // `null` for a handoff asked for and gone, `undefined` for none asked for.
  // Unanswered in time, the page fails, offering Try again.
  loader: async ({ context, deps, abortController }) => ({
    handoff:
      deps.handoff === undefined
        ? undefined
        : ((await context.braivo.handoff(deps.handoff, {
            signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS),
          })) ?? null),
  }),
  // A learn domain's sign-in never wears Braivo's name, expired included.
  head: ({ loaderData }) => {
    if (loaderData?.handoff === undefined) return {};
    const organizationName = loaderData.handoff?.organization.name;
    return {
      meta: [{ title: organizationName ? t`Sign in to ${organizationName}` : t(expiredTitle) }],
    };
  },
  component: Login,
});

/**
 * Google's round trip, when the installation offers it: back to `to` signed
 * in, or to this page refused. Built from what this page was asked for, never
 * its current URL, which may hold an earlier refusal.
 */
function useGoogleSignIn(to: string) {
  const { offersGoogle } = Route.useRouteContext();
  const { redirect, handoff, error } = Route.useSearch();
  if (!offersGoogle) return undefined;
  const search = new URLSearchParams(
    handoff !== undefined ? { handoff } : redirect !== undefined ? { redirect } : {},
  ).toString();
  return { callbackURL: to, errorCallbackURL: search ? `/login?${search}` : "/login", error };
}

function Login() {
  const { auth, needsName } = Route.useRouteContext();
  const { redirect, handoff } = Route.useSearch();
  const router = useRouter();
  const google = useGoogleSignIn(redirect ?? "/");

  if (handoff !== undefined) return <LearnDomainSignIn handoffId={handoff} />;
  return (
    <>
      <Heading>Braivo Console</Heading>
      <SignIn
        auth={auth}
        needsName={needsName}
        google={google}
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
  const { t } = useLingui();
  // Back here signed in, where the account is offered as any open session is:
  // only a click hands someone over.
  const google = useGoogleSignIn(`/login?handoff=${encodeURIComponent(handoffId)}`);
  const [view, setView] = useState<"account" | "form" | "leaving" | "refused" | "expired">(
    account ? "account" : "form",
  );
  // Once the account the page opened with is named, signed out, or found
  // signed out, what was read about it no longer holds.
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageDescriptor>();
  // The email to ask the organization to add, what it adds members by
  // (`organization add-member --email`). Read again at the refusal, as the
  // session may have changed since the page opened; best effort, as only the
  // server knows whom it refused.
  const [refusedEmail, setRefusedEmail] = useState<string>();
  // The pressed button is gone by the time a refusal shows, so the focus
  // moves to what comes next, after every refusal, a retried one too.
  const retry = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (view === "refused") retry.current?.focus();
  }, [view]);

  if (!handoff) return <Expired />;
  if (view === "expired") return <Expired hostname={handoff.hostname} />;
  const { name: organizationName } = handoff.organization;
  const { hostname } = handoff;

  /** From the account offered, or one just signed in to; failing, back to the former. */
  async function handOver() {
    setView("leaving");
    setError(undefined);
    try {
      // Leaving stays shown until the page is gone. Unanswered in time, it is
      // offered again: continuing replaces a code issued meanwhile (access-14).
      visit(
        await braivo.completeHandoff(handoffId, {
          signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
        }),
      );
    } catch (thrown) {
      const status = thrown instanceof BraivoError ? thrown.status : undefined;
      if (status === 404) setView("expired");
      else if (status === 403) {
        // The refusal stands even if the session cannot be read.
        const { data } = await auth
          .getSession({ fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
          .catch(() => ({ data: null }));
        setRefusedEmail(data?.user.email);
        setView("refused");
      } else if (status === 401) {
        setStale(true);
        setView("form");
        setError(msg`You were signed out. Sign in again.`);
      } else {
        setView("account");
        setError(
          thrown instanceof BraivoError
            ? msg`Something went wrong. Try again.`
            : msg`Could not connect. Check your connection and try again.`,
        );
      }
    }
  }

  async function switchAccount() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    // Unfinished in time, it may have signed out or not: the account stays offered.
    const { error } = await auth
      .signOut({ fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
      .catch(() => ({ error: true }));
    setPending(false);
    if (error) setError(msg`Could not sign out. Try again.`);
    else {
      setStale(true);
      setView("form");
    }
  }

  // aria-disabled, not disabled, so that they keep the focus meanwhile.
  const another = (
    <Button variant="link" aria-disabled={pending} onClick={switchAccount}>
      <Trans>Use another account</Trans>
    </Button>
  );
  return (
    <>
      <Heading>
        <Trans>Sign in to {organizationName}</Trans>
      </Heading>
      <MutedText className="mb-6 block wrap-break-word">
        <Trans>You will continue at {hostname}.</Trans>
      </MutedText>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {view === "form" && (
        <SignIn
          auth={auth}
          needsName={!stale && needsName}
          google={google}
          onSignedIn={() => {
            setStale(true);
            void handOver();
          }}
        />
      )}
      {view === "leaving" && <Spinner aria-label={t`Signing in`} />}
      {view === "account" && (
        <div className="flex flex-col items-center gap-2">
          {/* Wrapped whole, an unbroken email too: the account is what tells
              a shared device's users apart. */}
          <Button
            className="h-auto min-h-9 w-full py-1.5 whitespace-normal wrap-anywhere"
            aria-disabled={pending}
            // An account still without a name is named first.
            onClick={() => !pending && (!stale && needsName ? setView("form") : handOver())}
          >
            {account && !stale ? t`Continue as ${account}` : t`Continue`}
          </Button>
          {another}
        </div>
      )}
      {view === "refused" && (
        <div className="flex flex-col items-center gap-2">
          {/* Until invitations, the operator adds members by email: the
              learner asks, then retries here while the handoff lasts. */}
          <Alert variant="destructive">
            {/* An unbroken email wraps too, in a box centred by its column. */}
            <AlertDescription className="wrap-anywhere">
              {refusedEmail ? (
                <Trans>
                  {refusedEmail} is not a member of {organizationName}. Ask to be added with this
                  email, then try again.
                </Trans>
              ) : (
                <Trans>
                  This account is not a member of {organizationName}. Ask to be added, then try
                  again.
                </Trans>
              )}
            </AlertDescription>
          </Alert>
          <Button
            ref={retry}
            className="w-full"
            aria-disabled={pending}
            onClick={() => !pending && handOver()}
          >
            <Trans>Try again</Trans>
          </Button>
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
  const { t } = useLingui();
  const heading = useRef<HTMLHeadingElement>(null);
  const title = t(expiredTitle);
  useLayoutEffect(() => {
    document.title = title;
    if (hostname) heading.current?.focus();
  }, [title, hostname]);
  return (
    <>
      <Heading ref={heading} tabIndex={-1}>
        {title}
      </Heading>
      {hostname ? (
        <Button asChild className="mt-6 w-full">
          <a href={`https://${hostname}/login`}>
            <Trans>Sign in again</Trans>
          </a>
        </Button>
      ) : (
        <MutedText>
          <Trans>Go back to the site you came from and sign in again.</Trans>
        </MutedText>
      )}
    </>
  );
}
