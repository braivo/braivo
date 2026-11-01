// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AuthoredCourse,
  BraivoError,
  countExplanations,
  courseRef,
  type SourceSummary,
  type TaskWriteResult,
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
  AlertDialogTrigger,
} from "@braivo/ui/components/alert-dialog";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { CourseUrlLabel } from "#components/course-url-label";
import {
  ExplanationCount,
  explanationReviewIds,
  useExplanationNote,
} from "#components/explanations";
import { findingsId, hasFindings } from "#components/findings";
import { LearnersSite } from "#components/learners-site";
import {
  type Editing,
  formatTaskCount,
  Passages,
  type PublishAction,
  PublishBar,
  type ReviewTask,
  SelectAll,
  TaskList,
  type TaskSelection,
  usePublish,
  useTaskSelection,
} from "#components/task-review";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { authorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/** The count line's DOM ID: the focus after the last task shown is fixed. */
const EXPLANATION_COUNT_ID = "explanation-count";

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
  // Narrowed to the tasks without an explanation; any other value shows all.
  validateSearch: (search): { without?: "explanation" } =>
    search.without === "explanation" ? { without: "explanation" } : {},
  beforeLoad: authorsOnly,
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    // Bounded, since a correction or a retirement waits for this reload to
    // finish: unanswered in time, the page fails, offering Try again.
    const signal = withDeadline(abortController.signal, REQUEST_DEADLINE_MS);
    // Read through its organization, which Braivo checks owns it.
    const course = await orNotFound(
      context.braivo.readCourse({ organizationId, courseId: params.courseId }, { signal }),
    );

    return { course };
  },
  head: (head) => pageHead(head, head.loaderData?.course.title),
  component: CoursePage,
  notFoundComponent: () => <p>This course does not exist, or you do not manage it.</p>,
});

/** Keyed by course, so nothing said or pending on one course's page carries to another's. */
function CoursePage() {
  return <Course key={Route.useParams().courseId} />;
}

function Course() {
  const { course } = Route.useLoaderData();
  const { organization, braivo } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const narrowed = Route.useSearch().without === "explanation";
  const navigate = Route.useNavigate();
  const { t } = useLingui();
  // Focusable, to receive focus once Publish is done, its button gone or the
  // page changed, or once a change leaves a task's objective off the page.
  const heading = useRef<HTMLHeadingElement>(null);
  // Present from the start, so what Publish did is announced; `at` a task
  // shown, said beside it too, where the work goes on (`TaskList`'s `status`).
  const [status, setStatus] = useState<{ message: string; at?: string }>({ message: "" });
  const say = (message: string) => setStatus({ message });
  const selection = useTaskSelection();
  // Narrowed, what each objective shows (`explanationReviewIds`); Publish,
  // Select all, and the sections act on that alone, the course kept whole for
  // lookups and for what Publish warns of.
  const shownByObjective = narrowed
    ? new Map(course.objectives.map(({ id, tasks }) => [id, explanationReviewIds(tasks)]))
    : undefined;
  const isShown = (objectiveId: string, taskId: string) =>
    shownByObjective === undefined || shownByObjective.get(objectiveId)!.has(taskId);
  const shownPending = course.objectives.flatMap(({ id: objectiveId, tasks }) =>
    tasks.filter(({ id, published }) => !published && isShown(objectiveId, id)),
  );
  const selectedTasks = shownPending.filter(({ id }) => selection.selectedIds.has(id));
  const counts = countExplanations(course.objectives.flatMap(({ tasks }) => tasks));
  const missing = counts.published.withoutExplanation + counts.pending.withoutExplanation;
  // Narrowed, the tasks shown, in page order: Needs review's, then What it teaches'.
  const shownOrder = narrowed
    ? [
        ...course.objectives.flatMap(({ id: objectiveId, tasks }) =>
          tasks.filter(({ id, published }) => !published && isShown(objectiveId, id)),
        ),
        ...course.objectives.flatMap(({ id: objectiveId, tasks }) =>
          tasks.filter(({ id, published }) => published && isShown(objectiveId, id)),
        ),
      ].map(({ id }) => id)
    : [];
  // Opening an editor clears what the last action said: the next save's words,
  // even the same ones, are then a change the status announces.
  const edit = (next: Editing | undefined) => {
    if (next) say("");
    setEditingTask(next);
  };
  // A correction saved while narrowed: said, and the focus moved, once the page shows it.
  const [saved, setSaved] = useState<{
    published: boolean;
    focusOrder: readonly string[];
  }>();
  useLayoutEffect(() => {
    if (!saved) return;
    setSaved(undefined);
    // Left without one among the published, as the count line says.
    const left = counts.published.withoutExplanation;
    // The task saved, if still shown, else the next one shown, never an
    // objective's heading that left with its last task; at the end, the count.
    const at = saved.focusOrder.find((id) => document.getElementById(`task-${id}`));
    setStatus({
      message: saved.published
        ? t({
            comment: "{left}: the published tasks still without an explanation",
            message: `Saved and published. ${left} left.`,
          })
        : t`Saved. It waits for review.`,
      at,
    });
    const target =
      (at === undefined ? null : document.getElementById(`task-${at}`)) ??
      document.getElementById(EXPLANATION_COUNT_ID) ??
      heading.current;
    target?.focus();
    // Once per save, with the page as read again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const onSaved = narrowed
    ? (taskId: string, written: TaskWriteResult) =>
        setSaved({
          published: written.published,
          focusOrder: [written.id, ...shownOrder.slice(shownOrder.indexOf(taskId) + 1)],
        })
    : undefined;
  // One editor on the page: saving a task's correction retires its pending
  // correction, which the other section shows. Open only while its task is
  // listed and shown: a reload may show it corrected or retired by someone
  // else, and history may narrow the page past it. Closed for good then, so
  // it never reopens, emptied, nor holds Show all and Publish disabled.
  const [editingTask, setEditingTask] = useState<Editing>();
  const editing = course.objectives.some(({ id: objectiveId, tasks }) =>
    tasks.some(({ id }) => id === editingTask?.taskId && isShown(objectiveId, id)),
  )
    ? editingTask
    : undefined;
  if (editingTask && !editing) setEditingTask(undefined);
  // It and an open editor each wait for the other: Publish reloads the page,
  // which would close an editor and lose its unsaved edit.
  const publication = usePublish({
    onStart: () => say(""),
    onDone: (message) => {
      heading.current?.focus();
      say(message);
    },
  });
  const publishing = publication.publishing !== undefined;
  // Delete's request is under way: Publish and editors wait, as for Publish's.
  const [deleting, setDeleting] = useState(false);
  // Hide's or Show's is: Publish and editors wait, as for Delete's.
  const [changingVisibility, setChangingVisibility] = useState(false);
  const sources = new Map(course.sources.map((source) => [source.id, source]));
  // Objectives with work to review, numbered by their place in the course.
  const objectivesToReview = course.objectives
    .map((objective, index) => ({ objective, place: index + 1 }))
    .filter(({ objective }) =>
      objective.tasks.some(({ id, published }) => !published && isShown(objective.id, id)),
    );
  const objectivesTaught = course.objectives
    .map((objective, index) => ({ objective, place: index + 1 }))
    .filter(
      ({ objective }) =>
        !narrowed ||
        objective.tasks.some(({ id, published }) => published && isShown(objective.id, id)),
    );

  return (
    <>
      {/* The way back to every course, above its heading (docs/apps.md). */}
      <Link
        to="/$organizationSlug"
        params={{ organizationSlug: organization.slug }}
        className="mb-2 inline-block text-sm text-muted-foreground underline"
      >
        Courses
      </Link>
      <Heading ref={heading} tabIndex={-1}>
        {course.title}
      </Heading>
      {/* A tool's course and tasks wait for a person's review here (ADR 0039);
          the console's own, accepted from a draft, are published as created. */}
      {course.published && !course.hidden && (
        <LearnersSite
          learnDomain={organization.learnDomain}
          path={`/c/${courseRef(course)}`}
          at={`Open to every learner in ${organization.name} at`}
          none={`Open to every learner in ${organization.name}, once it has a site to practise on.`}
        />
      )}
      {course.hidden && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="outline">Hidden</Badge>
          <MutedText className="wrap-break-word">
            Learners can't open this course until you show it again. What they learned stays.
          </MutedText>
        </div>
      )}
      {(missing > 0 || narrowed) && (
        <ExplanationCount counts={counts} alwaysShown={narrowed} id={EXPLANATION_COUNT_ID}>
          {/* Disabled while editing: narrowing could unmount the editor, and its text with it. */}
          <Button
            variant="outline"
            size="sm"
            disabled={editing !== undefined}
            onClick={async () => {
              await navigate({ search: narrowed ? {} : { without: "explanation" }, replace: true });
              // Shown whole with nothing left to narrow to, this button is gone: the title takes the focus.
              if (narrowed && missing === 0) heading.current?.focus();
            }}
          >
            {narrowed
              ? t`Show all`
              : t({
                  comment: "Shows only the tasks without an explanation, counted beside it",
                  message: "Show only these",
                })}
          </Button>
        </ExplanationCount>
      )}
      {(!course.published || shownPending.length > 0) && (
        <PublishPending
          course={course}
          shownPending={shownPending}
          narrowed={narrowed}
          fallbackFocus={heading}
          selected={selectedTasks}
          publication={publication}
          editing={editing !== undefined}
          busy={deleting || changingVisibility}
        />
      )}
      {/* Said beside a task instead, only heard here: this may be scrolled far away. */}
      <MutedText
        role="status"
        className={status.at === undefined ? "mb-4 block empty:mb-0" : "sr-only"}
      >
        {status.message}
      </MutedText>
      {/* Its link's label, once the link reaches learners. */}
      {course.published && (
        <CourseUrlLabel braivo={braivo} organizationId={organization.id} course={course} />
      )}
      <div className="mb-8 flex flex-wrap items-start gap-2">
        {/* Every member's progress, an administrator's; a teacher's own
            learners' is reached from Groups (access-39). */}
        {organization.administers && (
          <Button asChild variant="outline">
            <Link
              to="/$organizationSlug/courses/$courseId/progress"
              params={{ organizationSlug: organization.slug, courseId }}
            >
              Learner progress
              <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        )}
        {/* Hidden rather than unpublished, as learners may have met it (ADR 0039). */}
        {course.published && (
          <CourseVisibility
            course={course}
            editing={editing !== undefined}
            pending={changingVisibility}
            publishing={publishing}
            onPending={(now) => {
              // The previous action's announcement, cleared.
              if (now) say("");
              setChangingVisibility(now);
            }}
            onDone={(message) => {
              heading.current?.focus();
              say(message);
            }}
          />
        )}
        {/* Only while no learner has seen it (ADR 0039). */}
        {!course.published && (
          <DeleteCourse
            course={course}
            deleting={deleting}
            onDeleting={(now) => {
              // What Publish said last no longer holds once Delete is tried.
              if (now) say("");
              setDeleting(now);
            }}
            editing={editing !== undefined}
            publishing={publishing}
            onRefused={(message) => {
              heading.current?.focus();
              say(message);
            }}
          />
        )}
      </div>
      {/* Pending work first (ADR 0039), each task once: here while it waits,
          below once published. In both sections, whatever is focused or
          scrolled to stops clear of Publish's sticky buttons, at their
          tallest: two rows on a phone, and its one-line failure. */}
      {objectivesToReview.length > 0 && (
        <section aria-labelledby="pending" className="mb-10 flex flex-col gap-6 **:scroll-mt-40">
          <Heading level={2} id="pending">
            Needs review
          </Heading>
          {objectivesToReview.map(({ objective, place }) => (
            <Objective
              key={objective.id}
              objective={objective}
              place={place}
              sources={sources}
              shownIds={shownByObjective?.get(objective.id)}
              onSaved={onSaved}
              status={status}
              showPending
              selection={selection}
              editing={editing}
              onEdit={edit}
              pending={publishing || deleting || changingVisibility}
              fallbackFocus={heading}
            />
          ))}
        </section>
      )}
      {/* Narrowed, gone with its last task shown, as the count line says why. */}
      {(!narrowed || objectivesTaught.length > 0) && (
        <section aria-labelledby="teaches" className="flex flex-col gap-6 **:scroll-mt-40">
          <Heading level={2} id="teaches">
            What it teaches
          </Heading>
          {course.objectives.length === 0 && <MutedText>No objectives yet.</MutedText>}
          {objectivesTaught.map(({ objective, place }) => (
            <Objective
              key={objective.id}
              objective={objective}
              place={place}
              sources={sources}
              shownIds={shownByObjective?.get(objective.id)}
              onSaved={onSaved}
              status={status}
              editing={editing}
              onEdit={edit}
              pending={publishing || deleting || changingVisibility}
              fallbackFocus={heading}
            />
          ))}
        </section>
      )}
    </>
  );
}

/**
 * Publishing what waits for review on this page, so learners reach it (ADR
 * 0039): the course, if it waits, with the tasks selected, or with every
 * pending task shown, in one request, all or nothing, so work written since
 * the page loaded, or not selected, waits for the next look. Asked first when
 * the tasks reach other courses too, since a task serves every course its
 * objective is in.
 */
function PublishPending(props: {
  course: AuthoredCourse;
  /** The pending tasks the page shows, in page order: every one unless narrowed. */
  shownPending: readonly ReviewTask[];
  /** Narrowed to tasks without an explanation: said beside the buttons. */
  narrowed: boolean;
  /** Focused by Review them when what it leads to is not shown. */
  fallbackFocus: RefObject<HTMLHeadingElement | null>;
  /** The pending tasks selected, in page order. */
  selected: readonly ReviewTask[];
  publication: ReturnType<typeof usePublish>;
  /** A task's editor is open: neither button sends until it closes. */
  editing: boolean;
  /** Delete, Hide, or Show is under way: neither button sends meanwhile. */
  busy: boolean;
}) {
  const {
    course,
    shownPending: pending,
    narrowed,
    fallbackFocus,
    selected,
    publication,
    editing,
    busy,
  } = props;
  const { t } = useLingui();
  const explanationNote = useExplanationNote(selected);

  const action = (
    action: "selected" | "all",
    label: string,
    tasks: readonly ReviewTask[],
  ): PublishAction => ({
    action,
    label,
    // Selecting nothing publishes nothing in a published course.
    disabled: editing || busy || (course.published && tasks.length === 0),
    confirm: confirmation(course, tasks, fallbackFocus),
    onPublish: () => {
      if (editing || busy) return;
      void publication.publish(
        action,
        {
          courseIds: course.published ? [] : [course.id],
          taskIds: tasks.map(({ id }) => id),
        },
        course.published
          ? `Published ${formatTaskCount(tasks.length)}.`
          : tasks.length === 0
            ? "Course published."
            : `Published the course and ${formatTaskCount(tasks.length)}.`,
      );
    },
  });

  // Sent with the course while it waits: the page is its review, so either
  // button publishes it. Without pending tasks, Publish alone.
  const actions =
    pending.length === 0
      ? [action("all", "Publish", [])]
      : course.published
        ? [
            action("selected", `Publish selected (${selected.length})`, selected),
            action("all", `Publish all (${pending.length})`, pending),
          ]
        : [
            action(
              "selected",
              selected.length === 0
                ? "Publish without tasks needing review"
                : `Publish with selected (${selected.length})`,
              selected,
            ),
            action("all", `Publish with all (${pending.length})`, pending),
          ];

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="outline">Needs review</Badge>
        <MutedText className="wrap-break-word">
          {course.published
            ? `${formatTaskCount(pending.length)} below ${pending.length === 1 ? "waits" : "wait"} for review: learners aren't asked ${pending.length === 1 ? "it" : "them"} until you publish.`
            : "Review it below, the tasks needing review first: learners can't see this course until you publish it."}
        </MutedText>
      </div>
      <PublishBar
        actions={actions}
        publishing={publication.publishing}
        note={
          editing
            ? `Save or cancel the open edit to ${course.published ? "publish" : "publish or delete"}.`
            : [narrowed && t`Publish acts only on the tasks shown.`, explanationNote]
                .filter(Boolean)
                .join(" ") || undefined
        }
        // Not beside another action's attempt, which it does not speak of.
        failures={busy ? 0 : publication.failures}
      />
    </>
  );
}

/**
 * Publish's question, when there is something to say: how many of `tasks`
 * have findings, the objectives the course would be left without a published
 * task once they are published (its published tasks and those sent: a
 * correction keeps its objective), and the organization's other published courses
 * they reach too, each once, by title; none when there is nothing.
 *
 * Review them focuses the first task sent with findings, whose notes the page
 * shows beside it; with none, the first objective left without practice, under
 * Needs review while it has a pending task, else under What it teaches, or
 * `fallbackFocus` when the page, narrowed, does not show it.
 */
function confirmation(
  course: AuthoredCourse,
  tasks: readonly ReviewTask[],
  fallbackFocus: RefObject<HTMLHeadingElement | null>,
): PublishAction["confirm"] {
  const sent = new Set(tasks.map(({ id }) => id));
  const courses = [
    ...new Map(
      course.objectives
        .filter((objective) => objective.tasks.some(({ id }) => sent.has(id)))
        .flatMap(({ otherPublishedCourses }) => otherPublishedCourses)
        .map((other) => [other.id, other]),
    ).values(),
  ].toSorted((a, b) => a.title.localeCompare(b.title));
  const uncovered = course.objectives.filter(
    ({ tasks }) => !tasks.some(({ id, published }) => published || sent.has(id)),
  );
  const flagged = tasks.filter(hasFindings);
  if (courses.length === 0 && flagged.length === 0 && uncovered.length === 0) return undefined;

  return {
    title: course.published
      ? `Publish ${formatTaskCount(tasks.length)}?`
      : tasks.length === 0
        ? "Publish the course?"
        : `Publish the course and ${formatTaskCount(tasks.length)}?`,
    ...((flagged.length > 0 || uncovered.length > 0) && {
      checks: {
        taskCount: flagged.length,
        objectivesWithoutPractice: uncovered.map(({ title }) => title),
        onReview: () => {
          const [first] = uncovered;
          const target =
            flagged.length > 0
              ? findingsId(flagged[0]!.id)
              : objectiveHeadingId(
                  first!.id,
                  first!.tasks.some(({ published }) => !published),
                );
          // Not shown while narrowed: the course's title instead.
          (document.getElementById(target) ?? fallbackFocus.current)?.focus();
        },
      },
    }),
    ...(courses.length > 0 && {
      reach: {
        description: `Learners of ${courses.length === 1 ? "another course" : "other courses"} will be asked ${tasks.length === 1 ? "it" : "some of them"} too:`,
        courses,
      },
    }),
  };
}

/**
 * Deleting an unpublished course, asked first: its arrangement goes, its
 * objectives and tasks stay (ADR 0039). Deleted, the organization's courses
 * open; published by someone meanwhile, the page shows it so, saying why.
 */
function DeleteCourse(props: {
  course: AuthoredCourse;
  /** Its request is under way: it says Deleting…, and sends no other. */
  deleting: boolean;
  onDeleting: (deleting: boolean) => void;
  /** A task's editor is open, whose unsaved edit leaving the page would lose: disabled meanwhile. */
  editing: boolean;
  /** Publish is under way, which would make deleting fail: inert meanwhile. */
  publishing: boolean;
  /** Refused as published since: the page shown again, and why to announce. */
  onRefused: (message: string) => void;
}) {
  const { course, deleting, onDeleting, editing, publishing, onRefused } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  // A ref, set at once, refuses a second confirmation before `deleting` renders.
  const pending = useRef(false);
  /** The last failure's count keys the alert, so a repeat is announced too. */
  const [failures, setFailures] = useState(0);

  async function remove() {
    if (pending.current) return;
    pending.current = true;
    onDeleting(true);
    setFailures(0);
    const from = router.latestLocation.pathname;
    try {
      try {
        // Bounded: retried after a lost answer, deleting again succeeds.
        await braivo.deleteCourse(
          { organizationId: organization.id, courseId: course.id },
          { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
        );
      } catch (thrown) {
        if (thrown instanceof BraivoError && thrown.status === 409) {
          await router.invalidate({ sync: true });
          onRefused("Not deleted: someone published this course meanwhile.");
        } else if (thrown instanceof BraivoError && [401, 403].includes(thrown.status)) {
          // Signed out, or no longer authoring there: the guard's check, run again, says so.
          await router.invalidate();
        } else {
          setFailures((count) => count + 1);
        }
        return;
      }
      // Deleted: its courses open, unless the owner left meanwhile, whose page is read again.
      if (router.latestLocation.pathname === from) {
        await router.navigate({
          to: "/$organizationSlug",
          params: { organizationSlug: organization.slug },
        });
      } else {
        void router.invalidate();
      }
    } finally {
      // Only once the page shows what happened, so it is not sent again meanwhile.
      pending.current = false;
      onDeleting(false);
    }
  }

  const inert = deleting || publishing;
  return (
    <div className="flex flex-col gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          {/* Focusable meanwhile, opening nothing. */}
          <Button
            variant="outline"
            className="w-fit"
            disabled={editing}
            // Absent rather than false while `disabled` says it.
            aria-disabled={inert || undefined}
            onClick={(event) => inert && event.preventDefault()}
          >
            {deleting ? (
              <>
                {/* Hidden: "Deleting…" already says it. */}
                <Spinner data-icon="inline-start" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              "Delete course"
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            {/* A grid item, which a long unbroken title would widen past the dialog. */}
            <AlertDialogTitle className="wrap-anywhere">Delete “{course.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Learners never saw it. Its objectives and tasks stay in Braivo, for other courses.
              Deleting it can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {failures > 0 && !deleting && (
        <Alert variant="destructive" key={failures}>
          <AlertDescription>The course could not be deleted. Try again.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * Hiding a published course from learners, asked first, or showing it again:
 * it stays published, and what they learned stays (ADR 0039). Done, the page
 * shows it so.
 */
function CourseVisibility(props: {
  course: AuthoredCourse;
  /** A task's editor is open, whose unsaved edit signing in again would lose: disabled meanwhile. */
  editing: boolean;
  /** Its request is under way: it says Hiding… or Showing…, and sends no other. */
  pending: boolean;
  /** Publish is under way, whose reload would race this one's: inert meanwhile. */
  publishing: boolean;
  onPending: (pending: boolean) => void;
  /** Done: the page shown again, and what to announce. */
  onDone: (message: string) => void;
}) {
  const { course, editing, pending, publishing, onPending, onDone } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  // What it asks for: hiding while learners reach it, else showing.
  const hide = !course.hidden;
  // A ref, set at once, refuses a second request before `pending` renders.
  const sending = useRef(false);
  /** The last failure's count keys the alert, so a repeat is announced too. */
  const [failures, setFailures] = useState(0);

  async function change() {
    if (sending.current) return;
    sending.current = true;
    onPending(true);
    setFailures(0);
    try {
      try {
        // Bounded: retried after a lost answer, it changes nothing again.
        await braivo.setCourseHidden(
          { organizationId: organization.id, courseId: course.id, hidden: hide },
          { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
        );
      } catch (thrown) {
        if (thrown instanceof BraivoError && [401, 403, 404].includes(thrown.status)) {
          // Signed out, no longer authoring there, or gone: the page, read again, says so.
          await router.invalidate();
        } else {
          setFailures((count) => count + 1);
        }
        return;
      }
      // Done: only the request's failure is said; a reload's shows as the page's own.
      await router.invalidate({ sync: true });
      onDone(hide ? "Hidden from learners." : "Shown to learners again.");
    } finally {
      sending.current = false;
      onPending(false);
    }
  }

  const label = pending ? (
    <>
      {/* Hidden: the words already say it. */}
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {hide ? "Hiding…" : "Showing…"}
    </>
  ) : hide ? (
    "Hide from learners"
  ) : (
    "Show to learners"
  );
  // Focusable meanwhile, doing nothing.
  const button = (
    <Button
      variant="outline"
      className="w-fit"
      disabled={editing}
      aria-disabled={pending || publishing || undefined}
      onClick={(event) => {
        if (pending || publishing) event.preventDefault();
        else if (!hide) void change();
      }}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      {hide ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              {/* A grid item, which a long unbroken title would widen past the dialog. */}
              <AlertDialogTitle className="wrap-anywhere">
                Hide “{course.title}” from learners?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Learners can't open it or practise it until you show it again. What they learned
                stays.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it open</AlertDialogCancel>
              <AlertDialogAction onClick={change}>Hide</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        // Shown again without asking: it restores what learners had.
        button
      )}
      {failures > 0 && !pending && (
        <Alert variant="destructive" key={failures}>
          <AlertDescription>
            The course could not be {hide ? "hidden" : "shown"}. Try again.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** The DOM ID of an objective's heading, under Needs review when `pending`, else What it teaches. */
function objectiveHeadingId(objectiveId: string, pending?: boolean) {
  return pending ? `pending-${objectiveId}` : objectiveId;
}

/**
 * One objective as a reviewer checks it. Under What it teaches: the passages
 * that teach it, then its published tasks, each with the passages it was
 * written from. `showPending`: its pending tasks instead, without its passages,
 * each selectable, a correction above the task it replaces.
 */
function Objective(props: {
  objective: AuthoredCourse["objectives"][number];
  place: number;
  sources: ReadonlyMap<string, SourceSummary>;
  /** Only these of its tasks, by ID, when the page is narrowed. */
  shownIds?: ReadonlySet<string>;
  /** A task of it corrected: `TaskList`'s. */
  onSaved?: (taskId: string, saved: TaskWriteResult) => void;
  /** The page's status: `TaskList`'s. */
  status?: { message: string; at?: string };
  showPending?: true;
  selection?: TaskSelection;
  /** The task whose editor is open on the page, if any: every other Edit waits for it. */
  editing: Editing | undefined;
  onEdit: (editing: Editing | undefined) => void;
  /** Publish, Delete, Hide, or Show is under way: no editor opens, as what follows would close it. */
  pending: boolean;
  /** Focused when a task's change leaves this objective off the page. */
  fallbackFocus: RefObject<HTMLHeadingElement | null>;
}) {
  const {
    objective,
    place,
    sources,
    shownIds,
    onSaved,
    status,
    showPending,
    selection,
    editing,
    onEdit,
    pending,
    fallbackFocus,
  } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingIds = objective.tasks.filter(({ published }) => !published).map(({ id }) => id);
  // What Select all selects: the pending tasks shown.
  const shownPendingIds = pendingIds.filter((id) => shownIds === undefined || shownIds.has(id));
  const publishedCount = objective.tasks.length - pendingIds.length;
  // One ID per section, as an objective may appear in both.
  const headingId = objectiveHeadingId(objective.id, showPending);

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* Focusable, to receive focus from a task retired or corrected beneath it. */}
        <Heading level={3} id={headingId} ref={heading} tabIndex={-1} className="mb-0 min-w-0">
          {place}. {objective.title}
        </Heading>
        {selection && (
          <SelectAll
            taskIds={shownPendingIds}
            selection={selection}
            objectiveTitle={objective.title}
          />
        )}
      </div>
      {!showPending &&
        (objective.citations.length === 0 ? (
          <MutedText>No passage cited as teaching it.</MutedText>
        ) : (
          <Passages citations={objective.citations} sources={sources} />
        ))}
      {!showPending && publishedCount === 0 && (
        <MutedText>
          {pendingIds.length === 0
            ? "No tasks: learners are not asked about it."
            : `No published tasks: learners are not asked about it until you publish ${pendingIds.length === 1 ? "the one" : "those"} needing review above.`}
        </MutedText>
      )}
      <TaskList
        objectiveId={objective.id}
        tasks={objective.tasks}
        showPending={showPending}
        shownIds={shownIds}
        onSaved={onSaved}
        status={status}
        sources={sources}
        selection={selection}
        editing={editing}
        onEdit={onEdit}
        pending={pending}
        // The heading here, or, once a change took the objective off the page, the course's.
        onChanged={() => (heading.current ?? fallbackFocus.current)?.focus()}
      />
    </article>
  );
}
