// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import {
  type Activity,
  BraivoError,
  type BraivoClient,
  type Grade,
  type LearnerProgressReport,
  type LearningDecision,
  type LearnerProgressStanding,
} from "@braivo/server/client";
import { ChoiceQuestion, Heading, MutedText, SourcePassage } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import { Notice, useFocusOnMount } from "#components/notice";
import { asSessionAuth } from "#lib/auth";
import {
  ANSWER_DEADLINE_MS,
  OPTIONAL_READ_DEADLINE_MS,
  READ_DEADLINE_MS,
  withDeadline,
} from "#lib/deadline";
import { pageHead } from "#lib/title";
import {
  clearUnfinishedAttempt,
  type UnfinishedAttempt,
  unfinishedAttempt,
  saveUnfinishedAttempt,
} from "#lib/unfinished-attempt";

export const Route = createFileRoute("/_signed-in/courses/$courseId")({
  // Dropped on leaving: what comes next depends on every answer since, and a
  // kept activity would show again, unanswered, while the next one loads.
  gcTime: 0,
  // Never preloaded: loading may resend an unfinished answer, whose feedback
  // only a visit shows.
  preload: false,
  loader: async ({ context, params, location, abortController }) => {
    const left = abortController.signal;
    const learnerId = context.user.id;
    try {
      // First, so the summary below counts it.
      const resumed = await resume(context.braivo, learnerId, params.courseId, left);
      // Timed out, the activity fails the page, whose Try again reloads it.
      const signal = withDeadline(left, READ_DEADLINE_MS);
      // The title and the summary are optional: a failure or their own shorter
      // deadline leaves them out rather than failing the page or holding the
      // question back. Awaited with the activity so they cannot arrive later
      // and shift the question down.
      const optional = withDeadline(left, OPTIONAL_READ_DEADLINE_MS);
      const [activity, progress, course] = await Promise.all([
        resumed?.attempt.activity ?? context.braivo.nextActivity(params.courseId, { signal }),
        context.braivo
          .learnerProgress({ courseId: params.courseId, learnerId }, { signal: optional })
          .catch(() => undefined),
        // The title, from the list: one more read per load, sized by the
        // learner's courses, rather than an endpoint for one string.
        context.braivo
          .learnerCourses({ signal: optional })
          .then((courses) => courses.find(({ id }) => id === params.courseId))
          .catch(() => undefined),
      ]);
      return {
        activity,
        progress,
        title: course?.title,
        // One attempt per activity shown, so a resend after a lost answer is
        // recorded once.
        attemptId: resumed?.attempt.id ?? crypto.randomUUID(),
        resumed,
      };
    } catch (error) {
      if (left.aborted) throw error;
      // Braivo answers a missing course and someone else's alike.
      if (error instanceof BraivoError && error.status === 404) throw notFound();
      // The session ended since the guard checked it: checked again, which
      // sends the learner to sign in and back here, any answer still kept.
      if (error instanceof BraivoError && error.status === 401) {
        await requireSession(asSessionAuth(context.braivo), location);
      }
      throw error;
    }
  },
  head: (head) => pageHead(head, head.loaderData?.title),
  component: NextStep,
  notFoundComponent: CourseNotFound,
  errorComponent: CourseError,
});

/**
 * Refusals after which an answer is forgotten, never resent: none records it,
 * and a 409 is not retried once the rest ends (ADR 0017).
 */
const FINAL_REFUSALS = [400, 403, 404, 409, 413];

/** An answer this tab left unfinished, resent: graded, or still unconfirmed. */
type Resumed = { attempt: UnfinishedAttempt; grade?: Grade };

/**
 * Resends the answer this tab left unfinished in the course, if any, so a
 * reload before Continue still shows its feedback; its ID records it at most
 * once (learner-loop-11). Refused, it is forgotten and the course loads as
 * usual, showing the rest or what is there now.
 */
async function resume(
  braivo: BraivoClient,
  learnerId: string,
  courseId: string,
  left: AbortSignal,
): Promise<Resumed | undefined> {
  const attempt = unfinishedAttempt(learnerId, courseId);
  if (!attempt) return undefined;
  const { id, activity, response } = attempt;
  try {
    const grade = await braivo.submitAttempt(
      { courseId, id, taskId: activity.task.id, response },
      { signal: withDeadline(left, ANSWER_DEADLINE_MS) },
    );
    return { attempt, grade };
  } catch (error) {
    if (left.aborted || (error instanceof BraivoError && error.status === 401)) throw error;
    if (error instanceof BraivoError && FINAL_REFUSALS.includes(error.status)) {
      clearUnfinishedAttempt(learnerId, courseId);
      return undefined;
    }
    return { attempt };
  }
}

function CourseNotFound() {
  const { t } = useLingui();
  return (
    <Notice title={t`This course does not exist, or is not one of yours.`}>
      <Button asChild variant="outline">
        <Link to="/">
          <Trans>Your courses</Trans>
        </Link>
      </Button>
    </Notice>
  );
}

function NextStep() {
  const { activity, progress, title, attemptId, resumed } = Route.useLoaderData();

  return (
    <>
      <Link to="/" className="mb-2 inline-block text-sm text-muted-foreground underline">
        <Trans>Your courses</Trans>
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
        <NoPractice objectiveTitle={activity.objective.title} />
      ) : (
        // Keyed, so the next activity starts unanswered, and what a reload's
        // resend found replaces what was on screen.
        <Practice
          key={`${attemptId}:${resumed?.grade ? "graded" : resumed ? "unconfirmed" : "new"}`}
          activity={activity}
          attemptId={attemptId}
          resumed={resumed}
          // Until an answer starts an objective and Continue reloads progress;
          // unknown progress says nothing.
          nothingStarted={
            progress !== undefined &&
            progress.objectives.length > 0 &&
            progress.objectives.every(({ phase }) => phase === "unseen")
          }
        />
      )}
    </>
  );
}

/**
 * In the summary's order, each alone, beside an objective's title, and
 * counted: a count's words agree with it, in three forms in Polish.
 */
const PROGRESS_LABELS = {
  retained: {
    alone: msg({ message: "retained", comment: "After an objective's title: a form fitting any" }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# retained", other: "# retained" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  dueForReview: {
    alone: msg({
      message: "due for review",
      comment: "After an objective's title: a form fitting any",
    }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# due for review", other: "# due for review" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  learning: {
    alone: msg({ message: "learning", comment: "After an objective's title: a form fitting any" }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# learning", other: "# learning" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
  notStarted: {
    alone: msg({
      message: "not started",
      comment: "After an objective's title: a form fitting any",
    }),
    counted: (count: number) =>
      msg({
        message: plural(count, { one: "# not started", other: "# not started" }),
        comment: "A count of objectives, the noun implied (Polish: temat)",
      }),
  },
};
type ProgressLabel = keyof typeof PROGRESS_LABELS;

/**
 * The model's phases, with `due` splitting retaining, so the summary claims no
 * more than the model does: "retained", not "mastered", which Braivo does not define.
 */
function labelOf(standing: LearnerProgressStanding): ProgressLabel {
  if (standing.phase === "unseen") return "notStarted";
  if (standing.phase === "acquiring") return "learning";
  return standing.due ? "dueForReview" : "retained";
}

function ProgressSummary({ report }: { report: LearnerProgressReport }) {
  const { t } = useLingui();
  const labels = report.objectives.map(labelOf);
  const line = (Object.keys(PROGRESS_LABELS) as ProgressLabel[])
    .map((label) => [label, labels.filter((each) => each === label).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => t(PROGRESS_LABELS[label].counted(count)))
    .join(" · ");
  if (!line) return null;

  return (
    <details className="mb-6 text-sm wrap-break-word text-muted-foreground">
      <summary className="cursor-pointer">{line}</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {report.objectives.map((standing) => (
          <li key={standing.objectiveId}>
            {standing.title}: {t(PROGRESS_LABELS[labelOf(standing)].alone)}
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
  const { t, i18n } = useLingui();
  // Read moments apart from the activity, the report may already count one due,
  // whose time has passed.
  const next = report?.objectives
    .flatMap((standing) => (standing.phase === "retaining" && !standing.due ? [standing] : []))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  let description = t`Nothing is due right now.`;
  if (next) {
    const objectiveTitle = next.title;
    const nextReviewAt = new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: "full",
      timeStyle: "short",
    }).format(roundUpToMinute(Date.parse(next.dueAt)));
    description = t`Nothing is due right now. Next review due: ${objectiveTitle}, on ${nextReviewAt}.`;
  }
  return <Notice title={t`You're caught up`} description={description} />;
}

function NoPractice({ objectiveTitle }: { objectiveTitle: string }) {
  const { t } = useLingui();
  return (
    <Notice
      title={t`Nothing to practise right now`}
      description={t`${objectiveTitle} comes next, but there's no practice for it yet.`}
    />
  );
}

/** Reloads the course, after the guard rechecks the session (access-6); never the root's brand. */
function reloadCourse(router: ReturnType<typeof useRouter>): Promise<void> {
  return router.invalidate({ filter: (match) => match.routeId === Route.id });
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
  const { t } = useLingui();
  return (
    <Notice title={t`Something went wrong.`}>
      <Button onClick={() => reloadCourse(router)}>
        <Trans>Try again</Trans>
      </Button>
      <Button asChild variant="outline">
        <Link to="/">
          <Trans>Your courses</Trans>
        </Link>
      </Button>
    </Notice>
  );
}

/** Every task for what comes next was answered recently. Reloads itself once one may be asked again. */
function Resting({ objectiveTitle, retryAfter }: { objectiveTitle: string; retryAfter: number }) {
  const router = useRouter();
  const { t, i18n } = useLingui();
  const delay = retryAfter * 1000;
  // Display only: the timer waits out the duration, so the device's clock cannot move it.
  const [retryAt] = useState(() => Date.now() + delay);

  useEffect(() => {
    const timer = setTimeout(() => void reloadCourse(router), delay);
    return () => clearTimeout(timer);
  }, [delay, router]);

  const continuesAt = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(roundUpToMinute(retryAt));

  return (
    <Notice
      title={t`Take a short break`}
      description={t`You practised ${objectiveTitle} recently. Practice continues at ${continuesAt}, so the next try shows what you remember.`}
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
      return (
        <MutedText>
          <Trans>You missed this last time.</Trans>
        </MutedText>
      );
    case "review": {
      const percent = Math.round(decision.retrievability * 100);
      return (
        <MutedText>
          <Trans>Due for review: about {percent}% likely to recall now.</Trans>
        </MutedText>
      );
    }
    default:
      return decision satisfies never;
  }
}

/** In context, as each reads unlike the same English elsewhere ("Try again", the button). */
const INTENT_LABELS: Record<LearningDecision["intent"], MessageDescriptor> = {
  introduce: msg({ message: "New", context: "Why a question comes now" }),
  reteach: msg({ message: "Try again", context: "Why a question comes now" }),
  review: msg({ message: "Review", context: "Why a question comes now" }),
};

function Practice({
  activity,
  attemptId,
  resumed,
  nothingStarted,
}: {
  activity: Extract<Activity, { task: unknown }>;
  attemptId: string;
  /** The answer a reload resent, shown graded or unconfirmed. */
  resumed?: Resumed;
  /** No objective started yet: says how practice goes. */
  nothingStarted: boolean;
}) {
  const { braivo, user } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const router = useRouter();
  const { t } = useLingui();
  const [chosen, setChosen] = useState(resumed?.attempt.response.choice);
  const [grade, setGrade] = useState(resumed?.grade);
  // Counted, not flagged, so that each answer left unconfirmed gets a new alert (below).
  const [unconfirmedCount, setUnconfirmedCount] = useState(resumed && !resumed.grade ? 1 : 0);
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
    const left = lifetime.current?.signal;
    setChosen(choice);
    setSending(true);
    // Before sending, kept until Continue: a reload can land after Braivo
    // records it and before its grade arrives, or before it is read.
    const response = { choice };
    saveUnfinishedAttempt(user.id, courseId, { id: attemptId, activity, response });
    try {
      const answered = await braivo.submitAttempt(
        { courseId, id: attemptId, taskId: task.id, response },
        { signal: withDeadline(left, ANSWER_DEADLINE_MS) },
      );
      setGrade(answered);
      setUnconfirmedCount(0);
    } catch (error) {
      // Kept unless refused (below): it may have been recorded. Left, not timed
      // out: a timeout is unconfirmed, below.
      if (left?.aborted) return;
      if (error instanceof BraivoError) {
        if (FINAL_REFUSALS.includes(error.status)) clearUnfinishedAttempt(user.id, courseId);
        // Reloading explains these. 401: the guard sends the learner to sign
        // in. 404: the course is gone, or the task was retired while on screen;
        // the reload offers what is there now. 409: the task was answered
        // moments ago elsewhere, another tab say, and the reload says when it
        // may be answered again.
        if ([401, 404, 409].includes(error.status)) {
          await reloadCourse(router);
          return;
        }
        // Refusals that would only repeat: choosing again cannot fix them.
        if ([400, 403, 413].includes(error.status)) {
          setRefused(true);
          return;
        }
      }
      // Anything else (lost, timed out, 5xx, an answer not from Braivo) may or may not be
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
    clearUnfinishedAttempt(user.id, courseId);
    setContinuing(true);
    void reloadCourse(router);
  }

  // No retry, unlike a failed load: this answer would be refused again.
  if (refused) return <Notice title={t`Something went wrong.`} />;

  const correctAnswer =
    grade?.outcome === "failure"
      ? task.options.find((option) => option.choice === grade.correctChoice)?.text
      : undefined;

  return (
    <section className="flex flex-col gap-6">
      <div id={contextId} className="flex flex-col wrap-break-word">
        <MutedText>
          {t(INTENT_LABELS[decision.intent])} · {objective.title}
        </MutedText>
        <Reason decision={decision} />
        {/* In the question's description, so it is read as the focus lands there. */}
        {nothingStarted && (
          <MutedText className="mt-2">
            <Trans>
              One question at a time. What you get wrong comes back soon; what you get right returns
              for review before you're likely to forget it.
            </Trans>
          </MutedText>
        )}
      </div>
      <ChoiceQuestion
        prompt={task.prompt}
        options={task.options}
        chosen={chosen}
        correctChoice={grade?.correctChoice}
        pending={sending}
        onChoose={submit}
        // Resumed, the focus is on Send again or Continue, as when answered here.
        ref={resumed ? undefined : focused}
        aria-describedby={contextId}
      />
      {unconfirmedCount > 0 && chosen !== undefined && (
        <>
          {/* Only the alert is keyed, so failing again mounts a new one, not the
              same one unchanged, while Send again keeps its node and focus. */}
          <Alert key={unconfirmedCount} variant="destructive">
            <AlertDescription>
              <Trans>Your answer could not be confirmed.</Trans>
            </AlertDescription>
          </Alert>
          {/* aria-disabled while resending, so that it keeps the focus. */}
          <Button
            size="lg"
            autoFocus
            aria-disabled={sending}
            onClick={() => !sending && submit(chosen)}
          >
            {sending ? t`Sending…` : t`Send again`}
          </Button>
        </>
      )}
      {grade && (
        <>
          {/* `wrap-anywhere`: a grid, whose column is otherwise as wide as the
              explanation's longest word, such as a link. */}
          <Alert className="wrap-anywhere">
            <AlertTitle>{grade.outcome === "success" ? t`Correct` : t`Not quite`}</AlertTitle>
            {(correctAnswer || grade.explanation) && (
              <AlertDescription>
                {/* Named, not only marked, so a learner need not go back to the
                    options once Continue takes the focus, or a phone scrolls them
                    away. */}
                {correctAnswer && (
                  <p>
                    <Trans>The answer: {correctAnswer}</Trans>
                  </p>
                )}
                {grade.explanation && <p>{grade.explanation}</p>}
              </AlertDescription>
            )}
          </Alert>
          {grade.passages && (
            // Titled, so a learner reads the quotes as where the answer comes from.
            <section aria-labelledby={passagesId} className="flex flex-col gap-3">
              <Heading level={2} id={passagesId} className="mb-0">
                <Trans>From your lessons</Trans>
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
          <Button size="lg" autoFocus aria-disabled={continuing} onClick={next}>
            {continuing ? t`Loading…` : t`Continue`}
          </Button>
        </>
      )}
    </section>
  );
}
