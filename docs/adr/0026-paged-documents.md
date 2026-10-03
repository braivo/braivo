# 0026: A document enters page by page, and a passage cited from it names its page

Status: accepted (2026-09-24)

## Context

Schools teach from books. A textbook, a workbook, a worksheet is the material a teacher most often has, and after a wrong answer the learner is holding the same book: "p. 12" is what sends them to the passage, as a moment does for a video ([ADR 0025](0025-timed-transcripts.md)). Extracted text alone has lost where each page began.

## Decision

- **A source may be sent as pages.** `POST …/sources` takes `pages: [{ "page": "12", "text": "…" }]` instead of `text` or `cues` — exactly one of the three. `content.joinPages` normalizes and trims each page, joins them a blank line apart, and records where each begins: the source's **pagination**, `[{ "start", "page" }]`, in code points. The joined text is a source's text like any other.
- **A page is labelled as printed.** `page` is a string — `12`, `iv`, `A-3` — of at most 16 characters, because the number a learner looks for is the one on the paper, which a PDF's own sheet count need not match. Labels need not be ordered or unique: front matter comes before `1`, and books restart. Pages stay in the order sent.
- **A cited passage names its page**: the one it starts on (`content.pageOf`). The grade carries `page`, and the learn app captions it "Mi primer libro · p. 12". The link to the document is left as it is: a PDF's `#page=` counts sheets, not printed labels.
- **Pagination is part of what the source is.** It takes timing's place as the digest's fifth field ([ADR 0024](0024-idempotent-authoring.md)); a source has one or neither, and their JSON differs by key, so the two never collide. A new column, `pagination`, rather than one column for both: each keeps its own type, and a reader never asks which it holds.
- **Extraction stays the sender's** ([ADR 0020](0020-source-content.md)). `braivo sources add` sends text with form feeds between pages — what `pdftotext` writes — as pages labelled by position from 1, or from `--first-page`, leaving out pages without words. `braivo mcp`'s `add_document` asks the agent, which reads the PDF itself, for printed labels.

## Consequences

- `pdftotext`'s pages are sheets. `--first-page` gives the book's number of the first one extracted, for a book not numbered by its sheets or a chapter extracted alone (`pdftotext -f`; a long book is added in parts). Labels other than numbers, front matter's `iv`, need an agent.
- A scanned book has no text to extract: the CLI says so, and OCR happens before Braivo, like any extraction.
- A slide deck is a document whose pages are slides. A video that shows slides is still a recording.
