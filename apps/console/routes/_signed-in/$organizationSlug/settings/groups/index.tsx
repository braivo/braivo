// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { NoSuchSetting } from "#components/no-such-setting";
import { SearchField } from "#components/search-field";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { matchesQuery } from "#lib/search";
import { pageHead } from "#lib/title";

/**
 * The organization's groups, for whoever administers it (access-38): who
 * teaches whom in which courses, each opened to change it.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/groups/")({
  beforeLoad: administratorsOnly,
  loader: async ({ context, abortController }) => ({
    groups: await orNotFound(
      context.braivo.listGroups(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, t`Groups`),
  component: Groups,
  notFoundComponent: NoSuchSetting,
});

function Groups() {
  const { groups } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();
  const { i18n, t } = useLingui();
  const [query, setQuery] = useState("");
  const id = useId();
  const shown = groups.filter(({ name }) => matchesQuery(name, query, i18n.locale));

  const create = (
    <Button asChild>
      <Link to="/$organizationSlug/settings/groups/new" params={{ organizationSlug }}>
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        <Trans>Create group</Trans>
      </Link>
    </Button>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <Heading className="mb-0" id={`${id}-heading`}>
          <Trans>Groups</Trans>
        </Heading>
        {groups.length > 0 && create}
      </div>
      <MutedText className="mb-6 block wrap-break-word">
        <Trans>
          Organize learners, teachers, and courses. Teachers can read progress for the learners and
          courses in their groups.
        </Trans>
      </MutedText>
      {groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              <Trans>No groups yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Create a group to give teachers access to the learners they teach.</Trans>
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{create}</EmptyContent>
        </Empty>
      ) : (
        <>
          <SearchField label={t`Find a group`} value={query} onChange={setQuery} className="mb-4" />
          {shown.length === 0 ? (
            <MutedText className="block wrap-break-word">
              <Trans>No group matches “{query}”.</Trans>
            </MutedText>
          ) : (
            <Table aria-labelledby={`${id}-heading`}>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Trans context="group">Name</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>Teachers</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>Learners</Trans>
                  </TableHead>
                  <TableHead className="text-right">
                    <Trans>Courses</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((group) => (
                  <TableRow key={group.id}>
                    {/* A row header, so each count is announced with its group; a
                        minimum width, or `wrap-anywhere` lets the counts crush it
                        to a letter a line. */}
                    <TableHead scope="row" className="min-w-36 font-normal whitespace-normal">
                      <Link
                        to="/$organizationSlug/settings/groups/$groupId"
                        params={{ organizationSlug, groupId: group.id }}
                        className="font-medium wrap-anywhere underline-offset-4 hover:underline"
                      >
                        {group.name}
                      </Link>
                    </TableHead>
                    <TableCell className="text-right tabular-nums">
                      {group.teachers.length}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {group.learners.length}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {group.courses.length}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </>
  );
}
