// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { PdfReadError, readPdf } from "../lib/pdf/read.ts";
import { bomb, document, locked, pdf } from "./pdfs.ts";

// The reader as the console runs it, its worker and pdf.js real, in Chromium
// (docs/adr/0055-pdf-text-in-the-browser.md); the form around it is proved in
// sources.test.tsx against a stub.

const worksheet = () =>
  document(
    [
      { lines: ["Fernwood Spanish, unit 1", "Hola means hello.", "A well-", "known greeting."] },
      { lines: ["Adios means goodbye."] },
    ],
    // Printed as i, then 7: front matter, then the book's own numbers.
    { labels: "[0 << /S /r >> 1 << /S /D /St 7 >>]" },
  );

afterEach(() => vi.restoreAllMocks());

/** Counts the workers made and ended while `read` runs. */
async function counting<T>(read: () => Promise<T>) {
  const made = vi.spyOn(globalThis, "Worker");
  const ended = vi.spyOn(Worker.prototype, "terminate");
  const settled: { value?: T; error?: unknown } = await read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { ...settled, made: made.mock.calls.length, ended: ended.mock.calls.length };
}

describe("reading a PDF's text layer", () => {
  test("reads every page in order, labelled as the PDF prints them, in one worker it ends", async () => {
    const progress: [number, number][] = [];
    const { value, made, ended } = await counting(() =>
      readPdf(worksheet(), { onProgress: (done, pages) => progress.push([done, pages]) }),
    );
    expect(value).toEqual([
      {
        position: 1,
        label: "i",
        outcome: "text",
        text: "Fernwood Spanish, unit 1 Hola means hello. A well-known greeting.",
      },
      { position: 2, label: "7", outcome: "text", text: "Adios means goodbye." },
    ]);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect([made, ended]).toEqual([1, 1]);
  });

  test("labels nothing in a PDF without labels, leaving positions to the review", async () => {
    const pages = await readPdf(document([{ lines: ["Hola."] }]), {});
    expect(pages[0]).toEqual({ position: 1, outcome: "text", text: "Hola." });
  });

  test("marks a scan with a line of text doubtful, and a page without text as such", async () => {
    const pages = await readPdf(
      document([
        { scan: true, lines: ["Fernwood School, worksheet 3"] },
        { scan: true },
        { lines: ["Fernwood School, worksheet 3"] },
      ]),
      {},
    );
    expect(pages.map((page) => page.outcome)).toEqual(["doubtful", "no-text", "text"]);
  });

  test("reads the pages of a tree that lists itself, failing the page behind the loop", async () => {
    const pages = await readPdf(
      document([{ lines: ["One"] }, { lines: ["Two"] }], {
        // The tree, object 2, among its own kids.
        kids: ([first, second]) => [first!, 2, second!],
      }),
      {},
    );
    expect(pages[0]).toMatchObject({ position: 1, outcome: "text", text: "One" });
    expect(pages[1]).toMatchObject({ position: 2, outcome: "failed", text: "" });
  });

  test("fails a page whose contents pdf.js could not follow, rather than keep what came before", async () => {
    // Its second content stream draws an image the page does not have: the
    // header read before it is not the page.
    const encoder = new TextEncoder();
    const file = pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents [5 0 R 6 0 R] >>",
      { dict: "", bytes: encoder.encode("BT /F1 12 Tf 72 720 Td (Selectable header) Tj ET") },
      { dict: "", bytes: encoder.encode("/Missing Do") },
    ]);
    expect(await readPdf(file, {})).toEqual([{ position: 1, outcome: "failed", text: "" }]);
  });

  test.each([
    ["encrypted", () => locked()],
    ["unreadable", () => new File(["Hola, not a PDF."], "notes.pdf", { type: "application/pdf" })],
  ])("refuses a file it cannot open: %s", async (problem, file) => {
    const { error, ended } = await counting(() => readPdf(file(), {}));
    expect(error).toEqual(new PdfReadError(problem as "encrypted"));
    expect(ended).toBe(1);
  });

  test("stops past its budgets for pages and text, saying which", async () => {
    const three = document([{ lines: ["Uno"] }, { lines: ["Dos"] }, { lines: ["Tres"] }]);
    const pages = await readPdf(three, { limits: { pages: 2 } }).catch((error: unknown) => error);
    expect(pages).toMatchObject({ problem: "too-many-pages", pages: 3 });
    const text = await readPdf(three, { limits: { textBytes: 5 } }).catch(
      (error: unknown) => error,
    );
    expect(text).toMatchObject({ problem: "too-much-text" });
  });

  test("stops a decompression bomb when no page finishes in time, ending its worker", async () => {
    const file = await bomb(256 << 20);
    expect(file.size).toBeLessThan(1 << 20);
    const started = performance.now();
    const { error, ended } = await counting(() => readPdf(file, { limits: { watchdogMs: 300 } }));
    expect(error).toMatchObject({ problem: "too-slow" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(ended).toBe(1);
    // And the total deadline, however often pages finish.
    const total = await readPdf(file, { limits: { totalMs: 300 } }).catch(
      (thrown: unknown) => thrown,
    );
    expect(total).toMatchObject({ problem: "too-slow" });
  });

  test.each([
    ["while the worker loads", 0],
    ["once the PDF opened", 1],
    ["between pages", 2],
  ])("cancels %s at once, ending the worker", async (_, onProgressCall) => {
    const controller = new AbortController();
    const progress = vi.fn((done: number) => {
      if (done + 1 === onProgressCall) controller.abort(new Error("Cancelled."));
    });
    if (onProgressCall === 0) queueMicrotask(() => controller.abort(new Error("Cancelled.")));
    const book = document(Array.from({ length: 30 }, (_, index) => ({ lines: [`Page ${index}`] })));
    let cancelled = 0;
    controller.signal.addEventListener("abort", () => (cancelled = performance.now()));
    const { error, ended } = await counting(() =>
      readPdf(book, { signal: controller.signal, onProgress: progress }),
    );
    expect(error).toEqual(new Error("Cancelled."));
    expect(performance.now() - cancelled).toBeLessThan(100);
    expect(ended).toBe(1);
    // Nothing reported after the cancel.
    expect(progress).toHaveBeenCalledTimes(onProgressCall);
  });
});
