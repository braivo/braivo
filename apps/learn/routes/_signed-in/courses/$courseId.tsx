// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Activity,
  BraivoError,
  type Grade,
  type KnowledgeReport,
  type LearningDecision,
} from "@braivo/server/client";
import { ChoiceQuestion, MutedText } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  // Dropped on leaving: what comes next depends on every answer since, and a
  // kept activity would show again, unanswered, while the next one loads.
  gcTime: 0,
  loader: async ({ context, params, abortController }) => {
    try {
      const signal = abortController.signal;
      const [activity, progress] = await Promise.all([
        context.braivo.nextActivity(params.courseId, { signal }),
        // Optional: a failure leaves the summary out rather than failing the
        // page. Awaited with the activity, which does the same reads and more,
        // so the line never arrives late and shifts the question down.
        context.braivo
          .learnerProgress({ courseId: params.courseId, learnerId: context.user.id }, { signal })
          .catch(() => undefined),
      ]);
      // One attempt per activity shown, so a resend after a lost answer is
      // recorded once.
      return { activity, progress, attemptId: crypto.randomUUID() };
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
 * Focuses its element on mount, so focus follows the learner to whatever
 * replaced Continue instead of falling to the page. Explicit: React applies
 * `autoFocus` only to form controls.
 */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function NextStep() {
  const { activity, progress, attemptId } = Route.useLoaderData();

  return (
    <>
      {progress && <ProgressSummary report={progress} />}
      {!activity ? (
        // Not "caught up": an objective with no task to practise it can still
        // be due (glossary: No activity), and the summary above says so.
        <Notice title="Nothing to practise right now" />
      ) : "retryAfter" in activity ? (
        <Resting key={attemptId} retryAfter={activity.retryAfter} />
      ) : (
        // Keyed, so the next activity starts unanswered.
        <Practice key={attemptId} activity={activity} attemptId={attemptId} />
      )}
    </>
  );
}

/**
 * Where the learner stands in the course, in one line: counts by the model's
 * own states, so it claims no more than they do — "retained" rather than
 * "mastered", which Braivo does not define.
 */
function ProgressSummary({ report }: { report: KnowledgeReport }) {
  const counts = { retained: 0, due: 0, learning: 0, unseen: 0 };
  for (const standing of report.objectives) {
    if (standing.phase === "unseen") counts.unseen++;
    else if (standing.phase === "acquiring") counts.learning++;
    else if (standing.due) counts.due++;
    else counts.retained++;
  }

  const parts = [
    counts.retained && `${counts.retained} retained`,
    counts.due && `${counts.due} due for review`,
    counts.learning && `${counts.learning} learning`,
    counts.unseen && `${counts.unseen} not started`,
  ].filter(Boolean);
  if (parts.length === 0) return null;

  return <MutedText className="mb-6">{parts.join(" · ")}</MutedText>;
}

/** What the page says instead of a question, focused as a question would be. */
function Notice({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const focused = useFocusOnMount<HTMLDivElement>();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Empty
      ref={focused}
      tabIndex={-1}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <EmptyHeader>
        <EmptyTitle id={titleId}>{title}</EmptyTitle>
        {description && <EmptyDescription id={descriptionId}>{description}</EmptyDescription>}
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

/** Every task for what comes next was answered recently. Reloads itself once one may be asked again. */
function Resting({ retryAfter }: { retryAfter: number }) {
  const router = useRouter();
  const delay = retryAfter * 1000;
  // Display only: the timer waits out the duration, so the device's clock cannot move it.
  const [retryAt] = useState(() => Date.now() + delay);

  useEffect(() => {
    const timer = setTimeout(() => void router.invalidate(), delay);
    return () => clearTimeout(timer);
  }, [delay, router]);

  return (
    <Notice
      title="Take a short break"
      description={`You answered this question recently. Practice continues at ${new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, so the next try shows what you remember.`}
    />
  );
}

const INTENT_LABELS: Record<LearningDecision["intent"], string> = {
  introduce: "New",
  reteach: "Try again",
  review: "Review",
};

function Practice({
  activity,
  attemptId,
}: {
  activity: Extract<Activity, { task: unknown }>;
  attemptId: string;
}) {
  const { braivo } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const router = useRouter();
  const [chosen, setChosen] = useState<number>();
  const [grade, setGrade] = useState<Grade>();
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
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

  async function submit(choice: number) {
    const signal = lifetime.current?.signal;
    setChosen(choice);
    setSending(true);
    try {
      const answered = await braivo.submitAttempt(
        { courseId, id: attemptId, taskId: task.id, response: { choice } },
        { signal },
      );
      setGrade(answered);
      setFailed(false);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof BraivoError) {
        // Reloading explains these. 401: the guard sends the learner to sign
        // in. 404: the course is gone, or the task was retired while on screen;
        // the reload offers what is there now. 409: the task was answered
        // moments ago elsewhere, another tab say, and the reload says when it
        // may be answered again.
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
      // Anything else (lost, 5xx, an answer not from Braivo) may or may not be
      // recorded. Only the same answer may be resent: under the same attempt it
      // is recorded once, or fetches its grade; another choice would conflict.
      setFailed(true);
    } finally {
      setSending(false);
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
        correctChoice={grade?.correctChoice}
        pending={sending}
        onChoose={submit}
      />
      {failed && chosen !== undefined && (
        <>
          <Alert variant="destructive">
            <AlertDescription>Your answer could not be confirmed.</AlertDescription>
          </Alert>
          {/* aria-disabled while resending, so that it keeps the focus. */}
          <Button autoFocus aria-disabled={sending} onClick={() => !sending && submit(chosen)}>
            {sending ? "Sending…" : "Send again"}
          </Button>
        </>
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
