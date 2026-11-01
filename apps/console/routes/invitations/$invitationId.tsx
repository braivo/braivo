// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { InvitationPage } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ConsoleBrand, ConsoleSignInPage } from "#components/sign-in-page";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

/**
 * Accepting an invitation to an organization (ADR 0018). Signed out, the
 * page names the school alone and leads to sign in, then back; signed in, the
 * account it was sent to accepts by pressing a button naming the school, the
 * role, and the account, never by arriving, so a wrong account on a shared
 * device is noticed. Another account is told so, and offered to sign out.
 */
export const Route = createFileRoute("/invitations/$invitationId")({
  // Another invitation starts afresh: nothing pressed or refused carries over.
  remountDeps: ({ params }) => params.invitationId,
  beforeLoad: async ({ context, location, abortController }) => {
    // One that cannot be checked in time counts as none: signing in finds out.
    const { data } = await context.auth
      .getSession({
        fetchOptions: { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) },
      })
      .catch(() => ({ data: null }));
    const user = data?.user;
    // Named first, as anyone new is, by `/login`'s step, then back here.
    if (user && !user.name.trim()) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    return { email: user?.email };
  },
  // `null` for an invitation that does not exist, shown as an expired one.
  loader: async ({ context, params, abortController }) => ({
    invitation:
      (await context.braivo.invitation(params.invitationId, {
        signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS),
      })) ?? null,
  }),
  head: ({ loaderData }) => {
    const name = loaderData?.invitation?.organization.name;
    return { meta: [{ title: name ? t`Invitation to ${name}` : t`Invitation` }] };
  },
  component: Invitation,
});

/** What accepting makes someone, as the page says it: whole sentences, so each language words its own. */
const ROLE_COPY: Record<
  string,
  { join: (school: string) => MessageDescriptor; does: MessageDescriptor }
> = {
  author: {
    join: (school) => msg`Join ${school} as an author`,
    does: msg`There, you will manage and publish learning content.`,
  },
  admin: {
    join: (school) => msg`Join ${school} as an admin`,
    does: msg`There, you will manage people, settings, and learning content.`,
  },
};

function Invitation() {
  const { invitation } = Route.useLoaderData();
  const { email } = Route.useRouteContext();
  return (
    <ConsoleSignInPage brand={<ConsoleBrand />}>
      <InvitationState invitation={invitation} email={email} />
    </ConsoleSignInPage>
  );
}

function InvitationState({
  invitation,
  email,
}: {
  invitation: InvitationPage | null;
  email: string | undefined;
}) {
  const { invitationId } = Route.useParams();
  const returnTo = `/invitations/${encodeURIComponent(invitationId)}`;

  if (!invitation) {
    return (
      <Closed heading={<Trans>This invitation has expired</Trans>}>
        <Trans>Ask whoever invited you to send a new one.</Trans>
      </Closed>
    );
  }
  const school = invitation.organization.name;
  if (invitation.status === "expired") {
    return (
      <Closed heading={<Trans>This invitation has expired</Trans>}>
        <Trans>Ask {school} to send a new one.</Trans>
      </Closed>
    );
  }
  if (invitation.status === "canceled") {
    return (
      <Closed heading={<Trans>This invitation was cancelled</Trans>}>
        <Trans>If you still need to join, ask {school}.</Trans>
      </Closed>
    );
  }
  if (email === undefined) {
    return (
      <>
        <Heading>
          <Trans>Join {school}</Trans>
        </Heading>
        <MutedText className="mb-6 block wrap-break-word">
          {invitation.status === "accepted" ? (
            <Trans>This invitation was accepted. Sign in to continue.</Trans>
          ) : (
            <Trans>
              You are invited. Sign in with the email address the invitation was sent to.
            </Trans>
          )}
        </MutedText>
        <Button asChild className="w-full">
          <Link to="/login" search={{ redirect: returnTo }}>
            {invitation.status === "accepted" ? (
              <Trans>Sign in to continue</Trans>
            ) : (
              <Trans>Sign in to accept</Trans>
            )}
          </Link>
        </Button>
      </>
    );
  }
  if (!invitation.recipient) return <Mismatch email={email} />;
  return <Accept invitation={invitation} email={email} />;
}

/** An invitation that can no longer be accepted: what happened, and what to do. */
function Closed({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <>
      <Heading>{heading}</Heading>
      <MutedText className="wrap-break-word">{children}</MutedText>
    </>
  );
}

/**
 * Signs out, then shows the page again, signed out: for whoever is on someone
 * else's account. Not while `busy`, accepting meanwhile.
 */
function useAnotherAccount(busy = false) {
  const { auth } = Route.useRouteContext();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(0);
  async function switchAccount() {
    if (pending || busy) return;
    setPending(true);
    const { error } = await auth
      .signOut({ fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
      .catch(() => ({ error: true }));
    setPending(false);
    if (error) setFailed((count) => count + 1);
    else await router.invalidate();
  }
  const button = (
    <Button variant="link" aria-disabled={pending || busy} onClick={switchAccount}>
      <Trans>Use another account</Trans>
    </Button>
  );
  const alert = failed > 0 && (
    <Alert key={failed} variant="destructive">
      <AlertDescription>
        <Trans>Could not sign out. Try again.</Trans>
      </AlertDescription>
    </Alert>
  );
  return { button, alert, pending };
}

function Mismatch({ email }: { email: string }) {
  const another = useAnotherAccount();
  return (
    <>
      <Heading>
        <Trans>This invitation was sent to another email</Trans>
      </Heading>
      <MutedText className="mb-6 block wrap-anywhere">
        <Trans>You are signed in as {email}. Sign in with the address it was sent to.</Trans>
      </MutedText>
      <div className="flex flex-col items-center gap-2">
        {another.alert}
        {another.button}
      </div>
    </>
  );
}

function Accept({ invitation, email }: { invitation: InvitationPage; email: string }) {
  const { auth } = Route.useRouteContext();
  const { invitationId } = Route.useParams();
  const router = useRouter();
  const { i18n } = useLingui();
  const [pending, setPending] = useState(false);
  const another = useAnotherAccount(pending);
  const [failure, setFailure] = useState<{ message: MessageDescriptor; count: number }>();
  // An answer arriving after this page was left belongs to no page shown.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const school = invitation.organization.name;
  // The recipient's answer names it; a member continues there.
  const slug = invitation.organization.slug ?? "";
  const inviter = invitation.inviter?.name ?? "";
  const role = ROLE_COPY[invitation.role ?? ""];
  const toConsole = () =>
    router.navigate({
      to: "/$organizationSlug",
      params: { organizationSlug: slug },
      replace: true,
    });

  async function accept() {
    if (pending || another.pending) return;
    setPending(true);
    setFailure(undefined);
    const fail = (message: MessageDescriptor) =>
      setFailure((last) => ({ message, count: (last?.count ?? 0) + 1 }));
    const answer = await auth
      .$fetch("/organization/accept-invitation", {
        method: "POST",
        body: { invitationId },
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      })
      .catch(() => undefined);
    if (!shown.current) return;
    if (answer && !answer.error) return await toConsole();
    setPending(false);
    if (!answer) return fail(msg`Could not connect. Check your connection and try again.`);
    const { code } = answer.error as { code?: string };
    if (code === "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED") {
      return fail(msg`${school} has no room for new members. Contact them.`);
    }
    fail(msg`Could not join. Try again.`);
    // Signed out or in as another account, cancelled, accepted, or made a
    // member another way meanwhile: the page, read again, says which.
    await router.invalidate();
  }

  if (invitation.member && invitation.status !== "accepted") {
    return (
      <>
        <Heading>
          <Trans>You already belong to {school}</Trans>
        </Heading>
        <MutedText className="wrap-break-word">
          <Trans>Your role there stays as it is.</Trans>
        </MutedText>
        <Button className="mt-6 w-full" onClick={() => void toConsole()}>
          <Trans>Continue</Trans>
        </Button>
      </>
    );
  }
  if (invitation.status === "accepted") {
    return (
      <>
        <Heading>
          <Trans>You have joined {school}</Trans>
        </Heading>
        <Button className="mt-6 w-full" onClick={() => void toConsole()}>
          <Trans>Continue</Trans>
        </Button>
      </>
    );
  }
  return (
    <>
      <Heading>
        <Trans>Join {school}</Trans>
      </Heading>
      <MutedText className="mb-6 block wrap-break-word">
        <Trans>{inviter} invited you.</Trans> {role && i18n._(role.does)}
      </MutedText>
      <div className="flex flex-col items-center gap-2">
        {failure && (
          <Alert key={failure.count} variant="destructive">
            <AlertDescription className="wrap-break-word">
              {i18n._(failure.message)}
            </AlertDescription>
          </Alert>
        )}
        <Button
          className="h-auto min-h-9 w-full py-1.5 whitespace-normal wrap-anywhere"
          aria-disabled={pending}
          onClick={() => void accept()}
        >
          {pending && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {role ? i18n._(role.join(school)) : <Trans>Join {school}</Trans>}
        </Button>
        <MutedText className="text-center wrap-anywhere">
          <Trans>Signed in as {email}</Trans>
        </MutedText>
        {another.alert}
        {another.button}
      </div>
    </>
  );
}
