// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How a learn app's address names a course, `/c/<ref>`: its number within the
// organization the domain serves, then a label to read, which names nothing
// (`4732-everyday-english`); or, where no organization is implied, its ID
// (docs/adr/0044-course-numbers.md). Imports nothing: the client bundles it.

/** The longest label, in characters as a reader counts them. */
const LABEL_LENGTH = 80;
/** And in UTF-16 code units, as any number of marks may stack on one character. */
const LABEL_UNITS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The address naming `course` by its number, with its label to read. */
export function courseRef(course: { number: number; urlLabel: string }): string {
  return course.urlLabel ? `${course.number}-${course.urlLabel}` : `${course.number}`;
}

/**
 * `text` as a label: lowercase letters and digits of any script, with the
 * marks on them, each run of anything else one hyphen, none at either end, cut
 * to 80 characters (200 code units); empty for text with no letter or digit.
 * A course's default is its title's.
 */
export function urlLabel(text: string): string {
  const words = text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{Nd}]+/gu, "-")
    // A mark on nothing would show alone. Linear passes, not a lookbehind,
    // which is quadratic in a run of marks.
    .replace(/(^|-)\p{M}+/gu, "$1")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  let label = "";
  let length = 0;
  for (const { segment } of new Intl.Segmenter().segment(words)) {
    if (length === LABEL_LENGTH || label.length + segment.length > LABEL_UNITS) break;
    label += segment;
    length++;
  }
  return label.replace(/-+$/, "");
}

/** Whether `text` is a label as `urlLabel` writes one, and not empty. */
export function isUrlLabel(text: string): boolean {
  // Too long to be one, refused before the work of normalizing it.
  return text !== "" && text.length <= LABEL_UNITS && urlLabel(text) === text;
}

/**
 * What `ref` names: a course's ID, or its number, any label after it ignored;
 * `undefined` for anything else. An ID is tried first, as one may start with
 * digits and a hyphen.
 */
export function parseCourseRef(
  ref: string,
): { id: string } | { number: number; urlLabel?: string } | undefined {
  if (UUID.test(ref)) return { id: ref.toLowerCase() };
  const [, digits, label] = /^([^-]*)(?:-(.*))?$/s.exec(ref)!;
  if (label === "") return undefined;
  const number = parseCourseNumber(digits!);
  if (number === undefined) return undefined;
  return label === undefined ? { number } : { number, urlLabel: label };
}

/**
 * A course number as written, `4732`, or `undefined` for anything else: a
 * sign, a leading zero, a fraction, or one past PostgreSQL's `integer`.
 */
export function parseCourseNumber(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return undefined;
  const number = Number(text);
  return number <= 2_147_483_647 ? number : undefined;
}
