// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { PdfPage, PdfStop, ReaderMessage, ReaderRequest } from "./reader.worker.ts";

export type { PdfPage } from "./reader.worker.ts";
export type { Outcome } from "./text.ts";

/**
 * 600 pages read in under 3 s on a laptop (ADR 0055), so these budgets leave
 * room for a slow device. They bound time and output, not memory:
 * no pdf.js option bounds what a page decodes, so a hostile file can still
 * exhaust the tab (docs/adr/0055-pdf-text-in-the-browser.md).
 */
export const PDF_LIMITS = {
  pages: 1000,
  /**
   * Braivo's limit on a source's request (`MAX_SOURCE_BYTES`), over the
   * strings pdf.js yields, as they stream: it stops a page producing endless
   * text, not a source too big, which saving checks on the request itself.
   */
  textBytes: 10_000_000,
  /** Without a page finishing: a decompression bomb sits inside one page. */
  watchdogMs: 5_000,
  totalMs: 60_000,
};

/** Why reading a PDF stopped: the worker's own, `too-slow` at a deadline, `failed` when it crashed. */
export type PdfReadProblem = PdfStop | "too-slow" | "failed";

export class PdfReadError extends Error {
  constructor(
    readonly problem: PdfReadProblem,
    /** Its page count, once it opened: what `too-many-pages` is about. */
    readonly pages?: number,
  ) {
    super(`The PDF could not be read: ${problem}`);
    this.name = "PdfReadError";
  }
}

export type ReadPdf = (
  file: File,
  options: {
    signal?: AbortSignal;
    /** After it opens (`done` 0) and after each page. */
    onProgress?: (done: number, pages: number) => void;
    /** Tests' smaller budgets. */
    limits?: Partial<typeof PDF_LIMITS>;
  },
) => Promise<PdfPage[]>;

/**
 * Reads a PDF's text layer in a dedicated worker, every physical page in
 * order with how far to trust its text. Rejects with a `PdfReadError`, or
 * with the signal's reason once it aborts. The main thread never parses the
 * file: it posts the `File`, and terminates the worker on completion, a stop,
 * a deadline, or the signal, so nothing keeps running for nobody.
 */
export const readPdf: ReadPdf = (file, { signal, onProgress, limits: overrides }) => {
  const limits = { ...PDF_LIMITS, ...overrides };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = new Worker(new URL("./reader.worker.ts", import.meta.url), {
      type: "module",
      name: "pdf-reader",
    });
    const pages: PdfPage[] = [];
    let count: number | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(() => stop(new PdfReadError("too-slow", count)), limits.totalMs);
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop(new PdfReadError("too-slow", count)), limits.watchdogMs);
    };
    const abort = () => stop(signal!.reason);
    const end = () => {
      worker.terminate();
      clearTimeout(watchdog);
      clearTimeout(total);
      signal?.removeEventListener("abort", abort);
    };
    function stop(reason: unknown) {
      end();
      reject(reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<ReaderMessage>) => {
      watch();
      switch (data.type) {
        case "opened":
          count = data.pages;
          onProgress?.(0, data.pages);
          break;
        case "page":
          pages.push(data.page);
          onProgress?.(pages.length, count!);
          break;
        case "done":
          end();
          resolve(pages);
          break;
        case "stopped":
          stop(new PdfReadError(data.stop, count));
      }
    };
    // The worker failing to load, or an exception outside its read.
    worker.onerror = (event) => {
      event.preventDefault();
      stop(new PdfReadError("failed", count));
    };
    worker.postMessage({
      file,
      maxPages: limits.pages,
      maxTextBytes: limits.textBytes,
    } satisfies ReaderRequest);
    watch();
  });
};
