// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ObjectiveReview } from "@braivo/server/client";
import { Heading, SourcePassage } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { type Ref, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { READ_DEADLINE_MS, withDeadline } from "#lib/deadline";

/** A label too long for one line, as enlarged text or Polish makes it at 320px, wraps. */
const WRAPS = "h-auto py-2 whitespace-normal wrap-anywhere";

/**
 * Review this topic, under a miss's feedback or on the resting screen (ADR
 * 0054): `aria-disabled`, not `disabled`, so that it keeps the focus.
 * `reviewing` toggles the review, and the focus comes back here when it closes.
 */
export function useReviewing() {
  const [reviewing, setReviewing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  // Back to practice: the focus returns to the button that opened it, before paint (docs/apps.md).
  useLayoutEffect(() => {
    if (opened.current && !reviewing) button.current?.focus();
    opened.current = reviewing;
  }, [reviewing]);
  return { reviewing, open: () => setReviewing(true), close: () => setReviewing(false), button };
}

export function ReviewButton({
  disabled = false,
  onClick,
  ref,
  variant = "ghost",
}: {
  disabled?: boolean;
  onClick: () => void;
  ref: Ref<HTMLButtonElement>;
  /** `ghost` under feedback, as Show answer; `outline` in a notice, as its other actions. */
  variant?: "ghost" | "outline";
}) {
  return (
    <Button
      ref={ref}
      variant={variant}
      className={cn(
        WRAPS,
        // A ghost's text, not its padding, in line with the question's (docs/apps.md).
        variant === "ghost" && "-ms-3 self-start text-start",
      )}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
    >
      <Trans>Review this topic</Trans>
    </Button>
  );
}

/**
 * An objective's passages, read when opened, in place of the practice it was
 * opened from, which stays as it was for Back to practice. Reading it records
 * nothing; `onShown` runs once passages show, so a failed or empty read marks
 * nothing (ADR 0054).
 */
export function ReviewTopic({
  title,
  read,
  onShown,
  onBack,
}: {
  /** The objective's, as the page already names it. */
  title: string;
  read: (signal: AbortSignal) => Promise<ObjectiveReview | undefined>;
  onShown: () => void;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const [review, setReview] = useState<ObjectiveReview | "loading" | "failed">("loading");
  const headingId = useId();
  const passagesId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), []);
  // Passages arriving push Back down: a learner who tabbed to it keeps seeing it.
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (document.activeElement === back.current) back.current?.scrollIntoView({ block: "nearest" });
  }, [review]);

  // Read once, as opened: the props' functions are new on every render.
  const [opened] = useState(() => ({ read, onShown }));
  useEffect(() => {
    const left = new AbortController();
    opened
      .read(withDeadline(left.signal, READ_DEADLINE_MS))
      .then((found) => {
        if (left.signal.aborted) return;
        setReview(found ?? "failed");
        if (found) opened.onShown();
      })
      .catch(() => !left.signal.aborted && setReview("failed"));
    return () => left.abort();
  }, [opened]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-6">
      <Heading level={2} id={headingId} ref={heading} tabIndex={-1} className="mb-0">
        {t`Review: ${title}`}
      </Heading>
      {/* Mounted from the start, its text changing, so it is announced (docs/apps.md);
          unseen once read, where it would only add a gap. */}
      <p
        role="status"
        className={review === "loading" ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {review === "loading" ? t`Loading…` : ""}
      </p>
      {review === "failed" && (
        <Alert variant="destructive">
          <AlertDescription>
            <Trans>This couldn't be loaded.</Trans>
          </AlertDescription>
        </Alert>
      )}
      {typeof review === "object" && (
        <section aria-labelledby={passagesId} className="flex flex-col gap-3">
          <Heading level={3} id={passagesId}>
            <Trans>From your lessons</Trans>
          </Heading>
          {review.passages.map((passage, index) => (
            <SourcePassage
              // Stable for this read: nothing reorders them.
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
      <Button ref={back} size="lg" className={WRAPS} onClick={onBack}>
        <Trans>Back to practice</Trans>
      </Button>
    </section>
  );
}
