// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Caption files as the cues Braivo takes (docs/adr/0025-timed-transcripts.md):
// WebVTT, which YouTube and most players write, and SRT. Extraction, so it is
// the CLI's, before Braivo — the server takes cues and never a caption format
// (docs/adr/0020-source-content.md).

/** One caption line and the second it starts at, as `POST …/sources` takes it. */
export type Cue = { at: number; text: string };

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
// A word's own time inside a cue's text, `hola<00:00:00.560><c> amigos</c>`,
// which auto-generated WebVTT writes and people do not.
const WORD_TIMING = new RegExp(`<${TIME}>`);

// Shorter than any line a person reads, or any pause between two: rolling
// captions flash the line just said for 10 ms, and leave no gap between cues.
const INSTANT_SECONDS = 0.05;

/**
 * A caption file's cues, one per line of captions and in order, or an error
 * saying what is wrong. What a viewer reads is kept; what a player reads —
 * styling, positions, speaker tags, word timings — is dropped.
 *
 * Auto-generated captions, the ones timing each word inline, roll: a cue's last
 * line is what is newly said, a line above it carries over the line just kept,
 * and a cue lasting an instant flashes that line alone. A repeated line is
 * skipped only when its cue starts within an instant of the previous one's end
 * and the line is carried or flashed. Any other line said again is kept,
 * rolling or not: in a lesson, repeating can be the material.
 */
export function parseCaptions(content: string, format: CaptionFormat): Cue[] | Error {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // A WebVTT block ends at an empty line: YouTube's cues hold lines of one
  // space. SRT has no such lines, and editors leave spaces on its separators.
  const blocks = text.split(format === "vtt" ? /\n{2,}/ : /\n(?:[ \t]*\n)+/);

  if (format === "vtt") {
    // The first line, which headers such as YouTube's `Kind:` may follow.
    if (!/^WEBVTT(?:[ \t]|$)/.test(blocks[0]?.split("\n", 1)[0] ?? "")) {
      return new Error("This is not a WebVTT file: its first line is not WEBVTT.");
    }
    blocks.shift();
  }

  const timed: { at: number; until: number; lines: string[] }[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    // WebVTT's comments and settings, whatever they quote.
    if (format === "vtt" && /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0] ?? "")) continue;
    // A cue's timing is its first line, or its second after an identifier —
    // an SRT counter, or a WebVTT cue name. Anything else is not a cue.
    const index = lines.findIndex((line) => TIMING.test(line));
    if (index === -1 || index > 1) continue;
    const timing = TIMING.exec(lines[index]!)!;
    const at = seconds(timing.slice(1, 5));
    timed.push({ at, until: seconds(timing.slice(5, 9)), lines: lines.slice(index + 1) });
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
    const follows = at - lastUntil < INSTANT_SECONDS;
    const flash = until - at < INSTANT_SECONDS;
    lastUntil = until;
    for (const [index, line] of said.entries()) {
      const carried = rolling && follows && (index < said.length - 1 || flash);
      if (carried && line === last) continue;
      cues.push({ at, text: line });
      last = line;
    }
  }

  return cues.length > 0 ? cues : new Error(`No captions found in this ${format} file.`);
}

function seconds([hours, minutes, whole, milliseconds]: (string | undefined)[]): number {
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
  lrm: "",
  rlm: "",
};

// WebVTT escapes a literal `<`, so anything between brackets is markup. SRT
// escapes nothing: only its own tags go, and `x < 5 and y > 2` stays.
const TAGS: Record<CaptionFormat, RegExp> = {
  vtt: /<[^>]*>/g,
  srt: /<\/?(?:i|b|u|font)(?:\s[^<>]*)?>/gi,
};

/** A caption line as it is read: tags removed, entities decoded, spaces collapsed. */
function spoken(line: string, format: CaptionFormat): string {
  return line
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
    .trim();
}
