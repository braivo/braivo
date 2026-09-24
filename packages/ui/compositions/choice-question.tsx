// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type KeyboardEvent, type Ref, useId } from "react";

import { Button } from "#components/button";
import { Kbd } from "#components/kbd";
import { Spinner } from "#components/spinner";
import { cn } from "#lib/utils";

/**
 * A question with one correct option. Choosing an option answers it: one tap,
 * no separate submit. Presentation only — what a choice does is the caller's,
 * and so are `chosen` and `correctChoice`, which describe its state.
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
 *
 * Until then, keys 1 to 9 choose the option shown in that place, but only while
 * focus is within the question, so a stray digit from elsewhere on the page, or
 * from speech input, answers nothing (WCAG 2.1.4). `ref` is the question itself,
 * for a caller to move focus to.
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
  ref?: Ref<HTMLDivElement>;
}) {
  const { prompt, options, chosen, correctChoice, pending, onChoose, ref } = props;
  const promptId = useId();
  const graded = correctChoice !== undefined;
  const locked = graded || chosen !== undefined;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (locked || event.repeat) return;
    // Shift too: on some layouts, AZERTY among them, it is what types a digit.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const option = /^[1-9]$/.test(event.key) ? options[Number(event.key) - 1] : undefined;
    if (option === undefined) return;
    event.preventDefault();
    onChoose(option.choice);
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={promptId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4 outline-none"
    >
      <p id={promptId} className="font-heading text-lg font-semibold text-pretty">
        {prompt}
      </p>
      <div className="flex flex-col gap-2">
        {options.map(({ choice, text }, place) => {
          const correct = graded && choice === correctChoice;
          const wrong = graded && choice === chosen && choice !== correctChoice;
          const ungraded = !graded && choice === chosen;
          return (
            <Button
              key={choice}
              variant="outline"
              aria-disabled={locked}
              aria-keyshortcuts={place < 9 ? String(place + 1) : undefined}
              onClick={() => !locked && onChoose(choice)}
              className={cn(
                "h-auto justify-between py-3 text-left whitespace-normal aria-disabled:pointer-events-none",
                correct && "border-primary bg-primary/10",
                wrong && "border-destructive bg-destructive/10",
              )}
            >
              <span className="flex items-center gap-3">
                {/* Hidden from the accessible name, which `aria-keyshortcuts` covers. */}
                {place < 9 && !locked && <Kbd aria-hidden>{place + 1}</Kbd>}
                {text}
              </span>
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
