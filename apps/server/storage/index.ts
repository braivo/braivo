// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The bytes of the files content owners upload — a source's original PDF, say —
// behind one small interface, so where they are kept is an installation's
// choice (docs/adr/0028-original-files.md). No queries: what a file is lives in
// `persistence`, and `application` joins the two.

export { bucketStore } from "./bucket.ts";
export { directoryStore } from "./directory.ts";
export type { FileStore } from "./store.ts";
