// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { useId } from "react";

import { Button } from "#components/button";
import { Spinner } from "#components/spinner";
import { cn } from "#lib/utils";

/**
 * A question with one correct option. Choosing an option answers it: one tap,
 * no separate submit. Presentation only — what a choice does is the caller's,
 * and so are `chosen` and `correctChoice`, which describe the caller's attempt.
 *
 * Options are shown in the order given and identified by `choice`, never by
 * position, so a shuffled order cannot be mistaken for the answer key's.
 * `chosen` and `correctChoice` are choices too.
 *
 * Once `chosen` or `correctChoice` is set the options lock. The chosen option shows a
 * spinner while `pending`, and is marked as the learner's answer otherwise, such
 * as when it could not be confirmed. Once `correctChoice` is set, the correct option
 * and a wrong choice are marked in words as well as colour.
 *
 * Locked with `aria-disabled` rather than `disabled`: a disabled button drops
 * focus, which would leave a keyboard learner nowhere while the answer is on
 * its way.
 */
export function ChoiceQuestion(props: {
  prompt: string;
  options: readonly { choice: number; text: string }[];
  /** The picked option's `choice`, from the moment they pick it. */
  chosen?: number;
  /** The correct option's `choice`, once graded. */
  correctChoice?: number;
  /** Whether the chosen option is on its way. */
  pending?: boolean;
  onChoose: (choice: number) => void;
}) {
  const { prompt, options, chosen, correctChoice, pending, onChoose } = props;
  const promptId = useId();
  const graded = correctChoice !== undefined;
  const locked = graded || chosen !== undefined;

  return (
    <div role="group" aria-labelledby={promptId} className="flex flex-col gap-4">
      <p id={promptId} className="font-heading text-lg font-semibold text-pretty">
        {prompt}
      </p>
      <div className="flex flex-col gap-2">
        {options.map(({ choice, text }) => {
          const correct = graded && choice === correctChoice;
          const wrong = graded && choice === chosen && choice !== correctChoice;
          const ungraded = !graded && choice === chosen;
          return (
            <Button
              key={choice}
              variant="outline"
              aria-disabled={locked}
              onClick={() => !locked && onChoose(choice)}
              className={cn(
                "h-auto justify-between py-3 text-left whitespace-normal aria-disabled:pointer-events-none",
                correct && "border-primary bg-primary/10",
                wrong && "border-destructive bg-destructive/10",
              )}
            >
              <span>{text}</span>
              {correct && <span className="text-xs font-semibold text-primary">Correct</span>}
              {wrong && <span className="text-xs font-semibold text-destructive">Your answer</span>}
              {ungraded &&
                (pending ? (
                  <Spinner />
                ) : (
                  <span className="text-xs font-semibold">Your answer</span>
                ))}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
