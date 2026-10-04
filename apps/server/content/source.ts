// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Pagination } from "./pages.ts";
import type { Timing } from "./transcript.ts";

/**
 * A source's text in the one form Braivo stores, or nothing when it cannot be a
 * source. Citations locate quotes in this text by position, so the same
 * document must have one spelling: Unicode NFC, so an accented letter typed two
 * ways matches, and `\n` line endings, so a file saved on Windows does too.
 *
 * Refused rather than repaired: blank text, which grounds nothing; a NUL, which
 * PostgreSQL cannot store in `text`; and an unpaired surrogate, which is not
 * text at all and would be mangled on its way to UTF-8.
 */
export function normalizeSourceText(text: string): string | undefined {
  if (!text.isWellFormed() || text.includes("\u0000")) return undefined;

  const normalized = text.replace(/\r\n?/g, "\n").normalize("NFC");
  return normalized.trim() === "" ? undefined : normalized;
}

/**
 * What makes two sources the same one: their title, text, link, and language,
 * already in the form Braivo stores. Adding a source that is already there
 * returns it rather than storing it twice (docs/adr/0024-idempotent-authoring.md).
 *
 * SHA-256 over the fields' UTF-8 bytes, each separated by a zero byte, which no
 * stored field can contain; an absent link or language is empty, which a
 * present one cannot be.
 *
 * A transcript's timing or a document's pagination, when present, follows as
 * JSON, its keys telling them apart: the same words at other moments or on
 * other pages are another source. So does the original file's SHA-256, marked
 * `original:`, which neither JSON nor an earlier field starts with: the same
 * words from another file are another source (docs/adr/0028-original-files.md).
 */
export function sourceDigest(source: {
  title: string;
  text: string;
  url?: string;
  language?: string;
  timing?: Timing;
  pagination?: Pagination;
  original?: string;
}): string {
  const separator = new Uint8Array([0]);
  const hasher = createHash("sha256");
  const fields = [source.title, source.text, source.url ?? "", source.language ?? ""];
  const located = source.timing ?? source.pagination;
  if (located !== undefined) fields.push(JSON.stringify(located));
  if (source.original !== undefined) fields.push(`original:${source.original}`);
  for (const [index, field] of fields.entries()) {
    if (index > 0) hasher.update(separator);
    hasher.update(field);
  }
  return hasher.digest("hex");
}

/** Longer than any link a person shares; a bound so a URL cannot carry a document. */
const MAX_URL_LENGTH = 2048;

/**
 * A link a source's text came from, in its canonical form, or nothing when it
 * cannot be one. Only `http` and `https`: a source's link is for people to
 * follow, and anything else is either unreachable or unsafe to render as a
 * link. Credentials are refused rather than stripped, since a link carrying a
 * password was not meant to be shared.
 */
export function parseSourceUrl(value: string): string | undefined {
  // Checked before parsing only to bound the work; the limit applies to what is
  // stored, which percent-encoding can make several times longer.
  if (value.length > MAX_URL_LENGTH) return undefined;

  const url = URL.parse(value.trim());
  if (url === null) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;

  return url.href.length > MAX_URL_LENGTH ? undefined : url.href;
}

/**
 * A language tag in its canonical BCP 47 form — `es-mx` becomes `es-MX` — or
 * nothing when it is not one. Canonical so that two spellings of one language
 * are one value to filter and grade by.
 *
 * The primary subtag must have two or three letters, the shape of an ISO 639
 * code. `Intl` checks syntax only, and BCP 47's syntax admits a five-to-eight-
 * letter language subtag that no registered language uses — so `Spanish`, the
 * mistake a person is likeliest to make, would otherwise pass as a language.
 * Registration itself is not checked: `xx` passes. The registry Braivo could
 * check against is ICU's, and refusing a real language ICU lacks would be
 * worse than storing a code nobody uses.
 */
export function parseLanguageTag(value: string): string | undefined {
  // RFC 5646's suggested buffer: room for any language, script, and region.
  if (value.length > 35) return undefined;

  let tag: string | undefined;
  try {
    [tag] = Intl.getCanonicalLocales(value.trim());
  } catch {
    return undefined;
  }
  return tag !== undefined && /^[a-z]{2,3}(-|$)/.test(tag) ? tag : undefined;
}
