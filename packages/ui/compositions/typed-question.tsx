// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Trans, useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, type Ref, useId, useState } from "react";

import { Button } from "#components/button";
import { Input } from "#components/input";
import { Spinner } from "#components/spinner";
import { cn } from "#lib/utils";

/**
 * A question answered by typing. Presentation only, as `ChoiceQuestion` is:
 * what an answer does is the caller's, and so are `sent` and `outcome`. The
 * caller says the outcome in words: here a success only colours the field, and
 * a failure labels the text as the learner's, apart from the answer it names.
 *
 * Enter or Check sends the text, but not while an input method composes, where
 * Enter commits a character, nor while the field is blank: a stray Enter would
 * rest the task as a miss. Autocorrect, autocapitalize, and spellcheck are off,
 * or the keyboard would answer for the learner.
 *
 * Locked with `readOnly` and `aria-disabled`, not `disabled`, so focus stays;
 * showing `sent`, or nothing when locked without it, since what was typed was
 * not sent.
 */
export function TypedQuestion(props: {
  prompt: string;
  /** The text sent, from the moment it is sent. */
  sent?: string;
  /** The grade's outcome, once graded. */
  outcome?: "success" | "failure";
  /** Whether the text is on its way. */
  pending?: boolean;
  /** Locks the field without a text, as when the learner asked to be shown the answer. */
  locked?: boolean;
  onSubmit: (text: string) => void;
  ref?: Ref<HTMLInputElement>;
  /** Context read after the prompt when the field takes focus. */
  "aria-describedby"?: string;
}) {
  const { prompt, sent, outcome, pending, onSubmit, ref } = props;
  const describedBy = props["aria-describedby"];
  const { t } = useLingui();
  const promptId = useId();
  const [text, setText] = useState("");
  const locked = props.locked || sent !== undefined || outcome !== undefined;
  const blank = text.trim() === "";

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 229: what Safari reports while composing, where `isComposing` can be false.
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && !blank) onSubmit(text);
      }}
      className="flex flex-col gap-4"
    >
      <p id={promptId} className="font-heading text-lg font-semibold text-pretty wrap-break-word">
        {prompt}
      </p>
      <div className="flex gap-2">
        <Input
          ref={ref}
          value={sent ?? (props.locked ? "" : text)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={locked}
          aria-disabled={locked}
          aria-labelledby={promptId}
          aria-describedby={describedBy}
          aria-invalid={(sent !== undefined && outcome === "failure") || undefined}
          placeholder={t`Type the answer`}
          maxLength={500}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          className={cn(
            "h-11 text-base",
            sent !== undefined && outcome === "success" && "border-primary bg-primary/10",
          )}
        />
        <Button
          type="submit"
          size="lg"
          // Out of the tab order while there is nothing to send; once sent, kept for the focus.
          disabled={blank && !locked}
          aria-disabled={locked}
          className="h-11 shrink-0"
        >
          {pending ? <Spinner aria-label={t`Loading`} /> : <Trans>Check</Trans>}
        </Button>
      </div>
      {outcome === "failure" && sent !== undefined && (
        <p className="text-xs font-semibold text-destructive">
          <Trans>Your answer</Trans>
        </p>
      )}
    </form>
  );
}
