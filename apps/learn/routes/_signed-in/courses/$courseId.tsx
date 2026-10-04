// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Activity,
  BraivoError,
  type Grade,
  type LearnerProgressReport,
  type LearningDecision,
  type LearnerProgressStanding,
} from "@braivo/server/client";
import { ChoiceQuestion, Heading, MutedText, SourcePassage } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import { Notice, useFocusOnMount } from "#components/notice";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  // Dropped on leaving: what comes next depends on every answer since, and a
  // kept activity would show again, unanswered, while the next one loads.
  gcTime: 0,
  loader: async ({ context, params, abortController }) => {
    try {
      const signal = abortController.signal;
      // The title and the summary are optional: a failure leaves them out
      // rather than failing the page. Awaited with the activity so they cannot
      // arrive later and shift the question down.
      const [activity, progress, course] = await Promise.all([
        context.braivo.nextActivity(params.courseId, { signal }),
        context.braivo
          .learnerProgress({ courseId: params.courseId, learnerId: context.user.id }, { signal })
          .catch(() => undefined),
        // The title, from the list: one more read per load, sized by the
        // learner's courses, rather than an endpoint for one string.
        context.braivo
          .learnerCourses({ signal })
          .then((courses) => courses.find(({ id }) => id === params.courseId))
          .catch(() => undefined),
      ]);
      // One attempt per activity shown, so a resend after a lost answer is
      // recorded once.
      return { activity, progress, title: course?.title, attemptId: crypto.randomUUID() };
    } catch (error) {
      // Braivo answers a missing course and someone else's alike.
      if (error instanceof BraivoError && error.status === 404) throw notFound();
      throw error;
    }
  },
  head: (head) => pageHead(head, head.loaderData?.title),
  component: NextStep,
  notFoundComponent: () => (
    <Notice title="This course does not exist, or is not one of yours.">
      <Button asChild variant="outline">
        <Link to="/">Your courses</Link>
      </Button>
    </Notice>
  ),
  errorComponent: CourseError,
});

function NextStep() {
  const { activity, progress, title, attemptId } = Route.useLoaderData();

  return (
    <>
      <Link to="/" className="mb-2 inline-block text-sm text-muted-foreground underline">
        Your courses
      </Link>
      {title && <Heading>{title}</Heading>}
      {progress && <ProgressSummary report={progress} />}
      {!activity ? (
        <CaughtUp report={progress} />
      ) : "retryAfter" in activity ? (
        <Resting
          key={attemptId}
          objectiveTitle={activity.objective.title}
          retryAfter={activity.retryAfter}
        />
      ) : !("task" in activity) ? (
        // Not "caught up": the objective selected next has nothing to practise it
        // with (glossary: No activity).
        <Notice
          title="Nothing to practise right now"
          description={`${activity.objective.title} comes next, but there's no practice for it yet.`}
        />
      ) : (
        // Keyed, so the next activity starts unanswered.
        <Practice key={attemptId} activity={activity} attemptId={attemptId} />
      )}
    </>
  );
}

const LABELS = ["retained", "due for review", "learning", "not started"] as const;
type Label = (typeof LABELS)[number];

/**
 * The model's phases, with `due` splitting retaining, so the summary claims no
 * more than the model does: "retained", not "mastered", which Braivo does not define.
 */
function labelOf(standing: LearnerProgressStanding): Label {
  if (standing.phase === "unseen") return "not started";
  if (standing.phase === "acquiring") return "learning";
  return standing.due ? "due for review" : "retained";
}

function ProgressSummary({ report }: { report: LearnerProgressReport }) {
  const labels = report.objectives.map(labelOf);
  const line = LABELS.map(
    (label) => [label, labels.filter((each) => each === label).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
  if (!line) return null;

  return (
    <details className="mb-6 text-sm wrap-break-word text-muted-foreground">
      <summary className="cursor-pointer">{line}</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {report.objectives.map((standing) => (
          <li key={standing.objectiveId}>
            {standing.title}: {labelOf(standing)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Adds when the next review falls due, if any objective is retained and not
 * yet due. The model's time, not a promise of practice: an objective may have
 * no task. A label, since a title may be a phrase ("Greet someone").
 */
function CaughtUp({ report }: { report: LearnerProgressReport | undefined }) {
  // Read moments apart from the activity, the report may already count one due,
  // whose time has passed.
  const next = report?.objectives
    .flatMap((standing) => (standing.phase === "retaining" && !standing.due ? [standing] : []))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  return (
    <Notice
      title="You're caught up"
      description={
        next
          ? `Nothing is due right now. Next review due: ${next.title}, on ${dueOn(next.dueAt)}.`
          : "Nothing is due right now."
      }
    />
  );
}

function dueOn(dueAt: string): string {
  return roundUpToMinute(Date.parse(dueAt)).toLocaleString([], {
    dateStyle: "full",
    timeStyle: "short",
  });
}

/** For a time shown to the minute: an earlier one would bring the learner back too soon. */
function roundUpToMinute(time: number): Date {
  const minute = 60_000;
  return new Date(Math.ceil(time / minute) * minute);
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
      <Button asChild variant="outline">
        <Link to="/">Your courses</Link>
      </Button>
    </Notice>
  );
}

/** Every task for what comes next was answered recently. Reloads itself once one may be asked again. */
function Resting({ objectiveTitle, retryAfter }: { objectiveTitle: string; retryAfter: number }) {
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
      description={`You practised ${objectiveTitle} recently. Practice continues at ${roundUpToMinute(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, so the next try shows what you remember.`}
    />
  );
}

/**
 * Why this comes now, from the values the decision was made on: decisions are
 * explainable. A reteach always follows a miss: only a failure keeps an objective acquiring.
 */
function Reason({ decision }: { decision: LearningDecision }) {
  switch (decision.intent) {
    case "introduce":
      return null;
    case "reteach":
      return <MutedText>You missed this last time.</MutedText>;
    case "review":
      return (
        <MutedText>
          Due for review: about {Math.round(decision.retrievability * 100)}% likely to recall now.
        </MutedText>
      );
    default:
      return decision satisfies never;
  }
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
  // Counted, not flagged, so that each answer left unconfirmed gets a new alert (below).
  const [unconfirmedCount, setUnconfirmedCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(false);
  const [continuing, setContinuing] = useState(false);
  // The question itself, so its number keys work at once and a screen reader
  // announces the prompt that labels it.
  const focused = useFocusOnMount<HTMLDivElement>();
  // Describes the question, so the focus landing on it reads this too.
  const contextId = useId();
  const passagesId = useId();
  const { decision, objective, task } = activity;

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
      setUnconfirmedCount(0);
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
      setUnconfirmedCount((count) => count + 1);
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

  const correctAnswer =
    grade?.outcome === "failure"
      ? task.options.find((option) => option.choice === grade.correctChoice)?.text
      : undefined;

  return (
    <section className="flex flex-col gap-6">
      <div id={contextId} className="flex flex-col wrap-break-word">
        <MutedText>
          {INTENT_LABELS[decision.intent]} · {objective.title}
        </MutedText>
        <Reason decision={decision} />
      </div>
      <ChoiceQuestion
        prompt={task.prompt}
        options={task.options}
        chosen={chosen}
        correctChoice={grade?.correctChoice}
        pending={sending}
        onChoose={submit}
        ref={focused}
        aria-describedby={contextId}
      />
      {unconfirmedCount > 0 && chosen !== undefined && (
        <>
          {/* Only the alert is keyed, so failing again mounts a new one, not the
              same one unchanged, while Send again keeps its node and focus. */}
          <Alert key={unconfirmedCount} variant="destructive">
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
          {/* `wrap-anywhere`: a grid, whose column is otherwise as wide as the
              explanation's longest word, such as a link. */}
          <Alert className="wrap-anywhere">
            <AlertTitle>{grade.outcome === "success" ? "Correct" : "Not quite"}</AlertTitle>
            {(correctAnswer || grade.explanation) && (
              <AlertDescription>
                {/* Named, not only marked, so a learner need not go back to the
                    options once Continue takes the focus, or a phone scrolls them
                    away. */}
                {correctAnswer && <p>The answer: {correctAnswer}</p>}
                {grade.explanation && <p>{grade.explanation}</p>}
              </AlertDescription>
            )}
          </Alert>
          {grade.passages && (
            // Titled, so a learner reads the quotes as where the answer comes from.
            <section aria-labelledby={passagesId} className="flex flex-col gap-3">
              <Heading level={2} id={passagesId} className="mb-0">
                From your lessons
              </Heading>
              {grade.passages.map((passage, index) => (
                <SourcePassage
                  // Stable for this grade: passages never change once graded.
                  key={index}
                  quote={passage.quote}
                  title={passage.source.title}
                  url={passage.source.url}
                  at={passage.at}
                  page={passage.page}
                />
              ))}
            </section>
          )}
          {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
          <Button autoFocus aria-disabled={continuing} onClick={next}>
            {continuing ? "Loading…" : "Continue"}
          </Button>
        </>
      )}
    </section>
  );
}
