// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type Grade } from "@braivo/server/client";
import { ChoiceQuestion, MutedText } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  // Dropped on leaving: what comes next depends on every answer since, and a
  // kept activity would show again, unanswered, while the next one loads.
  gcTime: 0,
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
  notFoundComponent: () => <Notice title="This course does not exist, or is not one of yours." />,
  errorComponent: CourseError,
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

  // Not "caught up": an objective with no task to practise it can still be due
  // (glossary: No activity), so waiting may not help either.
  if (!activity) return <Notice title="Nothing to practise right now" />;
  // Keyed, so the next activity starts unanswered.
  return <Practice key={attemptId} activity={activity} attemptId={attemptId} />;
}

/** What the page says instead of a question, focused as a question would be. */
function Notice({ title, children }: { title: string; children?: ReactNode }) {
  const focused = useFocusOnMount<HTMLDivElement>();
  const titleId = useId();
  return (
    <Empty ref={focused} tabIndex={-1} role="region" aria-labelledby={titleId}>
      <EmptyHeader>
        <EmptyTitle id={titleId}>{title}</EmptyTitle>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

/**
 * Anything that failed the route, such as a load that may only have failed for
 * now. Trying again reloads the course and resets this boundary.
 */
function CourseError() {
  const router = useRouter();
  return (
    <Notice title="Something went wrong.">
      <Button onClick={() => router.invalidate()}>Try again</Button>
    </Notice>
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
  const [refused, setRefused] = useState(false);
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
      if (error instanceof BraivoError) {
        // Refusals the loader explains once reloaded. 401: the session ended,
        // and the guard sends the learner to sign in. 404: the course or task
        // is gone. 409: this attempt was answered already, its grade lost on
        // the way back; that answer stands, so move on to the next.
        if ([401, 404, 409].includes(error.status)) {
          await router.invalidate();
          return;
        }
        // Refusals that would only repeat: choosing again cannot fix them.
        if ([400, 403, 413].includes(error.status)) {
          setRefused(true);
          return;
        }
      }
      // Anything else — lost, a server failure, an answer that is not Braivo's —
      // leaves unknown whether Braivo recorded it, and resending the same
      // attempt is safe either way.
      setChosen(undefined);
      setFailed(true);
    }
  }

  function next() {
    // Held until the next activity replaces this one: the reload keeps this one
    // on screen while it runs, and a second press would restart it.
    if (continuing) return;
    setContinuing(true);
    void router.invalidate();
  }

  // No retry, unlike a failed load: this answer would be refused again.
  if (refused) return <Notice title="Something went wrong." />;

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
          <AlertDescription>Your answer could not be confirmed. Choose again.</AlertDescription>
        </Alert>
      )}
      {grade && (
        <>
          <Alert>
            <AlertTitle>{grade.outcome === "success" ? "Correct" : "Not quite"}</AlertTitle>
            {grade.explanation && <AlertDescription>{grade.explanation}</AlertDescription>}
          </Alert>
          {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
          <Button autoFocus aria-disabled={continuing} onClick={next}>
            {continuing ? "Loading…" : "Continue"}
          </Button>
        </>
      )}
    </section>
  );
}
