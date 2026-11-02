// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LearnerProgressSummary } from "@braivo/server/client";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
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
          <SessionRecap session={session} report={report} />
          {nextReview && <p className="mt-2">{nextReview}</p>}
        </>
      }
    >
      {report && <StandingMeter report={report} />}
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
    </Notice>
  );
}

/**
 * What a session did: how many of its answers were right, and the objectives
 * it brought to retained, from not started or learning as it began; a review
 * kept retained is not news. Without both standings, the score alone.
 */
export function SessionRecap({
  session,
  report,
}: {
  session: Session;
  report: LearnerProgressSummary | undefined;
}) {
  const { t, i18n } = useLingui();
  const before = new Map(session.start?.objectives.map((each) => [each.objectiveId, each]));
  const newlyRetained = (report?.objectives ?? []).filter((now) => {
    const then = before.get(now.objectiveId);
    if (!then || labelOf(now) !== "retained") return false;
    const was = labelOf(then);
    return was === "notStarted" || was === "learning";
  });
  const titles = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
    newlyRetained.map(({ title }) => title),
  );
  const { answers, right } = session;
  return (
    <>
      <p>{t`${right} of ${answers} right.`}</p>
      {newlyRetained.length > 0 && (
        <p className="mt-2">
          {t({
            message: `Newly retained: ${titles}.`,
            comment: "Objectives this session moved to retained, joined as a list",
          })}
        </p>
      )}
    </>
  );
}
