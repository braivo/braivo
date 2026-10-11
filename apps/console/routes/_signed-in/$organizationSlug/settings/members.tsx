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
import { createFileRoute } from "@tanstack/react-router";

import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * Who belongs to the organization, by name, with their roles (access-26):
 * read-only until ADR 0018's invitations, the operator adding and removing
 * them meanwhile (access-20).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/members")({
  loader: async ({ context, abortController }) => ({
    members: await orNotFound(
      context.braivo.listMembers(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, t`Members`),
  component: Members,
  notFoundComponent: () => (
    <p>
      <Trans>This organization does not exist, or you do not manage it.</Trans>
    </p>
  ),
});

/** Each role as a school says it: a `member` is a learner, membership being enrollment (access-23). */
const ROLE_NAMES = {
  owner: msg`Owner`,
  admin: msg`Admin`,
  member: msg`Learner`,
} as const;

function Members() {
  const { members } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const { i18n } = useLingui();
  const count = members.length;
  // "Owner and Admin", in the reader's language.
  const roles = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  return (
    <>
      <Heading>
        <Trans>Members</Trans>
      </Heading>
      <MutedText className="mb-4 block wrap-break-word">
        <Plural value={count} one="# member." other="# members." />{" "}
        <Trans>They cannot be added or removed here yet; whoever runs Braivo for you can.</Trans>
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
                <span className="wrap-anywhere">{member.name}</span>
                {member.userId === user.id && (
                  <Badge variant="secondary" className="ms-2 align-middle">
                    <Trans>You</Trans>
                  </Badge>
                )}
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {roles.format(
                  member.roles.map((role) =>
                    Object.hasOwn(ROLE_NAMES, role)
                      ? i18n._(ROLE_NAMES[role as keyof typeof ROLE_NAMES])
                      : role,
                  ),
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
