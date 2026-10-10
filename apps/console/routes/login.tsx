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
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  ConsoleBrand,
  ConsoleStory,
  LearnerNote,
  ConsoleSignInPage,
} from "#components/sign-in-page";
import { OPTIONAL_READ_DEADLINE_MS, REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

const expiredTitle = msg`This sign-in has expired`;

/**
 * Signing in on the installation's origin: to the console, or, with
 * `?handoff=`, to the learn domain that sent the person here (ADR 0018).
 */
export const Route = createFileRoute("/login")({
  // `error`: why Google's round trip came back here rather than signed in.
  // `provider`: a learn domain's learner chose Google there, which this page
  // starts (ADR 0018).
  validateSearch: (
    search,
  ): { redirect?: string; handoff?: string; error?: string; provider?: "google" } => ({
    redirect: safeRedirect(search.redirect),
    handoff: typeof search.handoff === "string" && search.handoff ? search.handoff : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    provider: search.provider === "google" ? "google" : undefined,
  }),
  beforeLoad: async ({ context, search, abortController }) => {
    // Asked alongside the session, but awaited only for a form to show it.
    // Not knowing still leaves the code, so it is no reason to fail the page,
    // nor, on stalled wifi, to keep it waiting: unread, it offers no Google and
    // links no legal pages.
    const settingsRead = context.braivo
      .signInSettings({ signal: withDeadline(abortController.signal, OPTIONAL_READ_DEADLINE_MS) })
      .catch(() => ({ google: false, legal: null }));
    // One read for both, so they describe the same session. One that cannot be
    // checked, in time or at all, counts as none: signing in is how to find out.
    const { data } = await context.auth
      .getSession({
        fetchOptions: { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) },
      })
      .catch(() => ({ data: null }));
    const user = data?.user;
    // Signed in already (Back, a bookmark): on to where sign-in would lead,
    // in `/login`'s place, as every redirect is. A learn domain's sign-in
    // offers the account instead (access-13).
    if (search.handoff === undefined && user?.name.trim()) {
      throw redirect({ href: search.redirect ?? "/" });
    }
    const settings = await settingsRead;
    return {
      offersGoogle: settings.google,
      legal: settings.legal ?? undefined,
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
  const { auth, needsName, legal } = Route.useRouteContext();
  const { redirect, handoff } = Route.useSearch();
  const router = useRouter();
  const google = useGoogleSignIn(redirect ?? "/");

  if (handoff !== undefined) return <LearnDomainSignIn handoffId={handoff} />;
  return (
    <ConsoleSignInPage
      brand={<ConsoleBrand />}
      aside={<ConsoleStory />}
      footer={`© ${new Date().getFullYear()} Braivo`}
    >
      <SignIn
        auth={auth}
        needsName={needsName}
        google={google}
        legal={legal}
        // In `/login`'s place, so Back does not return to it.
        onSignedIn={() => router.navigate({ href: redirect ?? "/", replace: true })}
      />
      <LearnerNote />
    </ConsoleSignInPage>
  );
}

/**
 * Signing in for a learn domain, under its organization's name rather than
 * Braivo's, then handing the account over as a learner there. An account
 * already signed in is offered, not used: on a shared device it may be
 * someone else's.
 */
function LearnDomainSignIn({ handoffId }: { handoffId: string }) {
  const { auth, braivo, visit, needsName, account, legal } = Route.useRouteContext();
  const { handoff } = Route.useLoaderData();
  const { t } = useLingui();
  // Back here signed in, where the account is offered as any open session is:
  // only a click hands someone over.
  const google = useGoogleSignIn(`/login?handoff=${encodeURIComponent(handoffId)}`);
  const { provider } = Route.useSearch();
  // Google chosen on the learn domain starts at once, unless an account is
  // open here, which is offered first as always: on a shared device it may
  // be someone else's, and Google's round trip would only offer it again.
  const startsGoogle = provider === "google" && google !== undefined && !account;
  const [view, setView] = useState<"account" | "form" | "leaving" | "refused" | "expired">(
    account ? "account" : startsGoogle ? "leaving" : "form",
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
  // Once, as Strict Mode runs an effect twice. Back from Google, the URL has
  // no `provider`, so this never loops.
  const startedGoogle = useRef(false);
  useEffect(() => {
    if (!startsGoogle || !google || !handoff || startedGoogle.current) return;
    startedGoogle.current = true;
    void auth.signIn
      .social({
        provider: "google",
        callbackURL: google.callbackURL,
        errorCallbackURL: google.errorCallbackURL,
        fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      })
      .then(
        ({ error }) =>
          error && msg`Could not sign in with Google. Try again, or sign in with a code.`,
        () => msg`Could not connect. Check your connection and try again.`,
      )
      .then((failed) => {
        // Otherwise leaving for Google: "leaving" stays until the page is gone.
        if (!failed) return;
        setError(failed);
        setView("form");
      });
  }, [startsGoogle, google, handoff, auth]);

  if (!handoff) {
    return (
      <ConsoleSignInPage>
        <Expired />
      </ConsoleSignInPage>
    );
  }
  const { name: organizationName } = handoff.organization;
  const { hostname } = handoff;
  // The organization in Braivo's place, named on every view, as each step of
  // the form heads itself (access-13).
  const brand = <span className="font-semibold wrap-anywhere">{organizationName}</span>;
  if (view === "expired") {
    return (
      <ConsoleSignInPage brand={brand}>
        <Expired hostname={hostname} />
      </ConsoleSignInPage>
    );
  }

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
    <ConsoleSignInPage brand={brand} footer={<Trans>You will continue at {hostname}.</Trans>}>
      {view !== "form" && (
        <Heading>
          <Trans>Sign in to {organizationName}</Trans>
        </Heading>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {view === "form" && (
        <SignIn
          auth={auth}
          title={t`Sign in to ${organizationName}`}
          needsName={!stale && needsName}
          google={google}
          legal={legal}
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
    </ConsoleSignInPage>
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
