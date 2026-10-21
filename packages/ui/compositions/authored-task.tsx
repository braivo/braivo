// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { Badge } from "#components/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "#components/card";

import { MutedText } from "./muted-text.tsx";

/**
 * A task as written, for reviewing rather than answering: a choice task's
 * options in their order, the correct one marked in words; a typed task's
 * accepted answers, the one a learner who missed is shown marked. `status`
 * says where it stands (pending review, say); `action` is what the
 * reviewer can do with it (retire it, say); `notice` what came of that, first
 * under the row, not beside `action`, where it squeezes the prompt; `children`
 * the passages it was written from, as `SourcePassage`s.
 */
export function AuthoredTask(props: {
  task:
    | {
        kind: "choice";
        prompt: string;
        options: readonly string[];
        /** Index into `options` of the correct one. */
        answer: number;
        explanation?: string;
      }
    | { kind: "typed"; prompt: string; accepted: readonly string[]; explanation?: string };
  status?: ReactNode;
  action?: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
}) {
  const { task, status, action, notice, children } = props;

  return (
    <Card size="sm" className="@container/task">
      {/* In a narrow card (a phone's), `action` goes under the prompt, which
          keeps the full width, at the end of `status`'s row or the next;
          `status` first, as that row reads. Long words wrap, not clipped. */}
      <CardHeader className="@max-sm/task:flex @max-sm/task:flex-wrap @max-sm/task:items-center">
        <CardTitle className="wrap-anywhere @max-sm/task:basis-full">{task.prompt}</CardTitle>
        {status && <div className="wrap-anywhere">{status}</div>}
        {action && <CardAction className="@max-sm/task:ms-auto">{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notice}
        {task.kind === "choice" ? (
          <ol className="flex list-[upper-alpha] flex-col gap-1 pl-6">
            {task.options.map((option, index) => (
              // Options are fixed once written, so their place is their identity.
              <li key={index}>
                {option}{" "}
                {index === task.answer && <Badge variant="secondary">Correct answer</Badge>}
              </li>
            ))}
          </ol>
        ) : (
          <>
            <MutedText>Typed. Accepted answers:</MutedText>
            <ul className="flex list-disc flex-col gap-1 pl-6">
              {task.accepted.map((answer, index) => (
                <li key={index}>
                  {answer} {index === 0 && <Badge variant="secondary">Shown after a miss</Badge>}
                </li>
              ))}
            </ul>
          </>
        )}
        {task.explanation && <MutedText>{task.explanation}</MutedText>}
        {children}
      </CardContent>
    </Card>
  );
}
