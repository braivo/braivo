// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Grade, LearnerProgressSummary } from "@braivo/server/client";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Notice } from "#components/notice";
import { StandingMeter } from "#components/standing";

/**
 * Answers in a session, after which practice pauses at its end. Short enough
 * for a break on a phone, long enough for a few objectives to move; a
 * constant until learners' sessions say otherwise.
 */
export const SESSION_LENGTH = 10;

/**
 * What this page saw of a session: its graded answers and how many were right.
 * Only what happened here: where the learner stands across the course moves
 * with evidence from anywhere (another tab, a shared objective, an import), so
 * it is shown as it stands, never claimed as this session's doing.
 */
export type PracticeSession = { answers: number; right: number };

/**
 * This visit's session as the page counts it (learner-loop-23): each attempt
 * once, whatever finds its grade (`count`), until `restart` begins another.
 * The attempts it is done with are those it counted and those a load's resend
 * found graded (`resumed`, per load), which it never counts: a grade found
 * again for one, as a reload's resend then Send again find it, counts nothing,
 * while one first confirmed by Send again counts once.
 */
export function usePracticeSession(
  resumed: { attempt: { id: string }; grade?: unknown } | undefined,
) {
  const [session, setSession] = useState<PracticeSession>({ answers: 0, right: 0 });
  const handled = useRef(new Set<string>());
  // In the commit that shows the load, before anything on it can count.
  useLayoutEffect(() => {
    if (resumed?.grade) handled.current.add(resumed.attempt.id);
  }, [resumed]);

  function count(attempt: string, grade: Grade) {
    if (handled.current.has(attempt)) return;
    handled.current.add(attempt);
    setSession((current) => ({
      answers: current.answers + 1,
      right: current.right + (grade.outcome === "success" ? 1 : 0),
    }));
  }

  const restart = useCallback(() => {
    handled.current = new Set();
    setSession({ answers: 0, right: 0 });
  }, []);

  return { session, count, restart };
}

/**
 * The end of a session: its recap (`SessionRecap`), what comes next in words
 * (`nextStep`: more now, when practice resumes, or when to come back), Keep
 * going where it leads to a question (`canKeepGoing`), else Done alone, then where the
 * learner stands (`report`; left out if unread, the score still said). Whole
 * as it mounts, so the focus landing on it reads all of it. Keep going reads
 * what comes next afresh as Continue does (`onKeepGoing`), staying here,
 * saying so, if that fails.
 */
export function SessionEnd({
  session,
  report,
  nextStep,
  canKeepGoing,
  onKeepGoing,
  objectiveAction,
}: {
  session: PracticeSession;
  report: LearnerProgressSummary | undefined;
  nextStep: string | undefined;
  canKeepGoing: boolean;
  onKeepGoing: (left: AbortSignal) => Promise<{ failed: boolean }>;
  /** After each objective where the learner stands, such as Practise. */
  objectiveAction?: ComponentProps<typeof StandingMeter>["action"];
}) {
  const { t } = useLingui();
  const [going, setGoing] = useState(false);
  // Failures in a row, each a new alert (docs/apps.md).
  const [failures, setFailures] = useState(0);
  // Aborted when this end goes away: what replaced it is current.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function keepGoing() {
    const left = lifetime.current?.signal;
    if (going || !left) return;
    setGoing(true);
    try {
      const { failed } = await onKeepGoing(left);
      if (failed && !left.aborted) setFailures((count) => count + 1);
    } catch {
      // A reload that failed itself: said as any other failure.
      if (!left.aborted) setFailures((count) => count + 1);
    } finally {
      if (!left.aborted) setGoing(false);
    }
  }

  return (
    <Notice
      title={t`Session complete`}
      description={
        <>
          <SessionRecap session={session} />
          {nextStep && <p className="mt-2">{nextStep}</p>}
        </>
      }
    >
      {failures > 0 && (
        <Alert key={failures} variant="destructive">
          <AlertDescription>
            <Trans>Could not load the next question. Try again.</Trans>
          </AlertDescription>
        </Alert>
      )}
      {/* Full width, as Continue: the next step under the thumb. Offered only
          where a question waits (or it is unknown): never a step to a stop.
          aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
      {canKeepGoing && (
        <Button size="lg" className="w-full" aria-disabled={going} onClick={() => void keepGoing()}>
          {going ? t`Loading…` : t`Keep going`}
        </Button>
      )}
      <Button asChild size="lg" variant={canKeepGoing ? "outline" : "default"} className="w-full">
        <Link to="/">
          <Trans>Done</Trans>
        </Link>
      </Button>
      {/* After the next step: its list may run long, never pushing the step away. */}
      {report && <StandingMeter report={report} action={objectiveAction} />}
    </Notice>
  );
}

/** What a session did, as this page saw it: how many of its answers were right. */
export function SessionRecap({ session }: { session: PracticeSession }) {
  const { t } = useLingui();
  const { answers, right } = session;
  return <p>{t`${right} of ${answers} right.`}</p>;
}
