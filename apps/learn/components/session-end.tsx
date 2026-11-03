// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LearnerProgressSummary } from "@braivo/server/client";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Notice } from "#components/notice";
import { StandingMeter, labelOf } from "#components/standing";

/**
 * Answers in a session, after which practice pauses at its end. Short enough
 * for a break on a phone, long enough for a few objectives to move; a
 * constant until learners' sessions say otherwise.
 */
export const SESSION_LENGTH = 10;

/** A session's answers so far, and where the learner stood before its first. */
export type Session = {
  answers: number;
  right: number;
  /** Unread, or read too late: the end says nothing of what changed. */
  start?: LearnerProgressSummary;
};

/**
 * The end of a session: its recap (`SessionRecap`), when the next review falls
 * due (`nextReview`, in words), and where the learner stands (`report`, read by
 * the Continue that ended it; left out if unread, the score still said), then
 * Keep going or Done. Whole as it
 * mounts, so the focus landing on it reads all of it. Keep going reads what
 * comes next as Continue does (`onKeepGoing`), staying here, saying so, if that fails.
 */
export function SessionEnd({
  session,
  report,
  nextReview,
  onKeepGoing,
}: {
  session: Session;
  report: LearnerProgressSummary | undefined;
  nextReview: string | undefined;
  onKeepGoing: (left: AbortSignal) => Promise<{ failed: boolean }>;
}) {
  const { t } = useLingui();
  const retained = newlyRetained(session, report);
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
          <SessionRecap session={session} retained={retained.size} />
          {nextReview && <p className="mt-2">{nextReview}</p>}
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
      {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
      {/* Full width, as Continue: the next step under the thumb. */}
      <Button size="lg" className="w-full" aria-disabled={going} onClick={() => void keepGoing()}>
        {going ? t`Loading…` : t`Keep going`}
      </Button>
      <Button asChild size="lg" variant="outline" className="w-full">
        <Link to="/">
          <Trans>Done</Trans>
        </Link>
      </Button>
      {/* After the next step: its list may run long, never pushing the step away. */}
      {report && <StandingMeter report={report} newlyRetained={retained} />}
    </Notice>
  );
}

/**
 * The objectives a session brought to retained, by ID: from not started or
 * learning as it began; a review kept retained is not news. None without both
 * standings.
 */
export function newlyRetained(
  session: Session,
  report: LearnerProgressSummary | undefined,
): Set<string> {
  const before = new Map(session.start?.objectives.map((each) => [each.objectiveId, each]));
  return new Set(
    (report?.objectives ?? [])
      .filter((now) => {
        const then = before.get(now.objectiveId);
        if (!then || labelOf(now) !== "retained") return false;
        const was = labelOf(then);
        return was === "notStarted" || was === "learning";
      })
      .map(({ objectiveId }) => objectiveId),
  );
}

/**
 * What a session did, in a line or two however many objectives moved: how
 * many of its answers were right, and how many objectives it newly retained.
 * Which ones, the standing's list says (`StandingMeter`'s `newlyRetained`),
 * below the next step rather than before it.
 */
export function SessionRecap({ session, retained }: { session: Session; retained: number }) {
  const { t } = useLingui();
  const { answers, right } = session;
  return (
    <>
      <p>{t`${right} of ${answers} right.`}</p>
      {retained > 0 && (
        <p className="mt-2">
          {t({
            message: plural(retained, { one: "# newly retained.", other: "# newly retained." }),
            comment:
              "A count of objectives a session moved to retained, the noun implied (Polish: temat)",
          })}
        </p>
      )}
    </>
  );
}
