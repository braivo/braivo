// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Caption files as the cues Braivo takes (docs/adr/0025-timed-transcripts.md):
// WebVTT, which YouTube and most players write, and SRT. Extraction, so it is
// the CLI's, before Braivo — the server takes cues and never a caption format
// (docs/adr/0020-source-content.md).

import type { Cue } from "../content/index.ts";

/** The caption formats read here, by the extension a file of each has. */
export type CaptionFormat = "vtt" | "srt";

/** `vtt` or `srt` for a caption file's name, or nothing for any other file. */
export function captionFormat(file: string): CaptionFormat | undefined {
  const extension = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase();
  return extension === "vtt" || extension === "srt" ? extension : undefined;
}

// `00:01:02.500`, or WebVTT's hourless `01:02.500`; SRT separates milliseconds
// with a comma.
const TIME = String.raw`(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})`;
const TIMING = new RegExp(String.raw`^${TIME}\s+-->\s+${TIME}`);
// A line that looks like a timing, typed right or nearly: a time, its first
// separator a colon, dot, or comma, then an arrow such as `->` or `→`. Words a
// caption says seldom open that way, and `p --> q` does not.
const TIMING_LIKE = /^\s*\d+[:.,][\d:.,]*\s*(?:[-=]+>|→)/;
// A word's own time inside a cue's text, `hola<00:00:00.560><c> amigos</c>`,
// which auto-generated WebVTT writes and people do not.
const WORD_TIMING = new RegExp(`<${TIME}>`);
// A WebVTT comment, style sheet, or region, which a viewer never reads.
const METADATA = /^(?:NOTE(?:[ \t]|$)|(?:STYLE|REGION)[ \t]*$)/;
// A timing as each format writes it, for a refusal to show.
const EXAMPLE: Record<CaptionFormat, string> = {
  vtt: "00:00:01.000 --> 00:00:02.000",
  srt: "00:00:01,000 --> 00:00:02,000",
};

// Shorter than any line a person reads, or any pause between two: rolling
// captions flash the line just said for 10 ms, and leave no gap between cues.
const INSTANT_SECONDS = 0.05;

/**
 * A caption file's cues, one per line of captions and in order, or an error
 * saying what is wrong. What a viewer reads is kept, a WebVTT speaker's name
 * as a prefix, `Anna: `; what a player reads — styling, positions, word
 * timings — is dropped. A caption it cannot time, or run into another, is
 * refused, naming its line, rather than its words lost or mistimed; a run-in
 * timing is told by its look (`TIMING_LIKE`).
 *
 * Auto-generated captions, the ones timing each word inline, roll: a cue's last
 * line is what is newly said, a line above it carries over the line just kept,
 * and a cue lasting an instant flashes that line alone. A repeated line is
 * skipped only when its cue starts within an instant of the previous one's end
 * and the line is carried or flashed. Any other line said again is kept,
 * rolling or not: in a lesson, repeating can be the material.
 */
export function parseCaptions(content: string, format: CaptionFormat): Cue[] | Error {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = blocksOf(text, format);
  // WebVTT allows `-->` only in a timing, past its first line; SRT's words may say it.
  const timingLike = ({ text }: Line) =>
    TIMING_LIKE.test(text) || (format === "vtt" && text.includes("-->"));

  if (format === "vtt") {
    if (!/^WEBVTT(?:[ \t]|$)/.test(text.split("\n", 1)[0]!)) {
      return new Error("This is not a WebVTT file: its first line is not WEBVTT.");
    }
    // The header: `WEBVTT` and a title, then lines such as YouTube's `Kind:`.
    const cue = blocks.shift()!.slice(1).find(timingLike);
    if (cue) {
      return new Error(
        `Line ${cue.number}: the first caption needs a blank line after the WebVTT header.`,
      );
    }
  }

  const timed: { at: number; until: number; lines: string[] }[] = [];
  for (const lines of blocks) {
    // A cue's timing is its first line, or its second after an identifier —
    // an SRT counter, or a WebVTT cue name, which may be `NOTE`.
    const timings = lines.flatMap((line, index) => (TIMING.test(line.text) ? [index] : []));
    const index = timings[0];
    // WebVTT's comments and settings; a timing on the second line, mistyped or
    // not, makes a cue named like one. A comment quoting a mistyped timing there
    // is refused with it, rather than a caption risked.
    const metadata = format === "vtt" && METADATA.test(lines[0]!.text);
    if (metadata && !(lines[1] && timingLike(lines[1]))) continue;
    if (index === undefined) {
      const typo = lines.find(timingLike);
      return new Error(
        typo
          ? `Line ${typo.number}: a timing should look like ${EXAMPLE[format]}.`
          : `Line ${lines[0]!.number}: a caption needs a timing, such as ${EXAMPLE[format]}.`,
      );
    }
    // Lines above the timing, or another timing, are another caption's.
    const misplaced = index > 1 ? index : timings[1];
    if (misplaced !== undefined) {
      return new Error(
        `Line ${lines[misplaced]!.number}: captions need a blank line between them.`,
      );
    }
    // A mistyped one as well, which would be read out and the words after it
    // timed as this caption's.
    const mistyped = lines.slice(index + 1).find(timingLike);
    if (mistyped) {
      return new Error(
        `Line ${mistyped.number}: a timing should look like ${EXAMPLE[format]}, and captions need a blank line between them.`,
      );
    }

    const { number, text: timingLine } = lines[index]!;
    const timing = TIMING.exec(timingLine)!;
    const at = seconds(timing.slice(1, 5));
    const until = seconds(timing.slice(5, 9));
    if (at === undefined || until === undefined) {
      return new Error(`Line ${number}: minutes and seconds in a timing run from 00 to 59.`);
    }
    if (until < at) return new Error(`Line ${number}: a caption ends before it starts.`);
    timed.push({ at, until, lines: lines.slice(index + 1).map((line) => line.text) });
  }
  // In the order they are said, which an edited file need not be in, and
  // Braivo requires; stable, so cues starting together keep the file's order.
  timed.sort((a, b) => a.at - b.at);

  const rolling = format === "vtt" && WORD_TIMING.test(text);
  const cues: Cue[] = [];
  let last: string | undefined;
  let lastUntil = -Infinity;
  for (const { at, until, lines } of timed) {
    const said = lines.map((line) => spoken(line, format)).filter((line) => line !== "");
    const adjacent = Math.abs(at - lastUntil) < INSTANT_SECONDS;
    const flash = until - at < INSTANT_SECONDS;
    lastUntil = until;
    for (const [index, line] of said.entries()) {
      const carried = rolling && adjacent && (index < said.length - 1 || flash);
      if (carried && line === last) continue;
      cues.push({ at, text: line });
      last = line;
    }
  }

  return cues.length > 0 ? cues : new Error(`No captions found in this ${format} file.`);
}

/** A line with text, and its number in the file. */
type Line = { number: number; text: string };

/**
 * `text`'s blocks, each the lines with text between two blank ones. A WebVTT
 * block ends at an empty line: YouTube's cues hold lines of one space. SRT has
 * no such lines, and editors leave spaces on its separators.
 */
function blocksOf(text: string, format: CaptionFormat): Line[][] {
  const blank = format === "vtt" ? /^$/ : /^[ \t]*$/;
  const blocks: Line[][] = [];
  let block: Line[] | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    if (blank.test(line)) block = undefined;
    else if (line.trim() !== "") {
      if (!block) blocks.push((block = []));
      block.push({ number: index + 1, text: line });
    }
  }
  return blocks;
}

/** A time's seconds, or nothing when its minutes or seconds are past 59. */
function seconds([hours, minutes, whole, milliseconds]: (string | undefined)[]):
  | number
  | undefined {
  if (Number(minutes) > 59 || Number(whole) > 59) return undefined;
  return (
    Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(whole) + Number(milliseconds) / 1000
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "\u200e",
  rlm: "\u200f",
};

// A WebVTT voice, `<v Anna>` or `<v.loud Anna>`: who speaks, which a dialogue
// needs, so kept as a script writes it, `Anna: `.
const VOICE = /<v(?:\.[^\s>]*)?[ \t]+([^>]*)>/g;

// WebVTT escapes a literal `<`, so anything between brackets is markup. SRT
// escapes nothing: only its own tags go, and `x < 5 and y > 2` stays.
const TAGS: Record<CaptionFormat, RegExp> = {
  vtt: /<[^>]*>/g,
  srt: /<\/?(?:i|b|u|font)(?:\s[^<>]*)?>/gi,
};

/**
 * A caption line as it is read: tags removed, entities decoded, spaces
 * collapsed, in NFC, so a rolling repeat in another form is still a repeat.
 */
function spoken(line: string, format: CaptionFormat): string {
  // SRT has no voice tags: its `<v Anna>` is words.
  const voiced =
    format === "vtt"
      ? line.replace(VOICE, (_, name: string) => (name.trim() ? `${name.trim()}: ` : ""))
      : line;
  return voiced
    .replace(TAGS[format], "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        // Not NUL or a lone surrogate, which no text can hold, nor past Unicode.
        const character = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
        return character ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}
