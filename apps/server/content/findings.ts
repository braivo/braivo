// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizeAnswer, type TaskBody } from "./task.ts";

// Advisory checks on content as written: what a learner may run into that its
// author likely did not mean. Nothing here changes grading (ADR 0038) or is
// stored: recomputed from the content as it is, a finding goes once what
// raised it no longer holds. Deterministic and
// language-neutral, so the server and the console agree; each is a code with
// the text it concerns, worded by whoever shows it.

/** What a learner may run into with a task as written. */
export type Finding =
  /**
   * `answer` ends in a sentence mark no accepted answer goes without: typed
   * without it, it is marked wrong. `suggestion`, that answer without it, when
   * adding it reads right and fits.
   */
  | { code: "typed-trailing-punctuation"; answer: string; suggestion?: string }
  /** `answer` holds " / " or a parenthesised part, matched as written. */
  | { code: "typed-literal-delimiters"; answer: string }
  /**
   * The correct option and `other` are equal once case, quotes, and a final
   * mark are set aside; `differences` names those that make them so.
   */
  | {
      code: "choice-correct-alike";
      correct: string;
      other: string;
      differences: Difference[];
    };

/** What `choice-correct-alike` sets aside, in the order it lists them. */
type Difference = "case" | "punctuation" | "quotes";

/** As `parseTaskBody` allows: a suggestion past it could not be saved. */
const MAX_ACCEPTED = 20;

/** A task's findings, in the order of its answers or options. Empty when nothing. */
export function taskFindings(body: TaskBody): Finding[] {
  if (body.kind === "choice") return choiceFindings(body.options, body.answer);

  const compared = new Set(body.accepted.map(normalizeAnswer));
  return body.accepted.flatMap((answer): Finding[] => {
    const found: Finding[] = [];
    const ending = sentenceEnding(answer);
    if (ending && !compared.has(normalizeAnswer(ending.without))) {
      // `¿Qué` or `¡Hola` reads wrong, and a 21st answer cannot be saved.
      const suggest = !/^\s*[¿¡]/u.test(ending.content) && body.accepted.length < MAX_ACCEPTED;
      found.push({
        code: "typed-trailing-punctuation",
        answer,
        ...(suggest && { suggestion: ending.without }),
      });
    }
    if (LITERAL_DELIMITERS.test(answer)) found.push({ code: "typed-literal-delimiters", answer });
    return found;
  });
}

/**
 * A spaced slash, or a fullwidth one, as CJK text leaves no spaces; brackets,
 * ASCII or fullwidth, with something inside: `colour / color` and `(to) go`
 * read as alternatives or optional words, yet are matched whole. `km/h` is
 * not one; `f(x)` is, harmlessly. Inside brackets, spacing then the first
 * other character: no two parts can match the same text, so a long unclosed
 * `(` costs linear time, not quadratic.
 */
const LITERAL_DELIMITERS = / \/ |／|\(\s*[^\s()][^()]*\)|（\s*[^\s（）][^（）]*）/u;

/**
 * Closing quote marks, each with the marks that open it, as languages pair
 * them: `“…”`, `„…“`, `„…”`, `”…”`, `«…»`, `»…«`, `»…»`, `「…」`, and singles.
 */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "”": "“„”",
  "“": "„",
  "’": "‘‚’",
  "‘": "‚",
  "»": "«»",
  "«": "»",
  "›": "‹›",
  "‹": "›",
  "」": "「",
  "』": "『",
};

/**
 * A sentence's final mark in the scripts most courses are written in: Latin,
 * fullwidth and CJK, Arabic and Urdu, Devanagari, Armenian, Ethiopic. Not the Greek question mark, which is
 * `;` once NFC, as a semicolon ends no sentence.
 */
const FINAL_MARK = /(?:\.\.\.|…|[.!?。！？｡؟۔।॥։።])(\s*)$/u;

/**
 * `text`'s final sentence mark (`FINAL_MARK`), inside one pair of quotes
 * around it: `without` is `text` without it, quotes kept, and
 * `content` what is inside them. None when there is no such mark, or nothing
 * but marks without it (`?`, `“…”`). A mark inside the text (`Dr. Who`) or in
 * a number (`3.5`) is not final.
 */
function sentenceEnding(text: string): { without: string; content: string } | undefined {
  const close = text.at(-1)!;
  const quoted = text.length > 1 && QUOTE_PAIRS[close]?.includes(text[0]!) === true;
  const [open, inner, end] = quoted ? [text[0]!, text.slice(1, -1), close] : ["", text, ""];
  // Spacing before a closing quote stays, as in French `« Bonjour. »`.
  const mark = FINAL_MARK.exec(inner);
  if (!mark) return undefined;
  const content = inner.slice(0, mark.index).trimEnd();
  if (!/[\p{L}\p{N}]/u.test(content)) return undefined;
  return { without: `${open}${content}${quoted ? mark[1] : ""}${end}`, content };
}

/** Every straight, typographic, and CJK quote mark, an apostrophe included. */
const QUOTE_MARKS = /["'“”„‟‘’‚‛«»‹›ʼ「」『』]/gu;

/** The folds `choice-correct-alike` sets aside, applied in this order. */
const FOLDS: Record<Difference, (text: string) => string> = {
  quotes: (text) => text.replace(QUOTE_MARKS, ""),
  punctuation: (text) => sentenceEnding(text)?.without ?? text,
  case: (text) => text.toLowerCase(),
};

/** Every set of folds, as which ones are applied. */
const FOLD_SETS = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
  (Object.keys(FOLDS) as Difference[]).filter((_, index) => bits & (1 << index)),
);

/** `text` NFC, with `applied` folds, in their order. */
function folded(text: string, applied: readonly Difference[]): string {
  // Spacing as stored, only trimmed: `New York` and `New\u00a0York` are not
  // alike, as the parser keeps both.
  let result = text.normalize("NFC");
  for (const [name, fold] of Object.entries(FOLDS)) {
    if (applied.includes(name as Difference)) result = fold(result).trim();
  }
  return result;
}

/**
 * The correct option against each distractor: alike once case, quotes, and a
 * final mark are set aside. Not `normalizeAnswer`, which straightens quotes
 * rather than dropping them. Distractors alike to each other are not flagged.
 *
 * A fold is a difference when, added to some others, it makes the two equal:
 * with the other two applied, as `Paris` and `paris.` differ in case and
 * punctuation, or alone, where either fold hides one mark (`"Paris."` and
 * `"Paris".`). Never one that changes nothing between them.
 */
function choiceFindings(options: readonly string[], answer: number): Finding[] {
  const correct = options[answer]!;
  const all = FOLD_SETS.at(-1)!;
  const alike = (applied: readonly Difference[], other: string) =>
    folded(other, applied) === folded(correct, applied);
  return options.flatMap((other, index): Finding[] => {
    if (index === answer || !alike(all, other)) return [];
    const differences = (["case", "punctuation", "quotes"] as const).filter((fold) =>
      FOLD_SETS.some(
        (applied) =>
          !applied.includes(fold) && !alike(applied, other) && alike([...applied, fold], other),
      ),
    );
    return [{ code: "choice-correct-alike", correct, other, differences }];
  });
}
