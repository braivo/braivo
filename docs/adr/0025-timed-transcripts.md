# 0025: A recording enters as timed cues, and a passage cited from it names its moment

Status: accepted (2026-09-24)

## Context

Video is where much of Braivo's material will come from: a teacher's YouTube lessons, and videos Braivo will generate. [ADR 0020](0020-source-content.md) takes a recording as its transcript, and [ADR 0021](0021-citations.md) grounds tasks in the transcript's words, so after a wrong answer a learner sees the passage that teaches the right one. For a video that stops short: the passage is what was said, but the learner would rather hear it said, and the transcript alone has lost when that was.

Captions keep it. Every caption format — WebVTT, SRT, YouTube's own — is a list of cues, each some words and the second they start.

## Decision

- **A source may be sent as cues.** `POST …/sources` takes `cues: [{ "at": seconds, "text": "…" }]` instead of `text`. `content.joinCues` puts each cue's words, normalized and trimmed, on a line of its own, and records where each line starts in the text and at which second: the source's **timing**, `[{ "start", "at" }]`, in code points like every other position in a source. The joined text is the source's text as for any other, so quoting, citing, and reading it change nothing.
- **A cited passage names its moment.** A passage's `at` is the second at which the cue holding its first word starts (`content.momentOf`). The grade a learner gets carries it, and the learn app shows it — "Los animales · 1:02" — and opens the video there: YouTube's `t` parameter for a YouTube link, a media fragment (`#t=`) for any other.
- **Timing is part of what the source is.** The same words said at other moments are another recording, so the digest that makes adding a source idempotent ([ADR 0024](0024-idempotent-authoring.md)) takes the timing as a fifth field — only when there is one.
- **Cues are checked, and refusals say which.** Times are seconds from 0 to a day, in order; each cue has words Braivo can store; at most 100,000 cues. A refused cue is named: "Cue 1 starts before the cue before it; send cues in order."
- **Converting caption files is the sender's.** Braivo takes cues, not WebVTT or SRT: parsing formats, stripping markup, and merging the rolling repeats of auto-generated captions is extraction, which happens before Braivo (ADR 0020) — in `braivo mcp`'s `add_transcript`, the agent does it, and the tool's description tells it to.

## Consequences

- Only the start of a passage names its moment. A passage spanning cues still opens where it begins, which is where a learner wants to start listening.
- A transcript without cues — pasted, or extracted without timing — is plain text, and its passages have no moment. Nothing about it changes.
- Pages of a document are the same idea with another unit: [ADR 0026](0026-paged-documents.md).
- `braivo sources add` is a sender too: it reads a `.vtt` or `.srt` file into cues (`cli/captions.ts`), so a teacher's caption files — or YouTube's, fetched with `yt-dlp` — are timed without an agent. Auto-generated WebVTT, recognisable by its inline word timings, rolls: its cues follow one another without a gap, each repeats the line before above the one newly said, and a cue of a few milliseconds shows that line alone. Those repeats are skipped by where they sit, not by their words, so a line really said twice is kept twice: in a lesson, repetition can be the material.
