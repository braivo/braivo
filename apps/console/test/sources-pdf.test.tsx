// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { type PdfPage, PdfReadError, type ReadPdf } from "../lib/pdf/read.ts";
import { school } from "./fixtures.ts";
import { answerLeaving, renderAt, stall } from "./render.tsx";

// Adding a PDF read from its own text, without AI, and reviewed before it is
// saved (sources-22, sources-23). The reader itself runs in Chromium:
// pdf-reader.browser.test.tsx.

const pdf = new File(["%PDF"], "Unidad_1.pdf", { type: "application/pdf" });
const fileId = "f".repeat(64);
const aiOff = [{ ...school, aiEnabled: false }];

const read = (position: number, text: string, extra: Partial<PdfPage> = {}): PdfPage => ({
  position,
  outcome: "text",
  text,
  ...extra,
});

/** Braivo, answering what adding a source asks, and a reader answering `pages`. */
function stubs(pages: PdfPage[] | (() => Promise<PdfPage[]>)) {
  const braivo = {
    listSources: async () => [],
    getSource: async () => ({ id: "s1", title: "Unidad 1", text: "Hola.", createdAt: "…" }),
    uploadFile: vi.fn(async () => ({ fileId })),
    addSource: vi.fn(async () => "s1"),
    readFileText: vi.fn(),
  };
  const readPdf = vi.fn<ReadPdf>(typeof pages === "function" ? pages : async () => pages);
  return { braivo, readPdf };
}

/** Attaches `file` with no text pasted, and adds it: the PDF is read for review. */
async function attach(file = pdf) {
  await screen.findByText("No material yet");
  fireEvent.change(screen.getByLabelText("Original file"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Add material" }));
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save source" }));
const decide = (position: number, choice: "Keep" | "Leave out") =>
  fireEvent.click(
    within(screen.getByRole("radiogroup", { name: `Page ${position}` })).getByRole("radio", {
      name: choice,
    }),
  );

describe("adding a PDF read from its own text", () => {
  test("where Braivo's AI is off, reads it, and saves the pages reviewed as a source naming it", async () => {
    const { braivo, readPdf } = stubs([
      read(1, "Hola means hello.", { label: "i" }),
      read(2, "Adios means goodbye.", { label: "7" }),
    ]);
    const { router } = renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });

    await attach();

    // The review takes the focus; nothing is uploaded until it is saved.
    const heading = await screen.findByRole("heading", { name: "Review the pages" });
    expect(document.activeElement).toBe(heading);
    // Focusable: a heading is not, unless told, and Chromium would leave the focus behind.
    expect(heading.tabIndex).toBe(-1);
    expect(screen.getByText(/^2 pages: 2 read\./)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Saving 2\u00A0pages; 0 left out.");
    expect(braivo.uploadFile).not.toHaveBeenCalled();
    expect(readPdf).toHaveBeenCalledWith(
      pdf,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Labelled as the PDF prints them, the text correctable.
    expect(screen.getByLabelText<HTMLInputElement>("Printed page of page 1").value).toBe("i");
    expect(screen.getByLabelText<HTMLInputElement>("Printed page of page 2").value).toBe("7");
    fireEvent.change(screen.getByLabelText("Text of page 2"), {
      target: { value: "Adiós means goodbye." },
    });
    // What was pasted or read is the file's: the text field is not a second source.
    expect(screen.getByLabelText<HTMLTextAreaElement>("Text").readOnly).toBe(true);

    save();

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(braivo.uploadFile).toHaveBeenCalledWith(
      { organizationId: "org-1", file: pdf },
      expect.anything(),
    );
    expect(braivo.addSource).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        title: "Unidad 1",
        pages: [
          { page: "i", text: "Hola means hello." },
          { page: "7", text: "Adiós means goodbye." },
        ],
        original: fileId,
      },
      { signal: expect.any(AbortSignal) },
    );
    // No model was asked, so no AI request is recorded (generation-10).
    expect(braivo.readFileText).not.toHaveBeenCalled();
  });

  test("where Braivo's AI is on, reads the PDF's own text unless the owner chooses the AI", async () => {
    const { braivo, readPdf } = stubs([read(1, "Hola.")]);
    renderAt("/example/sources", { braivo, readPdf });
    await screen.findByText("No material yet");
    fireEvent.change(screen.getByLabelText("Original file"), { target: { files: [pdf] } });

    const choice = screen.getByRole("radiogroup", { name: "Without pasted text, read" });
    expect(
      within(choice)
        .getByRole("radio", { name: "The text in the PDF, without AI" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));

    expect(await screen.findByRole("heading", { name: "Review the pages" })).toBeTruthy();
    expect(braivo.readFileText).not.toHaveBeenCalled();
    // Chosen once the review is open, no longer.
    expect(screen.queryByRole("radiogroup", { name: "Without pasted text, read" })).toBeNull();
  });

  test("numbers the pages from the first one's printed number, each still correctable", async () => {
    const { braivo, readPdf } = stubs([read(1, "Uno."), read(2, "Dos."), read(3, "Tres.")]);
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();
    await screen.findByRole("heading", { name: "Review the pages" });
    const labels = () =>
      [1, 2, 3].map(
        (position) =>
          screen.getByLabelText<HTMLInputElement>(`Printed page of page ${position}`).value,
      );
    // Without labels in the PDF, each page's place.
    expect(labels()).toEqual(["1", "2", "3"]);
    const first = screen.getByLabelText("The first page is printed page");

    fireEvent.change(first, { target: { value: "12" } });
    expect(labels()).toEqual(["12", "13", "14"]);
    fireEvent.change(first, { target: { value: "" } });
    expect(labels()).toEqual(["1", "2", "3"]);
    fireEvent.change(first, { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Printed page of page 3"), { target: { value: "vii" } });
    save();

    await vi.waitFor(() =>
      expect(braivo.addSource).toHaveBeenCalledWith(
        expect.objectContaining({
          pages: [
            { page: "5", text: "Uno." },
            { page: "6", text: "Dos." },
            { page: "vii", text: "Tres." },
          ],
        }),
        expect.anything(),
      ),
    );
  });

  test("waits for the owner to keep or leave out each page the reader doubted, saying why", async () => {
    const { braivo, readPdf } = stubs([
      read(1, "Hola means hello."),
      read(2, "Fernwood School", { outcome: "doubtful" }),
      read(3, "", { outcome: "no-text" }),
      read(4, "", { outcome: "failed" }),
    ]);
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();
    await screen.findByRole("heading", { name: "Review the pages" });
    expect(screen.getByText(/^4 pages: 1 read, 2 to check, 1 without text\./)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "3\u00A0pages to decide: keep each, or leave it out.",
    );
    // A page read cleanly is kept; one doubted waits for a decision, with the
    // page itself a click away to check against.
    expect(
      within(screen.getByRole("radiogroup", { name: "Page 1" }))
        .getByRole("radio", { name: "Keep" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    for (const position of [2, 3, 4]) {
      const group = screen.getByRole("radiogroup", { name: `Page ${position}` });
      expect(within(group).queryByRole("radio", { checked: true })).toBeNull();
      const open = screen.getByRole("link", { name: `Open page ${position} of the PDF` });
      expect(open.getAttribute("href")).toMatch(new RegExp(`^blob:.*#page=${position}$`));
      expect(open.getAttribute("target")).toBe("_blank");
    }
    expect(screen.getByText(/may not be what the page shows/)).toBeTruthy();

    save();
    const undecided = await screen.findByRole("alert");
    expect(undecided.textContent).toBe("Keep page 2 or leave it out.");
    expect(document.activeElement).toBe(
      within(screen.getByRole("radiogroup", { name: "Page 2" })).getByRole("radio", {
        name: "Keep",
      }),
    );
    decide(2, "Leave out");
    decide(3, "Keep");
    decide(4, "Leave out");
    // Kept without words: its text is asked for, at its field.
    save();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Page 3 has no words to keep: paste its text, or leave it out.",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Text of page 3"));
    fireEvent.change(screen.getByLabelText("Text of page 3"), { target: { value: "Gracias." } });
    expect(screen.getByRole("status").textContent).toBe("Saving 2\u00A0pages; 2 left out.");
    save();

    await vi.waitFor(() =>
      expect(braivo.addSource).toHaveBeenCalledWith(
        expect.objectContaining({
          pages: [
            { page: "1", text: "Hola means hello." },
            { page: "3", text: "Gracias." },
          ],
        }),
        expect.anything(),
      ),
    );
  });

  test("refuses, before sending, a label Braivo would refuse, and keeping no page", async () => {
    const { braivo, readPdf } = stubs([read(1, "Uno."), read(2, "Dos.")]);
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();
    await screen.findByRole("heading", { name: "Review the pages" });

    const label = screen.getByLabelText("Printed page of page 2");
    fireEvent.change(label, { target: { value: "x".repeat(17) } });
    save();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Page 2's printed page needs 1 to 16 characters, such as 12 or iv.",
    );
    expect(document.activeElement).toBe(label);
    expect(label.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(label, { target: { value: "2" } });
    decide(1, "Leave out");
    decide(2, "Leave out");
    save();
    expect((await screen.findByRole("alert")).textContent).toBe("Keep at least one page.");
    expect(braivo.uploadFile).not.toHaveBeenCalled();
  });

  test("discards a review, keeping the rest of the form", async () => {
    const { braivo, readPdf } = stubs([read(1, "Uno.")]);
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();
    await screen.findByRole("heading", { name: "Review the pages" });

    fireEvent.click(screen.getByRole("button", { name: "Discard the review" }));

    expect(screen.queryByRole("heading", { name: "Review the pages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add material" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Unidad 1");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Text").readOnly).toBe(false);
  });

  test("says how far reading has come, and cancels it, leaving the form as it was", async () => {
    let signal: AbortSignal | undefined;
    const { braivo, readPdf } = stubs(() => Promise.reject(new Error("unused")));
    readPdf.mockImplementation(async (_file, options) => {
      signal = options.signal;
      options.onProgress?.(0, 3);
      return stall(options);
    });
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();

    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Reading the PDF: page 0 of 3…"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Adding the same material again adds nothing.",
      ),
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Original file").files?.[0]).toBe(pdf);
  });

  test("asks before leaving while a PDF is read, and stops reading once the owner leaves", async () => {
    const confirm = answerLeaving(false);
    let signal: AbortSignal | undefined;
    const { braivo, readPdf } = stubs([]);
    readPdf.mockImplementation(async (_file, options) => {
      signal = options.signal;
      return stall(options);
    });
    const { router } = renderAt("/example/sources", {
      organizations: aiOff,
      braivo: { ...braivo, listCourses: async () => [] },
      readPdf,
    });
    await attach();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const toCourses = () =>
      router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });

    // Nothing is sent yet: the form is all there is of the material.
    void toCourses();
    await vi.waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        "Leave this page? The material you entered will be lost.",
      ),
    );
    expect(signal?.aborted).toBe(false);
    confirm.mockReturnValue(true);
    await toCourses();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  test.each([
    [new PdfReadError("encrypted"), "This PDF is locked: save an unlocked copy and attach that."],
    [
      new PdfReadError("too-many-pages", 1200),
      "This PDF has 1,200 pages, more than the 1,000 Braivo reads at once: split it, adding a chapter at a time.",
    ],
    [
      new PdfReadError("too-slow"),
      "Reading this PDF took too long, so it was stopped: it may be damaged or built unusually. Save it again as a PDF, or paste its text in the Text field.",
    ],
    [
      new PdfReadError("unreadable"),
      "This PDF could not be read: it may be damaged. Save it again as a PDF, or paste its text in the Text field.",
    ],
  ])("says what to do with a PDF it cannot read, at the file: %s", async (failure, message) => {
    const { braivo, readPdf } = stubs(() => Promise.reject(failure));
    renderAt("/example/sources", { organizations: aiOff, braivo, readPdf });
    await attach();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    const file = screen.getByLabelText("Original file");
    expect(document.activeElement).toBe(file);
    expect(file.closest("[data-slot=field]")?.contains(alert)).toBe(true);
    expect(braivo.uploadFile).not.toHaveBeenCalled();
  });
});
