// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a learner may run into with a task as written (`taskFindings`), said
 * under its answers, worded here from each finding's code and text. Advisory:
 * nothing is dismissed or blocked. Each line says what is true of the task as
 * written, never that an answer is the only one accepted, since others may be
 * listed, and grading forgives case and spacing.
 */

import type { Finding } from "@braivo/server/client";
import { Button } from "@braivo/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { TriangleAlertIcon } from "lucide-react";

/** Whether a task has something a learner may run into, as written. */
export const hasFindings = (task: { findings?: readonly Finding[] }) =>
  (task.findings?.length ?? 0) > 0;

/** The answer a typed task's finding suggests adding, if any: its first. */
function suggestedAnswer(findings: readonly Finding[] | undefined): string | undefined {
  for (const finding of findings ?? []) {
    if (finding.code === "typed-trailing-punctuation" && finding.suggestion !== undefined) {
      return finding.suggestion;
    }
  }
}

/** The DOM ID of a task's findings, focused by Review them. */
export const findingsId = (taskId: string) => `findings-${taskId}`;

/**
 * A task's findings, a line each, with `onAdd`'s button when one suggests an
 * answer: it opens the task's editor with that answer added, for the person to
 * review and save. `label` names that button for assistive technology, naming
 * the task, as its Edit button is named.
 */
export function FindingLines(props: {
  taskId: string;
  findings: readonly Finding[] | undefined;
  onAdd?: { label: (answer: string) => string; disabled: boolean; add: (answer: string) => void };
}) {
  const { taskId, findings, onAdd } = props;
  const { t } = useLingui();
  if (!findings?.length) return null;
  const suggestion = suggestedAnswer(findings);

  return (
    // Focusable, to receive focus from the Publish confirmation's Review them.
    <div
      id={findingsId(taskId)}
      tabIndex={-1}
      className="flex flex-col items-start gap-2 rounded-md outline-offset-2"
    >
      <ul className="flex flex-col gap-1 text-sm">
        {findings.map((finding, index) => (
          // By index: fixed for this task's text, and two may read alike.
          <li key={index} className="flex gap-2">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span className="min-w-0 wrap-break-word">
              <FindingText finding={finding} />
            </span>
          </li>
        ))}
      </ul>
      {onAdd && suggestion !== undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-8 py-1 whitespace-normal wrap-anywhere"
          aria-label={onAdd.label(suggestion)}
          disabled={onAdd.disabled}
          onClick={() => onAdd.add(suggestion)}
        >
          {t`Edit and add “${suggestion}”`}
        </Button>
      )}
    </div>
  );
}

/** One finding's line, in the language the console speaks. */
function FindingText({ finding }: { finding: Finding }) {
  const { t, i18n } = useLingui();
  switch (finding.code) {
    case "typed-trailing-punctuation": {
      const { answer, suggestion } = finding;
      return suggestion === undefined
        ? t`“${answer}” is accepted only with its final mark: a learner who leaves it out is marked wrong. Check whether that should count too.`
        : t`“${answer}” is accepted, “${suggestion}” is not: a learner who leaves out the final mark is marked wrong. Check whether it should count too.`;
    }
    case "typed-literal-delimiters": {
      const { answer } = finding;
      return t`“${answer}” is matched as written, slash or brackets included: a learner who types one part alone is marked wrong unless it is listed too.`;
    }
    case "choice-correct-alike": {
      const { correct, other } = finding;
      const parts = finding.differences.map((difference) =>
        difference === "case"
          ? t({ message: "case", comment: "Completes “differs from … only in …”" })
          : difference === "quotes"
            ? t({
                message: "quote marks or apostrophes",
                comment: "Completes “differs from … only in …”",
              })
            : t({ message: "a final mark", comment: "Completes “differs from … only in …”" }),
      );
      const differences = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(parts);
      return t`The correct option “${correct}” differs from “${other}” only in ${differences}.`;
    }
  }
}
