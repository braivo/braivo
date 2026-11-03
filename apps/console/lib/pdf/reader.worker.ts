// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Everything that parses a PDF runs here, in a dedicated worker the main thread
// terminates on completion, a stop, or a cancel: one worker per read
// (docs/adr/0055-pdf-text-in-the-browser.md). pdf.js's own worker module is
// imported and exposed as `globalThis.pdfjsWorker`, so pdf.js runs it in this
// thread: no nested worker, blob URL, or eval, which the console's
// `script-src 'self'` would refuse (docs/adr/0049-app-security-headers.md).

import { getDocument, OPS, type PDFPageProxy } from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";

import {
  assemble,
  type Box,
  classify,
  coverage,
  type Item,
  type Outcome,
  textFeatures,
} from "./text.ts";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

/** One physical page as read: `label` is the PDF's own (`/PageLabels`), if it has any. */
export type PdfPage = { position: number; label?: string; outcome: Outcome; text: string };

/** Why a read stopped. */
export type PdfStop = "encrypted" | "unreadable" | "too-many-pages" | "too-much-text";

export type ReaderRequest = { file: File; maxPages: number; maxTextBytes: number };

export type ReaderMessage =
  | { type: "opened"; pages: number }
  | { type: "page"; page: PdfPage }
  | { type: "done" }
  | { type: "stopped"; stop: PdfStop };

const post = (message: ReaderMessage) => postMessage(message);

class Stopped extends Error {
  constructor(readonly stop: PdfStop) {
    super(stop);
  }
}

self.onmessage = async ({ data }: MessageEvent<ReaderRequest>) => {
  try {
    await read(data);
    post({ type: "done" });
  } catch (error) {
    // An error pdf.js did not turn into a page's failure, or the file no longer
    // readable: a rejection here never reaches the main thread's `onerror`.
    post({ type: "stopped", stop: error instanceof Stopped ? error.stop : "unreadable" });
  }
};

async function read({ file, maxPages, maxTextBytes }: ReaderRequest) {
  // Support files come from this origin, and only when a PDF needs one: the
  // standard fonts' metrics, CJK character maps, and JavaScript image decoders
  // (`tooling/pdfjs-files.ts`). No WebAssembly: the console's policy would
  // refuse to compile it, and the decoders' JavaScript fallbacks suffice.
  const files = new URL("/pdfjs/", self.location.href).href;
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: true,
    useWasm: false,
    // The decoders' fallbacks are fetched from here by name, wasm or not.
    wasmUrl: `${files}wasm/`,
    cMapUrl: `${files}cmaps/`,
    standardFontDataUrl: `${files}standard_fonts/`,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    enableXfa: false,
    // A page whose contents pdf.js cannot follow, such as a missing image or
    // font program, fails rather than yielding the text read before the error
    // as the page's. Not every damage is reported: a corrupt compressed stream
    // still reads as what it decodes to (docs/adr/0055-pdf-text-in-the-browser.md).
    stopAtErrors: true,
  });
  const document = await task.promise.catch((error: unknown) => {
    // Locked to open. A PDF only restricting copying opens and is read: pdf.js
    // does not enforce permissions, and the owner brought it.
    const locked = (error as { name?: string } | undefined)?.name === "PasswordException";
    throw new Stopped(locked ? "encrypted" : "unreadable");
  });
  const pages = document.numPages;
  post({ type: "opened", pages });
  if (pages > maxPages) throw new Stopped("too-many-pages");
  const labels = await document.getPageLabels().catch(() => null);

  let textBytes = 0;
  for (let position = 1; position <= pages; position++) {
    const label = labels?.[position - 1] || undefined;
    let page: PDFPageProxy;
    try {
      page = await document.getPage(position);
    } catch {
      // A broken page tree, such as one listing itself, fails its page alone.
      post({ type: "page", page: { position, label, outcome: "failed", text: "" } });
      continue;
    }
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const items: Item[] = [];
    const boxes: Box[] = [];
    try {
      // Streamed, so a page's text is limited while it is produced: one page
      // can hold a gigabyte of it.
      const reader = page
        .streamTextContent({ disableNormalization: true })
        .getReader() as ReadableStreamDefaultReader<{ items: unknown[] }>;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value.items as {
          str?: string;
          transform: number[];
          width: number;
          height: number;
          hasEOL: boolean;
        }[]) {
          if (item.str === undefined) continue;
          const [, , , d, x, y] = item.transform as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          const h = item.height || Math.abs(d);
          items.push({ str: item.str, x, y, w: item.width, h, eol: item.hasEOL });
          if (item.str.trim()) {
            boxes.push([x - x0, y - y0 - h * 0.2, x - x0 + item.width, y - y0 + h * 0.8]);
          }
          textBytes += utf8Bytes(item.str);
        }
        if (textBytes > maxTextBytes) throw new Stopped("too-much-text");
      }
    } catch (error) {
      if (error instanceof Stopped) throw error;
      post({ type: "page", page: { position, label, outcome: "failed", text: "" } });
      continue;
    }
    const text = assemble(items);
    const features = textFeatures(text, boxes, x1 - x0, y1 - y0);
    const fromText = classify(features);
    const outcome =
      fromText === "needs-images" ? classify(features, await imageCover(page)) : fromText;
    page.cleanup();
    post({ type: "page", page: { position, label, outcome, text } });
  }
  await task.destroy();
}

/**
 * The share of the page images cover, or -1 when its operators cannot be read.
 * Each image paints the unit square under the current matrix. Listing the
 * operators decodes the page's images, so it is asked only of a page whose
 * text is sparse.
 */
async function imageCover(page: PDFPageProxy): Promise<number> {
  const [x0, y0, x1, y1] = page.view as [number, number, number, number];
  let operators;
  try {
    operators = await page.getOperatorList();
  } catch {
    return -1;
  }
  const { fnArray, argsArray } = operators as { fnArray: number[]; argsArray: unknown[][] };
  const boxes: Box[] = [];
  const paint = (m: Matrix) => {
    const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
    const xs = corners.map(([x]) => x - x0);
    const ys = corners.map(([, y]) => y - y0);
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const saved: Matrix[] = [];
  for (const [index, operator] of fnArray.entries()) {
    const args = argsArray[index] ?? [];
    switch (operator) {
      case OPS.save:
      case OPS.paintFormXObjectBegin:
        saved.push(matrix);
        if (operator === OPS.paintFormXObjectBegin && args[0]) {
          matrix = multiply(matrix, args[0] as Matrix);
        }
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
        matrix = saved.pop() ?? matrix;
        break;
      case OPS.transform:
        matrix = multiply(matrix, args as Matrix);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        paint(matrix);
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, scaleX, scaleY, positions] = args as [unknown, number, number, number[]];
        for (let i = 0; i + 1 < positions.length; i += 2) {
          paint(multiply(matrix, [scaleX, 0, 0, scaleY, positions[i]!, positions[i + 1]!]));
        }
        break;
      }
    }
  }
  return coverage(boxes, x1 - x0, y1 - y0);
}

/** An affine matrix `[a b c d e f]`, as in PDF. */
type Matrix = [number, number, number, number, number, number];

/** `n` applied first, then `m`. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** UTF-8 length without encoding: 1 to 3 bytes per UTF-16 unit, 4 per surrogate pair. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
