// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type InvitationResult } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@braivo/ui/components/radio-group";
import { Spinner } from "@braivo/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { msg, t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CircleExclamationPointIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { CopyButton } from "#components/copy-button";
import { NoSuchSetting } from "#components/no-such-setting";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { sayRoles } from "#lib/roles";
import { pageHead } from "#lib/title";

/**
 * Who belongs to the organization, by name, with their roles (access-26),
 * and who is invited (access-50, 51): a learner, an author, or an admin, by
 * email (ADR 0018); removal stays the operator's for now. Teaching
 * belongs to groups, not roles (access-38), so each role shows with the
 * groups its member teaches.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/members")({
  beforeLoad: administratorsOnly,
  loader: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    // Both or neither: without the groups, a teacher would read as only a learner.
    const [members, groups, invitations] = await Promise.all([
      orNotFound(context.braivo.listMembers(context.organization.id, options)),
      orNotFound(context.braivo.listGroups(context.organization.id, options)),
      orNotFound(context.braivo.listInvitations(context.organization.id, options)),
    ]);
    return { members, groups, invitations };
  },
  head: (head) => pageHead(head, t`Members`),
  // A page per organization: switching carries over nothing typed or sending.
  remountDeps: ({ params }) => params.organizationSlug,
  component: Members,
  notFoundComponent: NoSuchSetting,
});

function Members() {
  const { members, groups } = Route.useLoaderData();
  const { user, organization } = Route.useRouteContext();
  const { i18n } = useLingui();
  const count = members.length;
  // The groups each teaches, "Spanish A and Spanish B", in the reader's language.
  const listFormat = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  const groupsTaughtBy = (userId: string) =>
    groups
      .filter(({ teachers }) => teachers.some((teacher) => teacher.userId === userId))
      .map(({ name }) => name);
  return (
    <>
      <Heading>
        <Trans>Members</Trans>
      </Heading>
      <MutedText className="mb-4 block wrap-break-word">
        <Plural value={count} one="# member." other="# members." />{" "}
        <Trans>
          Invite learners, authors, and admins here. Anyone is removed by whoever runs Braivo for
          you.
        </Trans>{" "}
        <Trans>
          To let a member read their learners' progress, make them a teacher in a{" "}
          <Link
            to="/$organizationSlug/settings/groups"
            params={{ organizationSlug: organization.slug }}
            className="underline underline-offset-4"
          >
            group
          </Link>
          .
        </Trans>
      </MutedText>
      <InviteForm />
      <Invitations />
      <Heading level={2} className="mt-8 mb-2">
        <Trans>Members</Trans>
      </Heading>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              {/* A person's, which Polish words apart from a thing's. */}
              <Trans context="person">Name</Trans>
            </TableHead>
            <TableHead>
              <Trans>Role</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell className="align-top whitespace-normal">
                {/* A gap, not a margin, so a badge that wraps starts where the name does. */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="wrap-anywhere">{member.name}</span>
                  {member.userId === user.id && (
                    <Badge variant="secondary">
                      <Trans>You</Trans>
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {sayRoles(i18n, member.roles)}
                <Teaching groupNames={groupsTaughtBy(member.userId)} listFormat={listFormat} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/** The groups a member teaches, by name, if any (access-38). */
function Teaching({
  groupNames,
  listFormat,
}: {
  groupNames: string[];
  listFormat: Intl.ListFormat;
}) {
  if (groupNames.length === 0) return null;
  const names = listFormat.format(groupNames);
  return (
    <MutedText className="block wrap-anywhere">
      <Trans>Teaches {names}</Trans>
    </MutedText>
  );
}

/** The roles an invitation offers, each with what it lets someone do (ADR 0048). */
const INVITED_ROLES = [
  { value: "member", label: msg`Learner`, does: msg`Practise its courses` },
  { value: "author", label: msg`Author`, does: msg`Manage and publish content` },
  { value: "admin", label: msg`Admin`, does: msg`Manage people, settings, and content` },
] as const;

/** The last invitation's outcome; its count keys the message, so a repeat is announced too. */
type Outcome = {
  email: string;
  result: InvitationResult | "failed" | "refused" | "no learn domain";
  count: number;
};

/** A role an invitation carries. */
type InvitedRole = (typeof INVITED_ROLES)[number]["value"];

/** Invites one address as a learner, an author, or an admin, mailing them its link (access-50). */
function InviteForm() {
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t, i18n } = useLingui();
  const id = useId();
  const [role, setRole] = useState<InvitedRole>("member");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the field from submitting the form.
    if (pending) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("email") as HTMLInputElement;
    const email = input.value.trim().toLowerCase();
    if (!email) {
      input.setCustomValidity(t`Enter an email address.`);
      input.reportValidity();
      return;
    }

    setPending(true);
    const next = (result: Outcome["result"]) =>
      setOutcome((last) => ({ email, result, count: (last?.count ?? 0) + 1 }));
    try {
      const result = await braivo.invite(
        organization.id,
        { email, role },
        {
          signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
          // The mail's language: the inviter's, as the page shows it (localization-6).
          headers: { "Accept-Language": i18n.locale },
        },
      );
      setPending(false);
      next(result);
      if (result.outcome === "invited") {
        form.reset();
        setRole("member");
        // Lists it among those waiting, with its link.
        await router.invalidate();
      }
    } catch (thrown) {
      setPending(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      const code = thrown instanceof BraivoError ? thrown.code : undefined;
      next(
        code === "EMAIL_INVALID"
          ? "refused"
          : code === "NO_LEARN_DOMAIN"
            ? "no learn domain"
            : "failed",
      );
      // Perhaps no longer managing it: if so, the page, read again, says so.
      if (thrown instanceof BraivoError && thrown.status === 403) await router.invalidate();
    }
  }

  const result = outcome?.result;
  const email = outcome?.email ?? "";
  // What went wrong, or what the address holds already: an alert. What worked: a status.
  const alert =
    result === "failed" ? (
      <Trans>Could not send the invitation. Try again.</Trans>
    ) : result === "refused" ? (
      <Trans>Enter a valid email address.</Trans>
    ) : result === "no learn domain" ? (
      <Trans>
        Learners have no site to practise on yet, so none can be invited. Authors and admins can.
      </Trans>
    ) : result?.outcome === "invited" && !result.emailSent ? (
      <Trans>
        {email} is invited, but the email could not be sent. Copy the link below and send it to
        them.
      </Trans>
    ) : undefined;
  const said = (roles: readonly string[]) => sayRoles(i18n, roles);
  const status =
    result === undefined || typeof result === "string" ? undefined : result.outcome === "invited" &&
      result.emailSent ? (
      <Trans>Invitation sent to {email}.</Trans>
    ) : result.outcome === "already a member" ? (
      <Trans>
        {email} is already a member, as {said(result.roles)}.
      </Trans>
    ) : result.outcome === "already invited" ? (
      <Trans>
        {email} is already invited, as {said(result.role ? [result.role] : [])}. Their invitation
        stays as it is.
      </Trans>
    ) : undefined;

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-6">
      <Heading level={2} id={`${id}-heading`} className="mb-2">
        <Trans>Invite</Trans>
      </Heading>
      <form onSubmit={invite}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>
              <Trans>Email address</Trans>
            </FieldLabel>
            <Input
              id={`${id}-email`}
              name="email"
              type="email"
              required
              autoComplete="off"
              readOnly={pending}
              aria-describedby={`${id}-email-hint`}
              onChange={(event) => event.currentTarget.setCustomValidity("")}
            />
            <FieldDescription id={`${id}-email-hint`}>
              <Trans>They accept by signing in with this address.</Trans>
            </FieldDescription>
          </Field>
          <FieldSet>
            <FieldLegend variant="label" id={`${id}-role`}>
              <Trans>Role</Trans>
            </FieldLegend>
            <RadioGroup
              aria-labelledby={`${id}-role`}
              value={role}
              onValueChange={(value) => setRole(value as InvitedRole)}
            >
              {INVITED_ROLES.map(({ value, label, does }) => (
                <div key={value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={value}
                    id={`${id}-${value}`}
                    className="mt-0.5"
                    aria-describedby={`${id}-${value}-does`}
                  />
                  <div className="grid gap-0.5">
                    <FieldLabel htmlFor={`${id}-${value}`} className="font-normal">
                      {i18n._(label)}
                    </FieldLabel>
                    <MutedText id={`${id}-${value}-does`}>{i18n._(does)}</MutedText>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </FieldSet>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" aria-disabled={pending}>
              {pending ? (
                <>
                  {/* Hidden: "Sending…" already says it. */}
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                  <Trans>Sending…</Trans>
                </>
              ) : (
                <Trans>Send invitation</Trans>
              )}
            </Button>
            {/* Mounted before it says anything: a status region shown already
                filled is not reliably announced. */}
            <p
              key={outcome?.count}
              role="status"
              className="text-sm wrap-anywhere text-muted-foreground"
            >
              {status}
            </p>
          </div>
        </FieldGroup>
      </form>
      {alert && (
        <Alert key={outcome?.count} variant="destructive" className="mt-4">
          <CircleExclamationPointIcon />
          <AlertDescription className="wrap-anywhere">{alert}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

/** Invitations waiting to be accepted, each with its link to copy (access-51). */
function Invitations() {
  const { invitations } = Route.useLoaderData();
  const { i18n, t } = useLingui();
  const id = useId();
  if (invitations.length === 0) return null;
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "long" });
  return (
    <section aria-labelledby={`${id}-heading`} className="mt-8">
      <Heading level={2} id={`${id}-heading`} className="mb-2">
        <Trans>Invitations</Trans>
      </Heading>
      <MutedText className="mb-3 block wrap-break-word">
        <Trans>
          A link works only for the address it was sent to: whoever opens it still signs in with a
          code sent to that email, or with Google.
        </Trans>
      </MutedText>
      <ul className="divide-y rounded-lg border">
        {invitations.map((invitation) => {
          const link = new URL(`/invitations/${invitation.id}`, window.location.origin).href;
          const inviter = invitation.inviter.name;
          const expires = date.format(new Date(invitation.expiresAt));
          return (
            <li key={invitation.id} className="grid gap-1 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium wrap-anywhere">{invitation.email}</span>
                <Badge variant="secondary">{sayRoles(i18n, [invitation.role])}</Badge>
              </div>
              <MutedText className="block wrap-break-word">
                <Trans>
                  Invited by {inviter}. Expires on {expires}.
                </Trans>
              </MutedText>
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-mono text-xs wrap-anywhere text-muted-foreground">
                  {link}
                </span>
                <CopyButton value={link} label={t`Copy link`} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
