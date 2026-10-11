// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "#components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#components/field";
import { Input } from "#components/input";
import { RadioGroup, RadioGroupItem } from "#components/radio-group";
import { Textarea } from "#components/textarea";

/** A task's words and answers: what a reviewer may change of a proposed one. */
export type EditableTask =
  | {
      kind: "choice";
      prompt: string;
      options: readonly string[];
      /** Index into `options` of the correct one. */
      answer: number;
      explanation?: string;
    }
  | {
      kind: "typed";
      prompt: string;
      /** Every answer graded correct, the first shown to a learner who missed. */
      accepted: readonly string[];
      explanation?: string;
      /** Not edited here: saved as it was. */
      answerLanguage?: string;
    };

/** The most a task's question, option, or explanation may hold: the server's limit. */
const MAX_TEXT = 2000;

/** The server's limits on a typed task's accepted answers. */
const MAX_ACCEPTED = 20;
const MAX_ACCEPTED_TEXT = 200;

/**
 * A typed answer as the server compares it (`normalizeAnswer`, `apps/server/content/task.ts`):
 * two answers equal here are one answer listed twice, which it refuses.
 */
function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u02BC]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"');
}

/**
 * Trimmed, each run of spaces, tabs, and line breaks one space, as the server
 * stores a question and its options: "a  b" repeats "a b".
 */
function collapseWhitespace(text: string): string {
  return text.trim().replace(/[\t\n\r ]+/g, " ");
}

/**
 * Edits a proposed task before it is kept: a choice task's options, as many
 * as they were, or a typed task's accepted answers, one a line. Checks what
 * the server would refuse (blank, repeated, overlong, or non-text input)
 * before saving; the server checks again.
 *
 * Not a form: it sits inside one, the review it edits a task of. Its buttons
 * do not submit, and Enter in a field saves the task rather than that form.
 * It takes focus when it opens; giving it back on Save or Cancel is the
 * caller's, which knows where it came from.
 */
export function TaskEditor(props: {
  task: EditableTask;
  onSave: (task: EditableTask) => void;
  onCancel: () => void;
}) {
  const { task, onSave, onCancel } = props;
  const [prompt, setPrompt] = useState(task.prompt);
  const [options, setOptions] = useState<string[]>(task.kind === "choice" ? [...task.options] : []);
  const [answer, setAnswer] = useState(task.kind === "choice" ? task.answer : 0);
  const [accepted, setAccepted] = useState(task.kind === "typed" ? task.accepted.join("\n") : "");
  const [explanation, setExplanation] = useState(task.explanation ?? "");
  const [problem, setProblem] = useState<string>();
  const id = useId();
  const question = useRef<HTMLInputElement>(null);

  // Opened from a button that is now gone: focus continues here, not the page's top.
  useEffect(() => question.current?.focus(), []);

  function save() {
    if (prompt.trim() === "") return setProblem("Write the question.");
    if (task.kind === "typed") return saveTyped(task);
    const collapsed = options.map(collapseWhitespace);
    if (collapsed.some((option) => option === "")) return setProblem("Fill in every option.");
    // Equal in NFC, two options read the same, as the server compares them.
    if (new Set(collapsed.map((option) => option.normalize("NFC"))).size !== collapsed.length)
      return setProblem("Every option must differ.");
    const texts = [prompt, ...options, explanation];
    // `maxLength` stops typing past it, not a value set otherwise.
    if (texts.some((text) => text.trim().length > MAX_TEXT)) {
      return setProblem(`Keep each text to ${MAX_TEXT.toLocaleString("en")} characters.`);
    }
    // The server refuses these too, but only once the review is sent.
    if (texts.some((text) => text.includes("\u0000") || !text.isWellFormed())) {
      return setProblem("Remove the characters that are not text, such as a NUL.");
    }
    onSave({
      kind: "choice",
      prompt: collapseWhitespace(prompt),
      options: collapsed,
      answer,
      ...(explanation.trim() === "" ? {} : { explanation: explanation.trim() }),
    });
  }

  function saveTyped(typed: Extract<EditableTask, { kind: "typed" }>) {
    // Blank lines, blank as the server trims (a no-break space too), are
    // spacing, not answers.
    const answers = accepted
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(collapseWhitespace);
    if (answers.length === 0) return setProblem("Write at least one accepted answer.");
    if (answers.length > MAX_ACCEPTED) {
      return setProblem(`Keep to ${MAX_ACCEPTED} accepted answers.`);
    }
    if (answers.some((text) => text.length > MAX_ACCEPTED_TEXT)) {
      return setProblem(`Keep each answer to ${MAX_ACCEPTED_TEXT} characters.`);
    }
    if (new Set(answers.map(normalizeAnswer)).size !== answers.length) {
      return setProblem(
        "Every answer must differ, case, spacing, and curly or straight quotes aside.",
      );
    }
    // The answers are bounded each, above; together they may pass `MAX_TEXT`.
    if ([prompt, explanation].some((text) => text.trim().length > MAX_TEXT)) {
      return setProblem(`Keep each text to ${MAX_TEXT.toLocaleString("en")} characters.`);
    }
    if (
      [prompt, accepted, explanation].some(
        (text) => text.includes("\u0000") || !text.isWellFormed(),
      )
    ) {
      return setProblem("Remove the characters that are not text, such as a NUL.");
    }
    onSave({
      kind: "typed",
      prompt: collapseWhitespace(prompt),
      accepted: answers,
      ...(explanation.trim() === "" ? {} : { explanation: explanation.trim() }),
      ...(typed.answerLanguage === undefined ? {} : { answerLanguage: typed.answerLanguage }),
    });
  }

  function saveOnEnter(event: KeyboardEvent<HTMLDivElement>) {
    // Not while an input method composes: its Enter confirms the text, not the task.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      save();
    }
  }

  return (
    <div role="group" aria-label="Edit the task" onKeyDown={saveOnEnter}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-prompt`}>Question</FieldLabel>
          <Input
            id={`${id}-prompt`}
            ref={question}
            maxLength={MAX_TEXT}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        {task.kind === "typed" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-accepted`}>Accepted answers, one a line</FieldLabel>
            <Textarea
              id={`${id}-accepted`}
              aria-describedby={`${id}-accepted-description`}
              rows={3}
              value={accepted}
              onChange={(event) => setAccepted(event.target.value)}
            />
            <FieldDescription id={`${id}-accepted-description`}>
              The first is shown to a learner who missed. Case, spacing, and curly versus straight
              quotes do not count; accents and punctuation do, a missing apostrophe included, so
              list each variant to accept.
            </FieldDescription>
          </Field>
        ) : (
          <FieldSet>
            <FieldLegend id={`${id}-options`} variant="label">
              Options, the correct one chosen
            </FieldLegend>
            {/* Named by the legend too: it names the fieldset, not the radio group within. */}
            <RadioGroup
              aria-labelledby={`${id}-options`}
              value={String(answer)}
              onValueChange={(value) => setAnswer(Number(value))}
            >
              {options.map((option, index) => {
                const letter = String.fromCharCode(65 + index);
                return (
                  // Options keep their places while edited, so a place is an identity.
                  <Field key={index} orientation="horizontal">
                    <RadioGroupItem value={String(index)} aria-label={`${letter} is correct`} />
                    <Input
                      aria-label={`Option ${letter}`}
                      maxLength={MAX_TEXT}
                      value={option}
                      onChange={(event) =>
                        setOptions(
                          options.map((old, at) => (at === index ? event.target.value : old)),
                        )
                      }
                    />
                  </Field>
                );
              })}
            </RadioGroup>
          </FieldSet>
        )}
        <Field>
          <FieldLabel htmlFor={`${id}-explanation`}>Why the answer is right</FieldLabel>
          <Textarea
            id={`${id}-explanation`}
            rows={2}
            maxLength={MAX_TEXT}
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
          />
        </Field>
        {problem && <FieldError>{problem}</FieldError>}
        <Field orientation="horizontal">
          <Button type="button" onClick={save}>
            Save
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </div>
  );
}
