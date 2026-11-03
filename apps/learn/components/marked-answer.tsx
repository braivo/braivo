// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { missedCharacters } from "#lib/missed-characters";

/**
 * The correct answer, the characters a missed typed answer lacked marked, in
 * weight and underline, not colour alone. Read whole by a screen reader: a
 * mark around single letters would be read letter by letter.
 */
export function MarkedAnswer({ answer, typed }: { answer: string; typed: string | undefined }) {
  const marks = typed === undefined ? undefined : missedCharacters(answer, typed);
  if (!marks?.some(({ missed }) => missed)) return answer;
  return (
    <>
      <span className="sr-only">{answer}</span>
      <span aria-hidden="true">
        {marks.map(({ text, missed }, index) =>
          missed ? (
            <mark
              key={index}
              className="bg-transparent font-semibold text-inherit underline decoration-2 underline-offset-2"
            >
              {text}
            </mark>
          ) : (
            text
          ),
        )}
      </span>
    </>
  );
}
