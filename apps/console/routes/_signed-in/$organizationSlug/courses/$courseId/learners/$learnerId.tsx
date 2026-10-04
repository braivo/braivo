// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LearnerProgressStanding } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { orNotFound, readCourseInOrganization } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute(
  "/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId",
)({
  loader: async ({ context, params, abortController }) => {
    const signal = abortController.signal;
    const organizationId = context.organization.id;

    const course = await readCourseInOrganization(context.braivo, {
      organizationId,
      courseId: params.courseId,
      signal,
    });

    const [report, members] = await Promise.all([
      orNotFound(
        context.braivo.learnerProgress(
          { courseId: params.courseId, learnerId: params.learnerId },
          { signal },
        ),
      ),
      orNotFound(context.braivo.listMembers(organizationId, { signal })),
    ]);

    const learner = members.find(({ userId }) => userId === params.learnerId);
    return { report, learnerName: learner?.name ?? params.learnerId, courseTitle: course.title };
  },
  // With the course, so one learner's tabs in two courses differ.
  head: (head) =>
    pageHead(
      head,
      head.loaderData && `${head.loaderData.learnerName} · ${head.loaderData.courseTitle}`,
    ),
  component: Progress,
  notFoundComponent: () => <p>This learner's progress is not yours to see, or does not exist.</p>,
});

function Progress() {
  const { report, learnerName, courseTitle } = Route.useLoaderData();
  const { organizationSlug, courseId } = Route.useParams();

  return (
    <>
      {/* The course this report is in, and the way back to its other learners. */}
      <Link
        to="/$organizationSlug/courses/$courseId"
        params={{ organizationSlug, courseId }}
        className="mb-2 inline-block text-sm text-muted-foreground underline"
      >
        {courseTitle}
      </Link>
      <Heading>{learnerName}</Heading>
      {/* A course is open to learners even before it has objectives. */}
      {report.objectives.length === 0 ? (
        <MutedText>This course has no objectives yet, so there is no progress to report.</MutedText>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Objective</TableHead>
              <TableHead>Standing</TableHead>
              <TableHead>Last evidence</TableHead>
              <TableHead>Evidence</TableHead>
              <TableHead>Review due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.objectives.map((standing) => (
              <TableRow key={standing.objectiveId}>
                {/* A row header, so each value is announced with its objective. */}
                <TableHead scope="row" className="font-normal">
                  {standing.title}
                </TableHead>
                <TableCell>{describe(standing)}</TableCell>
                <TableCell>
                  {standing.phase === "unseen"
                    ? "—"
                    : new Date(standing.lastEvidenceAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Evidence objective={standing.title} evidence={standing.evidence} />
                </TableCell>
                {/* Only what is retained falls due; what is learning comes back first. */}
                <TableCell>
                  {standing.phase === "retaining" ? new Date(standing.dueAt).toLocaleString() : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

/**
 * What a standing was replayed from, counted, and dated on request: one failure
 * and many both read "Learning", and only this tells them apart. Newest first,
 * since a long history is read for its end.
 */
function Evidence({
  objective,
  evidence,
}: {
  objective: string;
  evidence: LearnerProgressStanding["evidence"];
}) {
  if (evidence.length === 0) return "—";
  const successes = evidence.filter(({ outcome }) => outcome === "success").length;
  const failures = evidence.length - successes;
  const counted = [
    successes > 0 && `${successes} ${successes === 1 ? "success" : "successes"}`,
    failures > 0 && `${failures} ${failures === 1 ? "failure" : "failures"}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <details>
      {/* Named with its objective: a toggle reached on its own is not read with its row. */}
      <summary aria-label={`${objective}: ${counted}`} className="cursor-pointer">
        {counted}
      </summary>
      <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
        {evidence.toReversed().map(({ outcome, at }, index) => (
          // Stable for this report: evidence never changes once recorded.
          <li key={index}>
            {new Date(at).toLocaleString()}: {outcome}
          </li>
        ))}
      </ul>
    </details>
  );
}

function describe(standing: LearnerProgressStanding): string {
  switch (standing.phase) {
    case "unseen":
      return "Not started";
    case "acquiring":
      return "Learning";
    case "retaining": {
      const recall = `${Math.round(standing.retrievability * 100)}% recall`;
      return standing.due ? `Due for review, ${recall}` : `Retained, ${recall}`;
    }
    default:
      return standing satisfies never;
  }
}
