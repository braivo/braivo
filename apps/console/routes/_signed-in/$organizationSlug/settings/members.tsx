// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BraivoError,
  type InvitableRole,
  type InvitationResult,
  type InvitationBatchResult,
  type Member,
  type PendingInvitation,
} from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@braivo/ui/components/alert-dialog";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@braivo/ui/components/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@braivo/ui/components/field";
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
import { Textarea } from "@braivo/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CircleExclamationPointIcon, EllipsisIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { CopyButton } from "#components/copy-button";
import { NameTag } from "#components/name-tag";
import { NoSuchSetting } from "#components/no-such-setting";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { type InvitationDraft, invitationDrafts } from "#lib/invitation-drafts";
import { nameWithTag, sharedNameTags } from "#lib/name-tags";
import { refreshInPlace } from "#lib/page-scroller";
import { schoolAdministratorsOnly, orNotFound } from "#lib/refusals";
import { sayRoles } from "#lib/roles";
import { pageHead } from "#lib/title";

/**
 * Who belongs to the organization, by name, with their roles (access-26),
 * each but an owner and oneself given another role or removed (access-56);
 * and who is invited (access-50, 51): learners, authors, or admins, up to
 * 100 addresses at once, each reported, with Resend and Cancel, and those
 * expired to invite again (ADR 0018). Teaching belongs to groups, not roles
 * (access-38), so each role shows with the groups its member teaches.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/members")({
  beforeLoad: schoolAdministratorsOnly,
  loader: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    // Both or neither: without the groups, a teacher would read as only a learner.
    const [members, groups, waiting] = await Promise.all([
      orNotFound(context.braivo.listMembers(context.organization.id, options)),
      orNotFound(context.braivo.listGroups(context.organization.id, options)),
      orNotFound(context.braivo.listInvitations(context.organization.id, options)),
    ]);
    return { members, groups, ...waiting };
  },
  head: (head) => pageHead(head, t`Members`),
  // A page per organization: switching carries over nothing typed or sending.
  remountDeps: ({ params }) => params.organizationSlug,
  component: Members,
  notFoundComponent: NoSuchSetting,
});

function Members() {
  const { members, groups } = Route.useLoaderData();
  const { organization, user } = Route.useRouteContext();
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
        <Trans>Invite learners, authors, and admins here.</Trans>{" "}
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
      {/* Per account: another signed in meanwhile finds no draft of this one's. */}
      <InviteForm key={user.id} />
      <Invitations />
      <MemberList members={members} groupsTaughtBy={groupsTaughtBy} listFormat={listFormat} />
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

/** What came of acting on a member or an invitation: said, or alerted; its count keys a repeat. */
type Notice = { said?: ReactNode; alert?: ReactNode; count: number };

/**
 * A notice's setter that counts, so an alert said twice is announced twice
 * (docs/apps.md), and a failure's words: signed out, the page stays, since
 * the invite field may hold pasted addresses; refused because the page is
 * stale (403, 404, 409), the page is read again, which shows how things stand,
 * the focus going to `heading` if the control that had it went with its row.
 */
function useNotice(heading: RefObject<HTMLHeadingElement | null>) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>();
  // A reread just answered, which may have removed the row whose control had
  // the focus: checked once, on the commit after it, then forgotten.
  const [reread, setReread] = useState(0);
  useLayoutEffect(() => {
    if (reread === 0) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected) heading.current?.focus();
  }, [reread, heading]);
  const say = (next: Omit<Notice, "count">) =>
    setNotice((last) => ({ ...next, count: (last?.count ?? 0) + 1 }));
  async function failed(thrown: unknown, words: ReactNode) {
    const status = thrown instanceof BraivoError ? thrown.status : undefined;
    if (status === 401) {
      return say({
        alert: (
          <Trans>
            You were signed out.{" "}
            <a href="/login" target="_blank" rel="noopener" className="underline">
              Sign in again in a new tab
            </a>
            , then try again.
          </Trans>
        ),
      });
    }
    say({ alert: words });
    if (status !== 403 && status !== 404 && status !== 409) return;
    // No longer theirs to manage, the reread may leave the page; else it stays where it was.
    await (status === 403 ? router.invalidate() : refreshInPlace(router));
    // Rendered after the reread's own commit, so its rows are as read.
    setReread((count) => count + 1);
  }
  return { notice, say, failed } as const;
}

/** A notice's two regions, mounted once so a status filled later is announced. */
function NoticeRegions({ notice, className }: { notice: Notice | undefined; className?: string }) {
  return (
    <>
      <p role="status" className={`text-sm wrap-anywhere text-muted-foreground ${className ?? ""}`}>
        {notice?.said}
      </p>
      {notice?.alert && (
        <Alert key={notice.count} variant="destructive" className="mb-3">
          <CircleExclamationPointIcon />
          <AlertDescription className="wrap-break-word">{notice.alert}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/** The one role an administrator gives, of the roles a member holds: the widest. */
const widestRole = (roles: readonly string[]): InvitableRole =>
  roles.includes("admin") ? "admin" : roles.includes("author") ? "author" : "member";

/**
 * The members, each with their roles and the groups they teach, and, for
 * each but an owner and oneself, a menu giving another role or removing
 * them (access-56). What came of it is said above the table: a removed
 * member's row is gone once the page is read again.
 */
function MemberList(props: {
  members: Member[];
  groupsTaughtBy: (userId: string) => string[];
  listFormat: Intl.ListFormat;
}) {
  const { user } = Route.useRouteContext();
  const { i18n } = useLingui();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useNotice(heading);
  // Two members of one name told apart wherever one is acted on.
  const tags = sharedNameTags(props.members);
  return (
    <section aria-labelledby={`${id}-heading`} className="mt-8">
      <Heading ref={heading} tabIndex={-1} level={2} id={`${id}-heading`} className="mb-2">
        <Trans>Members</Trans>
      </Heading>
      <NoticeRegions notice={actions.notice} className="mb-2" />
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
            <TableHead className="w-0">
              <span className="sr-only">
                <Trans>Actions</Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell className="align-top whitespace-normal">
                {/* A gap, not a margin, so a badge that wraps starts where the name does. */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="wrap-anywhere">
                    {member.name}
                    <NameTag tag={tags.get(member.userId)} />
                  </span>
                  {member.userId === user.id && (
                    <Badge variant="secondary">
                      <Trans>You</Trans>
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {sayRoles(i18n, member.roles)}
                <Teaching
                  groupNames={props.groupsTaughtBy(member.userId)}
                  listFormat={props.listFormat}
                />
              </TableCell>
              <TableCell className="py-1 text-end align-top">
                {member.userId !== user.id && !member.roles.includes("owner") && (
                  <MemberActions
                    member={member}
                    name={nameWithTag(member.name, tags.get(member.userId))}
                    actions={actions}
                    heading={heading}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * One member's menu: their role, chosen among Learner, Author, and Admin and
 * applied at once, and removing them, asked first.
 */
function MemberActions(props: {
  member: Member;
  /** Their name, tagged when another member shares it. */
  name: string;
  actions: ReturnType<typeof useNotice>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { member, name, actions, heading } = props;
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { i18n, t } = useLingui();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The dialog opens from the menu, not a trigger of its own: closed, it gives the focus back here.
  const menuButton = useRef<HTMLButtonElement>(null);

  /** A refusal that trying again cannot undo, said so; its row is read again. */
  function refusal(thrown: unknown) {
    const code = thrown instanceof BraivoError ? thrown.code : undefined;
    if (code === "MEMBER_NOT_FOUND") return <Trans>{name} is no longer a member.</Trans>;
    if (code === "MEMBER_IS_OWNER") {
      return <Trans>{name} is an owner now, whose membership is not changed here.</Trans>;
    }
    return undefined;
  }

  async function changeRole(role: InvitableRole) {
    if (pending || role === widestRole(member.roles)) return;
    setPending(true);
    try {
      const changed = await braivo.setMemberRole(organization.id, member.userId, role, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
      const roles = sayRoles(i18n, changed.roles);
      actions.say({
        said: (
          <Trans>
            {name} is now {roles}.
          </Trans>
        ),
      });
      await refreshInPlace(router);
    } catch (thrown) {
      await actions.failed(
        thrown,
        refusal(thrown) ?? <Trans>Could not change {name}'s role. Try again.</Trans>,
      );
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (pending) return;
    setPending(true);
    try {
      await braivo.removeMember(organization.id, member.userId, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
      actions.say({ said: <Trans>{name} was removed.</Trans> });
      await refreshInPlace(router);
      // Their row, and the menu that had the focus, are gone.
      heading.current?.focus();
    } catch (thrown) {
      await actions.failed(
        thrown,
        refusal(thrown) ?? <Trans>Could not remove {name}. Try again.</Trans>,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuButton}
            variant="ghost"
            size="icon-sm"
            aria-label={t`Change or remove ${name}`}
            aria-disabled={pending}
          >
            {pending ? <Spinner aria-hidden="true" /> : <EllipsisIcon aria-hidden="true" />}
          </Button>
        </DropdownMenuTrigger>
        {/* Wide enough for "Administrator" and its check, in Polish too. */}
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel>
            <Trans>Role</Trans>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={widestRole(member.roles)}
            onValueChange={(value) => void changeRole(value as InvitableRole)}
          >
            {INVITED_ROLES.map(({ value, label }) => (
              <DropdownMenuRadioItem key={value} value={value} disabled={pending}>
                {i18n._(label)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => setConfirming(true)}
          >
            <Trans>Remove…</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Kept, or still to be removed: their menu. Removed, `remove` moves it on.
            event.preventDefault();
            menuButton.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">
              <Trans>Remove {name}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                They leave its groups and can no longer practise or work here. Their learning
                history is kept. You can invite them again.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep them</Trans>
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              <Trans>Remove</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The roles an invitation offers, each with what it lets someone do (ADR 0048). */
const INVITED_ROLES = [
  { value: "member", label: msg`Learner`, does: msg`Practise its courses` },
  { value: "author", label: msg`Author`, does: msg`Manage and publish content` },
  { value: "admin", label: msg`Admin`, does: msg`Manage people, settings, and content` },
] satisfies { value: InvitableRole; label: MessageDescriptor; does: MessageDescriptor }[];

/**
 * Why an address was not invited, or not mailed again (access-50): each a
 * sentence of its own, said after the address in a submission's results and
 * alone beside a Resend.
 */
const REFUSED: Record<string, MessageDescriptor> = {
  EMAIL_INVALID: msg`Not a valid email address.`,
  RECIPIENT_DAILY_LIMIT: msg`Sent three invitations in the last 24 hours. Try again later.`,
  RECIPIENT_COOLDOWN: msg`Sent an invitation a moment ago. Try again in a minute.`,
  ORGANIZATION_HOURLY_LIMIT: msg`300 invitations were sent from here in the last hour. Try again later.`,
  PENDING_LIMIT: msg`Too many invitations are waiting. Wait for some to be accepted or expire.`,
  NO_LEARN_DOMAIN: msg`Learners have no site to practise on yet.`,
};

/** An invitation's link, on this origin: the console's, where it is accepted. */
const linkTo = (invitationId: string) =>
  new URL(`/invitations/${invitationId}`, window.location.origin).href;

/** One address's result, as a sentence after it. */
function ResultSentence({ result }: { result: InvitationResult }) {
  const { i18n, t } = useLingui();
  switch (result.outcome) {
    case "invited":
      return result.emailSent ? (
        <Trans>Invitation sent.</Trans>
      ) : (
        // Its link beside it: in a class, its card in the list below is far away.
        <>
          <Trans>Invited, but the email may not have gone.</Trans>{" "}
          <CopyButton value={linkTo(result.invitation.id)} label={t`Copy link`} />
        </>
      );
    case "already invited": {
      const role = sayRoles(i18n, [result.role]);
      return <Trans>Already invited, as {role}. The invitation stays as it is.</Trans>;
    }
    case "already a member": {
      const roles = sayRoles(i18n, result.roles);
      return <Trans>Already a member, as {roles}.</Trans>;
    }
    case "refused":
      return <>{i18n._(REFUSED[result.code]!)}</>;
    default:
      return <Trans>Could not be invited. Try again.</Trans>;
  }
}

/**
 * Addresses as typed or pasted: separated by spaces, commas, semicolons, or
 * lines, as a spreadsheet's column or a mail's recipients copy. Braivo
 * normalizes and deduplicates them.
 */
const addressesIn = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

/** A submission answered, or why the whole of it was not; its count keys what it says. */
type Outcome = {
  answer?: InvitationBatchResult;
  refusal?: "too many" | "no learn domain" | "signed out" | "failed";
  count: number;
};

/**
 * Invites up to 100 addresses as a learner, an author, or an admin, mailing
 * each its link (access-50), and says what came of each. Those that may
 * work on another try stay in the field.
 */
function InviteForm() {
  const { organization, braivo, user } = Route.useRouteContext();
  const { membersLeft } = Route.useLoaderData();
  const router = useRouter();
  const { t, i18n } = useLingui();
  const id = useId();
  const draft = invitationDrafts.get(user.id, organization.id);
  const emailsField = useRef<HTMLTextAreaElement>(null);
  const [role, setRole] = useState<InvitableRole>(draft?.role ?? "member");
  // Both as they are now, whichever changed.
  const keep = (next: Partial<InvitationDraft> = {}) =>
    invitationDrafts.set(user.id, organization.id, {
      emails: emailsField.current?.value ?? "",
      role,
      ...next,
    });
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter from submitting the form.
    if (pending) return;
    const field = event.currentTarget.elements.namedItem("emails") as HTMLTextAreaElement;
    const emails = addressesIn(field.value);
    if (emails.length === 0) {
      field.setCustomValidity(t`Enter one or more email addresses.`);
      field.reportValidity();
      return;
    }

    setPending(true);
    // The draft this submission owns: any edit since, even back to the same
    // text and role, stores another.
    const sent: InvitationDraft = { emails: field.value, role };
    invitationDrafts.set(user.id, organization.id, sent);
    const said = (next: Omit<Outcome, "count">) =>
      setOutcome((last) => ({ ...next, count: (last?.count ?? 0) + 1 }));
    try {
      const answer = await braivo.invite(
        organization.id,
        { emails, role },
        {
          // Each address may wait on its mail (ADR 0033), a few at once.
          signal: withDeadline(undefined, REQUEST_DEADLINE_MS + emails.length * 2_000),
          // The mail's language: the inviter's, as the page shows it (localization-6).
          headers: { "Accept-Language": i18n.locale },
        },
      );
      setPending(false);
      said({ answer });
      const retry = answer.results
        .filter(({ outcome }) => outcome === "refused" || outcome === "failed")
        .map(({ email }) => email)
        .join("\n");
      field.value = retry;
      // Kept from the answer, not the field, which a page left meanwhile no
      // longer has; and only over the draft sent, never one changed since.
      if (invitationDrafts.get(user.id, organization.id) === sent) {
        invitationDrafts.set(user.id, organization.id, { emails: retry, role });
      }
      // Lists those invited among those waiting, with their links, and the room left.
      await refreshInPlace(router);
    } catch (thrown) {
      setPending(false);
      const status = thrown instanceof BraivoError ? thrown.status : undefined;
      const code = thrown instanceof BraivoError ? thrown.code : undefined;
      // The page alone holds the addresses pasted: it stays (docs/apps.md).
      if (status === 401) return said({ refusal: "signed out" });
      if (code === "TOO_MANY_ADDRESSES") {
        said({ refusal: "too many" });
        // About the field, so its explanation is there, and so is the focus.
        return field.focus();
      }
      if (code === "NO_LEARN_DOMAIN") return said({ refusal: "no learn domain" });
      said({ refusal: "failed" });
      // No longer managing it: the page, read again, says so. Not after any
      // other failure, whose reread may fail too and lose the addresses.
      if (status === 403) await router.invalidate();
    }
  }

  const answer = outcome?.answer;
  const invited = answer?.results.filter(({ outcome }) => outcome === "invited").length ?? 0;
  const total = answer?.results.length ?? 0;
  const unsent =
    answer?.results.filter((result) => result.outcome === "invited" && !result.emailSent).length ??
    0;
  const kept =
    answer?.results.filter(({ outcome }) => outcome === "refused" || outcome === "failed").length ??
    0;
  const tooMany = outcome?.refusal === "too many";
  const alert =
    outcome?.refusal === "no learn domain" ? (
      <Trans>
        Learners have no site to practise on yet, so none can be invited. Authors and admins can.
      </Trans>
    ) : outcome?.refusal === "signed out" ? (
      <Trans>
        You were signed out.{" "}
        <a href="/login" target="_blank" rel="noopener" className="underline">
          Sign in again in a new tab
        </a>
        , then send again: the addresses stay here.
      </Trans>
    ) : outcome?.refusal === "failed" ? (
      <Trans>
        Could not send the invitations. Some may have gone: reload the page to see which, then try
        again.
      </Trans>
    ) : undefined;

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-6">
      <Heading level={2} id={`${id}-heading`} className="mb-2">
        <Trans>Invite</Trans>
      </Heading>
      <MutedText className="mb-4 block wrap-break-word">
        <Plural
          value={membersLeft}
          one="Room for # more member. An invitation reserves no place."
          other="Room for # more members. An invitation reserves no place."
        />
      </MutedText>
      <form onSubmit={invite}>
        <FieldGroup>
          <Field data-invalid={tooMany || undefined}>
            <FieldLabel htmlFor={`${id}-emails`}>
              <Trans>Email addresses</Trans>
            </FieldLabel>
            <Textarea
              id={`${id}-emails`}
              name="emails"
              required
              rows={3}
              // Grows with what is pasted up to about ten lines, then
              // scrolls: a class's hundred would push its hint, an error
              // about it, and Send screens away.
              className="max-h-60"
              autoComplete="off"
              spellCheck={false}
              readOnly={pending}
              aria-invalid={tooMany || undefined}
              aria-describedby={
                tooMany ? `${id}-emails-hint ${id}-emails-error` : `${id}-emails-hint`
              }
              ref={emailsField}
              defaultValue={draft?.emails}
              onChange={(event) => {
                event.currentTarget.setCustomValidity("");
                if (tooMany) setOutcome(undefined);
                keep();
              }}
            />
            <FieldDescription id={`${id}-emails-hint`}>
              <Trans>
                Up to 100, separated by spaces, commas, or lines. Each accepts by signing in with
                their address.
              </Trans>
            </FieldDescription>
            {tooMany && (
              <FieldError key={outcome?.count} id={`${id}-emails-error`}>
                <Trans>Invite at most 100 addresses at once.</Trans>
              </FieldError>
            )}
          </Field>
          <FieldSet>
            <FieldLegend variant="label" id={`${id}-role`}>
              <Trans>Role</Trans>
            </FieldLegend>
            <RadioGroup
              aria-labelledby={`${id}-role`}
              value={role}
              // Fixed while sending: the role results are said for.
              disabled={pending}
              onValueChange={(value) => {
                setRole(value as InvitableRole);
                keep({ role: value as InvitableRole });
              }}
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
                <Trans>Send invitations</Trans>
              )}
            </Button>
            {/* Mounted once, its text cleared while sending: a status region
                shown already filled is not reliably announced. */}
            <p role="status" className="text-sm wrap-anywhere text-muted-foreground">
              {answer && !pending && (
                // What needs doing too, not only how many went: said where the
                // result is announced, not only in the list below it.
                <>
                  <Trans>
                    {invited} of {total} invited.
                  </Trans>
                  {unsent > 0 && (
                    <>
                      {" "}
                      <Plural
                        value={unsent}
                        one="# email may not have gone: copy its link below."
                        other="# emails may not have gone: copy their links below."
                      />
                    </>
                  )}
                  {kept > 0 && (
                    <>
                      {" "}
                      <Plural
                        value={kept}
                        one="# address kept above to try again."
                        other="# addresses kept above to try again."
                      />
                    </>
                  )}
                </>
              )}
            </p>
          </div>
        </FieldGroup>
      </form>
      {alert && (
        <Alert key={outcome?.count} variant="destructive" className="mt-4">
          <CircleExclamationPointIcon />
          <AlertDescription className="wrap-break-word">{alert}</AlertDescription>
        </Alert>
      )}
      {answer && (
        <ul aria-label={t`Results`} className="mt-4 grid gap-1 text-sm">
          {answer.results.map((result) => (
            <li key={result.email} className="wrap-anywhere">
              <span className="font-medium">{result.email}</span>:{" "}
              <ResultSentence result={result} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Mails a waiting invitation again (access-55): the same link, its expiry
 * renewed; or, `expired`, invites its address anew, a new link.
 */
function ResendButton({
  invitation,
  expiredList,
}: {
  invitation: PendingInvitation;
  /**
   * Its list's notice and heading: invited again, its row leaves this list
   * for the waiting one, so what came of it is said there, the focus moved there.
   */
  expiredList?: {
    notice: ReturnType<typeof useNotice>;
    heading: RefObject<HTMLHeadingElement | null>;
  };
}) {
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { i18n } = useLingui();
  const [pending, setPending] = useState(false);
  const [said, setSaid] = useState<{
    alert?: MessageDescriptor | "signed out";
    sent?: true;
    count: number;
  }>();
  const email = invitation.email;

  async function resend() {
    if (pending) return;
    setPending(true);
    const say = (next: { alert?: MessageDescriptor | "signed out"; sent?: true }) =>
      setSaid((last) => ({ ...next, count: (last?.count ?? 0) + 1 }));
    try {
      const resent = await braivo.resendInvitation(organization.id, invitation.id, {
        // Its mail may wait up to its transport's deadline (ADR 0033), as one address invited.
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS + 2_000),
        headers: { "Accept-Language": i18n.locale },
      });
      setPending(false);
      if (expiredList) {
        expiredList.notice.say({
          said: resent.emailSent ? (
            <Trans>Invited {email} again.</Trans>
          ) : (
            <Trans>Invited {email} again, but the email may not have gone. Copy its link.</Trans>
          ),
        });
      } else {
        say(
          resent.emailSent
            ? { sent: true }
            : { alert: msg`The email may not have gone. Copy the link instead.` },
        );
      }
      // Its expiry renewed, or, expired meanwhile, a new link.
      await refreshInPlace(router);
      expiredList?.heading.current?.focus();
    } catch (thrown) {
      setPending(false);
      // Addresses pasted above may be all the page holds: it stays (docs/apps.md).
      if (thrown instanceof BraivoError && thrown.status === 401) {
        return say({ alert: "signed out" });
      }
      const code = thrown instanceof BraivoError ? thrown.code : undefined;
      const refused = code === undefined ? undefined : REFUSED[code];
      if (expiredList) {
        // Its row may leave with the reread: said, and the focus kept, by its list.
        return expiredList.notice.failed(
          thrown,
          refused ? (
            i18n._(refused)
          ) : code === "ALREADY_INVITED" ? (
            <Trans>{email} is already invited again.</Trans>
          ) : code === "ALREADY_MEMBER" ? (
            <Trans>{email} is a member now.</Trans>
          ) : (
            <Trans>Could not invite {email} again. Try again.</Trans>
          ),
        );
      }
      say({ alert: refused ?? msg`Could not resend. Try again.` });
      // Accepted, cancelled, or no longer theirs to manage: the page, read
      // again, says so. Not after a failed connection or server, whose reread
      // may fail too and lose the addresses pasted above.
      const status = thrown instanceof BraivoError ? thrown.status : undefined;
      if (!refused && (status === 403 || status === 404 || status === 409)) {
        await router.invalidate();
      }
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-disabled={pending}
        aria-label={i18n._(expiredList ? msg`Invite ${email} again` : msg`Resend to ${email}`)}
        onClick={() => void resend()}
      >
        {pending && <Spinner data-icon="inline-start" aria-hidden="true" />}
        {expiredList ? <Trans>Invite again</Trans> : <Trans>Resend</Trans>}
      </Button>
      {/* Mounted once, cleared while resending, so each "Sent again." is announced;
          shown after the row's other actions, which it would otherwise push down. */}
      <p role="status" className="order-last basis-full text-sm text-muted-foreground">
        {said?.sent && !pending && <Trans>Sent again.</Trans>}
      </p>
      {said?.alert && (
        <p key={said.count} role="alert" className="order-last basis-full text-sm text-destructive">
          {said.alert === "signed out" ? (
            <Trans>
              You were signed out.{" "}
              <a href="/login" target="_blank" rel="noopener" className="underline">
                Sign in again in a new tab
              </a>
              , then resend.
            </Trans>
          ) : (
            i18n._(said.alert)
          )}
        </p>
      )}
    </>
  );
}

/**
 * Cancels a waiting invitation (access-57), so its link admits no one. One
 * accepted first is said so: they are a member, or about to be.
 */
function CancelButton(props: {
  invitation: PendingInvitation;
  notice: ReturnType<typeof useNotice>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { invitation, notice, heading } = props;
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const email = invitation.email;

  async function cancel() {
    if (pending) return;
    setPending(true);
    try {
      await braivo.cancelInvitation(organization.id, invitation.id, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
      notice.say({ said: <Trans>Cancelled the invitation to {email}.</Trans> });
      await refreshInPlace(router);
      // Its row, and this button, are gone.
      heading.current?.focus();
    } catch (thrown) {
      const code = thrown instanceof BraivoError ? thrown.code : undefined;
      await notice.failed(
        thrown,
        code === "INVITATION_ACCEPTED" ? (
          <Trans>
            {email} accepted the invitation before it could be cancelled. Remove them from members
            if they should not be here.
          </Trans>
        ) : code === "INVITATION_ACCEPTING" ? (
          <Trans>
            {email} is accepting the invitation right now, so it cannot be cancelled. Look at the
            members again in a moment.
          </Trans>
        ) : code === "INVITATION_CANCELED" ? (
          <Trans>The invitation to {email} was cancelled already.</Trans>
        ) : (
          <Trans>Could not cancel the invitation to {email}. Try again.</Trans>
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      aria-disabled={pending}
      aria-label={t`Cancel the invitation to ${email}`}
      onClick={() => void cancel()}
    >
      {pending && <Spinner data-icon="inline-start" aria-hidden="true" />}
      <Trans>Cancel</Trans>
    </Button>
  );
}

/**
 * Invitations waiting to be accepted, each with its link to copy, Resend, and
 * Cancel (access-51), then those expired, to invite again. Shown while any
 * is listed, or something done here is still said.
 */
function Invitations() {
  const { invitations, expired } = Route.useLoaderData();
  const { i18n, t } = useLingui();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const notice = useNotice(heading);
  if (invitations.length === 0 && expired.length === 0 && !notice.notice) return null;
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "long" });
  return (
    <section aria-labelledby={`${id}-heading`} className="mt-8">
      <Heading ref={heading} tabIndex={-1} level={2} id={`${id}-heading`} className="mb-2">
        <Trans>Invitations</Trans>
      </Heading>
      <NoticeRegions notice={notice.notice} className="mb-2" />
      {invitations.length > 0 && (
        <>
          <MutedText className="mb-3 block wrap-break-word">
            <Trans>
              A link works only for the address it was sent to: whoever opens it still signs in with
              a code sent to that email, or with Google.
            </Trans>
          </MutedText>
          <ul className="divide-y rounded-lg border">
            {invitations.map((invitation) => {
              const link = linkTo(invitation.id);
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
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs wrap-anywhere text-muted-foreground">
                      {link}
                    </span>
                    <CopyButton value={link} label={t`Copy link`} />
                    <ResendButton invitation={invitation} />
                    <CancelButton invitation={invitation} notice={notice} heading={heading} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {expired.length > 0 && (
        <>
          <Heading level={3} className="mt-6 mb-2">
            <Trans>Expired</Trans>
          </Heading>
          <ul aria-label={t`Expired`} className="divide-y rounded-lg border">
            {expired.map((invitation) => {
              const expiredOn = date.format(new Date(invitation.expiresAt));
              return (
                <li key={invitation.id} className="grid gap-1 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium wrap-anywhere">{invitation.email}</span>
                    <Badge variant="secondary">{sayRoles(i18n, [invitation.role])}</Badge>
                  </div>
                  <MutedText className="block wrap-break-word">
                    <Trans>Expired on {expiredOn}.</Trans>
                  </MutedText>
                  <div className="flex flex-wrap items-center gap-x-2">
                    <ResendButton invitation={invitation} expiredList={{ notice, heading }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
