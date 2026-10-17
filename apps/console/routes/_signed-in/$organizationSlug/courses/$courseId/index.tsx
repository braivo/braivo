// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type AuthoredCourse, BraivoError, courseRef } from "@braivo/server/client";
import {
  AuthoredTask,
  type EditableTask,
  Heading,
  MutedText,
  SourcePassage,
  TaskEditor,
} from "@braivo/ui";
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
import { Checkbox } from "@braivo/ui/components/checkbox";
import { Label } from "@braivo/ui/components/label";
import { Spinner } from "@braivo/ui/components/spinner";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { CourseUrlLabel } from "#components/course-url-label";
import { LearnersSite } from "#components/learners-site";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
  beforeLoad: administratorsOnly,
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
  // Selected for Publish selected, none on opening. By ID, so a task no longer
  // waiting (published, retired, or corrected, a correction being a new ID)
  // drops out of `selectedTasks`.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const waiting = waitingTasks(course);
  const selectedTasks = waiting.filter(({ id }) => selectedIds.has(id));
  const select = (taskIds: readonly string[], checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of taskIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  // One editor on the page: saving a task's correction retires its waiting
  // correction, which the other section shows. Open only while its task is
  // listed: a reload may show it corrected or retired by someone else.
  const [editingId, setEditingId] = useState<string>();
  const editing = course.objectives.some(({ tasks }) => tasks.some(({ id }) => id === editingId))
    ? editingId
    : undefined;
  // Which Publish button's request is under way. It and an open editor each
  // wait for the other: Publish reloads the page, which would close an editor
  // and lose its unsaved edit.
  const [publishing, setPublishing] = useState<"selected" | "all">();
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
      {course.published && (
        <LearnersSite
          learnDomain={organization.learnDomain}
          path={`/c/${courseRef(course)}`}
          at={`Open to every learner in ${organization.name} at`}
          none={`Open to every learner in ${organization.name}, once it has a site to practise on.`}
        />
      )}
      {(!course.published || waiting.length > 0) && (
        <PublishWaiting
          course={course}
          selected={selectedTasks}
          publishing={publishing}
          onPublishing={setPublishing}
          editing={editing !== undefined}
          onStart={() => setStatusMessage("")}
          onDone={(message) => {
            heading.current?.focus();
            setStatusMessage(message);
          }}
        />
      )}
      <MutedText role="status" className="mb-4 block empty:mb-0">
        {statusMessage}
      </MutedText>
      {/* Its link's label, once the link reaches learners. */}
      {course.published && (
        <CourseUrlLabel braivo={braivo} organizationId={organization.id} course={course} />
      )}
      {/* Its learners' progress, a page shared with teachers (access-39). */}
      <Button asChild variant="outline" className="mb-8 w-fit">
        <Link
          to="/$organizationSlug/courses/$courseId/progress"
          params={{ organizationSlug: organization.slug, courseId }}
        >
          Learner progress
          <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
        </Link>
      </Button>
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
              course={course}
              waiting
              selection={{ selectedIds, select }}
              editing={editing}
              onEdit={setEditingId}
              publishing={publishing !== undefined}
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
            course={course}
            editing={editing}
            onEdit={setEditingId}
            publishing={publishing !== undefined}
            fallbackFocus={heading}
          />
        ))}
      </section>
    </>
  );
}

type CourseTask = AuthoredCourse["objectives"][number]["tasks"][number];

/** The course's tasks still waiting for review, in the order the page shows them. */
function waitingTasks(course: AuthoredCourse) {
  return course.objectives.flatMap(({ tasks }) => tasks.filter(({ published }) => !published));
}

/** "1 task", "3 tasks". */
const formatTaskCount = (count: number) => (count === 1 ? "1 task" : `${count} tasks`);

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
  selected: readonly CourseTask[];
  /** Which button's request is under way: it says Publishing…, and neither sends another. */
  publishing: "selected" | "all" | undefined;
  onPublishing: (action: "selected" | "all" | undefined) => void;
  /** A task's editor is open: neither button sends until it closes. */
  editing: boolean;
  /** Sending: what an earlier attempt said no longer holds, and the next result is announced anew. */
  onStart: () => void;
  /** Published, or refused as stale: the page shown again, and what happened to announce. */
  onDone: (message: string) => void;
}) {
  const { course, selected, publishing, onPublishing, editing, onStart, onDone } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  // Counted, so a second failure mounts a new alert, announced again.
  const [failures, setFailures] = useState(0);
  const waiting = waitingTasks(course);

  async function publish(action: "selected" | "all", tasks: readonly CourseTask[]) {
    if (publishing || editing) return;
    onPublishing(action);
    // What earlier attempts said goes: this one's result is what the page says.
    setFailures(0);
    onStart();
    try {
      await braivo.publish(
        {
          organizationId: organization.id,
          courseIds: course.published ? [] : [course.id],
          taskIds: tasks.map(({ id }) => id),
        },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      // Focus moves once the page shows it published (`sync`, as a correction's).
      await router.invalidate({ sync: true });
      onDone(
        course.published
          ? `Published ${formatTaskCount(tasks.length)}.`
          : tasks.length === 0
            ? "Course published."
            : `Published the course and ${formatTaskCount(tasks.length)}.`,
      );
    } catch (thrown) {
      if (thrown instanceof BraivoError && thrown.status === 409) {
        // Something it named was retired or corrected meanwhile: the page shows
        // what is there now, saying why, so nothing is published unseen.
        await router.invalidate({ sync: true });
        onDone(
          "Nothing was published: this page changed since it loaded. Review it, then publish.",
        );
      } else if (thrown instanceof BraivoError && [401, 403].includes(thrown.status)) {
        // Signed out or no longer administering it meanwhile: the guard's check, run again, says so.
        await router.invalidate();
      } else {
        setFailures((count) => count + 1);
      }
    } finally {
      onPublishing(undefined);
    }
  }

  // Sent with the course while it waits: the page is its review, so either
  // button publishes it. Without waiting tasks, Publish alone.
  const actions: { action: "selected" | "all"; label: string; tasks: readonly CourseTask[] }[] =
    waiting.length === 0
      ? [{ action: "all", label: "Publish", tasks: [] }]
      : course.published
        ? [
            { action: "selected", label: `Publish selected (${selected.length})`, tasks: selected },
            { action: "all", label: `Publish all (${waiting.length})`, tasks: waiting },
          ]
        : [
            {
              action: "selected",
              label:
                selected.length === 0
                  ? "Publish without waiting tasks"
                  : `Publish with selected (${selected.length})`,
              tasks: selected,
            },
            {
              action: "all",
              label: `Publish with all (${waiting.length})`,
              tasks: waiting,
            },
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
      {/* Kept in view while the tasks below are read, however many: a direct
          child of the page, so it sticks over all of it. */}
      <div className="sticky top-0 z-10 mb-4 flex flex-col gap-2 bg-background py-2">
        <div className="flex flex-wrap items-center gap-2">
          {actions.map(({ action, label, tasks }) => (
            <PublishButton
              key={action}
              // Publish selected beside Publish all, told apart by weight.
              variant={actions.length > 1 && action === "selected" ? "outline" : "default"}
              label={publishing === action ? undefined : label}
              course={course}
              tasks={tasks}
              publishing={publishing !== undefined}
              // Selecting nothing publishes nothing in a published course.
              disabled={editing || (course.published && tasks.length === 0)}
              onPublish={() => publish(action, tasks)}
            />
          ))}
        </div>
        {editing && <MutedText>Save or cancel the open edit to publish.</MutedText>}
        {/* Gone while trying again, so it never speaks of the attempt under way. */}
        {failures > 0 && publishing === undefined && (
          <Alert key={failures} variant="destructive">
            <AlertDescription>Could not publish. Try again.</AlertDescription>
          </Alert>
        )}
      </div>
    </>
  );
}

/**
 * One of Publish's buttons, sending `tasks`: asked first, naming them, when
 * those tasks' objectives are in other published courses.
 */
function PublishButton(props: {
  variant: "default" | "outline";
  /** Its name; none while its own request is under way, when it says Publishing…. */
  label: string | undefined;
  course: AuthoredCourse;
  tasks: readonly CourseTask[];
  publishing: boolean;
  disabled: boolean;
  onPublish: () => void;
}) {
  const { variant, label, course, tasks, publishing, disabled, onPublish } = props;
  const sent = new Set(tasks.map(({ id }) => id));
  // The other published courses these tasks reach, each once, by title.
  const otherPublishedCourses = [
    ...new Map(
      course.objectives
        .filter((objective) => objective.tasks.some(({ id }) => sent.has(id)))
        .flatMap(({ otherPublishedCourses }) => otherPublishedCourses)
        .map((other) => [other.id, other]),
    ).values(),
  ].toSorted((a, b) => a.title.localeCompare(b.title));

  // aria-disabled, not disabled, while publishing, so that it keeps the focus
  // meanwhile; its click ignored then, opening no confirmation either.
  const button = (onClick?: () => void) => (
    <Button
      size="sm"
      variant={variant}
      disabled={disabled}
      // Absent rather than false while `disabled` says it.
      aria-disabled={publishing || undefined}
      onClick={(event) => (publishing ? event.preventDefault() : onClick?.())}
    >
      {label ?? (
        <>
          {/* Hidden: "Publishing…" already says it. */}
          <Spinner data-icon="inline-start" aria-hidden="true" />
          Publishing…
        </>
      )}
    </Button>
  );

  if (otherPublishedCourses.length === 0) return button(onPublish);
  return (
    <AlertDialog>
      {/* Radix opens it unless the click was prevented, as while publishing. */}
      <AlertDialogTrigger asChild>{button()}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Publish {course.published ? "" : "the course and "}
            {formatTaskCount(tasks.length)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Learners of {otherPublishedCourses.length === 1 ? "another course" : "other courses"}{" "}
            will be asked {tasks.length === 1 ? "it" : "some of them"} too:
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Bounded and wrapped, so however many titles, and however long, the
            buttons stay in view; focusable, so a keyboard scrolls it too. */}
        <ul
          aria-label="Other courses"
          tabIndex={0}
          className="max-h-40 min-w-0 list-disc overflow-y-auto pl-6 text-sm wrap-break-word"
        >
          {otherPublishedCourses.map(({ id, title }) => (
            <li key={id}>{title}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Not yet</AlertDialogCancel>
          <AlertDialogAction onClick={onPublish}>Publish</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  course: AuthoredCourse;
  waiting?: true;
  /** Which waiting tasks Publish selected sends, and choosing them. */
  selection?: {
    selectedIds: ReadonlySet<string>;
    select: (taskIds: readonly string[], checked: boolean) => void;
  };
  /** The task whose editor is open on the page, if any: every other Edit waits for it. */
  editing: string | undefined;
  onEdit: (taskId: string | undefined) => void;
  /** Publish is under way: no editor opens until its reload is done. */
  publishing: boolean;
  /** Focused when a task's change leaves this objective off the page. */
  fallbackFocus: RefObject<HTMLHeadingElement | null>;
}) {
  const {
    objective,
    place,
    course,
    waiting,
    selection,
    editing,
    onEdit,
    publishing,
    fallbackFocus,
  } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  // The task whose Edit button takes focus back once its editor closes unsaved.
  const refocus = useRef<string>(undefined);
  const sources = new Map(course.sources.map((source) => [source.id, source]));
  const byId = new Map(objective.tasks.map((task) => [task.id, task]));
  // Published tasks a tool's correction waits to replace (ADR 0039), of all
  // its tasks: the section showing the task may not show its correction.
  const withWaitingCorrection = new Set(objective.tasks.flatMap((task) => task.replaces ?? []));
  const shown = objective.tasks.filter(({ published }) => (waiting ? !published : published));
  const waitingCount = objective.tasks.filter(({ published }) => !published).length;
  // The heading here, or, once a change took the objective off the page, the course's.
  const focusHeading = () => (heading.current ?? fallbackFocus.current)?.focus();
  const passages = (citations: AuthoredCourse["objectives"][number]["citations"]) =>
    citations.map((citation) => {
      const source = sources.get(citation.sourceId);
      return (
        <SourcePassage
          key={`${citation.sourceId}:${citation.start}:${citation.end}`}
          quote={citation.quote}
          title={source?.title ?? "A source"}
          url={source?.url}
        />
      );
    });
  const shownIds = shown.map(({ id }) => id);
  const selectedCount = selection
    ? shownIds.filter((id) => selection.selectedIds.has(id)).length
    : 0;
  // One ID per section, as an objective may appear in both.
  const headingId = waiting ? `waiting-${objective.id}` : objective.id;

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* Focusable, to receive focus from a task retired or corrected beneath it. */}
        <Heading level={3} id={headingId} ref={heading} tabIndex={-1} className="mb-0 min-w-0">
          {place}. {objective.title}
        </Heading>
        {/* The unit a teacher reviews: its waiting tasks, all at once. */}
        {selection && (
          <Label className="font-normal">
            <Checkbox
              checked={
                selectedCount === 0
                  ? false
                  : selectedCount === shownIds.length
                    ? true
                    : "indeterminate"
              }
              onCheckedChange={(checked) => selection.select(shownIds, checked === true)}
            />
            Select all {shownIds.length}
            <span className="sr-only"> of “{objective.title}”</span>
          </Label>
        )}
      </div>
      {!waiting &&
        (objective.citations.length === 0 ? (
          <MutedText>No passage cited as teaching it.</MutedText>
        ) : (
          passages(objective.citations)
        ))}
      {!waiting && shown.length === 0 && (
        <MutedText>
          {waitingCount === 0
            ? "No tasks: learners are not asked about it."
            : `No published tasks: learners are not asked about it until you publish ${waitingCount === 1 ? "the one" : "those"} waiting above.`}
        </MutedText>
      )}
      {shown.map((task) => {
        const replaced = task.replaces === undefined ? undefined : byId.get(task.replaces);
        return (
          <Fragment key={task.id}>
            {editing === task.id ? (
              <CorrectTask
                objectiveId={objective.id}
                task={task}
                hasWaitingCorrection={withWaitingCorrection.has(task.id)}
                onDone={() => {
                  onEdit(undefined);
                  focusHeading();
                }}
                onCancel={() => {
                  refocus.current = task.id;
                  onEdit(undefined);
                }}
              />
            ) : (
              <RetirableTask
                task={task}
                renderEdit={(retiring) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${taskName(task)}`}
                    ref={(button) => {
                      if (button && refocus.current === task.id) {
                        refocus.current = undefined;
                        button.focus();
                      }
                    }}
                    // Not while retiring it, which could land under the edit, nor while Publish's reload could close it.
                    disabled={retiring || publishing || editing !== undefined}
                    onClick={() => onEdit(task.id)}
                  >
                    Edit
                  </Button>
                )}
                select={
                  selection && (
                    <Checkbox
                      aria-label={`Select ${taskName(task)}`}
                      checked={selection.selectedIds.has(task.id)}
                      onCheckedChange={(checked) => selection.select([task.id], checked === true)}
                    />
                  )
                }
                hasWaitingCorrection={withWaitingCorrection.has(task.id)}
                corrects={replaced?.prompt}
                onRetired={focusHeading}
              >
                {passages(task.citations)}
              </RetirableTask>
            )}
            {/* Beside its correction, to compare; its buttons are under What it teaches. */}
            {replaced && (
              <div className="ms-6 flex flex-col gap-2">
                <MutedText>As published now:</MutedText>
                <AuthoredTask task={replaced}>{passages(replaced.citations)}</AuthoredTask>
              </div>
            )}
          </Fragment>
        );
      })}
    </article>
  );
}

/**
 * A task as its buttons are named: a waiting one apart from a published one,
 * since a correction usually keeps the prompt of the task it corrects.
 */
const taskName = (task: CourseTask) =>
  task.published ? `“${task.prompt}”` : `waiting task “${task.prompt}”`;

/**
 * Edits a task the only way an immutable one can be: its correction, with the
 * task's passages and option order, replaces it in one step. Not asked first,
 * unlike retiring, since learners always have one or the other.
 */
function CorrectTask(props: {
  objectiveId: string;
  task: CourseTask;
  /** A correction waits to replace it, which saving retires. */
  hasWaitingCorrection: boolean;
  /** Corrected, or reloaded to find it changed: the course as stored is shown. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const { objectiveId, task, hasWaitingCorrection, onDone, onCancel } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // `stale` when someone changed the task first, so saving again cannot help.
  const [error, setError] = useState<{ text: string; stale?: true }>();
  const alert = useRef<HTMLDivElement>(null);

  // Saving disabled the button that had focus; the reason it failed takes it.
  useLayoutEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  async function save(edit: EditableTask) {
    setSaving(true);
    setError(undefined);
    try {
      await braivo.defineTasks(
        {
          organizationId: organization.id,
          tasks: [
            {
              objectiveId,
              ...(edit.kind === "choice"
                ? {
                    ...edit,
                    options: [...edit.options],
                    ...(task.kind === "choice" && task.keepOrder && { keepOrder: true }),
                  }
                : { ...edit, accepted: [...edit.accepted] }),
              citations: task.citations.map(({ sourceId, quote }) => ({ sourceId, quote })),
              replaces: task.id,
            },
          ],
        },
        // Bounded: an identical correction retried after a lost answer returns the stored task.
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      // `sync`: resolved once the course is read again, not with the old one
      // while it reloads in the background, which would offer the old task to edit.
      await router.invalidate({ sync: true });
      onDone();
    } catch (thrown) {
      setSaving(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      setError(
        !(thrown instanceof BraivoError) || thrown.status !== 409
          ? { text: "The task could not be corrected. Try again." }
          : thrown.code === "DUPLICATE_CORRECTION"
            ? {
                text: "Another task of this objective is already the same. Review its tasks before editing or publishing.",
              }
            : { text: "Someone changed or retired this task since the page loaded.", stale: true },
      );
    }
  }

  async function reload() {
    if (saving) return;
    setSaving(true);
    await router.invalidate({ sync: true });
    onDone();
  }

  return (
    <div className="flex flex-col gap-3">
      <MutedText>
        {task.published
          ? "Saving replaces the task: learners are asked the corrected one from now on, and what they already answered stays."
          : "Saving replaces the task: the corrected one waits for review, as this one does."}
        {hasWaitingCorrection && " The correction waiting for review is retired with it."}
      </MutedText>
      {error && (
        <Alert variant="destructive" ref={alert} tabIndex={-1}>
          <AlertDescription>{error.text}</AlertDescription>
          {error.stale && (
            // aria-disabled, not disabled, so that it keeps the focus meanwhile.
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-fit"
              aria-disabled={saving}
              onClick={reload}
            >
              Reload the course
            </Button>
          )}
        </Alert>
      )}
      {/* Disabled while saving, so the edit sent is the one shown, and Cancel cannot undo it. */}
      <fieldset disabled={saving} aria-busy={saving} className="min-w-0">
        <TaskEditor task={task} onSave={save} onCancel={onCancel} />
      </fieldset>
    </div>
  );
}

/**
 * A task with its Edit button, from `renderEdit`, and Retire. Retiring takes
 * a task out of practice for good: asked first, because learners stop seeing
 * it at once. The dialog hands focus back to Retire, which says Retiring…
 * meanwhile; once the task is gone, `onRetired` moves focus, unless it is
 * already elsewhere, as in another task's editor opened meanwhile.
 */
function RetirableTask(props: {
  task: CourseTask;
  /** The task's Edit button, given whether it is retiring. */
  renderEdit: (retiring: boolean) => ReactNode;
  /** While it waits, its checkbox for Publish selected. */
  select?: ReactNode;
  /** A correction waits to replace it, which retiring retires too. */
  hasWaitingCorrection: boolean;
  /** While it waits to correct a published task, that task's prompt. */
  corrects?: string;
  onRetired: () => void;
  /** The passages it was written from. */
  children: ReactNode;
}) {
  const { task, renderEdit, select, hasWaitingCorrection, corrects, onRetired, children } = props;
  const { prompt } = task;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  // A ref, set at once, refuses a second confirmation before `retiring` renders.
  const pending = useRef(false);
  const [retiring, setRetiring] = useState(false);
  /** The last failure's count keys the alert, so a repeat is announced too. */
  const [failures, setFailures] = useState(0);

  async function retire() {
    if (pending.current) return;
    pending.current = true;
    setRetiring(true);
    try {
      // Bounded: retried after a lost answer, it keeps the first retirement.
      await braivo.retireTasks(
        { organizationId: organization.id, taskIds: [task.id] },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
    } catch (thrown) {
      pending.current = false;
      setRetiring(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) {
        // Not an earlier failure said again on the way to sign in.
        setFailures(0);
        return router.invalidate();
      }
      setFailures((count) => count + 1);
      return;
    }
    // Focus moves once the task is gone (`sync`, as a correction's), if it went with it.
    await router.invalidate({ sync: true });
    if (document.activeElement === document.body) onRetired();
  }

  return (
    <AuthoredTask
      task={task}
      status={
        !task.published && (
          <>
            {/* Beside its state, not its buttons, which would squeeze its prompt on a phone. */}
            <span className="flex items-center gap-2">
              {select}
              <Badge variant="outline">Waiting</Badge>
            </span>
            {corrects !== undefined && (
              <MutedText className="mt-1 block">
                Corrects “{corrects}”, which stays published until you publish this.
              </MutedText>
            )}
          </>
        )
      }
      action={
        <span className="flex items-center gap-2">
          {renderEdit(retiring)}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              {/* Named for its task, as Edit is, retiring too. Focusable meanwhile, opening nothing. */}
              <Button
                variant="outline"
                size="sm"
                aria-label={`${retiring ? "Retiring" : "Retire"} ${taskName(task)}`}
                aria-disabled={retiring}
                onClick={(event) => retiring && event.preventDefault()}
              >
                {retiring ? (
                  <>
                    {/* Hidden: the name says it. */}
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                    Retiring…
                  </>
                ) : (
                  "Retire"
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Retire “{prompt}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  {task.published
                    ? "Learners will not be asked it again; what they already answered stays."
                    : "It was never published, so learners have not been asked it."}
                  {hasWaitingCorrection && " The correction waiting for review is retired with it."}{" "}
                  To change it instead, edit it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={retire}>
                  Retire
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </span>
      }
      notice={
        failures > 0 &&
        !retiring && (
          <Alert variant="destructive" key={failures}>
            <AlertDescription>The task could not be retired. Try again.</AlertDescription>
          </Alert>
        )
      }
    >
      {children}
    </AuthoredTask>
  );
}
