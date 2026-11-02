// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A character as grading compares it (`normalizeAnswer`, per character):
 * lowercase, NFC, typographic quotes as ASCII, any space one space, and a
 * final sigma as any sigma, which lowercasing a whole word would give.
 */
function graded(character: string): string {
  if (/^\s+$/u.test(character)) return " ";
  return character
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u02BC]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace("ς", "σ");
}

/** Its base letter: the accents a decomposition separates dropped (`ł` has none). */
function base(character: string): string {
  return character.normalize("NFD").replace(/\p{M}/gu, "");
}

/** A base match's weight over an exact one's, so more base matches always win, ties going to exact ones. */
const BASE = 1024;

/**
 * Which of `answer`'s characters (graphemes, so an accent and its letter are
 * one) the learner's `typed` text got wrong: aligned with it on base letters
 * (accents aside) by the longest common subsequence, among those the one
 * with the most exact matches, then marked where unaligned or aligned with
 * another accent (`zolc` for `żółć` marks each letter). Compared as grading
 * compares, so nothing it ignores is marked, nor any space. Undefined unless
 * at least half the answer aligned: a different word would be marked
 * throughout, telling nothing. An extra character typed marks nothing: the
 * answer beside it shows what was meant. Display only, never a grade.
 */
export function missedCharacters(
  answer: string,
  typed: string,
): { text: string; missed: boolean }[] | undefined {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const split = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);
  const want = split(answer).map((text) => ({ text, exact: graded(text) }));
  // Runs of space one space, as grading collapses them.
  const got = split(typed.trim().replace(/\s+/gu, " ")).map(graded);
  const wantBase = want.map(({ exact }) => base(exact));
  const gotBase = got.map(base);
  // score[i][j]: the best alignment of want[i..] and got[j..], BASE per base match plus 1 per exact one.
  const score = Array.from({ length: want.length + 1 }, () =>
    Array.from({ length: got.length + 1 }, () => 0),
  );
  const pair = (i: number, j: number) =>
    wantBase[i] === gotBase[j] ? BASE + (want[i]!.exact === got[j] ? 1 : 0) : 0;
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      const matched = pair(i, j);
      score[i]![j] = Math.max(
        matched ? score[i + 1]![j + 1]! + matched : 0,
        score[i + 1]![j]!,
        score[i]![j + 1]!,
      );
    }
  }
  if (Math.floor(score[0]![0]! / BASE) * 2 < want.length) return undefined;
  // Walked along that alignment: aligned and exact is right; else missed.
  const missed = want.map(({ exact }) => exact !== " ");
  for (let i = 0, j = 0; i < want.length && j < got.length;) {
    const matched = pair(i, j);
    if (matched && score[i]![j] === score[i + 1]![j + 1]! + matched) {
      if (matched > BASE) missed[i] = false;
      i++;
      j++;
    } else if (score[i + 1]![j]! >= score[i]![j + 1]!) i++;
    else j++;
  }
  return want.map(({ text }, i) => ({ text, missed: missed[i]! }));
}

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
