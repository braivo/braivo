# 0020: Source content is an immutable text snapshot, extracted by whoever holds the file

Status: accepted (2026-09-23)

## Context

Braivo's promise is "upload your existing materials and get a tutor". Objectives and tasks ([ADR 0015](0015-tasks.md)) exist, but a content owner writes them by hand, and nothing records what they were derived from, though the product requires that generated content stay tied to its source ([product.md](../product.md), Grounded AI).

Materials arrive as PDFs, slides, worksheets, photos of pages, audio, video, and links — a YouTube lesson, a web article. Turning them into something an AI can derive objectives and tasks from is expensive, varies by format, and is exactly the step content owners increasingly want to run in their own tools — a desktop Claude, Codex, or Grok working through a Braivo CLI or MCP server — instead of paying for it in the cloud.

## Decision

- **A source is text.** `source` stores an organization's material as a title and its text, Markdown by convention. Everything derived from it is grounded in that text: objectives and tasks cite it. An original file is provenance, not a substitute; video and audio enter as transcripts.
- **Extraction happens before Braivo.** `POST /api/organizations/:organizationId/sources` takes text. Braivo extracting it server-side and a content owner's local agent extracting it are the same call, so "bring your own AI" costs Braivo nothing to support and needs no second path.
- **Immutable.** A revised document is a new source, as a corrected task is a new task. Citations address the text by position, and stay valid only while it cannot change beneath them.
- **One spelling.** `content` normalizes the text before storage — NFC, `\n` line endings, otherwise as sent — and refuses blank text, NUL, and unpaired surrogates rather than repairing them. A position in a source then means the same thing to everyone who reads it.
- **Links are origins.** A YouTube video, a web article, or a shared slide deck is a source whose `url` is the link and whose text is its transcript or extracted text. Braivo keeps the link rather than a copy, which suits both the platforms' terms and a teacher who only has a link to give. Only `http` and `https`, without credentials: the link is for people to follow.
- **A declared language.** `language` is the text's main language as a canonical BCP 47 tag (`es`, `es-MX`), optional because a pasted note may not say. Language learning is Braivo's first subject, and what is drafted, how a task is graded, and which voice reads it aloud all depend on it. The primary subtag must have two or three letters, the shape of an ISO 639 code, since BCP 47's syntax alone accepts `Spanish`. Registration is not checked, so that a real language missing from ICU's data is never refused.
- **Organization-owned and restricted**, like objectives: deleting an organization that still has sources is refused.

## Follow-up decisions

- **Citations are verified quotes**: whatever proposes derived content cites the exact text it relies on, and Braivo refuses a quote it cannot find ([ADR 0021](0021-citations.md)).
- **Timed transcripts and paged documents**, so a citation names its moment in a video or its page in a book ([ADR 0025](0025-timed-transcripts.md), [ADR 0026](0026-paged-documents.md)).
- **Originals in a file store** the installation chooses, recorded on the source extracted from them ([ADR 0028](0028-original-files.md)).
- **Machine credentials** for the CLI and MCP server, which call the same HTTP API as a signed-in content owner ([ADR 0022](0022-machine-access.md)).

## Consequences

- A source cannot be edited or deleted through the API. Deletion waits for a decision on what happens to the content derived from it.
- A source's text travels in one request, up to 10 MB. Material larger than that is several sources, which is also the grain a citation is easiest to review at.
- Listing omits text, so an organization's library stays cheap to browse.
