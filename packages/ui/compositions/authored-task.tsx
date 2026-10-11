// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { Badge } from "#components/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "#components/card";

import { MutedText } from "./muted-text.tsx";

/**
 * A task as written, for reviewing rather than answering: a choice task's
 * options in their order, the correct one marked in words; a typed task's
 * accepted answers, the one a learner who missed is shown marked. `action` is
 * what the reviewer can do with it (retire it, say); `children` the passages
 * it was written from, as `SourcePassage`s.
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
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { task, action, children } = props;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{task.prompt}</CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
