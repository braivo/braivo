// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";

import { Notice } from "#components/notice";

// Practice on an objective the learner chose (docs/adr/0058-learner-chosen-objective.md,
// learner-loop-28): choosing it, saying which, and the way back to the model's
// choice. The course page owns what is read and when; these only show it.

/**
 * Practise one objective, chosen from where the learner stands (ADR 0058):
 * named for it, as each objective has one.
 */
export function PractiseLink({
  objectiveId,
  title,
  onClick,
  inPlace,
}: {
  objectiveId: string;
  title: string;
  onClick: () => void;
  /** The objective already chosen: read in place (`start`), the address unchanged. */
  inPlace?: { start: () => void; starting: boolean };
}) {
  const { t } = useLingui();
  // Its page loading: said on the link, as Continue says it, until it shows.
  const navigating = useRouterState({
    select: (state) =>
      state.status === "pending" &&
      (state.location.search as { objective?: string }).objective === objectiveId,
  });
  const loading = inPlace ? inPlace.starting : navigating;
  return (
    <Button asChild variant="outline" size="sm" className="shrink-0">
      <Link
        from="/c/$courseRef"
        to="."
        search={{ objective: objectiveId }}
        aria-label={loading ? undefined : t`Practise ${title}`}
        aria-disabled={loading}
        onClick={(event) => {
          if (loading || inPlace) event.preventDefault();
          if (loading) return;
          if (inPlace) inPlace.start();
          else onClick();
        }}
      >
        {loading ? <Trans>Loading…</Trans> : <Trans>Practise</Trans>}
      </Link>
    </Button>
  );
}

/**
 * Back to the model's choice, from practice on one the learner chose: drops
 * the objective from the address, reading what is recommended afresh.
 */
export function BackToRecommended({
  onClick,
  className,
  size,
  autoFocus,
  describedBy,
}: {
  onClick: () => void;
  className?: string;
  /** `lg`, the foot's main action; otherwise text, its edges the text's own. */
  size?: "lg";
  autoFocus?: boolean;
  /** What the page says beyond the verdict, read as the focus lands. */
  describedBy?: string;
}) {
  // A link, which React's `autoFocus` skips (`useFocusOnMount`).
  const link = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) link.current?.focus();
  }, [autoFocus]);
  return (
    <Button
      asChild
      size={size}
      variant={size === "lg" ? "default" : "link"}
      // A text link at a content edge: no inline padding, so it lines up there.
      className={cn(size !== "lg" && "h-auto px-0 py-2", className)}
    >
      <Link
        ref={link}
        from="/c/$courseRef"
        to="."
        search={{}}
        onClick={onClick}
        aria-describedby={describedBy}
      >
        <Trans>Back to recommended</Trans>
      </Link>
    </Button>
  );
}

/**
 * While practising an objective the learner chose, where no question names it
 * (a rest, the day's limit, nothing due): which, and, unless what shows offers
 * it (`showBack` false), the way back to the model's choice. `title` unknown,
 * the line says only that one was chosen.
 */
export function ChosenObjective({
  title,
  showBack,
  onBack,
}: {
  title: string | undefined;
  showBack: boolean;
  onBack: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-2">
      <MutedText className="wrap-anywhere">
        {title === undefined ? t`Practising a topic you chose` : t`Practising ${title}`}
      </MutedText>
      {showBack && <BackToRecommended className="shrink-0" onClick={onBack} />}
    </div>
  );
}

/**
 * Practice on a chosen objective reached one needing no attention: said, the
 * extra question it could ask waiting for the learner to ask (ADR 0058), never
 * asked by itself.
 */
export function NothingDue({
  objectiveTitle,
  onExtra,
  onBack,
}: {
  objectiveTitle: string;
  onExtra: () => void;
  onBack: () => void;
}) {
  const { t } = useLingui();
  return (
    <Notice
      title={t`Nothing is due on ${objectiveTitle} right now`}
      description={t`You can answer an extra question on it, or go back to what's recommended.`}
    >
      <BackToRecommended size="lg" className="w-full" onClick={onBack} />
      <Button size="lg" variant="outline" className="w-full" onClick={onExtra}>
        <Trans>Extra practice</Trans>
      </Button>
    </Notice>
  );
}
