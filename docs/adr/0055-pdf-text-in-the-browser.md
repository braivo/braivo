# 0055: The console reads a PDF's text layer in the browser, and the owner reviews its pages before saving them

Status: accepted (2026-11-02)

## Context

A school without Braivo's AI (an installation without a key, or an organization not entitled) could add a PDF only by pasting its text: the console refused a file alone, since reading one meant the model ([ADR 0030](0030-server-extraction.md)). With the AI on, every page went to the model, spending credits on words a born-digital PDF already carries as its text layer. [ADR 0046](0046-material-in-steps.md) plans server extraction in the background, text layer first; it needs an isolated runtime for untrusted parsing, jobs, and snapshots, none built.

A spike measured the browser instead, on synthetic fixtures in Chrome on an M1 laptop: pdf.js 6.4 read a 120-page book in 0.7 s from a fresh context and 600 pages in under 3 s, with no main-thread task over 50 ms, inside the console's unchanged policy ([ADR 0049](0049-app-security-headers.md)), downloading 403 KB (brotli) only when a PDF is read. Cancelling freed the page within a frame at every phase. Memory was not bounded: a 14 KB decompression bomb grew the worker past 4 GB within 10 s.

## Decision

- **Read in a dedicated worker, one per read.** The console posts the `File` to a module worker bundled from its own origin, which runs pdf.js in that thread: pdf.js's worker module is imported and exposed as `globalThis.pdfjsWorker`, so there is no nested worker, blob URL, or eval for the policy to refuse, and `useWasm: false`, as `script-src 'self'` refuses to compile WebAssembly; pdf.js's JavaScript image decoders suffice. Its support files (standard fonts' metrics, character maps, the decoders) are copied from the installed `pdfjs-dist` and served at `/pdfjs/`, fetched only when a PDF needs one (`tooling/pdfjs-files.ts`). The main thread never parses: it terminates the worker on completion, a stop, a deadline, or a cancel.
- **Budgets bound time and output.** At most 1,000 pages, counted after opening; 10 MB of text produced, counted as it streams, as a page can hold a gigabyte of it; a 5 s watchdog on the worker's silence, opening the file and then each page, and 60 s in all. The form refuses a file over 50 MB before reading, and the request's exact size after serializing (sources-2).
- **Each physical page gets an outcome**: `text`, `no-text`, `doubtful`, or `failed` (a page pdf.js cannot open, such as one behind a looping page tree, or whose contents it cannot follow, such as an image or font program the page names but lacks: pdf.js runs with `stopAtErrors`, as its usual recovery would yield the text before the error as the page's). `doubtful` is a scan with a line of typed text, or text that is mostly a font's codes: a page with images covering 30% of it whose text reaches fewer than 6% of its rows, about five lines, or with no letter or digit, or over 5% unreadable code points. The rule was frozen on calibration PDFs before held-out ones were made; images are measured only for a page whose text is that sparse, since listing a page's operators decodes its images, the heavy part of reading an ordinary PDF.
- **Text as drawn, normalized lightly.** Lines in content-stream order, joined by a space within a paragraph; a printed hyphen at a line's end kept; ligature characters spelled out; NFC. pdf.js does no layout analysis, so columns drawn line by line across the page interleave, and it drops soft hyphens, so a word split by one reads with a space.
- **The owner reviews before anything is stored**, in the add form: each page's printed label (the PDF's `/PageLabels`, else its place, or numbered from the first page's printed number), its text, and Keep or Leave out. A page read cleanly starts kept; a flagged one waits for a decision, with a link opening that page of the file in the browser's own viewer, so nothing the reader doubted is saved or dropped unseen. Saving uploads the PDF and adds the kept pages as a paged source naming it ([ADR 0026](0026-paged-documents.md), [ADR 0028](0028-original-files.md)), through the endpoints any caller uses ([ADR 0020](0020-source-content.md)): the server learns nothing new, and no AI request is made or counted.
- **AI stays a choice.** Where Braivo's AI is on, a PDF without pasted text is read this way unless the owner chooses the AI, which reads scans; a photo still goes to the AI.
- **pdf.js pinned** (`6.4.299`): the rule was calibrated, and the soft hyphen observed, on that version; an upgrade reruns the reader's browser tests.

## Alternatives rejected

- **Server extraction now**, in a Worker behind a service binding or a child process on Bun, with a lease per organization: a new isolated runtime and admission control for what the owner's browser does in under a second. It remains the plan for background extraction and for callers without a browser ([ADR 0046](0046-material-in-steps.md)).
- **pdf.js's own nested worker, or a blob URL for it**: the policy refuses a blob worker, and a nested worker is a second thread to terminate.
- **`'wasm-unsafe-eval'`** for pdf.js's WebAssembly decoders: a weaker policy for decoders a text reader barely needs.
- **Rendering each page's image beside its text**: a canvas in the worker, fonts and all, for what the browser's PDF viewer shows at `#page=N`.
- **Trusting the text layer unchecked** ([ADR 0046](0046-material-in-steps.md)): a scan with a selectable header would pass as read.
- **Honouring a PDF's "no copying" permission**: the owner brought the file to teach from; pdf.js does not enforce it, and neither does the reader.

## Consequences

- Memory is bounded only by the device: no pdf.js option bounds what a page decodes, so a hostile file can crash the owner's own tab before any deadline fires. Nothing else is harmed, and nothing is lost but what the form held: the file chosen and any title, link, or language entered, as the review exists only after a read succeeds. Containment under a process memory limit comes with server extraction.
- The classifier cannot see plausible wrong letters (a font whose character map is off by one), OCR text that is present but wrong, text hidden under an image, or a scan with five or more selectable lines; the owner's review is the check, and the source's text is what learners are quoted.
- A quote copied from the PDF with a ligature character does not match the saved text, which spells it out (sources-15).
- Measured on one laptop: Chrome, with the reader's cases passing in WebKit and Firefox too, and a slowed process as a stand-in for a slow device; phones and slower laptops are unmeasured.
- Not every damage is reported: a corrupt compressed stream reads as whatever it decodes to, so a page can still be read as `text` with part of its contents; the owner's review is the check, as for wrong letters.
- The review lists every page in one form, which grows long for a book; it is lost on leaving, as the form's other material is.
