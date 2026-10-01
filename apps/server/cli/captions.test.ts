// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { captionFormat, parseCaptions } from "./captions.ts";

describe("reading captions", () => {
  test("knows a caption file by its extension", () => {
    expect(captionFormat("lesson.es.vtt")).toBe("vtt");
    expect(captionFormat("LESSON.SRT")).toBe("srt");
    expect(captionFormat("lesson.txt")).toBeUndefined();
    expect(captionFormat("vtt")).toBeUndefined();
  });

  test("reads a WebVTT file's cues, dropping what only a player reads", () => {
    const vtt = [
      "﻿WEBVTT - Los animales",
      "Kind: captions",
      "",
      "NOTE a comment that quotes",
      "00:00:09.000 --> 00:00:10.000",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "intro",
      "00:00.500 --> 00:02.000 align:start position:0%",
      "<v Maestra>Hola, <b>amigos</b>.</v>",
      "",
      "01:02:03.250 --> 01:02:05.000",
      "Tom &amp; Jerry &lt;3 caf&#233;&nbsp;&#x1F642;",
    ].join("\r\n");

    expect(parseCaptions(vtt, "vtt")).toEqual([
      { at: 0.5, text: "Hola, amigos." },
      { at: 3723.25, text: "Tom & Jerry <3 café 🙂" },
    ]);
  });

  test("says each line of rolling auto-generated captions once, from when it starts", () => {
    // YouTube's auto captions: each cue repeats the line before it, with word
    // timings on the new one, and a brief cue repeats a line alone. A line of
    // one space, not a blank one, follows the first cue's timing.
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: es",
      "",
      "00:00:00.160 --> 00:00:02.310 align:start position:0%",
      " ",
      "hola<00:00:00.560><c> amigos</c>",
      "",
      "00:00:02.310 --> 00:00:02.320 align:start position:0%",
      "hola amigos",
      " ",
      "",
      "00:00:02.320 --> 00:00:04.990 align:start position:0%",
      "hola amigos",
      "hoy<00:00:02.800><c> vamos</c><00:00:03.100><c> a</c><00:00:03.300><c> contar</c>",
      "",
      "00:00:04.990 --> 00:00:05.000 align:start position:0%",
      "hoy vamos a contar",
      "",
    ].join("\n");

    expect(parseCaptions(vtt, "vtt")).toEqual([
      { at: 0.16, text: "hola amigos" },
      { at: 2.32, text: "hoy vamos a contar" },
    ]);
  });

  test("keeps a line said twice in rolling captions, as the line newly said", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      " ",
      "repetid<00:00:00.400><c> conmigo</c>",
      "",
      "00:00:01.000 --> 00:00:01.010",
      "repetid conmigo",
      "",
      "00:00:01.010 --> 00:00:03.000",
      "repetid conmigo",
      "buongiorno",
      "",
      "00:00:03.000 --> 00:00:03.010",
      "buongiorno",
      "",
      "00:00:03.010 --> 00:00:05.000",
      "buongiorno",
      "buongiorno",
      "",
      // After a pause, a first line is said again rather than carried over.
      "00:00:08.000 --> 00:00:10.000",
      "buongiorno",
      "a tutti",
      "",
    ].join("\n");

    expect(parseCaptions(vtt, "vtt")).toEqual([
      { at: 0, text: "repetid conmigo" },
      { at: 1.01, text: "buongiorno" },
      { at: 3.01, text: "buongiorno" },
      { at: 8, text: "buongiorno" },
      { at: 8, text: "a tutti" },
    ]);
  });

  test("keeps a line said twice in captions a person wrote", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Repetid: hola.",
      "",
      "00:00:02.000 --> 00:00:03.000",
      "Hola.",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "Hola.",
      "",
    ].join("\n");

    expect(parseCaptions(vtt, "vtt")).toEqual([
      { at: 1, text: "Repetid: hola." },
      { at: 2, text: "Hola." },
      { at: 3, text: "Hola." },
    ]);
  });

  test("reads an SRT file's numbered cues, with comma milliseconds and markup", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,500
<i>Uno,</i>
dos.

2
00:00:03,000 --> 00:00:04,000
{\\an8}Tres.
`;

    expect(parseCaptions(srt, "srt")).toEqual([
      { at: 1, text: "Uno," },
      { at: 1, text: "dos." },
      { at: 3, text: "{\\an8}Tres." },
    ]);
  });

  test("keeps SRT's literal brackets, which it does not escape", () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<font color="red">If x < 5 and y > 2</font>\n';

    expect(parseCaptions(srt, "srt")).toEqual([{ at: 1, text: "If x < 5 and y > 2" }]);
  });

  test("reads SRT cues in the order they are said, whatever separates them", () => {
    const srt = [
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "Tres.",
      " \t",
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Uno.",
      "",
    ].join("\n");

    expect(parseCaptions(srt, "srt")).toEqual([
      { at: 1, text: "Uno." },
      { at: 3, text: "Tres." },
    ]);
  });

  test("refuses a file that is not WebVTT, or has no captions, saying so", () => {
    expect(parseCaptions("1\n00:00:01,000 --> 00:00:02,000\nHola\n", "vtt")).toEqual(
      new Error("This is not a WebVTT file: its first line is not WEBVTT."),
    );
    expect(parseCaptions("WEBVTT\n\nNOTE nothing here\n", "vtt")).toEqual(
      new Error("No captions found in this vtt file."),
    );
  });

  test("keeps no character text cannot hold", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\na&#0;b&#xD800;c\n";

    expect(parseCaptions(vtt, "vtt")).toEqual([{ at: 1, text: "a&#0;b&#xD800;c" }]);
  });
});
