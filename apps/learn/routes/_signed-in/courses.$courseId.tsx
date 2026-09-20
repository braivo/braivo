// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type LearningDecision } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  loader: async ({ context, params, abortController }) => {
    try {
      const decision = await context.braivo.nextObjective(params.courseId, {
        signal: abortController.signal,
      });
      return { decision };
    } catch (error) {
      // Braivo answers a missing course and someone else's alike.
      if (error instanceof BraivoError && error.status === 404) throw notFound();
      throw error;
    }
  },
  component: NextStep,
  notFoundComponent: () => <p>This course does not exist, or is not one of yours.</p>,
});

function NextStep() {
  const { decision } = Route.useLoaderData();
  return <Decision decision={decision} />;
}

function Decision({ decision }: { decision: LearningDecision | undefined }) {
  if (!decision) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>You are all caught up</EmptyTitle>
          <EmptyDescription>Nothing needs attention right now. Come back later.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  switch (decision.intent) {
    case "introduce":
      return <Step title="Learn something new" objectiveId={decision.objectiveId} />;
    case "reteach":
      return (
        <Step title="Try this again" objectiveId={decision.objectiveId}>
          Last attempted {new Date(decision.lastEvidenceAt).toLocaleString()}.
        </Step>
      );
    case "review":
      return (
        <Step title="Time to review" objectiveId={decision.objectiveId}>
          Likely to recall: {Math.round(decision.retrievability * 100)}%.
        </Step>
      );
    default:
      return decision satisfies never;
  }
}

function Step(props: { title: string; objectiveId: string; children?: React.ReactNode }) {
  return (
    <section>
      <Heading className="mb-0">{props.title}</Heading>
      <MutedText>Objective {props.objectiveId}</MutedText>
      {props.children && <p className="mt-2">{props.children}</p>}
    </section>
  );
}
