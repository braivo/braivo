# 0028: Originals are content-addressed files in a store the installation chooses

Status: accepted (2026-09-24)

## Context

A source is text ([ADR 0020](0020-source-content.md)), extracted by whoever holds the file, and the file itself was lost to Braivo: a content owner reviewing a citation could not open the page it came from, a better extractor — OCR, Braivo's own AI — had nothing to start again from, and "upload your materials" meant "upload your text". Self-hosters keep files in different places: a disk, Cloudflare R2, Google Cloud Storage, MinIO.

## Decision

- **A `storage` module with two operations.** `FileStore` is `put(key, bytes, contentType)` and `get(key)`. `directoryStore` keeps files under a directory, written beside and renamed into place; `bucketStore` wraps Bun's S3 client, which speaks to R2, Google Cloud Storage's interoperability API, MinIO, and S3 alike. Keys are checked segment by segment and can never leave the directory or name `..`.
- **Chosen by `BRAIVO_FILES`.** `s3://<bucket>` with Bun's own `S3_*` variables, or an absolute path. Unset, the installation keeps no files, and its file routes answer 501 saying so: text-only Braivo remains a complete product.
- **A file is its SHA-256.** `POST …/files` takes the raw body, typed by `Content-Type`, hashes it, stores the bytes under `organizations/<organizationId>/files/<sha256>` and records the file in the `file` table, and answers the hash as `fileId`. Uploading the same bytes again adds no record and answers the same, which is [ADR 0024](0024-idempotent-authoring.md)'s rule for files — except its content type, which becomes the one it was last uploaded as, as the store's does: a PDF first sent as `application/octet-stream` is fixed by sending it again. Bytes first, record second, so a record always has bytes behind it; and the bytes are written on every upload, so a store that lost them — or a new bucket an operator moved to — is repaired by uploading the file again. Until then, reading it answers 500.
- **A source names its original.** `original` on `POST …/sources` is a `fileId` of the same organization's, enforced by a composite foreign key. It is part of the source's digest, marked `original:` so it cannot be read as another field: the same words from another file are another source, and a source, being immutable, gains an original only by being added again with it.
- **Uploads prove they are not a form.** The JSON routes refuse any other content type, so a page elsewhere cannot write through a signed-in browser. A file cannot be JSON, so the upload route refuses instead what a browser sends cross-site without a preflight — no type, a form's, `text/plain` — and any foreign `Origin`.
- **Downloads never render.** `GET …/files/:fileId` answers `Content-Disposition: attachment`, `Content-Security-Policy: sandbox`, and `nosniff`, for administrators only. An uploaded HTML file shown inline from Braivo's origin would run as Braivo.
- **Buffered, at most 50 MB.** The body is hashed before it is stored, so it is read whole. Enough for a textbook's PDF or a worksheet's scan.
- **The CLI uploads with the text.** `braivo sources add … --original libro.pdf` uploads the file, typed by its extension, once the text is known to be sendable, and adds the source naming it.
- **`braivo mcp` uploads nothing.** An agent reads material that may steer it, and an MCP server that uploaded a path the agent named would read for it whatever that material asked: a tax return is as much a valid PDF as a textbook. So its tools take text only, and a file goes up through the console or a command the person runs, `braivo sources add --original`. Should agents need to attach originals, the person will name the folders they may read from when starting the server.
- **The CLI uploads only material.** `--original` takes what is, by its extension, a document (PDF, Office, OpenDocument, EPUB), an image other than SVG, audio, or video — judged on the file a link resolves to, and refused before it is read — so a mistyped `~/.ssh/id_rsa` or `.env` stays on the machine.

## Alternatives rejected

- **`braivo mcp` uploading an absolute path, limited to documents and media by extension.** It stops `~/.ssh/id_rsa` but not `~/Documents/passport.pdf`.

## Consequences

- Video will not fit in 50 MB. It goes straight to the store with a presigned upload (`S3Client#presign`), the server recording it afterwards — a second path, added when generated or uploaded video needs it.
- Learners cannot open an original: a book's PDF is the school's to share or not, which is a product decision, not this one.
- The CLI uploads an original before Braivo checks the source; a source then refused leaves its file stored, unreferenced, and the retry that fixes it finds the same file.
- Nothing deletes a file. A source keeps its original (restricted), and deletion waits with sources' own.
