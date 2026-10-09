// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AuthoredCourse,
  BraivoError,
  type CourseProgressOverview,
} from "@braivo/server/client";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { LearnersSite } from "#components/learners-site";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    // Bounded, since a correction or a retirement waits for this reload to
    // finish: unanswered in time, the page fails, offering Try again.
    const signal = withDeadline(abortController.signal, REQUEST_DEADLINE_MS);
    // Read through its organization, which Braivo checks owns it.
    const course = await orNotFound(
      context.braivo.readCourse({ organizationId, courseId: params.courseId }, { signal }),
    );
    const progress = await orNotFound(context.braivo.courseProgress(params.courseId, { signal }));

    return { course, progress };
  },
  head: (head) => pageHead(head, head.loaderData?.course.title),
  component: Course,
  notFoundComponent: () => <p>This course does not exist, or you do not manage it.</p>,
});

function Course() {
  const { course, progress } = Route.useLoaderData();
  const { organization } = Route.useRouteContext();

  return (
    <>
      <Heading>{course.title}</Heading>
      {/* A course has no draft state: open to learners once created, as accepting a draft does, landing here. */}
      <LearnersSite
        learnDomain={organization.learnDomain}
        at={`Open to every learner in ${organization.name} at`}
        none={`Open to every learner in ${organization.name}, once it has a site to practise on.`}
      />
      <ObjectiveProgress objectives={progress.objectives} />
      <Learners learners={progress.learners} />
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

/**
 * Knowledge gaps across learners: each objective with its learners counted by
 * standing. Absent for a course without objectives, which "What it teaches" says.
 */
function ObjectiveProgress({ objectives }: { objectives: CourseProgressOverview["objectives"] }) {
  if (objectives.length === 0) return null;

  return (
    <section aria-labelledby="by-objective" className="flex flex-col gap-3">
      <Heading level={2} id="by-objective">
        Progress by objective
      </Heading>
      <StandingsTable
        labelledBy="by-objective"
        rowHeader="Objective"
        rows={objectives.map(({ objectiveId, title, standings }) => ({
          key: objectiveId,
          label: title,
          standings,
        }))}
      />
    </section>
  );
}

/**
 * Every member, as each is enrolled (ADR 0018), with their objectives counted
 * by standing.
 */
function Learners({ learners }: { learners: CourseProgressOverview["learners"] }) {
  const { organizationSlug, courseId } = Route.useParams();

  return (
    <section aria-labelledby="learners" className="flex flex-col gap-3">
      <Heading level={2} id="learners">
        Learners
      </Heading>
      <StandingsTable
        labelledBy="learners"
        rowHeader="Learner"
        rows={learners.map(({ userId, name, roles, standings }) => ({
          key: userId,
          label: (
            <>
              <Link
                to="/$organizationSlug/courses/$courseId/learners/$learnerId"
                params={{ organizationSlug, courseId, learnerId: userId }}
                className="underline"
              >
                {name}
              </Link>
              {roles.map((role) => (
                <Badge key={role} variant="secondary" className="ml-2">
                  {role}
                </Badge>
              ))}
            </>
          ),
          standings,
        }))}
      />
    </section>
  );
}

/**
 * Rows counted by standing, labelled as the learner's own report labels them.
 * Named by its section's heading, so a screen reader's list of tables tells the
 * page's two apart.
 */
function StandingsTable(props: {
  labelledBy: string;
  rowHeader: string;
  rows: {
    key: string;
    label: ReactNode;
    standings: CourseProgressOverview["learners"][number]["standings"];
  }[];
}) {
  return (
    <Table aria-labelledby={props.labelledBy}>
      <TableHeader>
        <TableRow>
          <TableHead>{props.rowHeader}</TableHead>
          <TableHead className="text-right">Not started</TableHead>
          <TableHead className="text-right">Learning</TableHead>
          <TableHead className="text-right">Retained</TableHead>
          <TableHead className="text-right">Due for review</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map(({ key, label, standings }) => (
          <TableRow key={key}>
            {/* A row header, so each count is announced with whose it is. */}
            <TableHead scope="row" className="font-normal">
              {label}
            </TableHead>
            <TableCell className="text-right">{standings.unseen}</TableCell>
            <TableCell className="text-right">{standings.acquiring}</TableCell>
            <TableCell className="text-right">{standings.retained}</TableCell>
            <TableCell className="text-right">{standings.due}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
              prompt={task.prompt}
              options={task.options}
              answer={task.answer}
              explanation={task.explanation}
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
            kind: task.kind,
            ...edit,
            options: [...edit.options],
            ...(task.keepOrder && { keepOrder: true }),
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
