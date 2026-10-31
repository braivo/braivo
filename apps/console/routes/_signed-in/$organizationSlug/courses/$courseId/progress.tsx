// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type BraivoClient,
  BraivoError,
  type CourseProgressOverview,
  courseRef,
  type Organization,
} from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldLabel } from "@braivo/ui/components/field";
import { NativeSelect, NativeSelectOption } from "@braivo/ui/components/native-select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { Toggle } from "@braivo/ui/components/toggle";
import { cn } from "@braivo/ui/lib/utils";
import { plural, t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, isNotFound, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useId, useState } from "react";

import { AsOf } from "#components/as-of";
import { LastPractised } from "#components/last-practised";
import { LearnersSite } from "#components/learners-site";
import { MissesSince } from "#components/misses-since";
import { NameTag } from "#components/name-tag";
import { pinnedColumn, ScrollingTable } from "#components/scrolling-table";
import { SearchField } from "#components/search-field";
import { useAbortOnUnmount } from "#lib/abort-on-unmount";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { sharedNameTags } from "#lib/name-tags";
import { PRACTICE_RECENCIES, type PracticeRecency, practiceWindow } from "#lib/practice-window";
import {
  MAX_QUERY,
  PROGRESS_SORTS,
  type ProgressSearch,
  validateProgressSearch,
} from "#lib/progress-search";
import { orNotFound, readCourseForProgress } from "#lib/refusals";
import { sayRoles } from "#lib/roles";
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
  loader: ({ context, params, abortController }) =>
    readProgressPage(context.braivo, {
      organization: context.organization,
      courseId: params.courseId,
      signal: abortController.signal,
    }),
  head: (head) => pageHead(head, head.loaderData && t`${head.loaderData.course.title} · Progress`),
  component: CourseProgress,
  notFoundComponent: () => <NotFound />,
});

/** `alert` when a Refresh is refused: it replaces the page, the focused button too, so it is said. */
function NotFound({ alert }: { alert?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined}>
      <Trans>This course does not exist, or its progress is not yours to see.</Trans>
    </p>
  );
}

/**
 * What the page shows, read by its loader and again by Refresh: the course and
 * a teacher's groups (the scope line names them), then its progress, so a
 * refreshed roster never sits under an old scope.
 */
async function readProgressPage(
  braivo: BraivoClient,
  input: { organization: Organization; courseId: string; signal: AbortSignal | undefined },
) {
  const signal = withDeadline(input.signal, REQUEST_DEADLINE_MS);
  // Checked before progress is read, which Braivo authorizes by course alone.
  const { course, groups } = await readCourseForProgress(braivo, {
    organization: input.organization,
    courseId: input.courseId,
    signal,
  });
  const progress = await orNotFound(braivo.courseProgress(input.courseId, { signal }));
  return { course, groups, progress };
}

type ProgressPageData = Awaited<ReturnType<typeof readProgressPage>>;

/** One course's page, remounted for another, so neither its data nor a Refresh carries over. */
function CourseProgress() {
  const { courseId } = Route.useParams();
  return <ProgressPage key={courseId} />;
}

/**
 * The page, kept open through a lesson: Refresh reads it again in place,
 * keeping what is searched, sorted, and opened. Refreshed data holds only
 * while the loader's is the one it replaced; a new load wins. Refused, the
 * reader may no longer read the course: not found, never the old roster.
 */
function ProgressPage() {
  const loaded = Route.useLoaderData();
  const { braivo, organization } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const router = useRouter();
  const abortOnUnmount = useAbortOnUnmount();
  const [refreshed, setRefreshed] = useState<{ from: ProgressPageData; page?: ProgressPageData }>();
  // Held until the request settles, even past a newer load, so no two Refreshes overlap.
  const [refreshing, setRefreshing] = useState(false);
  // Failures counted, so each mounts a new alert, announced again; like a
  // refreshed page, said only over the data they failed to replace.
  const [failed, setFailed] = useState<{ from: ProgressPageData; count: number }>();
  const current = refreshed?.from === loaded ? refreshed : undefined;
  const failures = failed?.from === loaded ? failed.count : 0;

  async function refresh() {
    setRefreshing(true);
    try {
      const page = await readProgressPage(braivo, {
        organization,
        courseId,
        signal: abortOnUnmount(),
      });
      setRefreshed({ from: loaded, page });
      setFailed(undefined);
    } catch (thrown) {
      if (isNotFound(thrown)) setRefreshed({ from: loaded });
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      else if (thrown instanceof BraivoError && thrown.status === 401) void router.invalidate();
      else setFailed({ from: loaded, count: failures + 1 });
    } finally {
      setRefreshing(false);
    }
  }

  if (current && !current.page) return <NotFound alert />;
  return (
    <ProgressView
      page={current?.page ?? loaded}
      refresh={
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MutedText>
              <AsOf at={(current?.page ?? loaded).progress.asOf} />
            </MutedText>
            <Button
              variant="outline"
              size="sm"
              aria-disabled={refreshing || undefined}
              onClick={() => !refreshing && void refresh()}
            >
              {refreshing ? <Trans>Refreshing…</Trans> : <Trans>Refresh</Trans>}
            </Button>
          </div>
          {failures > 0 && (
            <p key={failures} role="alert" className="text-sm text-destructive">
              <Trans>Could not refresh. Try again.</Trans>
            </p>
          )}
        </>
      }
    />
  );
}

function ProgressView({ page, refresh }: { page: ProgressPageData; refresh: ReactNode }) {
  const { course, groups, progress } = page;
  const { organization } = Route.useRouteContext();
  const search = Route.useSearch();
  const count = progress.learners.length;
  const { t, i18n } = useLingui();
  const explanation = useId();
  const learnerSearch = useLearnerSearch();
  const threshold = progress.repeatedMissesThreshold;
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
        ) : progress.open ? (
          <Trans>
            <Plural value={count} one="# member" other="# members" /> of {organization.name}, staff
            included: every member can study this course.
          </Trans>
        ) : (
          <Trans>
            <Plural value={count} one="# member" other="# members" /> of {organization.name}, staff
            included: every member can study this course once it is open to learners.
          </Trans>
        )}
      </MutedText>
      {/* What a teacher sends learners to practise it, once there is a site and
          the course is open: published, and not hidden (ADR 0039). */}
      {progress.open ? (
        <LearnersSite
          learnDomain={organization.learnDomain}
          path={`/c/${courseRef(course)}`}
          at={t`Learners practise it at`}
        />
      ) : (
        <MutedText className="mb-4 block wrap-break-word">
          <Trans>Learners can't open this course for now.</Trans>
        </MutedText>
      )}
      <div className="mb-6 flex flex-col gap-1">{refresh}</div>
      <MutedText id={explanation} className="mb-6 block">
        <Trans>
          Repeated misses: objectives still being learned with {threshold} or more misses since the
          last correct answer. Show answer counts as a miss.
        </Trans>
      </MutedText>
      <Learners progress={progress} explanation={explanation} learnerSearch={learnerSearch} />
      <ByObjective progress={progress} explanation={explanation} search={learnerSearch.current} />
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
 * What is searched for learners, as typed: the URL follows a moment later, as
 * a navigation per keystroke would run the console's session and organization
 * checks each time. `current` is the page as it now is, typed included, for
 * every link to a report to lead back to, the objectives' lists' too.
 */
function useLearnerSearch() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  // Refining the same roster in place: Back leaves the page, never steps through
  // each keystroke, order, or filter.
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
  const setQuery = (value: string) =>
    setTyping((last) => ({ text: value.slice(0, MAX_QUERY), sent: last?.sent, seen: committed }));
  useEffect(() => {
    if (!unsent) return;
    const later = setTimeout(sendTyping, 400);
    return () => clearTimeout(later);
  });
  // As the page now is, typed included, for a report to lead back to.
  const current = validateProgressSearch({ ...search, q: query });
  return { query, current, setQuery, commit, sendTyping };
}

/**
 * The learners, found by name, filtered by when they last practised, and
 * ordered as asked; the URL keeps all three, so a learner's report leads back
 * to the same list. Narrows this table alone: the practice counts and the
 * objectives below count every learner the page reports on. Filtered as
 * typed (`useLearnerSearch`).
 */
function Learners(props: {
  progress: CourseProgressOverview;
  explanation: string;
  learnerSearch: ReturnType<typeof useLearnerSearch>;
}) {
  const { learners, objectives, asOf } = props.progress;
  const search = Route.useSearch();
  const { organizationSlug, courseId } = Route.useParams();
  const { t, i18n } = useLingui();
  const { query, current, setQuery, commit, sendTyping } = props.learnerSearch;
  const id = useId();
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, i18n.locale);
  const tags = sharedNameTags(learners);
  // Counted over every learner, in the reader's zone (progress-17): a filter
  // shows as many as its count, whatever is searched.
  const { timeZone, recencyOf } = practiceWindow(asOf);
  const practiceCounts: Record<PracticeRecency, number> = { recent: 0, earlier: 0, none: 0 };
  for (const { lastPractisedAt } of learners) practiceCounts[recencyOf(lastPractisedAt)]++;
  // Each learner's latest repeated miss, to order equal counts by: the fresher first.
  const latestMiss = new Map<string, number>();
  for (const { repeatedMisses } of objectives)
    for (const { userId, misses } of repeatedMisses)
      latestMiss.set(userId, Math.max(latestMiss.get(userId) ?? 0, Date.parse(misses.lastMissAt)));
  // Only while its toggles show: a course without objectives hides them, so a
  // filter left in the URL must not hide everyone with no way to clear it.
  const practiceFilter = objectives.length > 0 ? search.practice : undefined;
  const shown = learners
    .filter(({ name }) => matchesQuery(name, query, i18n.locale))
    .filter((learner) => !practiceFilter || recencyOf(learner.lastPractisedAt) === practiceFilter)
    .toSorted((a, b) =>
      search.sort === "learning"
        ? b.standings.acquiring - a.standings.acquiring || byName(a, b)
        : search.sort === "due"
          ? b.standings.due - a.standings.due || byName(a, b)
          : search.sort === "misses"
            ? b.repeatedMisses - a.repeatedMisses ||
              (latestMiss.get(b.userId) ?? 0) - (latestMiss.get(a.userId) ?? 0) ||
              byName(a, b)
            : byName(a, b),
    );

  return (
    <section aria-labelledby={`${id}-learners`} className="mb-8 flex flex-col gap-3">
      <Heading level={2} id={`${id}-learners`}>
        <Trans>Learners</Trans>
      </Heading>
      <MutedText>
        <Trans>Each learner's objectives, counted by standing.</Trans>
      </MutedText>
      {learners.length === 0 ? (
        <MutedText>
          <Trans>No learners yet.</Trans>
        </MutedText>
      ) : (
        <>
          {/* Nothing to practise in a course without objectives, so nothing to count. */}
          {objectives.length > 0 && (
            <PracticeFilter
              counts={practiceCounts}
              timeZone={timeZone}
              value={search.practice}
              onChange={(practice) => commit({ practice })}
            />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <SearchField
              label={t`Find a learner`}
              value={query}
              // No longer than the URL keeps, or the two would never agree.
              maxLength={MAX_QUERY}
              onChange={setQuery}
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
                  const value = event.currentTarget.value;
                  commit({ sort: PROGRESS_SORTS.find((sort) => sort === value) });
                }}
              >
                <NativeSelectOption value="name">{t`By name`}</NativeSelectOption>
                <NativeSelectOption value="learning">{t`Most objectives learning`}</NativeSelectOption>
                <NativeSelectOption value="due">{t`Most objectives due`}</NativeSelectOption>
                <NativeSelectOption value="misses">{t`Most repeated misses`}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          {shown.length === 0 ? (
            <MutedText className="wrap-break-word">
              {/* Naming the filter too, or a learner it hides reads as missing. */}
              {query && practiceFilter ? (
                <Trans>No learner matches “{query}” with this practice filter.</Trans>
              ) : query ? (
                <Trans>No learner matches “{query}”.</Trans>
              ) : (
                <Trans>No learner matches this filter.</Trans>
              )}
            </MutedText>
          ) : (
            <StandingsTable
              labelledBy={`${id}-learners`}
              explanation={props.explanation}
              rowHeader={<Trans>Learner</Trans>}
              rows={shown.map(
                ({ userId, name, roles, standings, repeatedMisses, lastPractisedAt }) => {
                  // An administrator's view counts staff as learners (progress-17), so it
                  // says who they are; a teacher's carries no roles (access-26).
                  const staffRoles = roles?.filter((role) => role !== "member") ?? [];
                  return {
                    key: userId,
                    labelId: `${id}-${userId}`,
                    label: (
                      // The tag inside the link: its name tells two Ana Kowalskas apart too.
                      <Link
                        id={`${id}-${userId}`}
                        to="/$organizationSlug/courses/$courseId/learners/$learnerId"
                        params={{ organizationSlug, courseId, learnerId: userId }}
                        search={current}
                        className="underline"
                      >
                        {name}
                        <NameTag tag={tags.get(userId)} />
                      </Link>
                    ),
                    note: (
                      <>
                        {staffRoles.length > 0 && <>{sayRoles(i18n, staffRoles)} · </>}
                        <LastPractised at={lastPractisedAt} asOf={asOf} />
                      </>
                    ),
                    standings,
                    // Blank, not 0, so the eye finds the learners with any.
                    misses: repeatedMisses > 0 && repeatedMisses,
                  };
                },
              )}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * Who practised in the last seven days, before only, or never (progress-17),
 * counted over every learner the page reports on, whatever is searched: each
 * count a toggle filtering the learners to it, pressed again to show all.
 * A fact to check in on, never a ranking (product.md).
 */
function PracticeFilter(props: {
  counts: Record<PracticeRecency, number>;
  timeZone: string;
  value: PracticeRecency | undefined;
  onChange: (practice: PracticeRecency | undefined) => void;
}) {
  const { timeZone, value } = props;
  const { recent, earlier, none } = props.counts;
  const id = useId();
  const labels: Record<PracticeRecency, ReactNode> = {
    recent: <Trans>Practised: {recent}</Trans>,
    earlier: <Trans>Not lately: {earlier}</Trans>,
    none: <Trans>No practice yet: {none}</Trans>,
  };
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-meaning`}>
      <p id={`${id}-label`} className="mb-1.5 text-sm font-medium">
        <Trans>Practice in the last 7 days</Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        {PRACTICE_RECENCIES.map((practice) => (
          <Toggle
            key={practice}
            variant="outline"
            size="sm"
            pressed={value === practice}
            onPressedChange={(on) => props.onChange(on ? practice : undefined)}
            className="h-auto min-h-7 py-1 whitespace-normal tabular-nums"
          >
            {/* Pressed shows by more than colour. */}
            {value === practice && <CheckIcon aria-hidden="true" />}
            {labels[practice]}
          </Toggle>
        ))}
      </div>
      <MutedText id={`${id}-meaning`} className="mt-1.5 block wrap-break-word">
        <Trans>
          Today and the 6 days before, in your time zone ({timeZone}): questions answered here on
          this course's objectives. Results recorded elsewhere count toward standings, not practice.
        </Trans>
      </MutedText>
    </div>
  );
}

/**
 * Each objective, in the course's order, its learners counted: the same
 * learners as above, whatever is searched there. Its repeated misses open
 * into the learners behind them, in a row below rather than inside the row
 * header, whose name stays the objective's title; several may be open, kept
 * through a Refresh, not in the URL.
 */
function ByObjective(props: {
  progress: CourseProgressOverview;
  explanation: string;
  /** The page as it now is, typed search included, for a report to lead back to. */
  search: ProgressSearch;
}) {
  const { objectives } = props.progress;
  const learners = props.progress.learners.length;
  const id = useId();
  const { t } = useLingui();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (objectiveId: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(objectiveId)) next.add(objectiveId);
      return next;
    });
  // From the whole roster, as the learners' rows are tagged, so a namesake reads alike in both.
  const tags = sharedNameTags(props.progress.learners);
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
              whatever the search or filter above.
            </Trans>
          </MutedText>
          <StandingsTable
            labelledBy={`${id}-objectives`}
            explanation={props.explanation}
            rowHeader={<Trans>Objective</Trans>}
            rows={objectives.map(({ objectiveId, title, standings, repeatedMisses }) => {
              const count = repeatedMisses.length;
              const listId = `${id}-${objectiveId}`;
              // Open only while it has learners to list: a Refresh may have cleared them.
              const expanded = count > 0 && open.has(objectiveId);
              const counted = t({
                message: plural(count, { one: "# learner", other: "# learners" }),
              });
              return {
                key: objectiveId,
                label: title,
                standings,
                misses: count > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-me-3 h-auto min-h-9 py-1.5 whitespace-normal"
                    aria-expanded={expanded}
                    // Only while the list it names exists.
                    aria-controls={expanded ? listId : undefined}
                    aria-label={t({
                      message: plural(count, {
                        one: `# learner with repeated misses on ${title}`,
                        other: `# learners with repeated misses on ${title}`,
                      }),
                    })}
                    onClick={() => toggle(objectiveId)}
                  >
                    <ChevronRightIcon
                      aria-hidden="true"
                      className={cn("size-4 transition-transform", expanded && "rotate-90")}
                    />
                    {counted}
                  </Button>
                ),
                detail: expanded && (
                  <ul
                    id={listId}
                    role="list"
                    aria-label={t({
                      message: plural(count, {
                        one: `# learner with repeated misses on ${title}`,
                        other: `# learners with repeated misses on ${title}`,
                      }),
                    })}
                    className="flex flex-col gap-2"
                  >
                    {repeatedMisses.map((learner) => (
                      <li key={learner.userId} className="text-sm">
                        <RepeatedMissesLink
                          objectiveId={objectiveId}
                          learner={learner}
                          tag={tags.get(learner.userId)}
                          search={props.search}
                        />
                      </li>
                    ))}
                  </ul>
                ),
              };
            })}
          />
          {objectives.every(({ repeatedMisses }) => repeatedMisses.length === 0) && (
            <MutedText>
              <Trans>No objectives currently have repeated misses.</Trans>
            </MutedText>
          )}
        </>
      )}
    </section>
  );
}

/** A learner with repeated misses on an objective, leading to it in their report, and how many. */
function RepeatedMissesLink(props: {
  objectiveId: string;
  learner: CourseProgressOverview["objectives"][number]["repeatedMisses"][number];
  tag: string | undefined;
  search: ProgressSearch;
}) {
  const { organizationSlug, courseId } = Route.useParams();
  const { userId, name, misses } = props.learner;
  return (
    <>
      <Link
        to="/$organizationSlug/courses/$courseId/learners/$learnerId"
        params={{ organizationSlug, courseId, learnerId: userId }}
        search={props.search}
        hash={`objective-${props.objectiveId}`}
        className="underline wrap-anywhere"
      >
        {name}
        <NameTag tag={props.tag} />
      </Link>
      <MutedText className="block">
        <MissesSince {...misses} />
      </MutedText>
    </>
  );
}

type Standings = CourseProgressOverview["learners"][number]["standings"];

/** The standings in the columns' order. */
const STANDINGS = ["unseen", "acquiring", "retained", "due"] as const;

/** Each standing's colour in the bars and their legend (ADR 0037). */
const STANDING_COLOURS: Record<keyof Standings, string> = {
  unseen: "bg-chart-4",
  acquiring: "bg-chart-3",
  retained: "bg-chart-1",
  due: "bg-chart-2",
};

/**
 * Rows counted by standing, labelled as a learner's own report labels them.
 * Named by its section's heading, so a screen reader's list of tables tells a
 * page's apart.
 */
function StandingsTable(props: {
  labelledBy: string;
  /** The ID of the visible text explaining repeated misses, describing the column's heading. */
  explanation: string;
  rowHeader: ReactNode;
  rows: {
    key: string;
    label: ReactNode;
    /** The ID of the label's element, naming the row header by it alone, without its note. */
    labelId?: string;
    /** Under the label, the row header's description, never its name. */
    note?: ReactNode;
    standings: Standings;
    misses: ReactNode;
    /** Shown in a row of its own below, as wide as the visible table however far it is scrolled. */
    detail?: ReactNode;
  }[];
}) {
  return (
    <ScrollingTable aria-labelledby={props.labelledBy}>
      <TableHeader>
        <TableRow>
          <TableHead className={pinnedColumn}>{props.rowHeader}</TableHead>
          <TableHead className="text-right">
            <StandingSwatch standing="unseen" />
            <Trans context="A learner's standing on an objective">Not started</Trans>
          </TableHead>
          <TableHead className="text-right">
            <StandingSwatch standing="acquiring" />
            <Trans context="A learner's standing on an objective">Learning</Trans>
          </TableHead>
          <TableHead className="text-right" aria-describedby={props.explanation}>
            <Trans>Repeated misses</Trans>
          </TableHead>
          <TableHead className="text-right">
            <StandingSwatch standing="retained" />
            <Trans context="A learner's standing on an objective">Retained</Trans>
          </TableHead>
          <TableHead className="text-right">
            <StandingSwatch standing="due" />
            <Trans context="A learner's standing on an objective">Due for review</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map(({ key, label, labelId, note, standings, misses, detail }) => (
          <Fragment key={key}>
            <TableRow>
              {/* A row header, so each count is announced with whose it is; a long
                word wraps, rather than widening it over the counts, padded as a
                cell is. */}
              <TableHead
                scope="row"
                aria-labelledby={labelId}
                aria-describedby={labelId && note ? `${labelId}-note` : undefined}
                className={cn(
                  "min-w-36 py-2 font-normal whitespace-normal wrap-anywhere",
                  pinnedColumn,
                )}
              >
                {label}
                <StandingsBar standings={standings} />
                {note && (
                  <MutedText id={labelId && `${labelId}-note`} className="mt-1 block text-xs">
                    {note}
                  </MutedText>
                )}
              </TableHead>
              {STANDINGS.map((standing) => (
                <Fragment key={standing}>
                  <TableCell className="text-right tabular-nums">{standings[standing]}</TableCell>
                  {standing === "acquiring" && (
                    <TableCell className="text-right tabular-nums">{misses}</TableCell>
                  )}
                </Fragment>
              ))}
            </TableRow>
            {detail && (
              // Filled as its expanded row is, so the two read as one.
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableCell colSpan={STANDINGS.length + 2} className="p-0 whitespace-normal">
                  {/* As wide as the scroller, and held at its left: read without scrolling
                      sideways. Clear of the 32px its right edge fades over while it hides columns. */}
                  <div className="sticky left-0 w-[100cqw] ps-2 pe-8 py-3">{detail}</div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </ScrollingTable>
  );
}

/** A standing's colour beside its column's heading: the bars' legend. */
function StandingSwatch({ standing }: { standing: keyof Standings }) {
  return (
    <span
      aria-hidden="true"
      className={cn("me-1.5 inline-block size-2 rounded-full", STANDING_COLOURS[standing])}
    />
  );
}

/**
 * A row's counts as one bar, to scan the rows by; the counts stay exact, and are
 * what a screen reader reads. Each standing at least a pixel wide, so a small
 * count still shows, and a pixel apart, so neighbours part where colours do not.
 */
function StandingsBar({ standings }: { standings: Standings }) {
  if (STANDINGS.every((standing) => standings[standing] === 0)) return null;
  return (
    <span aria-hidden="true" className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full">
      {STANDINGS.map(
        (standing) =>
          standings[standing] > 0 && (
            <span
              key={standing}
              data-standing={standing}
              className={cn("min-w-px", STANDING_COLOURS[standing])}
              style={{ flexGrow: standings[standing] }}
            />
          ),
      )}
    </span>
  );
}
