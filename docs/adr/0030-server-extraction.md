# 0030: Braivo reads a PDF or photo into pages on request, and the caller adds them

Status: accepted (2026-09-24)

## Context

[ADR 0020](0020-source-content.md) made extraction the holder's: whoever has the PDF turns it into text, which works for a teacher with `pdftotext` or a desktop agent, and not for one with only a scan or a phone photo of a worksheet. [ADR 0028](0028-original-files.md) keeps the file; [ADR 0029](0029-server-drafting.md) drafts a course from text. The step between — the file's words — was the teacher's to type.

## Decision

- **The model reads the file.** `Model.answer` takes files: Anthropic's API reads a PDF as a `document` and an image as an `image`, both base64, before the prompt. `ai.extractPages` asks for each page's words exactly as printed, in reading order, without running headers, footers, or page numbers, labelled with the printed page number — the same pages [ADR 0026](0026-paged-documents.md) takes — and checks the answer with `content.joinPages`, so what it returns can be added as it is. That is a transcription with editing, not a copy: dropping headers is a judgment, and `joinPages` checks the answer's shape, not that it is faithful or complete.
- **Returned, not stored.** `POST …/files/:fileId/text` answers `{ "pages": [...] }`. Adding it as a source, with the file as its `original`, is the caller's next request: the source's rules stay in one place, and a caller that wants to check the transcription first can.
- **One gate for every AI request.** Drafting's key and operator list ([ADR 0029](0029-server-drafting.md)) become `Ai`, used by both routes: `AiUnavailable` (501), `AiNotEntitled` (403), `AiLimitReached` (429, [ADR 0031](0031-ai-limits.md)), and `InvalidAiRequest` (400), each explained.
- **What models read, within their limits.** PDFs up to 24 MB and PNG, JPEG, GIF, or WebP images up to 7.5 MB — the provider's limits on a request (32 MB) and an image (10 MB), less base64's third. Anything else is refused, saying to extract it another way; a longer book is sent a chapter at a time, since one answer holds a chapter's text, not a book's.
- **The console reads when no text is pasted.** Adding material with a file and an empty Text field uploads the file, reads it, and adds the pages; the new source's page, where a course is drafted, opens next. A PDF becomes a reviewed course in the console alone.

## Consequences

- A transcription is a model's: it can misread a smudged scan, skip a page, or lose what structure carries — a question's number, its answer key, a table's rows, which picture goes with which item — and one misread negation reverses a statement. The console adds the pages unreviewed; the source's page shows the text, and a source being immutable, a bad reading is replaced by adding the material again with pasted text. [ADR 0046](0046-material-in-steps.md) (accepted, not built yet) lets the owner correct an extraction before saving it as a source.
- A file's pictures are not read into the text: what a page shows only in an image is lost to the source, and a reading does not say so.
- Handwriting and pictures without words give little or nothing; a file the model finds no words in is refused as such.
- Each reading spends the operator's credits under the same gate and the same monthly count as drafting ([ADR 0031](0031-ai-limits.md)), even for a PDF whose own text layer would have given its words exactly; [ADR 0046](0046-material-in-steps.md) (accepted, not built yet) extracts that layer first, without a model.
- A PDF over 24 MB, or longer than one answer holds, cannot be read here at all: a question bank of hundreds of pages, say. [ADR 0046](0046-material-in-steps.md) (accepted, not built yet) extracts it in the background, a batch of pages at a time.
- Video and audio are not read here: captions ([ADR 0025](0025-timed-transcripts.md)) and a speech model are their road.
