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
import { Spinner } from "@braivo/ui/components/spinner";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

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
  // Focusable, to receive focus from Publish, gone once it is.
  const heading = useRef<HTMLHeadingElement>(null);
  // Present from the start, so saying it was published is announced.
  const [statusMessage, setStatusMessage] = useState("");

  return (
    <>
      <Heading ref={heading} tabIndex={-1}>
        {course.title}
      </Heading>
      {/* A tool's course waits for a person's review here (ADR 0039); the
          console's own, accepted from a draft, is published as it is created. */}
      {course.published ? (
        <LearnersSite
          learnDomain={organization.learnDomain}
          path={`/c/${courseRef(course)}`}
          at={`Open to every learner in ${organization.name} at`}
          none={`Open to every learner in ${organization.name}, once it has a site to practise on.`}
        />
      ) : (
        <PublishCourse
          courseId={course.id}
          onPublished={() => {
            heading.current?.focus();
            setStatusMessage("Course published.");
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
      <section aria-labelledby="teaches" className="flex flex-col gap-6">
        <Heading level={2} id="teaches">
          What it teaches
        </Heading>
        {course.objectives.length === 0 && <MutedText>No objectives yet.</MutedText>}
        {course.objectives.map((objective, index) => (
          <Objective key={objective.id} objective={objective} place={index + 1} course={course} />
        ))}
      </section>
    </>
  );
}

/** Publishing a course that waits for review, so learners reach it (ADR 0039). */
function PublishCourse(props: { courseId: string; onPublished: () => void }) {
  const { courseId, onPublished } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  const [publishing, setPublishing] = useState(false);
  // Counted, so a second failure mounts a new alert, announced again.
  const [failures, setFailures] = useState(0);

  async function publish() {
    setPublishing(true);
    try {
      await braivo.publish(
        { organizationId: organization.id, courseIds: [courseId] },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      // Focus moves once the page shows it published (`sync`, as a correction's).
      await router.invalidate({ sync: true });
      onPublished();
    } catch (thrown) {
      // Signed out or no longer administering it meanwhile, the guard's check,
      // run again, says so; on 409, the page shows what is there now.
      if (thrown instanceof BraivoError && [401, 403, 409].includes(thrown.status)) {
        await router.invalidate();
      } else {
        setFailures((count) => count + 1);
      }
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="outline">Needs review</Badge>
        <MutedText className="wrap-break-word">
          Review what it teaches below: learners can't see this course until you publish it.
        </MutedText>
        {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
        <Button size="sm" aria-disabled={publishing} onClick={() => !publishing && publish()}>
          {publishing ? (
            <>
              {/* Hidden: "Publishing…" already says it. */}
              <Spinner data-icon="inline-start" aria-hidden="true" />
              Publishing…
            </>
          ) : (
            "Publish"
          )}
        </Button>
      </div>
      {/* Gone while trying again, so it never speaks of the attempt under way. */}
      {failures > 0 && !publishing && (
        <Alert key={failures} variant="destructive">
          <AlertDescription>Could not publish. Try again.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * One objective as a reviewer checks it: the passages that teach it, then the
 * tasks that practise it, each with the passages it was written from.
 */
function Objective(props: {
  objective: AuthoredCourse["objectives"][number];
  place: number;
  course: AuthoredCourse;
}) {
  const { objective, place, course } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<string>();
  // Open only while its task is listed: a reload may show it corrected or retired by someone else.
  const open = objective.tasks.some(({ id }) => id === editing) ? editing : undefined;
  // The task whose Edit button takes focus back once its editor closes unsaved.
  const refocus = useRef<string>(undefined);
  const sources = new Map(course.sources.map((source) => [source.id, source]));
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

  return (
    <article aria-labelledby={objective.id} className="flex flex-col gap-3">
      {/* Focusable, to receive focus from a task retired or corrected beneath it. */}
      <Heading level={3} id={objective.id} ref={heading} tabIndex={-1}>
        {place}. {objective.title}
      </Heading>
      {objective.citations.length === 0 ? (
        <MutedText>No passage cited as teaching it.</MutedText>
      ) : (
        passages(objective.citations)
      )}
      {objective.tasks.length === 0 ? (
        <MutedText>No tasks: learners are not asked about it.</MutedText>
      ) : (
        objective.tasks.map((task) =>
          open === task.id ? (
            <CorrectTask
              key={task.id}
              objectiveId={objective.id}
              task={task}
              onDone={() => {
                setEditing(undefined);
                heading.current?.focus();
              }}
              onCancel={() => {
                refocus.current = task.id;
                setEditing(undefined);
              }}
            />
          ) : (
            <AuthoredTask
              key={task.id}
              task={task}
              action={
                <span className="flex items-start gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit “${task.prompt}”`}
                    ref={(button) => {
                      if (button && refocus.current === task.id) {
                        refocus.current = undefined;
                        button.focus();
                      }
                    }}
                    disabled={open !== undefined}
                    onClick={() => setEditing(task.id)}
                  >
                    Edit
                  </Button>
                  <RetireTask
                    taskId={task.id}
                    prompt={task.prompt}
                    onRetired={() => heading.current?.focus()}
                  />
                </span>
              }
            >
              {passages(task.citations)}
            </AuthoredTask>
          ),
        )
      )}
    </article>
  );
}

/**
 * Edits a task the only way an immutable one can be: its correction, with the
 * task's passages and option order, replaces it in one step. Not asked first,
 * unlike retiring, since learners always have one or the other.
 */
function CorrectTask(props: {
  objectiveId: string;
  task: AuthoredCourse["objectives"][number]["tasks"][number];
  /** Corrected, or reloaded to find it changed: the course as stored is shown. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const { objectiveId, task, onDone, onCancel } = props;
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
      await braivo.defineTasks({
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
      });
      // `sync`: resolved once the course is read again, not with the old one
      // while it reloads in the background, which would offer the old task to edit.
      await router.invalidate({ sync: true });
      onDone();
    } catch (thrown) {
      setSaving(false);
      setError(
        thrown instanceof BraivoError && thrown.status === 409
          ? { text: "Someone changed or retired this task since the page loaded.", stale: true }
          : { text: "The task could not be corrected. Try again." },
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
        Saving replaces the task: learners are asked the corrected one from now on, and what they
        already answered stays.
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
 * Retiring takes a task out of practice for good: asked first, because
 * learners stop seeing it at once. Once retired, the task and this button are
 * gone, so `onRetired` says where focus goes instead.
 */
function RetireTask(props: { taskId: string; prompt: string; onRetired: () => void }) {
  const { taskId, prompt, onRetired } = props;
  const { braivo, organization } = Route.useRouteContext();
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  // Set as the owner confirms, before the dialog closes, so that closing does
  // not hand focus back to a button about to disappear.
  const retiring = useRef(false);
  const [error, setError] = useState<string>();

  async function retire() {
    if (retiring.current) return;
    retiring.current = true;
    setError(undefined);
    try {
      await braivo.retireTasks({ organizationId: organization.id, taskIds: [taskId] });
      // Focus moves once the task is gone from the page (`sync`, as a correction's).
      await router.invalidate({ sync: true });
      onRetired();
    } catch {
      retiring.current = false;
      setError("The task could not be retired. Try again.");
      trigger.current?.focus();
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" ref={trigger}>
            Retire
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (retiring.current) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Retire “{prompt}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Learners will not be asked it again; what they already answered stays. To change it
              instead, edit it.
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
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
