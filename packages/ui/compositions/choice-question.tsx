// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { useId } from "react";

import { Button } from "#components/button";
import { Spinner } from "#components/spinner";
import { cn } from "#lib/utils";

/**
 * A question with one correct option. Choosing an option answers it: one tap,
 * no separate submit. Presentation only — what a choice does is the caller's,
 * and so are `chosen` and `answer`, which describe the caller's attempt.
 *
 * Once `chosen` or `answer` is set the options lock. Once `answer` is set, the
 * correct option and a wrong choice are marked in words as well as colour.
 *
 * Locked with `aria-disabled` rather than `disabled`: a disabled button drops
 * focus, which would leave a keyboard learner nowhere if the answer fails to
 * send and the options unlock again.
 */
export function ChoiceQuestion(props: {
  prompt: string;
  options: readonly string[];
  /** The option the learner picked, from the moment they pick it. */
  chosen?: number;
  /** The correct option, once graded. */
  answer?: number;
  onChoose: (index: number) => void;
}) {
  const { prompt, options, chosen, answer, onChoose } = props;
  const promptId = useId();
  const graded = answer !== undefined;
  const locked = graded || chosen !== undefined;

  return (
    <div role="group" aria-labelledby={promptId} className="flex flex-col gap-4">
      <p id={promptId} className="font-heading text-lg font-semibold text-pretty">
        {prompt}
      </p>
      <div className="flex flex-col gap-2">
        {options.map((option, index) => {
          const correct = graded && index === answer;
          const wrong = graded && index === chosen && index !== answer;
          return (
            <Button
              key={option}
              variant="outline"
              aria-disabled={locked}
              onClick={() => !locked && onChoose(index)}
              className={cn(
                "h-auto justify-between py-3 text-left whitespace-normal aria-disabled:pointer-events-none",
                correct && "border-primary bg-primary/10",
                wrong && "border-destructive bg-destructive/10",
              )}
            >
              <span>{option}</span>
              {correct && <span className="text-xs font-semibold text-primary">Correct</span>}
              {wrong && <span className="text-xs font-semibold text-destructive">Your answer</span>}
              {!graded && index === chosen && <Spinner />}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
