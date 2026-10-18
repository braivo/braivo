// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type CourseProgressOverview, courseRef } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Field, FieldLabel } from "@braivo/ui/components/field";
import { NativeSelect, NativeSelectOption } from "@braivo/ui/components/native-select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { cn } from "@braivo/ui/lib/utils";
import { t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";

import { LearnersSite } from "#components/learners-site";
import { NameTag } from "#components/name-tag";
import { pinnedColumn, ScrollingTable } from "#components/scrolling-table";
import { SearchField } from "#components/search-field";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { sharedNameTags } from "#lib/name-tags";
import { MAX_QUERY, type ProgressSearch, validateProgressSearch } from "#lib/progress-search";
import { orNotFound, readCourseForProgress } from "#lib/refusals";
import { matchesQuery } from "#lib/search";
import { pageHead } from "#lib/title";

/**
 * Where a course's learners stand, read-only, for whoever may read it: an
 * administrator, every member; a teacher, the learners of the groups they
 * teach it to, each once (access-39). Each objective counts the same learners
 * (progress-11). One report, never one group's: a teacher of two groups
 * taking the course sees both, and is told so.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/progress")({
  validateSearch: validateProgressSearch,
  // Read once per course, not again as the search is typed or the order changes.
  loaderDeps: () => ({}),
  loader: async ({ context, params, abortController }) => {
    const signal = withDeadline(abortController.signal, REQUEST_DEADLINE_MS);
    // Checked before progress is read, which Braivo authorizes by course alone.
    const { course, groups } = await readCourseForProgress(context.braivo, {
      organization: context.organization,
      courseId: params.courseId,
      signal,
    });
    const progress = await orNotFound(context.braivo.courseProgress(params.courseId, { signal }));
    return { course, groups, progress };
  },
  head: (head) => pageHead(head, head.loaderData && t`${head.loaderData.course.title} · Progress`),
  component: CourseProgress,
  notFoundComponent: () => (
    <p>
      <Trans>This course does not exist, or its progress is not yours to see.</Trans>
    </p>
  ),
});

function CourseProgress() {
  const { course, groups, progress } = Route.useLoaderData();
  const { organization } = Route.useRouteContext();
  const search = Route.useSearch();
  const { courseId } = Route.useParams();
  const count = progress.learners.length;
  const { t, i18n } = useLingui();
  const groupNames =
    groups &&
    new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
      groups.map(({ name }) => name),
    );

  return (
    <>
      <BackLink search={search} courseTitle={course.title} />
      <Heading>{course.title}</Heading>
      <MutedText className="mb-6 block wrap-break-word">
        {groups ? (
          <Trans>
            <Plural value={count} one="# learner" other="# learners" /> you teach in this course,
            across your groups: {groupNames}.
          </Trans>
        ) : progress.published ? (
          <Trans>
            <Plural value={count} one="# member" other="# members" /> of {organization.name}, staff
            included: every member can study this course.
          </Trans>
        ) : (
          <Trans>
            <Plural value={count} one="# member" other="# members" /> of {organization.name}, staff
            included: every member can study this course once it is published.
          </Trans>
        )}
      </MutedText>
      {/* What a teacher sends learners to practise it, once there is a site and
          the course is published (ADR 0039). */}
      {progress.published ? (
        <LearnersSite
          learnDomain={organization.learnDomain}
          path={`/c/${courseRef(course)}`}
          at={t`Learners practise it at`}
        />
      ) : (
        <MutedText className="mb-4 block wrap-break-word">
          <Trans>Learners can't see this course until it is published.</Trans>
        </MutedText>
      )}
      {/* Another course's list starts from its own URL, not this one's draft. */}
      <Learners key={courseId} learners={progress.learners} />
      <ByObjective objectives={progress.objectives} learners={count} />
    </>
  );
}

/** Back where the page was opened from: Groups, or the course itself. */
function BackLink({ search, courseTitle }: { search: ProgressSearch; courseTitle: string }) {
  const { organization } = Route.useRouteContext();
  const { organizationSlug, courseId } = Route.useParams();
  const className = "mb-2 inline-block text-sm text-muted-foreground underline wrap-anywhere";
  return search.from === "groups" || !organization.administers ? (
    <Link to="/$organizationSlug/groups" params={{ organizationSlug }} className={className}>
      <Trans>Groups</Trans>
    </Link>
  ) : (
    <Link
      to="/$organizationSlug/courses/$courseId"
      params={{ organizationSlug, courseId }}
      className={className}
    >
      {courseTitle}
    </Link>
  );
}

/**
 * The learners, found by name and ordered as asked; the URL keeps both, so a
 * learner's report leads back to the same list. Narrows this table alone:
 * the objectives below count every learner the page reports on. Filtered as
 * typed, the URL following a moment later: a navigation per keystroke would
 * run the console's session and organization checks each time.
 */
function Learners(props: { learners: CourseProgressOverview["learners"] }) {
  const search = Route.useSearch();
  const { organizationSlug, courseId } = Route.useParams();
  const { t, i18n } = useLingui();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const id = useId();
  // Typed and chosen in place: one history entry, not one per keystroke.
  const updateSearch = (next: ProgressSearch) =>
    navigate({ search: (last) => validateProgressSearch({ ...last, ...next }), replace: true });
  // What is typed, ahead of the URL (`seen`) until it holds it, and what was
  // sent to it. The URL moving to what was sent keeps typing since; moving
  // anywhere else, or to the text itself, is shown instead.
  const committed = search.q ?? "";
  const [typing, setTyping] = useState<{ text: string; sent?: string; seen: string }>();
  if (typing && typing.seen !== committed) {
    setTyping(
      committed === typing.sent && committed !== typing.text
        ? { text: typing.text, seen: committed }
        : undefined,
    );
  }
  const query = typing?.text ?? committed;
  const unsent = typing && typing.text !== committed && typing.text !== typing.sent;
  // Each navigation sends the text, the last one sent superseding any before.
  const commit = (next: ProgressSearch = {}) => {
    setTyping((last) => last && { ...last, sent: last.text });
    void updateSearch({ q: query, ...next });
  };
  // Typing is sent on its own only while the router still heads for this page
  // as it shows it, or as last sent: another navigation, Back included, keeps
  // this page up until the next one loads, and must not be overridden.
  const sendTyping = () => {
    const { latestLocation: next, state } = router;
    const q = validateProgressSearch(next.search).q ?? "";
    const headedHere =
      next.pathname === state.resolvedLocation?.pathname && (q === committed || q === typing?.sent);
    if (unsent && headedHere) commit();
  };
  // As the page now is, typed included, for a report to lead back to.
  const current = validateProgressSearch({ ...search, q: query });
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, i18n.locale);
  const tags = sharedNameTags(props.learners);
  const shown = props.learners
    .filter(({ name }) => matchesQuery(name, query, i18n.locale))
    .toSorted((a, b) =>
      search.sort === "learning"
        ? b.standings.acquiring - a.standings.acquiring || byName(a, b)
        : search.sort === "due"
          ? b.standings.due - a.standings.due || byName(a, b)
          : byName(a, b),
    );
  useEffect(() => {
    if (!unsent) return;
    const later = setTimeout(sendTyping, 400);
    return () => clearTimeout(later);
  });

  return (
    <section aria-labelledby={`${id}-learners`} className="mb-8 flex flex-col gap-3">
      <Heading level={2} id={`${id}-learners`}>
        <Trans>Learners</Trans>
      </Heading>
      <MutedText>
        <Trans>Each learner's objectives, counted by standing.</Trans>
      </MutedText>
      {props.learners.length === 0 ? (
        <MutedText>
          <Trans>No learners yet.</Trans>
        </MutedText>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <SearchField
              label={t`Find a learner`}
              value={query}
              // No longer than the URL keeps, or the two would never agree.
              maxLength={MAX_QUERY}
              onChange={(value) =>
                setTyping((last) => ({
                  text: value.slice(0, MAX_QUERY),
                  sent: last?.sent,
                  seen: committed,
                }))
              }
              // Kept in the page's own history entry before a report opens,
              // so Back finds it, without waiting for the moment above.
              onBlur={sendTyping}
              className="w-full sm:w-64"
            />
            <Field orientation="horizontal" className="w-auto">
              <FieldLabel htmlFor={`${id}-sort`} className="shrink-0 font-normal">
                <Trans>Order</Trans>
              </FieldLabel>
              <NativeSelect
                id={`${id}-sort`}
                value={search.sort ?? "name"}
                onChange={(event) => {
                  const sort = event.currentTarget.value;
                  commit({ sort: sort === "learning" || sort === "due" ? sort : undefined });
                }}
              >
                <NativeSelectOption value="name">{t`By name`}</NativeSelectOption>
                <NativeSelectOption value="learning">{t`Most objectives learning`}</NativeSelectOption>
                <NativeSelectOption value="due">{t`Most objectives due`}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          {shown.length === 0 ? (
            <MutedText className="wrap-break-word">
              <Trans>No learner matches “{query}”.</Trans>
            </MutedText>
          ) : (
            <StandingsTable
              labelledBy={`${id}-learners`}
              rowHeader={<Trans>Learner</Trans>}
              rows={shown.map(({ userId, name, standings }) => ({
                key: userId,
                label: (
                  // The tag inside the link: its name tells two Ana Kowalskas apart too.
                  <Link
                    to="/$organizationSlug/courses/$courseId/learners/$learnerId"
                    params={{ organizationSlug, courseId, learnerId: userId }}
                    search={current}
                    className="underline"
                  >
                    {name}
                    <NameTag tag={tags.get(userId)} />
                  </Link>
                ),
                standings,
              }))}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Each objective, in the course's order, its learners counted: the same learners as above. */
function ByObjective(props: {
  objectives: CourseProgressOverview["objectives"];
  learners: number;
}) {
  const { objectives, learners } = props;
  const id = useId();
  return (
    <section aria-labelledby={`${id}-objectives`} className="flex flex-col gap-3">
      <Heading level={2} id={`${id}-objectives`}>
        <Trans>Progress by objective</Trans>
      </Heading>
      {objectives.length === 0 ? (
        <MutedText>
          <Trans>This course has no objectives yet, so there is no progress to report.</Trans>
        </MutedText>
      ) : (
        <>
          <MutedText>
            <Trans>
              Each objective's learners, counted by standing:{" "}
              <Plural value={learners} one="the # learner" other="all # learners" /> on this page,
              whoever is searched for above.
            </Trans>
          </MutedText>
          <StandingsTable
            labelledBy={`${id}-objectives`}
            rowHeader={<Trans>Objective</Trans>}
            rows={objectives.map(({ objectiveId, title, standings }) => ({
              key: objectiveId,
              label: title,
              standings,
            }))}
          />
        </>
      )}
    </section>
  );
}

type Standings = CourseProgressOverview["learners"][number]["standings"];

/**
 * Rows counted by standing, labelled as a learner's own report labels them.
 * Named by its section's heading, so a screen reader's list of tables tells a
 * page's apart.
 */
function StandingsTable(props: {
  labelledBy: string;
  rowHeader: ReactNode;
  rows: { key: string; label: ReactNode; standings: Standings }[];
}) {
  return (
    <ScrollingTable aria-labelledby={props.labelledBy}>
      <TableHeader>
        <TableRow>
          <TableHead className={pinnedColumn}>{props.rowHeader}</TableHead>
          <TableHead className="text-right">
            <Trans context="A learner's standing on an objective">Not started</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans context="A learner's standing on an objective">Learning</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans context="A learner's standing on an objective">Retained</Trans>
          </TableHead>
          <TableHead className="text-right">
            <Trans context="A learner's standing on an objective">Due for review</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map(({ key, label, standings }) => (
          <TableRow key={key}>
            {/* A row header, so each count is announced with whose it is; a long
                word wraps, rather than widening it over the counts, padded as a
                cell is. */}
            <TableHead
              scope="row"
              className={cn(
                "min-w-36 py-2 font-normal whitespace-normal wrap-anywhere",
                pinnedColumn,
              )}
            >
              {label}
            </TableHead>
            <TableCell className="text-right tabular-nums">{standings.unseen}</TableCell>
            <TableCell className="text-right tabular-nums">{standings.acquiring}</TableCell>
            <TableCell className="text-right tabular-nums">{standings.retained}</TableCell>
            <TableCell className="text-right tabular-nums">{standings.due}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollingTable>
  );
}
