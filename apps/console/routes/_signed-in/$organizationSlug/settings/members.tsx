// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
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
import { createFileRoute, Link } from "@tanstack/react-router";

import { NoSuchSetting } from "#components/no-such-setting";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * Who belongs to the organization, by name, with their roles (access-26):
 * read-only until ADR 0018's invitations, the operator adding and removing
 * them meanwhile (access-20). Teaching belongs to groups, not roles
 * (access-38), so each role shows with the groups its member teaches.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/members")({
  beforeLoad: administratorsOnly,
  loader: async ({ context, abortController }) => {
    const options = { signal: abortController.signal };
    // Both or neither: without the groups, a teacher would read as only a learner.
    const [members, groups] = await Promise.all([
      orNotFound(context.braivo.listMembers(context.organization.id, options)),
      orNotFound(context.braivo.listGroups(context.organization.id, options)),
    ]);
    return { members, groups };
  },
  head: (head) => pageHead(head, t`Members`),
  component: Members,
  notFoundComponent: NoSuchSetting,
});

/** Each role as a school says it: a `member` is a learner, membership being enrollment (access-23). */
const ROLE_NAMES = {
  owner: msg`Owner`,
  admin: msg`Admin`,
  member: msg`Learner`,
} as const;

function Members() {
  const { members, groups } = Route.useLoaderData();
  const { user, organization } = Route.useRouteContext();
  const { i18n } = useLingui();
  const count = members.length;
  // "Owner and Admin", in the reader's language.
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
        <Trans>They cannot be added or removed here yet; whoever runs Braivo for you can.</Trans>{" "}
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
                {listFormat.format(
                  member.roles.map((role) =>
                    Object.hasOwn(ROLE_NAMES, role)
                      ? i18n._(ROLE_NAMES[role as keyof typeof ROLE_NAMES])
                      : role,
                  ),
                )}
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
