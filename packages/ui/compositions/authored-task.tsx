// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { Badge } from "#components/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "#components/card";

import { MutedText } from "./muted-text.tsx";

/**
 * A choice task as written, for reviewing rather than answering: options in
 * their order, the correct one marked in words. `action` is what the reviewer
 * can do with it (retire it, say); `children` the passages it was written
 * from, as `SourcePassage`s.
 */
export function AuthoredTask(props: {
  prompt: string;
  options: readonly string[];
  /** Index into `options` of the correct one. */
  answer: number;
  explanation?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { prompt, options, answer, explanation, action, children } = props;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{prompt}</CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex list-[upper-alpha] flex-col gap-1 pl-6">
          {options.map((option, index) => (
            // Options are fixed once written, so their place is their identity.
            <li key={index}>
              {option} {index === answer && <Badge variant="secondary">Correct answer</Badge>}
            </li>
          ))}
        </ol>
        {explanation && <MutedText>{explanation}</MutedText>}
        {children}
      </CardContent>
    </Card>
  );
}
