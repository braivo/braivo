// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import {
  type Activity,
  type ActivityDecision,
  BraivoError,
  type BraivoClient,
  type Grade,
  type LearnerProgressSummary,
  type ObjectiveReview,
  type TaskResponse,
  countStandings,
  courseRef,
  learnerDayIn,
  parseCourseRef,
} from "@braivo/server/client";
import { ChoiceQuestion, Heading, MutedText, SourcePassage, TypedQuestion } from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { cn } from "@braivo/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  notFound,
  redirect,
  useLoaderData,
  useRouter,
} from "@tanstack/react-router";
import { CircleCheckIcon, CircleXIcon, EyeIcon, XIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AccountHeader } from "#components/account-header";
import {
  BackToRecommended,
  ChosenObjective,
  NothingDue,
  PractiseLink,
} from "#components/chosen-objective";
import { HomeLink } from "#components/home-link";
import { MarkedAnswer } from "#components/marked-answer";
import { Notice, useFocusOnMount } from "#components/notice";
import { PinnedFoot } from "#components/pinned-foot";
import {
  SESSION_LENGTH,
  type PracticeSession,
  SessionEnd,
  SessionRecap,
  usePracticeSession,
} from "#components/practice-session";
import { ReportProblem } from "#components/report-problem";
import { ReviewButton, ReviewTopic, useReviewing } from "#components/review-topic";
import { formatCounts, StandingMeter } from "#components/standing";
import { asSessionAuth } from "#lib/auth";
import {
  ANSWER_DEADLINE_MS,
  OPTIONAL_READ_DEADLINE_MS,
  READ_DEADLINE_MS,
  withDeadline,
} from "#lib/deadline";
import { readHost } from "#lib/host";
import { markReviewed, takeReviewed } from "#lib/reviewed";
import { pageHead } from "#lib/title";
import {
  readRefusalNotice,
  clearRefusalNotice,
  clearUnfinishedAttempt,
  markRefusalNotice,
  type RefusalNotice,
  type UnfinishedAttempt,
  unfinishedAttempt,
  saveUnfinishedAttempt,
} from "#lib/unfinished-attempt";

export const Route = createFileRoute("/_signed-in/c/$courseRef")({
  // Dropped on leaving: what comes next depends on every answer since, and a
  // kept activity would show again, unanswered, while the next one loads.
  gcTime: 0,
  // Never preloaded: loading may resend an unfinished answer, whose feedback
  // only a visit shows.
  preload: false,
  // The objective the learner chose to practise (ADR 0058): in the address, so
  // a reload keeps it, and leaving the page, by any link, drops it.
  validateSearch: (search: Record<string, unknown>): { objective?: string } =>
    typeof search.objective === "string" && search.objective !== ""
      ? { objective: search.objective }
      : {},
  loaderDeps: ({ search }) => ({ objective: search.objective }),
  loader: async ({ context, params, location, abortController, deps }) => {
    const left = abortController.signal;
    const learnerId = context.user.id;
    const { objective } = deps;
    try {
      const course = await resolveCourse(context.braivo, params.courseRef, left);
      const courseId = course.id;
      // First, so the summary below counts it.
      const resumed = await resume(context.braivo, learnerId, courseId, left);
      // Timed out, the activity fails the page, whose Try again reloads it.
      // The title and the summary are optional: a failure or their own shorter
      // deadline leaves them out rather than failing the page or holding the
      // question back. Awaited with the activity so they cannot arrive later
      // and shift the question down.
      const [activity, progress, title] = await Promise.all([
        resumed?.attempt.activity ?? readActivity(context.braivo, courseId, left, objective),
        readProgress(context.braivo, courseId, learnerId, left),
        // Unless resolving the number read it: from the list, rather than an
        // endpoint for one string.
        course.title ??
          context.braivo
            .learnerCourses({ signal: withDeadline(left, OPTIONAL_READ_DEADLINE_MS) })
            .then((courses) => courses.find(({ id }) => id === courseId)?.title)
            .catch(() => undefined),
      ]);
      return {
        courseId,
        activity,
        progress,
        title,
        // One attempt per activity shown, so a resend after a lost answer is
        // recorded once.
        attemptId: resumed?.attempt.id ?? crypto.randomUUID(),
        // Loading the page with an objective chosen is asking for its question,
        // extra practice included: Practise, a reload, a rest's end.
        extraRequested: true,
        resumed,
        // Read here, not by `resume`: a refusal found by a load that then
        // failed is said by the load Try again makes.
        refusalNotice: readRefusalNotice(learnerId, courseId),
      };
    } catch (error) {
      if (left.aborted) throw error;
      // An objective no longer in the course, or the course gone: the course's
      // own practice, which says which.
      if (error instanceof BraivoError && error.status === 404 && objective !== undefined) {
        throw redirect({ to: "/c/$courseRef", params, search: {}, replace: true });
      }
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
  component: CoursePage,
  notFoundComponent: CourseNotFound,
  errorComponent: CourseError,
});

/**
 * Refusals the same answer would meet again, such as a request a page built
 * before an update sends: no reload explains them, so the learner is told.
 */
const REFUSALS_SAID = [400, 403, 413];

/**
 * Refusals after which an answer is forgotten, never resent: none records it,
 * and a 409 is not retried once the rest ends (ADR 0017).
 */
const FINAL_REFUSALS = [...REFUSALS_SAID, 404, 409];

/** The learner's history here was erased since this answer was begun (learner-loop-25). */
function isHistoryErased(error: BraivoError): boolean {
  return error.status === 409 && error.code === "HISTORY_ERASED";
}

/**
 * The course `ref` names: its ID, or its number, resolved to the ID (and
 * title) within a read's deadline, since everything else asks by ID. A stale
 * label is replaced in the address before anything else is asked, so the
 * learning work below runs once; a number alone stays as it is.
 */
async function resolveCourse(
  braivo: BraivoClient,
  ref: string,
  left: AbortSignal,
): Promise<{ id: string; title?: string }> {
  const named = parseCourseRef(ref);
  if (!named) throw notFound();
  if ("id" in named) {
    // The installation's origin opens a person's own courses alone, by ID; a
    // school's opens on its domain (ADR 0059). Elsewhere, the host's ceiling
    // decides, and an ID names a course there as on any host. Unread, the page
    // fails, offering Try again, never guessing which.
    if (!(await readHost(braivo)).installation) return named;
    const own = await braivo.personalCourses({ signal: withDeadline(left, READ_DEADLINE_MS) });
    const course = own.find(({ id }) => id === named.id);
    if (!course) throw notFound();
    return course;
  }
  const course = await braivo.learnerCourseByNumber(named.number, {
    signal: withDeadline(left, READ_DEADLINE_MS),
  });
  if (!course) throw notFound();
  if (named.urlLabel !== undefined && named.urlLabel !== course.urlLabel) {
    throw redirect({
      to: "/c/$courseRef",
      params: { courseRef: courseRef(course) },
      search: true,
      replace: true,
    });
  }
  return course;
}

/** What to practise next, on `objectiveId` if the learner chose one, within a read's deadline. */
function readActivity(
  braivo: BraivoClient,
  courseId: string,
  left: AbortSignal,
  objectiveId: string | undefined,
): Promise<Activity | undefined> {
  const signal = withDeadline(left, READ_DEADLINE_MS);
  return braivo.nextActivity(
    courseId,
    objectiveId === undefined ? { signal } : { signal, objectiveId },
  );
}

/** Extra practice: a question the learner asked for, on an objective needing no attention (ADR 0058). */
function isExtra(activity: Activity | undefined): boolean {
  return activity !== undefined && "task" in activity && activity.decision.intent === "practise";
}

/** Where the learner stands, standings only, or nothing if unread within its own deadline. */
function readProgress(
  braivo: BraivoClient,
  courseId: string,
  learnerId: string,
  left: AbortSignal,
): Promise<LearnerProgressSummary | undefined> {
  return braivo
    .learnerProgress(
      { courseId, learnerId, includeHistory: false },
      { signal: withDeadline(left, OPTIONAL_READ_DEADLINE_MS) },
    )
    .catch(() => undefined);
}

/** An answer this tab left unfinished, resent: graded, or still unconfirmed. */
type Resumed = { attempt: UnfinishedAttempt; grade?: Grade };

/**
 * Resends the answer this tab left unfinished in the course, if any, so a
 * reload before Continue still shows its feedback; its ID records it at most
 * once (learner-loop-11). Refused, it is forgotten and the course loads as
 * usual, showing the rest or what is there now; a refusal reloading cannot
 * explain is marked, for the page to say.
 */
async function resume(
  braivo: BraivoClient,
  learnerId: string,
  courseId: string,
  left: AbortSignal,
): Promise<Resumed | undefined> {
  const attempt = unfinishedAttempt(learnerId, courseId);
  if (!attempt) return undefined;
  const { id, activity, response, reviewedTeaching } = attempt;
  try {
    const grade = await braivo.submitAttempt(
      {
        courseId,
        id,
        taskId: activity.task.id,
        response,
        historyEpoch: activity.historyEpoch,
        ...(reviewedTeaching && { reviewedTeaching }),
      },
      { signal: withDeadline(left, ANSWER_DEADLINE_MS) },
    );
    return { attempt, grade };
  } catch (error) {
    if (left.aborted || (error instanceof BraivoError && error.status === 401)) throw error;
    if (error instanceof BraivoError && FINAL_REFUSALS.includes(error.status)) {
      // Forgotten first: storage too full for the notice has room once the attempt goes.
      clearUnfinishedAttempt(learnerId, courseId);
      if (isHistoryErased(error)) markRefusalNotice(learnerId, courseId, "history-erased");
      else if (REFUSALS_SAID.includes(error.status)) {
        markRefusalNotice(learnerId, courseId, "refused");
      }
      // Recorded nothing: the review is the next attempt's to say.
      if (reviewedTeaching) markReviewed(learnerId, activity.objective.id);
      return undefined;
    }
    return { attempt };
  }
}

/**
 * A link sent to the learner may be for another account of theirs, or a
 * course not yet open to them: said, with the way back, and the account's
 * header, not practice's, so they can sign out and in as the other.
 */
function CourseNotFound() {
  const { t } = useLingui();
  return (
    <>
      <AccountHeader />
      <Notice
        title={t`This course does not exist, or is not one of yours.`}
        description={
          <Trans>
            If someone sent you a link to it, check that you are signed in with the right account,
            or ask them for access.
          </Trans>
        }
      >
        <Button asChild variant="outline">
          <HomeLink>
            <Trans>Your courses</Trans>
          </HomeLink>
        </Button>
      </Notice>
    </>
  );
}

/**
 * One learner's practice in one course: keyed by both, so a session (and all
 * else held in state) never passes to another account signed in meanwhile, or
 * to another course; a reload for the same learner and course keeps it.
 */
function CoursePage() {
  const { courseId } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return <NextStep key={`${user.id}:${courseId}`} />;
}

function NextStep() {
  const routeLoad = Route.useLoaderData();
  const { braivo, user } = Route.useRouteContext();
  const { objective: chosenId } = Route.useSearch();
  const router = useRouter();
  // What Continue read, shown until the route loads again (a reload, a rest's end).
  const [continued, setContinued] = useState<{
    routeLoad: typeof routeLoad;
    load: typeof routeLoad;
  }>();
  const load = continued?.routeLoad === routeLoad ? continued.load : routeLoad;
  const { activity, progress, title, attemptId, resumed, refusalNotice, extraRequested } = load;
  // This visit's session: its answers, then its end (`SessionEnd`) once
  // `SESSION_LENGTH` were graded, until Keep going starts another.
  const { session, count, restart } = usePracticeSession(routeLoad.resumed);
  const [gradedAttempt, setGradedAttempt] = useState<string>();
  // The end, with what the selector offers next, read with it: `next`
  // undefined when that read failed, so nothing is claimed of it.
  const [end, setEnd] = useState<{
    report: LearnerProgressSummary | undefined;
    next: { activity: Activity | undefined } | undefined;
    at: Date;
  }>();
  const endStep = useEndStep(end);
  // A history erased takes the session that counted it (learner-loop-25).
  const startAfresh = useCallback(() => {
    restart();
    setEnd(undefined);
  }, [restart]);
  // Said once: the load holds it, so the mark goes as it shows. A refusal says
  // the history was erased even when no question follows, showing no new epoch.
  useEffect(() => {
    if (routeLoad.refusalNotice) clearRefusalNotice(user.id, routeLoad.courseId);
    if (routeLoad.refusalNotice === "history-erased") startAfresh();
  }, [routeLoad, startAfresh, user.id]);
  // With no answer refused, only a new epoch says so: another tab signed in again
  // after the erasure, with no reload here.
  const epoch = activity !== undefined && "task" in activity ? activity.historyEpoch : undefined;
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === undefined) return;
    const moved = lastEpoch.current !== undefined && epoch !== lastEpoch.current;
    lastEpoch.current = epoch;
    if (moved) startAfresh();
  }, [epoch, startAfresh]);
  // The route's load as of now, for a Continue that finishes after it changed.
  const latestRouteLoad = useRef(routeLoad);
  useLayoutEffect(() => {
    latestRouteLoad.current = routeLoad;
  });

  /**
   * Continue, Check again, and Keep going, actions rather than reloads, so that
   * failing keeps the page (docs/apps.md): rechecks the session (access-6) while
   * it `read`s, one round trip rather than two before what comes next, and
   * acts on the reads (`read`'s result, applied) or their failure only once the
   * session is this learner's: what another account signed in meanwhile was
   * shown is dropped unseen, and its refusal clears nothing of this learner's.
   * Resolves whether it failed;
   * failed, what is on screen stays, the answer kept for a reload. Signed out,
   * or another account signed in meanwhile, the route reloads, its guard
   * deciding; a 401 or 404 from a read reloads the course, which says why. Each
   * response is ignored once `left` aborts or the route loads again.
   */
  async function proceed(
    left: AbortSignal,
    read: () => Promise<() => void>,
  ): Promise<{ failed: boolean }> {
    const { courseId } = load;
    // Left, or reloaded meanwhile: an answer now would act on another page.
    const superseded = () => left.aborted || latestRouteLoad.current !== routeLoad;
    const reading = read();
    // Awaited below, or dropped with the session's failure: never unhandled.
    reading.catch(() => {});
    try {
      const account = await braivo.session({ signal: withDeadline(left, READ_DEADLINE_MS) });
      if (superseded()) return { failed: false };
      if (account?.id !== user.id || !account.name.trim()) {
        await router.invalidate({ sync: true });
        return { failed: false };
      }
      const apply = await reading;
      if (!superseded()) apply();
      return { failed: false };
    } catch (error) {
      if (superseded()) return { failed: false };
      if (error instanceof BraivoError && [401, 404].includes(error.status)) {
        // Gone, the course takes the answer with it; signed out, it is kept for after.
        if (error.status === 404) clearUnfinishedAttempt(user.id, courseId);
        await reloadCourse(router);
        return { failed: false };
      }
      return { failed: true };
    }
  }

  /**
   * What comes next, and only where practice stops there (caught up, a rest,
   * no activity), the notices that show it, where the learner stands
   * (progress-8): a question shows none, so it never waits on, or costs, a
   * whole-course replay; a stop pays one more round trip, rarely.
   */
  function advance(left: AbortSignal, { extraRequested = false } = {}) {
    return proceed(left, async () => {
      const { courseId } = load;
      const activity = await readActivity(braivo, courseId, left, chosenId);
      const asking = activity !== undefined && "task" in activity && isAnswerable(activity.task);
      const progress = asking ? undefined : await readProgress(braivo, courseId, user.id, left);
      return () => {
        clearUnfinishedAttempt(user.id, courseId);
        setContinued({
          routeLoad,
          load: {
            ...load,
            activity,
            progress,
            attemptId: crypto.randomUUID(),
            // Only Practise again asks for an extra question: Continue never
            // turns practice into one by itself (ADR 0058).
            extraRequested,
            resumed: undefined,
            // Said of the load that found it, not of what comes after.
            refusalNotice: undefined,
          },
        });
      };
    });
  }

  /**
   * Continue: what comes next, or past the session's last answer its end,
   * with where the learner stands read first, so it shows whole. The answer
   * is forgotten as Continue past it would.
   */
  function continueSession(left: AbortSignal): Promise<{ failed: boolean }> {
    if (session.answers < SESSION_LENGTH) return advance(left);
    return proceed(left, async () => {
      const [next, report] = await Promise.all([
        readActivity(braivo, load.courseId, left, chosenId).then(
          (activity) => ({ activity }),
          // Unknown for now, the score still said; but signed out, or the course
          // gone, as Continue says it (`proceed`): the course reloads.
          (error: unknown) => {
            if (error instanceof BraivoError && [401, 404].includes(error.status)) throw error;
            return undefined;
          },
        ),
        readProgress(braivo, load.courseId, user.id, left),
      ]);
      return () => {
        clearUnfinishedAttempt(user.id, load.courseId);
        // A session of an erased history has no recap to give: on to what comes
        // next, under the epoch that restarts it (learner-loop-25).
        if (next?.activity && "task" in next.activity && next.activity.historyEpoch !== epoch) {
          setContinued({
            routeLoad,
            load: {
              ...load,
              activity: next.activity,
              progress: report,
              attemptId: crypto.randomUUID(),
              extraRequested: false,
              resumed: undefined,
              refusalNotice: undefined,
            },
          });
          return;
        }
        setEnd({ report, next, at: new Date() });
      };
    });
  }

  /** Keep going: what comes next, as Continue reads it, starting a new session. */
  async function keepGoing(left: AbortSignal): Promise<{ failed: boolean }> {
    const result = await advance(left);
    if (!result.failed && !left.aborted) {
      restart();
      setEnd(undefined);
    }
    return result;
  }

  // Under way: a task, or once answered, a pause that does not end it (a rest,
  // no activity), so the bar does not vanish as if the session restarted.
  // Never on an extra question, which is no part of a session (ADR 0058).
  const practising =
    activity !== undefined &&
    ("task" in activity
      ? isAnswerable(activity.task) && !isExtra(activity)
      : session.answers > 0 && !("empty" in activity) && !("dailyLimit" in activity));
  // Shown where practice stops for now, caught up or at the day's limit.
  const sessionSoFar = session.answers > 0 ? session : undefined;

  // An extra question read by Continue, held until the learner asks for it.
  const needsExtraRequest = isExtra(activity) && !extraRequested;
  // This load's answer graded, here or found by a reload's resend.
  const answered = gradedAttempt === attemptId || resumed?.grade !== undefined;
  // A question shows, naming its objective and, while chosen, the way back itself.
  const asking =
    !end &&
    activity !== undefined &&
    "task" in activity &&
    isAnswerable(activity.task) &&
    !needsExtraRequest;
  // The chosen objective's title, from what is shown or else where the learner stands.
  const chosenTitle =
    chosenId === undefined
      ? undefined
      : ((activity !== undefined && "objective" in activity
          ? activity.objective.title
          : undefined) ??
        progress?.objectives.find(({ objectiveId }) => objectiveId === chosenId)?.title ??
        end?.report?.objectives.find(({ objectiveId }) => objectiveId === chosenId)?.title);

  // The objective chosen when the shown load was read. A load under another, by Practise,
  // Back to recommended, or the browser's history, leaves a session's end, or a
  // session at its last answer, behind: a new one starts as that load shows,
  // never before, so what is on screen meanwhile stays as it was.
  const shownLoad = useRef({ routeLoad, chosenId });
  useLayoutEffect(() => {
    // On a load alone: `chosenId` may change while the load it names is pending.
    if (routeLoad === shownLoad.current.routeLoad) return;
    const moved = chosenId !== shownLoad.current.chosenId;
    shownLoad.current = { routeLoad, chosenId };
    if (moved && (end || session.answers >= SESSION_LENGTH)) startAfresh();
  }, [routeLoad, chosenId, end, session.answers, startAfresh]);

  /**
   * Choosing an objective, or going back to the recommended, leaves what is on
   * screen: an answer graded here is done. The session, as `shownLoad` says.
   */
  function clearAnsweredAttempt() {
    if (answered) clearUnfinishedAttempt(user.id, load.courseId);
  }

  /**
   * A rest's end: the course reloads (learner-loop-20), unless practice on a
   * chosen objective reached the rest by Continue, which never asks for an
   * extra question (ADR 0058): then what comes next is read as Continue reads
   * it, and a failed read stays on the rest to try again, never reloading,
   * since a load asks for one.
   */
  async function restEnded(left: AbortSignal): Promise<{ failed: boolean }> {
    if (chosenId === undefined || extraRequested) {
      await reloadCourse(router);
      return { failed: false };
    }
    return advance(left);
  }

  // Practise on the objective already chosen: the address stays, so it reads
  // in place, as Practise again does, an explicit request (ADR 0058).
  const [startingInPlace, setStartingInPlace] = useState(false);
  const [inPlaceFailures, setInPlaceFailures] = useState(0);
  async function practiseInPlace() {
    if (startingInPlace) return;
    setStartingInPlace(true);
    const restartSession = end !== undefined || session.answers >= SESSION_LENGTH;
    const { failed } = await advance(new AbortController().signal, { extraRequested: true });
    setStartingInPlace(false);
    setInPlaceFailures((count) => (failed ? count + 1 : 0));
    if (!failed && restartSession) startAfresh();
  }

  // Practise, after each objective where practice pauses (progress-8).
  const practiseAction = ({ objectiveId, title }: { objectiveId: string; title: string }) => (
    <PractiseLink
      objectiveId={objectiveId}
      title={title}
      onClick={clearAnsweredAttempt}
      inPlace={
        objectiveId === chosenId
          ? { start: () => void practiseInPlace(), starting: startingInPlace }
          : undefined
      }
    />
  );

  return (
    // At least the screen's height, `main`'s bottom padding taken back, so a
    // graded answer's foot (`PinnedFoot`) sits at the screen's foot however
    // short the page: Continue in one place every question.
    <div className="-mb-6 flex min-h-[calc(100dvh-1.5rem)] flex-col">
      {/* Named for assistive technology, first, and the tab; on screen, practice alone. */}
      {title && <h1 className="sr-only">{title}</h1>}
      <PracticeBar answers={end ? SESSION_LENGTH : practising ? session.answers : undefined} />
      {chosenId !== undefined && !asking && (
        // Its own way back, unless what shows offers it already.
        <ChosenObjective
          title={chosenTitle}
          showBack={!needsExtraRequest}
          onBack={clearAnsweredAttempt}
        />
      )}
      {/* Practise in place failed. Keyed, so failing again mounts a new one (docs/apps.md). */}
      {inPlaceFailures > 0 && (
        <Alert key={inPlaceFailures} variant="destructive" className="mb-6">
          <AlertDescription>
            <Trans>Could not load the next question. Try again.</Trans>
          </AlertDescription>
        </Alert>
      )}
      {/* Above whatever comes next: the answer it speaks of is gone. Keyed by
          load, so one found by a reload in place mounts anew, and is announced.
          Gone once this load's answer is graded, or it would seem to mean that one. */}
      {refusalNotice && gradedAttempt !== attemptId && (
        <RefusalAlert key={attemptId} notice={refusalNotice} />
      )}
      {end ? (
        <SessionEnd
          session={session}
          report={end.report}
          nextStep={endStep.nextStep}
          canKeepGoing={endStep.canKeepGoing}
          onKeepGoing={keepGoing}
          objectiveAction={practiseAction}
        />
      ) : !activity ? (
        <CaughtUp report={progress} session={sessionSoFar} objectiveAction={practiseAction} />
      ) : "empty" in activity ? (
        // Not "caught up": nothing was ever there to finish.
        <EmptyCourse />
      ) : "dailyLimit" in activity ? (
        <CaughtUp
          report={progress}
          session={sessionSoFar}
          limitReached
          objectiveAction={practiseAction}
        />
      ) : "retryAfter" in activity ? (
        <Resting
          key={attemptId}
          courseId={load.courseId}
          objective={activity.objective}
          retryAfter={activity.retryAfter}
          reviewable={activity.reviewable}
          onEnd={restEnded}
        />
      ) : !("task" in activity) ? (
        // Not "caught up": the objective selected next has nothing to practise it
        // with (glossary: No activity). Keyed by course, not load: Check again's
        // outcome outlives its own reload, never another course's.
        <NoActivity
          key={load.courseId}
          objectiveTitle={activity.objective.title}
          report={progress}
          onCheck={advance}
        />
      ) : !isAnswerable(activity.task) ? (
        <UnsupportedTask />
      ) : needsExtraRequest ? (
        <NothingDue
          objectiveTitle={activity.objective.title}
          onExtra={() => setContinued({ routeLoad, load: { ...load, extraRequested: true } })}
          onBack={clearAnsweredAttempt}
        />
      ) : (
        // Keyed, so the next activity starts unanswered, and what a reload's
        // resend found replaces what was on screen.
        <Practice
          key={`${attemptId}:${resumed?.grade ? "graded" : resumed ? "unconfirmed" : "new"}`}
          activity={activity}
          courseId={load.courseId}
          attemptId={attemptId}
          resumed={resumed}
          onGraded={(attempt, grade) => {
            // An extra question is no part of a session (ADR 0058).
            if (!isExtra(activity)) count(attempt, grade);
            setGradedAttempt(attempt);
          }}
          onContinue={continueSession}
          onPractiseAgain={(left) => advance(left, { extraRequested: true })}
          onBack={chosenId === undefined ? undefined : clearAnsweredAttempt}
          // Until an answer starts an objective and Continue reloads progress;
          // unknown progress says nothing.
          nothingStarted={
            progress !== undefined &&
            progress.objectives.length > 0 &&
            progress.objectives.every(({ phase }) => phase === "unseen")
          }
        />
      )}
    </div>
  );
}

/**
 * That an answer was refused for good, and is gone. A status
 * mounted empty, filled after (docs/apps.md): one mounted filled may go unsaid.
 */
function RefusalAlert({ notice }: { notice: RefusalNotice }) {
  const { t } = useLingui();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const said =
    notice === "history-erased"
      ? t`Your learning history here was cleared, so your last answer wasn't saved. You're starting fresh.`
      : t`Your last answer couldn't be recorded.`;
  return (
    <p role="status" className="mb-6 text-sm">
      {mounted ? said : ""}
    </p>
  );
}

/**
 * The course page's only chrome: Close, back to the list, and while practising,
 * the session's progress, `answers` of `SESSION_LENGTH`, as a bar and in words,
 * moving with each grade.
 */
function PracticeBar({ answers }: { answers: number | undefined }) {
  const { t } = useLingui();
  // Named for translators: a placeholder takes the variable's name.
  const total = SESSION_LENGTH;
  return (
    // `-ms-3`: the icon, not its padding, at the page's edge, as a text button's.
    <div className="-mt-3 mb-4 flex flex-wrap items-center gap-x-2">
      <Button asChild variant="ghost" size="icon" className="-ms-3 size-11 shrink-0">
        <HomeLink aria-label={t`Close`}>
          <XIcon aria-hidden="true" className="size-5" />
        </HomeLink>
      </Button>
      {answers !== undefined && (
        // Not shadcn's `Progress`, which never hands Radix its value, so is
        // announced as indeterminate.
        <div
          role="progressbar"
          aria-label={t`Session`}
          aria-valuemin={0}
          aria-valuemax={SESSION_LENGTH}
          aria-valuenow={answers}
          aria-valuetext={t`${answers} of ${total} answered`}
          // Never squeezed to nothing beside its count: with larger text, the row wraps.
          className="h-2.5 min-w-24 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
            style={{ width: `${(answers / SESSION_LENGTH) * 100}%` }}
          />
        </div>
      )}
      {/* Said in words too, so the bar reads as this session's, not the
          course's; the bar says it to a screen reader already. */}
      {answers !== undefined && (
        <span aria-hidden="true" className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {t`${answers} of ${total}`}
        </span>
      )}
    </div>
  );
}

/**
 * Adds when the next review falls due, if any objective is retained and not
 * yet due. The model's time, not a promise of practice: an objective may have
 * no task. A label, since a title may be a phrase ("Greet someone").
 * `limitReached`: caught up but for new objectives, held back by the day's limit.
 * Then today's practice, from evidence on any device: "today", never "this
 * visit", in the daily limit's days, so past midnight is still tonight.
 */
function CaughtUp({
  report,
  session,
  limitReached = false,
  objectiveAction,
}: {
  report: LearnerProgressSummary | undefined;
  /** This visit's session, if answered: its recap, as practice stops before its end. */
  session?: PracticeSession;
  limitReached?: boolean;
  /** After each objective where the learner stands: Practise. */
  objectiveAction: (objective: { objectiveId: string; title: string }) => ReactNode;
}) {
  const { t } = useLingui();
  // Rendering stays pure: now is when this notice first showed.
  const [now] = useState(() => new Date());
  const status = useCaughtUpStatus(report, now, limitReached);
  const dayOf = learnerDayIn();
  const today = dayOf(now);
  const todaySummary = formatCounts(
    countStandings(
      report?.objectives.filter(
        (standing) =>
          standing.phase !== "unseen" && dayOf(new Date(standing.lastEvidenceAt)) === today,
      ) ?? [],
    ),
    t,
  ).join(" · ");
  const title = limitReached ? t`That's all the new material for today` : t`You're caught up`;
  return (
    <Notice
      title={title}
      description={
        <>
          <p>{status}</p>
          {session && (
            <div className="mt-2">
              <SessionRecap session={session} />
            </div>
          )}
          {todaySummary && (
            <p className="mt-2">
              {t({
                message: `Practised today: ${todaySummary}.`,
                comment: "Objectives practised today, by current standing: 2 retained · 1 learning",
              })}
            </p>
          )}
        </>
      }
    >
      {/* Where the learner stands, as practice pauses (progress-8). */}
      {report && <StandingMeter report={report} action={objectiveAction} />}
    </Notice>
  );
}

/**
 * A session end's next step, from the activity read with it (learner-loop-23),
 * never inferred from standings, which say what is known, not what can be
 * practised (a resting task, one unpublished, the day's limit): more now, and
 * Keep going (`canKeepGoing`), only where a question waits; else why practice stops
 * and when it resumes, Done alone. Unread, it claims nothing, and Keep going
 * stays, to try again.
 */
function useEndStep(
  end:
    | {
        report: LearnerProgressSummary | undefined;
        next: { activity: Activity | undefined } | undefined;
        at: Date;
      }
    | undefined,
): { nextStep: string | undefined; canKeepGoing: boolean } {
  const { t, i18n } = useLingui();
  const activity = end?.next?.activity;
  const limitReached = activity !== undefined && "dailyLimit" in activity;
  const stopped = useCaughtUpStatus(end?.report, end?.at, limitReached);
  if (!end?.next) return { nextStep: undefined, canKeepGoing: true };
  if (activity === undefined || limitReached) return { nextStep: stopped, canKeepGoing: false };
  if ("task" in activity) {
    // On a chosen objective needing no attention: an extra question is the
    // learner's to ask, never "more to practise" (ADR 0058).
    if (isExtra(activity)) {
      const objectiveTitle = activity.objective.title;
      return { nextStep: t`Nothing is due on ${objectiveTitle} right now.`, canKeepGoing: false };
    }
    return isAnswerable(activity.task)
      ? { nextStep: t`More to practise now.`, canKeepGoing: true }
      : { nextStep: undefined, canKeepGoing: false };
  }
  if ("retryAfter" in activity) {
    const continuesAt = new Intl.DateTimeFormat(i18n.locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(roundUpToMinute(end.at.getTime() + activity.retryAfter * 1000));
    return { nextStep: t`Practice continues at ${continuesAt}.`, canKeepGoing: false };
  }
  // No activity, or none at all: nothing to promise.
  return { nextStep: undefined, canKeepGoing: false };
}

/**
 * Why practice stops for now, in a line: nothing due, or the day's limit on
 * new material (`limitReached`), and when the next review falls due, if any.
 * Shared by caught up and a session's end, so the two say it alike.
 */
function useCaughtUpStatus(
  report: LearnerProgressSummary | undefined,
  now: Date | undefined,
  limitReached: boolean,
): string {
  const { t } = useLingui();
  const next = useNextReview(report, now);
  if (!next) {
    return limitReached
      ? t`You can start new material again tomorrow. Nothing is due right now.`
      : t`Nothing is due right now.`;
  }
  const { objectiveTitle, nextReviewAt } = next;
  return limitReached
    ? t`You can start new material again tomorrow. Next review due: ${objectiveTitle}, ${nextReviewAt}.`
    : t`Nothing is due right now. Next review due: ${objectiveTitle}, ${nextReviewAt}.`;
}

/**
 * The review that falls due first, if any objective is retained and not yet
 * due: its objective's title and when, in words ("today at 16:20"). The
 * model's time, not a promise of practice: an objective may have no task.
 */
function useNextReview(
  report: LearnerProgressSummary | undefined,
  now: Date | undefined,
): { objectiveTitle: string; nextReviewAt: string } | undefined {
  const { t, i18n } = useLingui();
  if (!now) return undefined;
  // Read moments apart from the activity, the report may already count one due,
  // whose time has passed.
  const next = report?.objectives
    .flatMap((standing) => (standing.phase === "retaining" && !standing.due ? [standing] : []))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  if (!next) return undefined;
  const dueAt = roundUpToMinute(Date.parse(next.dueAt));
  // Today and tomorrow by the calendar, not the 04:00 learner day: they name a clock time.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const time = new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short" }).format(dueAt);
  let nextReviewAt: string;
  if (dueAt.toDateString() === now.toDateString()) {
    nextReviewAt = t`today at ${time}`;
  } else if (dueAt.toDateString() === tomorrow.toDateString()) {
    nextReviewAt = t`tomorrow at ${time}`;
  } else {
    // Apart from the time: some engines join a Polish date and time with no word.
    const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "full" }).format(dueAt);
    nextReviewAt = t`on ${date} at ${time}`;
  }
  return { objectiveTitle: next.title, nextReviewAt };
}

type PresentedTask = Extract<Activity, { task: unknown }>["task"];

/**
 * Whether this page answers the task. Every kind its types know, but a newer
 * Braivo may send one they do not (docs/adr/0038-typed-answers.md).
 */
function isAnswerable(task: PresentedTask): boolean {
  return Object.hasOwn(KINDS, task.kind);
}

/** Every kind the page renders; a kind added to the types fails to compile here. */
const KINDS: Record<PresentedTask["kind"], true> = { choice: true, typed: true };

/**
 * A task of a kind this app does not answer yet: said, with a way out, and
 * nothing sent, so nothing is recorded (docs/adr/0038-typed-answers.md).
 */
function UnsupportedTask() {
  const { t } = useLingui();
  return (
    <Notice title={t`This question can't be answered here yet.`}>
      <Button asChild variant="outline">
        <HomeLink>
          <Trans>Your courses</Trans>
        </HomeLink>
      </Button>
    </Notice>
  );
}

/** A course with no objectives yet: never "caught up", which would say the learner finished. */
function EmptyCourse() {
  const { t } = useLingui();
  return (
    <Notice title={t`This course has nothing to practise yet.`}>
      <Button asChild variant="outline">
        <HomeLink>
          <Trans>Your courses</Trans>
        </HomeLink>
      </Button>
    </Notice>
  );
}

/**
 * The objective selected next has no task (glossary: No activity), whether
 * none was written, it waits for review, or it was retired: one wording for
 * all, revealing nothing unpublished, and claiming nobody was told. Practice
 * returns when a task for it is published, or when another objective with one
 * falls due, neither on a clock this page knows, so Check again reassures
 * rather than polls: `onCheck` reads the activity and standing
 * afresh, as Continue does, replacing this notice with whatever is there now.
 */
function NoActivity({
  objectiveTitle,
  report,
  onCheck,
}: {
  objectiveTitle: string;
  report: LearnerProgressSummary | undefined;
  onCheck: (left: AbortSignal) => Promise<{ failed: boolean }>;
}) {
  const { t } = useLingui();
  // Now is when the standing was read, so Check again renews it with the standing.
  const nextReview = useNextReview(report, report && new Date(report.asOf));
  const [checking, setChecking] = useState(false);
  // Said after a check that found nothing, cleared while one runs, so a second
  // says it again (docs/apps.md, a status mounted empty).
  const [stillNothing, setStillNothing] = useState(false);
  // Failures in a row, each a new alert (docs/apps.md); kept while a retry
  // runs, so the button does not jump under the pointer, and 0 once one works.
  const [failures, setFailures] = useState(0);
  // Aborted when this notice goes away, as Practice's: what replaced it is current.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  function nextReviewLine({ objectiveTitle, nextReviewAt }: NonNullable<typeof nextReview>) {
    return t`Next review due: ${objectiveTitle}, ${nextReviewAt}.`;
  }

  async function check() {
    const left = lifetime.current?.signal;
    if (checking || !left) return;
    setChecking(true);
    setStillNothing(false);
    try {
      const { failed } = await onCheck(left);
      if (left.aborted) return;
      setFailures((count) => (failed ? count + 1 : 0));
      setStillNothing(!failed);
    } catch {
      // A reload that failed itself: said as any other failure.
      if (!left.aborted) setFailures((count) => count + 1);
    } finally {
      if (!left.aborted) setChecking(false);
    }
  }

  return (
    <Notice
      title={t`Nothing to practise right now`}
      description={
        <>
          <p>{t`Practice for ${objectiveTitle} isn't available right now.`}</p>
          {nextReview && <p className="mt-2">{nextReviewLine(nextReview)}</p>}
        </>
      }
    >
      {failures > 0 && (
        <Alert key={failures} variant="destructive">
          <AlertDescription>
            <Trans>Could not check for practice. Try again.</Trans>
          </AlertDescription>
        </Alert>
      )}
      {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
      <Button aria-disabled={checking} onClick={() => void check()}>
        {checking ? t`Checking…` : t`Check again`}
      </Button>
      <Button asChild variant="outline">
        <HomeLink>
          <Trans>Your courses</Trans>
        </HomeLink>
      </Button>
      <p role="status" className="text-sm text-muted-foreground">
        {stillNothing ? t`Still nothing to practise.` : ""}
      </p>
    </Notice>
  );
}

/**
 * Reloads the course, after the guard rechecks the session (access-6); never
 * the root's brand. Resolves once the new load shows (`sync`): otherwise a loaded
 * course reloads in the background, the old page still answerable.
 */
function reloadCourse(router: ReturnType<typeof useRouter>): Promise<void> {
  return router.invalidate({ filter: (match) => match.routeId === Route.id, sync: true });
}

/**
 * An objective's review, for `ReviewTopic`. Signed out since, the course
 * reloads, so the guard sends the learner to sign in; the review still says it
 * could not load, should the reload not leave the page.
 */
async function readReview(
  braivo: BraivoClient,
  router: ReturnType<typeof useRouter>,
  input: { courseId: string; objectiveId: string },
  signal: AbortSignal,
): Promise<ObjectiveReview | undefined> {
  try {
    return await braivo.objectiveReview(input, { signal });
  } catch (error) {
    if (error instanceof BraivoError && error.status === 401) await reloadCourse(router);
    throw error;
  }
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
        <HomeLink>
          <Trans>Your courses</Trans>
        </HomeLink>
      </Button>
    </Notice>
  );
}

/**
 * Every task for what comes next was answered recently. Reads what comes next
 * once one may be asked again (`onEnd`), never while the learner reviews the
 * objective, which keeps the rest (ADR 0054): Back to practice then reads at
 * once if it ended meanwhile, or waits out what is left. A read that fails
 * stays here, saying so, with Try again, which reads the same way.
 */
function Resting({
  courseId,
  objective,
  retryAfter,
  reviewable,
  onEnd,
}: {
  courseId: string;
  objective: { id: string; title: string };
  retryAfter: number;
  reviewable: boolean;
  /** Once the rest ends: what comes next, read again under `left`; whether it failed. */
  onEnd: (left: AbortSignal) => Promise<{ failed: boolean }>;
}) {
  const { braivo, user } = Route.useRouteContext();
  const router = useRouter();
  // Failures in a row, each a new alert (docs/apps.md).
  const [failures, setFailures] = useState(0);
  const [reading, setReading] = useState(false);
  // Aborted when this notice goes away: what replaced it is current.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  async function readNext() {
    const left = lifetime.current?.signal;
    if (reading || !left) return;
    setReading(true);
    try {
      const { failed } = await onEnd(left);
      if (!left.aborted) setFailures((count) => (failed ? count + 1 : 0));
    } catch {
      if (!left.aborted) setFailures((count) => count + 1);
    } finally {
      if (!left.aborted) setReading(false);
    }
  }
  // The latest, so a render does not restart the timer.
  const readNextRef = useRef(readNext);
  useLayoutEffect(() => {
    readNextRef.current = readNext;
  });
  const { t, i18n } = useLingui();
  const objectiveTitle = objective.title;
  const delay = retryAfter * 1000;
  // Display only: the timer waits out the duration, so the device's clock cannot move it.
  const [retryAt] = useState(() => Date.now() + delay);
  // The timer's own end, on a monotonic clock, kept while a review pauses it.
  const [endsAt] = useState(() => performance.now() + delay);
  const { reviewing, open: openReview, close: closeReview, button: reviewButton } = useReviewing();

  useEffect(() => {
    if (reviewing) return;
    const timer = setTimeout(
      () => void readNextRef.current(),
      Math.max(0, endsAt - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [endsAt, reviewing]);

  const continuesAt = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(roundUpToMinute(retryAt));

  return (
    <>
      {reviewing && (
        <ReviewTopic
          title={objectiveTitle}
          read={(signal) =>
            readReview(braivo, router, { courseId, objectiveId: objective.id }, signal)
          }
          onShown={() => markReviewed(user.id, objective.id)}
          onBack={closeReview}
        />
      )}
      {/* Hidden, not unmounted, while reviewing: mounted again, the notice would
          take the focus Back to practice returns to the button. */}
      <div hidden={reviewing}>
        <Notice
          title={t`Take a short break`}
          description={t`You practised ${objectiveTitle} recently. Practice continues at ${continuesAt}, so the next try shows what you remember.`}
        >
          {failures > 0 && (
            <Alert key={failures} variant="destructive">
              <AlertDescription>
                <Trans>Could not load the next question. Try again.</Trans>
              </AlertDescription>
            </Alert>
          )}
          {failures > 0 && (
            // aria-disabled, not disabled, so that it keeps the focus meanwhile.
            <Button aria-disabled={reading} onClick={() => void readNext()}>
              {reading ? t`Loading…` : t`Try again`}
            </Button>
          )}
          {reviewable && <ReviewButton ref={reviewButton} variant="outline" onClick={openReview} />}
        </Notice>
      </div>
    </>
  );
}

/**
 * An answer refused for good, forgotten already. No retry, unlike a failed
 * load: this answer would be refused again. No cause either: a page built
 * before an update is one, the write check (403) another. Continue loads the
 * whole document, so such a page loads the current app, then the course its
 * next activity.
 */
function RefusedAnswer() {
  const { t } = useLingui();
  const [reloading, setReloading] = useState(false);

  function reload() {
    if (reloading) return;
    setReloading(true);
    location.reload();
  }

  return (
    <Notice title={t`This answer couldn't be recorded.`} description={t`Continue practising.`}>
      {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
      <Button aria-disabled={reloading} onClick={reload}>
        {reloading ? t`Loading…` : t`Continue`}
      </Button>
      <Button asChild variant="outline">
        <HomeLink>
          <Trans>Your courses</Trans>
        </HomeLink>
      </Button>
    </Notice>
  );
}

/**
 * Why this comes now, from the values the decision was made on: decisions are
 * explainable. A reteach follows a failure, from a wrong answer or Show answer,
 * which the decision does not tell apart, so the wording claims neither.
 */
function Reason({ decision }: { decision: ActivityDecision }) {
  switch (decision.intent) {
    case "introduce":
      return null;
    case "practise":
      // The learner's request: never presented as the model's recommendation.
      return (
        <MutedText>
          <Trans>You chose this. It isn't due for review yet.</Trans>
        </MutedText>
      );
    case "reteach":
      return (
        <MutedText>
          <Trans>Let's practise this again.</Trans>
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

/** UTF-16 units of a correct answer the foot holds, about three lines on a 320px phone: a rough bound, not a measure. */
const FOOT_ANSWER_MAX_LENGTH = 60;

/** In context, as each reads unlike the same English elsewhere ("Try again", the button). */
const INTENT_LABELS: Record<ActivityDecision["intent"], MessageDescriptor> = {
  introduce: msg({ message: "New", context: "Why a question comes now" }),
  reteach: msg({ message: "Try again", context: "Why a question comes now" }),
  review: msg({ message: "Review", context: "Why a question comes now" }),
  practise: msg({ message: "Extra practice", context: "Why a question comes now" }),
};

function Practice({
  activity,
  courseId,
  attemptId,
  resumed,
  onGraded,
  onContinue,
  onPractiseAgain,
  onBack,
  nothingStarted,
}: {
  activity: Extract<Activity, { task: unknown }>;
  /** As found, not as the address names it. */
  courseId: string;
  attemptId: string;
  /** The answer a reload resent, shown graded or unconfirmed. */
  resumed?: Resumed;
  /** Braivo graded an answer sent here, by Send again too; not one a reload's resend found. */
  onGraded: (attempt: string, grade: Grade) => void;
  /** Continue, under this practice's lifetime: whether it failed, keeping it on screen. */
  onContinue: (left: AbortSignal) => Promise<{ failed: boolean }>;
  /** After extra practice, in place of Continue: another, as `onContinue` reads it. */
  onPractiseAgain: (left: AbortSignal) => Promise<{ failed: boolean }>;
  /**
   * Back to the model's choice, on an objective the learner chose: beside the
   * question's label, and once an extra question is graded, at the foot.
   */
  onBack: (() => void) | undefined;
  /** No objective started yet: says how practice goes. */
  nothingStarted: boolean;
}) {
  const { braivo, user } = Route.useRouteContext();
  const { organization } = useLoaderData({ from: "__root__" });
  const router = useRouter();
  const { t } = useLingui();
  // From the moment it is sent, so the question shows what was sent.
  const [sent, setSent] = useState<TaskResponse | undefined>(resumed?.attempt.response);
  const [grade, setGrade] = useState(resumed?.grade);
  // Counted, not flagged, so that each answer left unconfirmed gets a new alert (below).
  const [unconfirmedCount, setUnconfirmedCount] = useState(resumed && !resumed.grade ? 1 : 0);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(false);
  const [continuing, setContinuing] = useState(false);
  // Counted, as `unconfirmedCount` is, so each failed Continue gets a new alert.
  const [continueFailures, setContinueFailures] = useState(0);
  // The question itself, so its number keys work at once and a screen reader
  // announces the prompt that labels it.
  const focused = useFocusOnMount<HTMLDivElement>();
  // A typed task's field, so the learner types straight away.
  const focusedField = useFocusOnMount<HTMLInputElement>();
  // Describes the question, so the focus landing on it reads this too.
  const contextId = useId();
  const passagesId = useId();
  const explanationId = useId();
  const answerId = useId();
  const { decision, objective, task } = activity;
  const { reviewing, open: openReview, close: closeReview, button: reviewButton } = useReviewing();
  // Whether this attempt says the learner reviewed its objective: taken from the
  // tab's mark when first sent, then the same for every resend (ADR 0054). A
  // resumed attempt was sent already: absent, its answer is `false`, never
  // taken again, or a review since would change it.
  const reviewedTeaching = useRef<boolean | undefined>(
    resumed && (resumed.attempt.reviewedTeaching ?? false),
  );

  // Aborted when this practice goes away, so an answer still in flight cannot
  // act on whatever page the learner has moved on to. Created in the effect,
  // not in state, since StrictMode runs the cleanup once before remounting.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function submit(response: TaskResponse) {
    const left = lifetime.current?.signal;
    setSent(response);
    setSending(true);
    reviewedTeaching.current ??= takeReviewed(user.id, objective.id);
    const reviewed = reviewedTeaching.current;
    // Before sending, kept until Continue: a reload can land after Braivo
    // records it and before its grade arrives, or before it is read.
    saveUnfinishedAttempt(user.id, courseId, {
      id: attemptId,
      activity,
      response,
      ...(reviewed && { reviewedTeaching: reviewed }),
    });
    try {
      const answered = await braivo.submitAttempt(
        {
          courseId,
          id: attemptId,
          taskId: task.id,
          response,
          historyEpoch: activity.historyEpoch,
          ...(reviewed && { reviewedTeaching: reviewed }),
        },
        { signal: withDeadline(left, ANSWER_DEADLINE_MS) },
      );
      // Left meanwhile: marking that page graded would cancel the next one's reread.
      if (left?.aborted) return;
      setGrade(answered);
      setUnconfirmedCount(0);
      onGraded(attemptId, answered);
    } catch (error) {
      // Kept unless refused (below): it may have been recorded. Left, not timed
      // out: a timeout is unconfirmed, below.
      if (left?.aborted) return;
      if (error instanceof BraivoError) {
        if (FINAL_REFUSALS.includes(error.status)) {
          clearUnfinishedAttempt(user.id, courseId);
          // Recorded nothing: the review is the next attempt's to say.
          if (reviewed) markReviewed(user.id, objective.id);
        }
        if (isHistoryErased(error)) markRefusalNotice(user.id, courseId, "history-erased");
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
        if (REFUSALS_SAID.includes(error.status)) {
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

  /**
   * The answer sent before, under the account this tab loaded for, or nothing:
   * the session's cookie may be another's by now, and Braivo would take this as
   * its first answer (access-49). Reloaded, the guard decides, and the answer
   * stays for its own learner. The check failing is said as the send's failure.
   */
  async function sendAgain(response: TaskResponse) {
    const left = lifetime.current?.signal;
    setSending(true);
    try {
      const account = await braivo.session({ signal: withDeadline(left, READ_DEADLINE_MS) });
      if (left?.aborted) return;
      if (account?.id === user.id) {
        await submit(response);
        return;
      }
      await router.invalidate({ sync: true });
    } catch (error) {
      if (left?.aborted) return;
      if (error instanceof BraivoError && error.status === 401) await reloadCourse(router);
      else setUnconfirmedCount((count) => count + 1);
    } finally {
      if (!left?.aborted) setSending(false);
    }
  }

  // Extra practice is finished once answered: never Continue (ADR 0058).
  const extra = decision.intent === "practise";

  async function next(read = onContinue) {
    // Held until the next activity replaces this one, or fails to: a second
    // press would read it twice.
    if (continuing) return;
    const left = lifetime.current?.signal;
    if (!left) return;
    setContinuing(true);
    try {
      const { failed } = await read(left);
      if (failed && !left.aborted) setContinueFailures((count) => count + 1);
    } catch {
      // A reload that failed itself: said as any other failure, not left unhandled.
      if (!left.aborted) setContinueFailures((count) => count + 1);
    } finally {
      // Replaced, by what came next or by a reload: nothing left to update.
      if (!left.aborted) setContinuing(false);
    }
  }

  if (refused) return <RefusedAnswer />;

  const correctChoice = grade?.kind === "choice" ? grade.correctChoice : undefined;
  // Named only on a failure: a typed answer may succeed on another accepted
  // spelling than the one named, and is not corrected then.
  const correctAnswer =
    grade?.outcome !== "failure"
      ? undefined
      : grade.kind === "typed"
        ? grade.correctAnswer
        : task.kind === "choice"
          ? task.options.find((option) => option.choice === correctChoice)?.text
          : undefined;
  const revealed = sent !== undefined && "reveal" in sent;
  // In the foot with the verdict while short: a long one (a typed answer may
  // run to 500 characters, an option to a sentence) would grow the pinned foot
  // over the question, so it goes in the page with the explanation instead.
  const answerInFoot =
    correctAnswer !== undefined && correctAnswer.length <= FOOT_ANSWER_MAX_LENGTH;
  // What the page says beyond the verdict, read as the focus lands on the next step.
  const describedBy =
    [correctAnswer && !answerInFoot && answerId, grade?.explanation && explanationId]
      .filter(Boolean)
      .join(" ") || undefined;
  // What a missed typed answer got wrong, marked in the answer (Show answer typed nothing).
  const markedAnswer = correctAnswer && (
    <MarkedAnswer answer={correctAnswer} typed={sent && "text" in sent ? sent.text : undefined} />
  );

  return (
    <>
      {reviewing && (
        <ReviewTopic
          title={objective.title}
          read={(signal) =>
            readReview(braivo, router, { courseId, objectiveId: objective.id }, signal)
          }
          onShown={() => markReviewed(user.id, objective.id)}
          onBack={closeReview}
        />
      )}
      {/* Hidden, not unmounted, while reviewing: Back to practice finds the
          feedback, a report sent or on its way, and Continue as they were. */}
      <section hidden={reviewing} className="flex flex-1 flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-x-2">
          <div id={contextId} className="flex min-w-0 flex-1 basis-48 flex-col wrap-break-word">
            <MutedText>
              {t(INTENT_LABELS[decision.intent])} · {objective.title}
            </MutedText>
            {/* "Not due" no longer holds once missed: the miss made it acquiring. */}
            {!(extra && grade?.outcome === "failure") && <Reason decision={decision} />}
            {/* In the question's description, so it is read as the focus lands there. */}
            {nothingStarted && (
              <MutedText className="mt-2">
                <Trans>
                  One question at a time. What you get wrong comes back soon; what you get right
                  returns for review before you're likely to forget it.
                </Trans>
              </MutedText>
            )}
          </div>
          {/* Out of the question's description; at the foot instead once an
            extra question is graded. Text level with the label's first line. */}
          {onBack && !(extra && grade) && (
            <BackToRecommended className="-mt-2 shrink-0" onClick={onBack} />
          )}
        </div>
        {/* Typed first: a kind added later then fails to compile on `options`
          rather than rendering as a typed question. */}
        {task.kind === "typed" ? (
          <TypedQuestion
            prompt={task.prompt}
            sent={sent && "text" in sent ? sent.text : undefined}
            outcome={grade?.outcome}
            pending={sending && !revealed}
            locked={revealed}
            onSubmit={(text) => submit({ text })}
            ref={resumed ? undefined : focusedField}
            aria-describedby={contextId}
          />
        ) : (
          <ChoiceQuestion
            prompt={task.prompt}
            options={task.options}
            chosen={sent && "choice" in sent ? sent.choice : undefined}
            correctChoice={correctChoice}
            pending={sending}
            locked={revealed}
            onChoose={(choice) => submit({ choice })}
            // Resumed, the focus is on Send again or Continue, as when answered here.
            ref={resumed ? undefined : focused}
            aria-describedby={contextId}
          />
        )}
        {/* Before answering only: asking is an answer of its own, a failure, not
          a hint (ADR 0038). Kept, locked, while it is sent, so it keeps the
          focus until the grade or Send again replaces it (docs/apps.md). */}
        {(sent === undefined || (revealed && sending && unconfirmedCount === 0)) && (
          <Button
            variant="ghost"
            // Its text, not its padding, in line with the question's.
            className="-ms-3 self-start"
            aria-disabled={sending}
            onClick={() => !sending && submit({ reveal: true })}
          >
            {revealed ? t`Loading…` : t`Show answer`}
          </Button>
        )}
        {unconfirmedCount > 0 && sent !== undefined && (
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
              onClick={() => !sending && sendAgain(sent)}
            >
              {sending ? t`Sending…` : t`Send again`}
            </Button>
          </>
        )}
        {grade && (
          <>
            {/* Teaching, not a verdict: body text by the question, read as
              Continue takes the focus (its description). */}
            {correctAnswer && !answerInFoot && (
              <p id={answerId} className="text-pretty wrap-break-word">
                <Trans>The answer: {markedAnswer}</Trans>
              </p>
            )}
            {grade.explanation && (
              <p id={explanationId} className="text-pretty wrap-break-word">
                {grade.explanation}
              </p>
            )}
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
            {/* After a miss, Show answer included, with the teaching above, not in
              the foot, which stays short; never between Continue and the
              learner, who has the focus there. Not while Continue reads, which
              would replace the feedback it returns to. */}
            {grade.outcome === "failure" && grade.reviewable && (
              <ReviewButton ref={reviewButton} disabled={continuing} onClick={openReview} />
            )}
            {/* A wrapping row: the verdict, its flag beside it where both fit
              (else on a line of its own, as larger text needs), then the rest
              across it. Placed by `order`, read in the page's: the flag after
              Continue, never between it and the learner. */}
            <PinnedFoot className="flex-row flex-wrap">
              {/* The verdict where the thumb and eye go next, beside Continue, in
                the outcome's tint as the options mark it; the question stays in
                view above. `wrap-anywhere`: a grid, whose column is otherwise as
                wide as the answer's longest word, such as a link. */}
              <Alert
                className={cn(
                  // At least 10rem, or the whole row: never squeezed beside the flag, which
                  // fits beside it on a 320px phone at the default text size.
                  "order-1 min-w-[min(100%,10rem)] flex-1 wrap-anywhere",
                  grade.outcome === "success"
                    ? "border-success bg-success/10"
                    : !revealed && "border-destructive bg-destructive/10",
                )}
              >
                {grade.outcome === "success" ? (
                  <CircleCheckIcon aria-hidden="true" className="text-success!" />
                ) : revealed ? (
                  <EyeIcon aria-hidden="true" />
                ) : (
                  <CircleXIcon aria-hidden="true" className="text-destructive!" />
                )}
                <AlertTitle>
                  {grade.outcome === "success"
                    ? t`Correct`
                    : revealed
                      ? t`Here it is`
                      : t`Not quite`}
                </AlertTitle>
                {/* Named, not only marked, so a learner need not go back to the
                  options, which a phone may have scrolled away. Ink, not muted,
                  on the tint. */}
                {answerInFoot && (
                  <AlertDescription className="text-foreground">
                    <Trans>The answer: {markedAnswer}</Trans>
                  </AlertDescription>
                )}
                {/* Too long for the foot, the answer is in the page, maybe under
                  it: a way there, never a step before Continue. */}
                {correctAnswer && !answerInFoot && (
                  <AlertDescription>
                    {/* Wrapping, as a phrase in a narrow cell may need to. */}
                    <Button
                      variant="link"
                      className="h-auto min-h-0 p-0 text-left whitespace-normal text-foreground"
                      onClick={() =>
                        document.getElementById(answerId)?.scrollIntoView({ block: "center" })
                      }
                    >
                      <Trans>See the answer</Trans>
                    </Button>
                  </AlertDescription>
                )}
              </Alert>
              {/* Above Continue, as Send again's; keyed, so failing again mounts a new one. */}
              {continueFailures > 0 && (
                <Alert key={continueFailures} variant="destructive" className="order-3">
                  <AlertDescription>
                    <Trans>Could not load the next question. Try again.</Trans>
                  </AlertDescription>
                </Alert>
              )}
              {extra ? (
                <>
                  {/* The way back first: another extra question is asked for, never offered as next. */}
                  <BackToRecommended
                    size="lg"
                    className="order-4 w-full"
                    autoFocus
                    describedBy={describedBy}
                    onClick={() => onBack?.()}
                  />
                  <Button
                    size="lg"
                    variant="outline"
                    className="order-4 w-full"
                    aria-disabled={continuing}
                    onClick={() => void next(onPractiseAgain)}
                  >
                    {continuing ? t`Loading…` : t`Practise again`}
                  </Button>
                </>
              ) : (
                // aria-disabled, not disabled, so that it keeps the focus meanwhile.
                <Button
                  size="lg"
                  className="order-4 w-full"
                  autoFocus
                  aria-disabled={continuing}
                  aria-describedby={describedBy}
                  onClick={() => void next()}
                >
                  {continuing ? t`Loading…` : t`Continue`}
                </Button>
              )}
              <ReportProblem
                triggerClassName="order-2 shrink-0"
                statusClassName="order-5 basis-full"
                send={(report, signal) =>
                  braivo.reportAttempt({ courseId, attemptId, ...report }, { signal })
                }
                missed={grade.outcome === "failure" && !revealed}
                passages={grade.passages !== undefined}
                organizationName={organization?.name}
              />
            </PinnedFoot>
          </>
        )}
      </section>
    </>
  );
}
