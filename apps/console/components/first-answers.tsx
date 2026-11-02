// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How learners first answered each published task (progress-18), for whoever
 * administers the organization, as learners' reports are: read beside a
 * page's own data, never holding it back, and said under each task as counts,
 * never as a verdict or a cause. An author reads none (`readFirstAnswers`
 * answers nothing to them).
 */

import type { BraivoClient, FirstAnswersSummary, Organization } from "@braivo/server/client";
import { MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

import { Disclosure } from "#components/disclosure";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { useSettled } from "#lib/settled";

/** A read's answer, or that it failed: a failure never fails the page. */
type FirstAnswersRead = FirstAnswersSummary | "failed";
type FirstAnswerCounts = NonNullable<FirstAnswersSummary["tasks"][number]["first"]>;
type OtherTasksCounts = NonNullable<FirstAnswersSummary["tasks"][number]["otherTasks"]>;

/**
 * A course's or an objective's first answers, for a page's loader to return
 * unawaited; `undefined` to someone who does not administer it, who reads none.
 */
export function readFirstAnswers(
  braivo: BraivoClient,
  organization: Organization,
  scope: { courseId: string } | { objectiveId: string },
  signal: AbortSignal,
): Promise<FirstAnswersRead> | undefined {
  if (!organization.administers) return undefined;
  return braivo
    .readFirstAnswers(
      { organizationId: organization.id, ...scope },
      { signal: withDeadline(signal, REQUEST_DEADLINE_MS) },
    )
    .catch((): FirstAnswersRead => "failed");
}

const FirstAnswersContext = createContext<FirstAnswersSummary | undefined>(undefined);

/** The page's read, once it has answered, for `FirstAnswers` and its other readers. */
export function useFirstAnswers(): FirstAnswersSummary | undefined {
  return useContext(FirstAnswersContext);
}

/**
 * The page's first answers, for each `FirstAnswers` beneath: the page renders
 * whole meanwhile, and a failed read says so once, above; so does how they
 * are counted, once there is a count to read.
 */
export function FirstAnswersProvider(props: {
  firstAnswers: Promise<FirstAnswersRead> | undefined;
  children: ReactNode;
}) {
  const read = useSettled(props.firstAnswers);
  const summary = read === undefined || read === "failed" ? undefined : read;
  const counted =
    summary !== undefined &&
    [...summary.tasks, ...summary.retired].some(({ first }) => first !== null);
  return (
    <FirstAnswersContext.Provider value={summary}>
      {read === "failed" && <FailedRead />}
      {counted && <HowCounted />}
      {props.children}
    </FirstAnswersContext.Provider>
  );
}

function FailedRead() {
  const router = useRouter();
  const { t } = useLingui();
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertDescription>
        {t`Learners' first answers could not be loaded.`}{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => router.invalidate()}>
          {t`Try again`}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Once per page: what the numbers are, and what they are not. */
function HowCounted() {
  const { t } = useLingui();
  return (
    <Disclosure
      className="mb-4 text-sm text-muted-foreground"
      summary={<span>{t`How first answers are counted`}</span>}
    >
      <p className="mt-2 ps-5">
        {t`Each current member's first answer to each question counts, given in any course of this organization. Learners don't meet every question at the same point, so the numbers aren't directly comparable. Use them to choose what to review.`}
      </p>
    </Disclosure>
  );
}

/** "2 correct, 8 incorrect, 1 asked to see the answer", in the reader's language. */
function useOutcomes() {
  const { t } = useLingui();
  return ({
    correct,
    incorrect,
    revealed,
  }: Pick<FirstAnswerCounts, "correct" | "incorrect" | "revealed">) =>
    t({
      comment: "Counts of first answers: correct, then incorrect, then Show answer",
      message: `${plural(correct, { one: "# correct", other: "# correct" })}, ${plural(incorrect, {
        one: "# incorrect",
        other: "# incorrect",
      })}, ${plural(revealed, {
        one: "# asked to see the answer",
        other: "# asked to see the answer",
      })}`,
    });
}

/**
 * A published task's first answers, under it: counted, a choice task's by
 * option too, with the objective's other tasks beside; under the floor, that
 * there are not enough yet. Nothing where the page reads none.
 */
export function FirstAnswers(props: { taskId: string }) {
  const summary = useFirstAnswers();
  const task = summary?.tasks.find(({ id }) => id === props.taskId);
  if (summary === undefined || task === undefined) return null;
  return (
    <FirstAnswerLines
      first={task.first}
      otherTasks={task.otherTasks}
      minLearners={summary.minLearners}
    />
  );
}

/** The lines themselves, for a task listed or retired. */
export function FirstAnswerLines(props: {
  first: FirstAnswerCounts | null;
  otherTasks?: OtherTasksCounts | null;
  minLearners: number;
}) {
  const { first, otherTasks, minLearners } = props;
  const { t } = useLingui();
  const outcomes = useOutcomes();
  if (first === null) {
    return (
      <MutedText>
        {t({
          message: plural(minLearners, {
            one: "Not enough answers yet (fewer than # learner).",
            other: "Not enough answers yet (fewer than # learners).",
          }),
        })}
      </MutedText>
    );
  }

  const { learners } = first;
  const counted = outcomes(first);
  const otherCounted = otherTasks && outcomes(otherTasks);
  const otherResponses = otherTasks?.responses ?? 0;
  const otherLearners = otherTasks?.learners ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <MutedText className="wrap-break-word">
        {t({
          comment:
            "{counted}: counts of first answers, as “2 correct, 8 incorrect, 1 asked to see the answer”",
          message: `${plural(learners, {
            one: "First answers from # learner",
            other: "First answers from # learners",
          })}: ${counted}.`,
        })}
      </MutedText>
      {first.options && (
        // Lettered as the options above are, counts wrapping between each.
        <MutedText className="wrap-break-word">
          {t`Chosen first:`}{" "}
          {first.options.map((count, index) => (
            <span key={index} className="whitespace-nowrap">
              {index > 0 && <span aria-hidden="true">{" · "}</span>}
              {`${String.fromCharCode(65 + index)}: ${count}`}
              {index < first.options!.length - 1 && <span className="sr-only">,</span>}
            </span>
          ))}
        </MutedText>
      )}
      {otherTasks && (
        <MutedText className="wrap-break-word">
          {t({
            comment:
              "{otherCounted}: counts of first answers to the objective's other questions, as above; then how many first answers in all, from how many learners",
            message: `The objective's other questions: ${otherCounted}, ${plural(otherResponses, {
              one: "of # first answer",
              other: "of # first answers",
            })} ${plural(otherLearners, { one: "from # learner", other: "from # learners" })}.`,
          })}
        </MutedText>
      )}
    </div>
  );
}
