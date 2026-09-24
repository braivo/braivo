// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type Grade } from "@braivo/server/client";
import { ChoiceQuestion, MutedText } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  loader: async ({ context, params, abortController }) => {
    try {
      const activity = await context.braivo.nextActivity(params.courseId, {
        signal: abortController.signal,
      });
      // One attempt per activity shown, named here so that a resubmission of
      // it — after a lost answer — is recognised by Braivo as the same one.
      return { activity, attemptId: crypto.randomUUID() };
    } catch (error) {
      // Braivo answers a missing course and someone else's alike.
      if (error instanceof BraivoError && error.status === 404) throw notFound();
      throw error;
    }
  },
  component: NextStep,
  notFoundComponent: () => <p>This course does not exist, or is not one of yours.</p>,
});

/**
 * Focuses what it is attached to when that mounts. Whatever follows Continue
 * takes the focus Continue had, or it would fall to the page and leave a
 * keyboard or screen-reader learner nowhere. Explicit, since React applies
 * `autoFocus` only to form controls.
 */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function NextStep() {
  const { activity, attemptId } = Route.useLoaderData();

  if (!activity) return <NoActivity />;
  // Keyed, so the next activity starts unanswered.
  return <Practice key={attemptId} activity={activity} attemptId={attemptId} />;
}

function NoActivity() {
  const focused = useFocusOnMount<HTMLDivElement>();
  const titleId = useId();
  return (
    <Empty ref={focused} tabIndex={-1} role="region" aria-labelledby={titleId}>
      <EmptyHeader>
        {/* Not "caught up": an objective with no task to practise it can still be
            due (glossary: No activity). */}
        <EmptyTitle id={titleId}>Nothing to practise right now</EmptyTitle>
        <EmptyDescription>Come back later.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const INTENT_LABELS: Record<Activity["decision"]["intent"], string> = {
  introduce: "New",
  reteach: "Try again",
  review: "Review",
};

function Practice({ activity, attemptId }: { activity: Activity; attemptId: string }) {
  const { braivo } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const router = useRouter();
  const [chosen, setChosen] = useState<number>();
  const [grade, setGrade] = useState<Grade>();
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<BraivoError>();
  const [continuing, setContinuing] = useState(false);
  const focused = useFocusOnMount<HTMLElement>();
  const { decision, task } = activity;

  // Aborted when this practice goes away, so an answer still in flight cannot
  // act on whatever page the learner has moved on to. Created in the effect,
  // not in state, since StrictMode runs the cleanup once before remounting.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function choose(choice: number) {
    const signal = lifetime.current?.signal;
    setChosen(choice);
    setFailed(false);
    try {
      const answered = await braivo.submitAttempt(
        { courseId, id: attemptId, taskId: task.id, response: { choice } },
        { signal },
      );
      setGrade(answered);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof BraivoError && error.status < 500) {
        // Refusals the loader explains once reloaded. 401: the session ended,
        // and the guard sends the learner to sign in. 404: the course or task
        // is gone. 409: this attempt was answered already, its grade lost on
        // the way back; that answer stands, so move on to the next.
        if ([401, 404, 409].includes(error.status)) {
          await router.invalidate();
          return;
        }
        // Any other refusal would only repeat: choosing again cannot fix it.
        setRefusal(error);
        return;
      }
      // Lost, or a server failure: whether Braivo recorded it is unknown, and
      // resending the same attempt is safe either way.
      setChosen(undefined);
      setFailed(true);
    }
  }

  function next() {
    // Held until the next activity replaces this one: the reload keeps this one
    // on screen while it runs, and a second press would restart it.
    setContinuing(true);
    void router.invalidate();
  }

  // To the route's error boundary, as a failed load would go.
  if (refusal) throw refusal;

  return (
    <section ref={focused} tabIndex={-1} aria-label={task.prompt} className="flex flex-col gap-6">
      <MutedText>{INTENT_LABELS[decision.intent]}</MutedText>
      <ChoiceQuestion
        prompt={task.prompt}
        options={task.options}
        chosen={chosen}
        answer={grade?.answer}
        onChoose={choose}
      />
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>Your answer could not be sent. Choose again.</AlertDescription>
        </Alert>
      )}
      {grade && (
        <>
          <Alert>
            <AlertTitle>{grade.outcome === "success" ? "Correct" : "Not quite"}</AlertTitle>
            {grade.explanation && <AlertDescription>{grade.explanation}</AlertDescription>}
          </Alert>
          <Button autoFocus disabled={continuing} onClick={next}>
            Continue
          </Button>
        </>
      )}
    </section>
  );
}
