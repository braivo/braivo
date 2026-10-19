// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AuthoredCourse,
  BraivoError,
  courseRef,
  type SourceSummary,
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
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { CourseUrlLabel } from "#components/course-url-label";
import { LearnersSite } from "#components/learners-site";
import {
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

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
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
  // Focusable, to receive focus once Publish is done, its button gone or the
  // page changed, or once a change leaves a task's objective off the page.
  const heading = useRef<HTMLHeadingElement>(null);
  // Present from the start, so what Publish did is announced.
  const [statusMessage, setStatusMessage] = useState("");
  const selection = useTaskSelection();
  const waiting = waitingTasks(course);
  const selectedTasks = waiting.filter(({ id }) => selection.selectedIds.has(id));
  // One editor on the page: saving a task's correction retires its waiting
  // correction, which the other section shows. Open only while its task is
  // listed: a reload may show it corrected or retired by someone else.
  const [editingId, setEditingId] = useState<string>();
  const editing = course.objectives.some(({ tasks }) => tasks.some(({ id }) => id === editingId))
    ? editingId
    : undefined;
  // It and an open editor each wait for the other: Publish reloads the page,
  // which would close an editor and lose its unsaved edit.
  const publication = usePublish({
    onStart: () => setStatusMessage(""),
    onDone: (message) => {
      heading.current?.focus();
      setStatusMessage(message);
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
    .filter(({ objective }) => objective.tasks.some(({ published }) => !published));

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
      {(!course.published || waiting.length > 0) && (
        <PublishWaiting
          course={course}
          selected={selectedTasks}
          publication={publication}
          editing={editing !== undefined}
          busy={deleting || changingVisibility}
        />
      )}
      <MutedText role="status" className="mb-4 block empty:mb-0">
        {statusMessage}
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
              if (now) setStatusMessage("");
              setChangingVisibility(now);
            }}
            onDone={(message) => {
              heading.current?.focus();
              setStatusMessage(message);
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
              if (now) setStatusMessage("");
              setDeleting(now);
            }}
            editing={editing !== undefined}
            publishing={publishing}
            onRefused={(message) => {
              heading.current?.focus();
              setStatusMessage(message);
            }}
          />
        )}
      </div>
      {/* Waiting work first (ADR 0039), each task once: here while it waits,
          below once published. In both sections, whatever is focused or
          scrolled to stops clear of Publish's sticky buttons, at their
          tallest: two rows on a phone, and its one-line failure. */}
      {objectivesToReview.length > 0 && (
        <section aria-labelledby="waiting" className="mb-10 flex flex-col gap-6 **:scroll-mt-40">
          <Heading level={2} id="waiting">
            Waiting for review
          </Heading>
          {objectivesToReview.map(({ objective, place }) => (
            <Objective
              key={objective.id}
              objective={objective}
              place={place}
              sources={sources}
              waiting
              selection={selection}
              editing={editing}
              onEdit={setEditingId}
              pending={publishing || deleting || changingVisibility}
              fallbackFocus={heading}
            />
          ))}
        </section>
      )}
      <section aria-labelledby="teaches" className="flex flex-col gap-6 **:scroll-mt-40">
        <Heading level={2} id="teaches">
          What it teaches
        </Heading>
        {course.objectives.length === 0 && <MutedText>No objectives yet.</MutedText>}
        {course.objectives.map((objective, index) => (
          <Objective
            key={objective.id}
            objective={objective}
            place={index + 1}
            sources={sources}
            editing={editing}
            onEdit={setEditingId}
            pending={publishing || deleting || changingVisibility}
            fallbackFocus={heading}
          />
        ))}
      </section>
    </>
  );
}

/** The course's tasks still waiting for review, in the order the page shows them. */
function waitingTasks(course: AuthoredCourse) {
  return course.objectives.flatMap(({ tasks }) => tasks.filter(({ published }) => !published));
}

/**
 * Publishing what waits for review on this page, so learners reach it (ADR
 * 0039): the course, if it waits, with the tasks selected, or with every
 * waiting task shown, in one request, all or nothing, so work written since
 * the page loaded, or not selected, waits for the next look. Asked first when
 * the tasks reach other courses too, since a task serves every course its
 * objective is in.
 */
function PublishWaiting(props: {
  course: AuthoredCourse;
  /** The waiting tasks selected, in page order. */
  selected: readonly ReviewTask[];
  publication: ReturnType<typeof usePublish>;
  /** A task's editor is open: neither button sends until it closes. */
  editing: boolean;
  /** Delete, Hide, or Show is under way: neither button sends meanwhile. */
  busy: boolean;
}) {
  const { course, selected, publication, editing, busy } = props;
  const waiting = waitingTasks(course);

  const action = (
    action: "selected" | "all",
    label: string,
    tasks: readonly ReviewTask[],
  ): PublishAction => ({
    action,
    label,
    // Selecting nothing publishes nothing in a published course.
    disabled: editing || busy || (course.published && tasks.length === 0),
    confirm: confirmation(course, tasks),
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
  // button publishes it. Without waiting tasks, Publish alone.
  const actions =
    waiting.length === 0
      ? [action("all", "Publish", [])]
      : course.published
        ? [
            action("selected", `Publish selected (${selected.length})`, selected),
            action("all", `Publish all (${waiting.length})`, waiting),
          ]
        : [
            action(
              "selected",
              selected.length === 0
                ? "Publish without waiting tasks"
                : `Publish with selected (${selected.length})`,
              selected,
            ),
            action("all", `Publish with all (${waiting.length})`, waiting),
          ];

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="outline">Needs review</Badge>
        <MutedText className="wrap-break-word">
          {course.published
            ? `${formatTaskCount(waiting.length)} below ${waiting.length === 1 ? "waits" : "wait"} for review: learners aren't asked ${waiting.length === 1 ? "it" : "them"} until you publish.`
            : "Review it below, its waiting tasks first: learners can't see this course until you publish it."}
        </MutedText>
      </div>
      <PublishBar
        actions={actions}
        publishing={publication.publishing}
        note={
          editing
            ? `Save or cancel the open edit to ${course.published ? "publish" : "publish or delete"}.`
            : undefined
        }
        // Not beside another action's attempt, which it does not speak of.
        failures={busy ? 0 : publication.failures}
      />
    </>
  );
}

/**
 * Publish's question when `tasks` reach the organization's other published
 * courses too, naming them, each once, by title; none when they reach none.
 */
function confirmation(course: AuthoredCourse, tasks: readonly ReviewTask[]) {
  const sent = new Set(tasks.map(({ id }) => id));
  const courses = [
    ...new Map(
      course.objectives
        .filter((objective) => objective.tasks.some(({ id }) => sent.has(id)))
        .flatMap(({ otherPublishedCourses }) => otherPublishedCourses)
        .map((other) => [other.id, other]),
    ).values(),
  ].toSorted((a, b) => a.title.localeCompare(b.title));
  if (courses.length === 0) return undefined;
  return {
    title: `Publish ${course.published ? "" : "the course and "}${formatTaskCount(tasks.length)}?`,
    description: `Learners of ${courses.length === 1 ? "another course" : "other courses"} will be asked ${tasks.length === 1 ? "it" : "some of them"} too:`,
    courses,
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

/**
 * One objective as a reviewer checks it. Under What it teaches: the passages
 * that teach it, then its published tasks, each with the passages it was
 * written from. `waiting`: its waiting tasks instead, without its passages,
 * each selectable, a correction above the task it replaces.
 */
function Objective(props: {
  objective: AuthoredCourse["objectives"][number];
  place: number;
  sources: ReadonlyMap<string, SourceSummary>;
  waiting?: true;
  selection?: TaskSelection;
  /** The task whose editor is open on the page, if any: every other Edit waits for it. */
  editing: string | undefined;
  onEdit: (taskId: string | undefined) => void;
  /** Publish, Delete, Hide, or Show is under way: no editor opens, as what follows would close it. */
  pending: boolean;
  /** Focused when a task's change leaves this objective off the page. */
  fallbackFocus: RefObject<HTMLHeadingElement | null>;
}) {
  const { objective, place, sources, waiting, selection, editing, onEdit, pending, fallbackFocus } =
    props;
  const heading = useRef<HTMLHeadingElement>(null);
  const waitingIds = objective.tasks.filter(({ published }) => !published).map(({ id }) => id);
  const publishedCount = objective.tasks.length - waitingIds.length;
  // One ID per section, as an objective may appear in both.
  const headingId = waiting ? `waiting-${objective.id}` : objective.id;

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* Focusable, to receive focus from a task retired or corrected beneath it. */}
        <Heading level={3} id={headingId} ref={heading} tabIndex={-1} className="mb-0 min-w-0">
          {place}. {objective.title}
        </Heading>
        {selection && (
          <SelectAll taskIds={waitingIds} selection={selection} objectiveTitle={objective.title} />
        )}
      </div>
      {!waiting &&
        (objective.citations.length === 0 ? (
          <MutedText>No passage cited as teaching it.</MutedText>
        ) : (
          <Passages citations={objective.citations} sources={sources} />
        ))}
      {!waiting && publishedCount === 0 && (
        <MutedText>
          {waitingIds.length === 0
            ? "No tasks: learners are not asked about it."
            : `No published tasks: learners are not asked about it until you publish ${waitingIds.length === 1 ? "the one" : "those"} waiting above.`}
        </MutedText>
      )}
      <TaskList
        objectiveId={objective.id}
        tasks={objective.tasks}
        waiting={waiting}
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
