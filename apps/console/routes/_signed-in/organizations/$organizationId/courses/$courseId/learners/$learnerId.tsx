// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ObjectiveStanding } from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { createFileRoute } from "@tanstack/react-router";

import { orNotFound, readCourseInOrganization, readMembers } from "#lib/refusals";

export const Route = createFileRoute(
  "/_signed-in/organizations/$organizationId/courses/$courseId/learners/$learnerId",
)({
  loader: async ({ context, params, abortController }) => {
    const signal = abortController.signal;

    await readCourseInOrganization(context.braivo, { ...params, signal });

    const [report, objectives, members] = await Promise.all([
      orNotFound(
        context.braivo.learnerProgress(
          { courseId: params.courseId, learnerId: params.learnerId },
          { signal },
        ),
      ),
      orNotFound(context.braivo.listObjectives(params.organizationId, { signal })),
      readMembers(context.auth, params.organizationId),
    ]);

    const titles = new Map(objectives.map(({ id, title }) => [id, title]));
    const learner = members.find(({ userId }) => userId === params.learnerId);
    return { report, titles, learnerName: learner?.user.name ?? params.learnerId };
  },
  component: Progress,
  notFoundComponent: () => <p>This learner's progress is not yours to see, or does not exist.</p>,
});

function Progress() {
  const { report, titles, learnerName } = Route.useLoaderData();

  return (
    <>
      <Heading>{learnerName}</Heading>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Objective</TableHead>
            <TableHead>Standing</TableHead>
            <TableHead>Last attempted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.objectives.map((standing) => (
            <TableRow key={standing.objectiveId}>
              <TableCell>{titles.get(standing.objectiveId) ?? standing.objectiveId}</TableCell>
              <TableCell>{describe(standing)}</TableCell>
              <TableCell>
                {standing.phase === "unseen"
                  ? "—"
                  : new Date(standing.lastEvidenceAt).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function describe(standing: ObjectiveStanding): string {
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
