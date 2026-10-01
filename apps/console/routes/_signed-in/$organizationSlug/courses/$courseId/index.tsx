// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthoredCourse } from "@braivo/server/client";
import { AuthoredTask, Heading, MutedText, SourcePassage } from "@braivo/ui";
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
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { orNotFound, readMembers } from "#lib/refusals";

export const Route = createFileRoute("/_signed-in/$organizationSlug/courses/$courseId/")({
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    // Read through its organization, which Braivo checks owns it.
    const course = await orNotFound(
      context.braivo.readCourse(
        { organizationId, courseId: params.courseId },
        { signal: abortController.signal },
      ),
    );
    const members = await readMembers(context.auth, organizationId);

    return { course, members };
  },
  component: Course,
  notFoundComponent: () => <p>This course does not exist, or you do not manage it.</p>,
});

function Course() {
  const { course, members } = Route.useLoaderData();
  const { organizationSlug, courseId } = Route.useParams();

  return (
    <>
      <Heading>{course.title}</Heading>
      <section aria-labelledby="teaches" className="flex flex-col gap-6">
        <Heading level={2} id="teaches">
          What it teaches
        </Heading>
        {course.objectives.length === 0 && <MutedText>No objectives yet.</MutedText>}
        {course.objectives.map((objective, index) => (
          <Objective key={objective.id} objective={objective} place={index + 1} course={course} />
        ))}
      </section>
      <Heading level={2}>Members</Heading>
      <ul className="list-disc pl-6">
        {members.map((member) => (
          <li key={member.id}>
            <Link
              to="/$organizationSlug/courses/$courseId/learners/$learnerId"
              params={{ organizationSlug, courseId, learnerId: member.userId }}
              className="underline"
            >
              {member.user.name}
            </Link>{" "}
            <Badge variant="secondary">{member.role}</Badge>
          </li>
        ))}
      </ul>
    </>
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
      {/* Focusable, to receive focus from a task retired beneath it. */}
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
        objective.tasks.map((task) => (
          <AuthoredTask
            key={task.id}
            prompt={task.prompt}
            options={task.options}
            answer={task.answer}
            explanation={task.explanation}
            action={
              <RetireTask
                taskId={task.id}
                prompt={task.prompt}
                onRetired={() => heading.current?.focus()}
              />
            }
          >
            {passages(task.citations)}
          </AuthoredTask>
        ))
      )}
    </article>
  );
}

/**
 * Retiring is how a task is taken back, since tasks are never edited: asked
 * first, because learners stop seeing it at once. Once retired, the task and
 * this button are gone, so `onRetired` says where focus goes instead.
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
      await router.invalidate();
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
              Learners will not be asked it again; what they already answered stays. Tasks are never
              edited: to change one, retire it and add the corrected one from a new draft or your
              desktop agent.
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
