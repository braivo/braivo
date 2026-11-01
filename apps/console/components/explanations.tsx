// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tasks that explain nothing after grading (`hasExplanation`), on a course's
 * page and an objective's: counted from the tasks the page already holds, with
 * the definition the course listing's `counts` use, so the two never disagree;
 * marked in words on each; and, on a course's page, the rule narrowing it to
 * them. A count is a review opportunity, never a quality score.
 */

import { type ExplanationCounts, hasExplanation } from "@braivo/server/client";
import { MutedText } from "@braivo/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import type { ReviewTask } from "#components/task-review";

/**
 * What `countExplanations` found, said as fact: "2 of 3 published tasks have
 * no explanation; 1 also cites no passage. 1 task waiting for review has no
 * explanation." Nothing when every task has one, unless `alwaysShown` (the
 * course narrowed to them), then saying so, or that there are no tasks yet.
 * `children` follow it, on its line.
 */
export function ExplanationCount(props: {
  counts: ExplanationCounts;
  alwaysShown?: boolean;
  /** Focusable, to take the focus when the task saved was the last one shown. */
  id?: string;
  children?: ReactNode;
}) {
  const { counts, alwaysShown, id, children } = props;
  const { t } = useLingui();
  const { total, withoutExplanation, withoutExplanationOrPassage } = counts.published;
  const pending = counts.pending.withoutExplanation;
  if (withoutExplanation === 0 && pending === 0 && !alwaysShown) return null;

  const sentences = [];
  if (withoutExplanation > 0) {
    const published = t({
      message: plural(withoutExplanation, {
        one: `# of ${total} published tasks has no explanation`,
        other: `# of ${total} published tasks have no explanation`,
      }),
    });
    sentences.push(
      withoutExplanationOrPassage === 0
        ? t({
            comment: "{published}: how many of the published tasks have no explanation",
            message: `${published}.`,
          })
        : t({
            comment:
              "{published}: how many of the published tasks have no explanation; then how many of those also cite no passage",
            message: `${published}; ${plural(withoutExplanationOrPassage, {
              one: "# also cites no passage",
              other: "# also cite no passage",
            })}.`,
          }),
    );
  }
  if (pending > 0) {
    sentences.push(
      t({
        message: plural(pending, {
          one: "# task waiting for review has no explanation.",
          other: "# tasks waiting for review have no explanation.",
        }),
      }),
    );
  }
  // None to explain is no completion to report.
  if (counts.published.total + counts.pending.total === 0) sentences.push(t`No tasks yet.`);
  else if (sentences.length === 0) sentences.push(t`Every task has an explanation.`);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
      <MutedText id={id} tabIndex={id === undefined ? undefined : -1} className="wrap-break-word">
        {sentences.join(" ")}
      </MutedText>
      {children}
    </div>
  );
}

/** Beside a task without an explanation: in words, not colour alone. */
export function NoExplanation(props: { task: ReviewTask }) {
  const { t } = useLingui();
  return hasExplanation(props.task) ? null : <MutedText>{t`No explanation`}</MutedText>;
}

/**
 * The tasks a course's page shows narrowed to those without an explanation,
 * by ID, out of an objective's `tasks`. Pending: one without, and any
 * correction of a published task without one, explained or not, since that is
 * what a reviewer of the gap must see and Publish sends. Published: one
 * without, unless a correction of it waits, beside which it is shown as
 * published now instead; its own Edit there would retire that correction.
 */
export function explanationReviewIds(tasks: readonly ReviewTask[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const corrected = new Set(tasks.flatMap((task) => task.replaces ?? []));
  return new Set(
    tasks
      .filter((task) => {
        if (task.published) return !hasExplanation(task) && !corrected.has(task.id);
        const original = task.replaces === undefined ? undefined : byId.get(task.replaces);
        return !hasExplanation(task) || (original !== undefined && !hasExplanation(original));
      })
      .map(({ id }) => id),
  );
}

/**
 * Beside Publish, of the tasks selected, how many have no explanation: "1 of
 * the 2 selected tasks has no explanation.", or "The selected task has no
 * explanation." when all lack one. A fact at the moment of deciding,
 * never a dialog or a click; nothing when none lacks one.
 */
export function useExplanationNote(selected: readonly ReviewTask[]): string | undefined {
  const { t } = useLingui();
  const without = selected.filter((task) => !hasExplanation(task)).length;
  const total = selected.length;
  if (without === 0) return undefined;
  // All of them, said so, never "1 of the 1".
  if (without === total) {
    return t({
      message: plural(total, {
        one: "The selected task has no explanation.",
        other: "None of the # selected tasks has an explanation.",
      }),
    });
  }
  return t({
    message: plural(without, {
      one: `# of the ${total} selected tasks has no explanation.`,
      other: `# of the ${total} selected tasks have no explanation.`,
    }),
  });
}
