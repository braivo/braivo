// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { countExplanations } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";

import { ExplanationCount } from "#components/explanations";
import { findingsId, hasFindings } from "#components/findings";
import {
  type Editing,
  formatTaskCount,
  type PublishAction,
  PublishBar,
  type ReviewTask,
  SelectAll,
  TaskList,
  usePublish,
  useTaskSelection,
} from "#components/task-review";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { authorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * An objective's tasks, reviewed once for every course it is in, or for none
 * (ADR 0039): where the organization's page leads for an objective in no
 * course, or in several with tasks pending. A course's page shows them too.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/objectives/$objectiveId")({
  beforeLoad: authorsOnly,
  loader: async ({ context, params, abortController }) => {
    const organizationId = context.organization.id;
    const { objectiveId } = params;
    // Bounded, since a correction or a retirement waits for this reload.
    const signal = withDeadline(abortController.signal, REQUEST_DEADLINE_MS);
    const [tasks, objectives, courses, sources] = await Promise.all([
      // Read through its organization, which Braivo checks owns it.
      orNotFound(context.braivo.listTasks({ organizationId, objectiveId }, { signal })),
      orNotFound(context.braivo.listObjectives(organizationId, { signal })),
      orNotFound(context.braivo.listCourses(organizationId, { signal })),
      orNotFound(context.braivo.listSources(organizationId, { signal })),
    ]);
    const objective = objectives.find(({ id }) => id === objectiveId);
    if (!objective) throw notFound();

    return {
      objective,
      tasks,
      // The courses its tasks serve, by title, as listed.
      courses: courses.filter(({ id }) => objective.courseIds.includes(id)),
      sources: new Map(sources.map((source) => [source.id, source])),
    };
  },
  head: (head) => pageHead(head, head.loaderData?.objective.title),
  component: ObjectivePage,
  notFoundComponent: () => <p>This objective does not exist, or you do not manage it.</p>,
});

/** Keyed by objective, so nothing said or pending on one objective's page carries to another's. */
function ObjectivePage() {
  return <Objective key={Route.useParams().objectiveId} />;
}

function Objective() {
  const { objective, tasks, courses, sources } = Route.useLoaderData();
  const { organization } = Route.useRouteContext();
  // Focusable, to receive focus once Publish is done, or a task's change.
  const heading = useRef<HTMLHeadingElement>(null);
  // Present from the start, so what Publish did is announced.
  const [statusMessage, setStatusMessage] = useState("");
  const selection = useTaskSelection();
  const pending = tasks.filter(({ published }) => !published);
  const selected = pending.filter(({ id }) => selection.selectedIds.has(id));
  // One editor on the page, open only while its task is listed, as on a course's.
  const [editingTask, setEditingTask] = useState<Editing>();
  const editing = tasks.some(({ id }) => id === editingTask?.taskId) ? editingTask : undefined;
  const publication = usePublish({
    onStart: () => setStatusMessage(""),
    onDone: (message) => {
      heading.current?.focus();
      setStatusMessage(message);
    },
  });
  const publishedCourses = courses.filter(({ published }) => published);
  const focusHeading = () => heading.current?.focus();

  const publishAction = (
    action: "selected" | "all",
    label: string,
    sent: readonly ReviewTask[],
  ): PublishAction => ({
    action,
    label,
    disabled: editing !== undefined || sent.length === 0,
    // Asked first when some of them have findings, or they reach published
    // courses, named. What a course is left without is its own page's to say.
    confirm: confirmation(sent),
    onPublish: () => {
      if (editing !== undefined) return;
      void publication.publish(
        action,
        { taskIds: sent.map(({ id }) => id) },
        `Published ${formatTaskCount(sent.length)}.`,
      );
    },
  });

  function confirmation(sent: readonly ReviewTask[]): PublishAction["confirm"] {
    const flagged = sent.filter(hasFindings);
    if (flagged.length === 0 && publishedCourses.length === 0) return undefined;
    return {
      title: `Publish ${formatTaskCount(sent.length)}?`,
      ...(flagged.length > 0 && {
        checks: {
          taskCount: flagged.length,
          objectivesWithoutPractice: [],
          onReview: () => document.getElementById(findingsId(flagged[0]!.id))?.focus(),
        },
      }),
      ...(publishedCourses.length > 0 && {
        reach: {
          description: `Learners of ${publishedCourses.length === 1 ? "this course" : "these courses"} will be asked ${sent.length === 1 ? "it" : "them"}:`,
          courses: publishedCourses,
        },
      }),
    };
  }

  return (
    <>
      {/* The way back to the list that leads here (docs/apps.md). */}
      <Link
        to="/$organizationSlug"
        params={{ organizationSlug: organization.slug }}
        className="mb-2 inline-block text-sm text-muted-foreground underline"
      >
        Courses
      </Link>
      <Heading ref={heading} tabIndex={-1}>
        {objective.title}
      </Heading>
      <MutedText className="mb-4 block wrap-break-word">
        {courses.length === 0 ? (
          "In no course: learners are asked its published tasks only once a published course includes it."
        ) : (
          <>
            In{" "}
            {courses.map((course, index) => (
              <Fragment key={course.id}>
                {index > 0 && ", "}
                <Link
                  to="/$organizationSlug/courses/$courseId"
                  params={{ organizationSlug: organization.slug, courseId: course.id }}
                  className="underline wrap-anywhere"
                >
                  {course.title}
                </Link>
                {!course.published && " (not published)"}
              </Fragment>
            ))}
            .
          </>
        )}
      </MutedText>
      {/* Its own count, for an objective in no course too; no narrowing: its tasks fit a page. */}
      <ExplanationCount counts={countExplanations(tasks)} />
      {pending.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Badge variant="outline">Needs review</Badge>
            <MutedText className="wrap-break-word">
              {`${formatTaskCount(pending.length)} below ${pending.length === 1 ? "waits" : "wait"} for review: `}
              {publishedCourses.length > 0
                ? `learners aren't asked ${pending.length === 1 ? "it" : "them"} until you publish.`
                : `learners are asked ${pending.length === 1 ? "it" : "them"} once you publish and a published course includes this objective.`}
            </MutedText>
          </div>
          <PublishBar
            actions={[
              publishAction("selected", `Publish selected (${selected.length})`, selected),
              publishAction("all", `Publish all (${pending.length})`, pending),
            ]}
            publishing={publication.publishing}
            note={editing !== undefined ? "Save or cancel the open edit to publish." : undefined}
            failures={publication.failures}
          />
        </>
      )}
      <MutedText role="status" className="mb-4 block empty:mb-0">
        {statusMessage}
      </MutedText>
      {/* Whatever is focused or scrolled to stops clear of Publish's sticky buttons. */}
      {pending.length > 0 && (
        <section aria-labelledby="pending" className="mb-10 flex flex-col gap-3 **:scroll-mt-40">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <Heading level={2} id="pending" className="mb-0">
              Needs review
            </Heading>
            <SelectAll
              taskIds={pending.map(({ id }) => id)}
              selection={selection}
              objectiveTitle={objective.title}
            />
          </div>
          <TaskList
            objectiveId={objective.id}
            tasks={tasks}
            showPending
            sources={sources}
            selection={selection}
            editing={editing}
            onEdit={setEditingTask}
            pending={publication.publishing !== undefined}
            onChanged={focusHeading}
          />
        </section>
      )}
      <section aria-labelledby="published" className="flex flex-col gap-3 **:scroll-mt-40">
        <Heading level={2} id="published">
          Published tasks
        </Heading>
        {tasks.length === pending.length && (
          <MutedText>None yet: learners are not asked about it.</MutedText>
        )}
        <TaskList
          objectiveId={objective.id}
          tasks={tasks}
          sources={sources}
          editing={editing}
          onEdit={setEditingTask}
          pending={publication.publishing !== undefined}
          onChanged={focusHeading}
        />
      </section>
    </>
  );
}
