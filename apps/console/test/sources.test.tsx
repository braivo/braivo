// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError } from "@braivo/server/client";
import { createBrowserHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS, bodyDeadline } from "../lib/deadline.ts";
import { school, annex, saludos, authoring } from "./fixtures.ts";
import {
  stall,
  waitOut,
  renderAt,
  expectProxyTimeoutExplained,
  expectDesktopAgentGuide,
  expectLockedInFocus,
  answerLeaving,
} from "./render.tsx";

describe("the console", () => {
  test("lists an organization's material, saying what each keeps", async () => {
    renderAt("/example/sources", {
      braivo: {
        listSources: async () => [
          {
            id: "s1",
            title: "Los animales",
            url: "https://www.youtube.com/watch?v=animales",
            language: "es",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          { id: "s2", title: "Mi libro", original: "f".repeat(64), createdAt: "…" },
        ],
      },
    });

    const video = await screen.findByRole("link", { name: "Los animales" });
    expect(video.getAttribute("href")).toBe("/example/sources/s1");
    const [first, second] = within(screen.getByRole("main")).getAllByRole("listitem");
    expect(within(first!).getByText("es")).toBeTruthy();
    expect(within(second!).getByText("Original kept")).toBeTruthy();
  });

  /** Fills the add form; `file` goes in as the original. */
  function addMaterial(fields: {
    title: string;
    text: string;
    url?: string;
    language?: string;
    file?: File;
  }) {
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: fields.title } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: fields.text } });
    if (fields.url) {
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: fields.url } });
    }
    if (fields.language) {
      fireEvent.change(screen.getByLabelText("Language"), { target: { value: fields.language } });
    }
    if (fields.file) {
      fireEvent.change(screen.getByLabelText("Original file"), {
        target: { files: [fields.file] },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));
  }

  /** Braivo's source reads, answering the one source added. */
  const added = {
    listSources: async () => [],
    getSource: async () => ({ id: "s1", title: "Unidad 1", text: "Hola.", createdAt: "…" }),
  };

  test("adds pasted text as a source with its link and language, and opens it", async () => {
    const addSource = vi.fn(async () => "s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Unidad 1",
      text: "Hola.",
      url: "https://example.com/unidad-1",
      language: "es",
    });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(addSource).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        title: "Unidad 1",
        text: "Hola.",
        url: "https://example.com/unidad-1",
        language: "es",
        original: undefined,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("titles material from its file's name, never over a title typed", async () => {
    renderAt("/example/sources", { braivo: { listSources: async () => [] } });
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const attach = (name: string) =>
      fireEvent.change(screen.getByLabelText("Original file"), {
        target: { files: [new File(["%PDF"], name, { type: "application/pdf" })] },
      });

    attach("Unidad_1_Saludos.pdf");
    expect(title.value).toBe("Unidad 1 Saludos");
    // Another file, the title untouched: replaced.
    attach("Unidad_2.final.pdf");
    expect(title.value).toBe("Unidad 2.final");
    // Typed, even to the same value: the person's now, kept.
    fireEvent.input(title, { target: { value: "Unidad 2.final" } });
    attach("Unidad_3.pdf");
    expect(title.value).toBe("Unidad 2.final");
    fireEvent.input(title, { target: { value: "Greetings" } });
    attach("Unidad_4.pdf");
    expect(title.value).toBe("Greetings");
  });

  test("suggests languages by name, as the tag Braivo stores", async () => {
    renderAt("/example/sources", { braivo: { listSources: async () => [] } });

    const language = await screen.findByLabelText("Language");
    const list = document.getElementById(language.getAttribute("list")!)!;
    expect(list.querySelector('option[value="es"]')?.textContent).toBe("Spanish");
    expect(list.querySelector('option[value="pl"]')?.textContent).toBe("Polish");
  });

  test("sends a language named in full as its tag, and any other as typed", async () => {
    const addSource = vi.fn(async (_source: { language?: string }) => "s1");
    const sent = async (language: string) => {
      const { router } = renderAt("/example/sources", { braivo: { ...added, addSource } });
      await screen.findByText("No material yet");
      addMaterial({ title: "Unidad 1", text: "Hola.", language });
      await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
      cleanup();
      return addSource.mock.lastCall?.[0].language;
    };

    // Where a browser shows tags alone (iOS Safari), the name typed in full.
    expect(await sent(" sPaNiSh ")).toBe("es");
    expect(await sent("Polish")).toBe("pl");
    // Any language with a two-letter tag, not only those suggested.
    expect(await sent("Czech")).toBe("cs");
    // A name two tags share, one deprecated: the current one.
    expect(await sent("Romanian")).toBe("ro");
    // `ak`, never `tw`, which some engines also name Akan.
    expect(await sent("Akan")).toBe("ak");
    expect(await sent("es-MX")).toBe("es-MX");
    // Not one it knows: Braivo's refusal says why.
    expect(await sent("Klingon")).toBe("Klingon");
  });

  test("holds the form still while it is sent, the focus kept where it was", async () => {
    const adding = Promise.withResolvers<string>();
    const addSource = vi.fn(() => adding.promise);
    renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");
    const button = screen.getByRole("button", { name: "Add material" });
    button.focus();

    addMaterial({ title: "Unidad 1", text: "Hola." });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expectLockedInFocus(button);
    // Enter in a field submits however the button is marked.
    fireEvent.submit(button.closest("form")!);
    // Nothing typed meanwhile, which would not be what was added.
    for (const label of ["Title", "Text", "Link", "Language"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
    }
    expect((screen.getByLabelText("Original file") as HTMLInputElement).disabled).toBe(true);
    // A disabled fieldset would disable the button too; the test DOM does not apply it.
    expect(button.closest("fieldset")?.disabled).toBe(false);
    expect(addSource).toHaveBeenCalledTimes(1);
    adding.resolve("s1");
    expect(await screen.findByRole("heading", { name: "Unidad 1" })).toBeTruthy();
  });

  test("leaves an owner where they went when the source they left is added", async () => {
    const adding = Promise.withResolvers<string>();
    const addSource = vi.fn(() => adding.promise);
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        // Annex's sources still loading when the source is added.
        listSources: (organizationId: string) =>
          organizationId === "org-1" ? Promise.resolve([]) : new Promise(() => {}),
        addSource,
      },
      organizations: [school, annex],
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    void router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "annex" },
    });
    adding.resolve("s1");
    await adding.promise;

    expect(router.history.location.pathname).toBe("/annex/sources");
  });

  test("leaves an owner on the page they returned to when the source they left is added", async () => {
    const adding = Promise.withResolvers<string>();
    let stored = false;
    const addSource = vi.fn(async () => {
      const sourceId = await adding.promise;
      stored = true;
      return sourceId;
    });
    // Braivo lists the source once it is stored.
    const listSources = async () =>
      stored ? [{ id: "s1", title: "Unidad 1", createdAt: "…" }] : [];
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, listSources, addSource, listCourses: async () => [] },
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });
    adding.resolve("s1");
    await adding.promise;

    expect(router.history.location.pathname).toBe("/example/sources");
    // Read before it was stored, the list is read again.
    expect(await screen.findByRole("link", { name: "Unidad 1" })).toBeTruthy();
  });

  const LEAVE_MATERIAL = "Leave this page? The material you entered will be lost.";

  test("asks before leaving material entered but not added, and keeps it if the owner stays", async () => {
    const confirm = answerLeaving(false);
    const { router } = renderAt("/example/sources", {
      braivo: { listSources: async () => [], listCourses: async () => [] },
      organizations: [school, annex],
    });
    const text = (await screen.findByLabelText("Text")) as HTMLTextAreaElement;
    const toCourses = () =>
      router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });

    // Blank, there is nothing to lose.
    fireEvent.change(text, { target: { value: "  " } });
    await toCourses();
    expect(confirm).not.toHaveBeenCalled();
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });

    const pasted = (await screen.findByLabelText("Text")) as HTMLTextAreaElement;
    fireEvent.change(pasted, { target: { value: "Hola." } });
    // Blocked, the navigation never settles.
    void toCourses();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_MATERIAL));
    expect(router.history.location.pathname).toBe("/example/sources");
    expect(screen.getByLabelText("Text")).toBe(pasted);
    expect(pasted.value).toBe("Hola.");

    // Another organization's Sources is another page, though the same route.
    void router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "annex" },
    });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(router.history.location.pathname).toBe("/example/sources");
    expect(pasted.value).toBe("Hola.");
    // A changed hash is not.
    await router.navigate({ to: ".", hash: "add-material" });
    expect(router.history.location.hash).toBe("#add-material");
    expect(confirm).toHaveBeenCalledTimes(2);

    // A file alone is material too, the title it filled in cleared; agreeing leaves.
    fireEvent.change(pasted, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Original file"), {
      target: { files: [new File(["%PDF"], "Unidad_1.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    confirm.mockReturnValue(true);
    await toCourses();
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(router.history.location.pathname).toBe("/example");
  });

  test("asks before going back, reloading, or closing the tab from material entered but not added", async () => {
    const confirm = answerLeaving(false);
    // The browser's Back, which a memory history never blocks.
    window.history.replaceState(null, "", "/example");
    const history = createBrowserHistory();
    onTestFinished(() => {
      history.destroy();
      window.history.replaceState(null, "", "/");
    });
    const { router } = renderAt("/example", {
      braivo: { listSources: async () => [], listCourses: async () => [] },
      history,
    });
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });
    // Reloading or closing the tab asks when `beforeunload` is cancelled.
    const asksOnUnload = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    const title = await screen.findByLabelText("Title");
    expect(asksOnUnload()).toBe(false);
    fireEvent.change(title, { target: { value: "Unidad 1" } });
    expect(asksOnUnload()).toBe(true);

    window.history.back();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_MATERIAL));
    await vi.waitFor(() => expect(window.location.pathname).toBe("/example/sources"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Unidad 1");
  });

  test("asks to leave material a failed add kept, but not material it opened once added", async () => {
    const confirm = answerLeaving(false);
    const addSource = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockResolvedValueOnce("s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource, listCourses: async () => [] },
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });
    await screen.findByText("The material could not be added. Try again.");
    void router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_MATERIAL));
    expect(router.history.location.pathname).toBe("/example/sources");

    fireEvent.click(screen.getByRole("button", { name: "Add material" }));
    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("stops uploading and reading a file nobody is waiting for once the owner leaves", async () => {
    let signal: AbortSignal | undefined;
    let uploading: AbortSignal | undefined;
    const readFileText = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>(() => {});
    });
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          uploading = options?.signal;
          return { fileId: "f".repeat(64) };
        },
        readFileText,
        addSource: async () => "s1",
      },
      organizations: [school, annex],
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    // The same page, another organization's.
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "annex" },
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(uploading?.aborted).toBe(true);
  });

  test("has Braivo's AI read an attached file when no text is pasted", async () => {
    const pages = [{ page: "12", text: "Hola significa hello." }];
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const readFileText = vi.fn(async () => pages);
    const addSource = vi.fn(async () => "s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, uploadFile, readFileText, addSource },
    });
    await screen.findByText("No material yet");
    // A link is kept for reference: nothing promises it is fetched.
    expect(screen.getByText(/Braivo does not import what it links to/)).toBeTruthy();

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(readFileText).toHaveBeenCalledWith(
      { organizationId: "org-1", fileId: "f".repeat(64) },
      { signal: expect.any(AbortSignal) },
    );
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Mi libro", pages, original: "f".repeat(64) }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("says which step is under way while material is added", async () => {
    const uploading = Promise.withResolvers<{ fileId: string }>();
    const reading = Promise.withResolvers<{ page: string; text: string }[]>();
    const adding = Promise.withResolvers<string>();
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: () => uploading.promise,
        readFileText: () => reading.promise,
        addSource: () => adding.promise,
      },
    });
    await screen.findByText("No material yet");
    // Present from the start, so what it says next is announced.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Adding the same material again adds nothing.");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });
    await vi.waitFor(() => expect(status.textContent).toBe("Uploading the file…"));
    uploading.resolve({ fileId: "f".repeat(64) });
    await vi.waitFor(() => expect(status.textContent).toMatch(/reading the file.*a few minutes/));
    reading.resolve([{ page: "1", text: "Hola." }]);
    await vi.waitFor(() => expect(status.textContent).toBe("Adding…"));
    adding.resolve("s1");
    expect(await screen.findByRole("heading", { name: "Unidad 1" })).toBeTruthy();
  });

  test("asks for a file's text, uploading nothing, where Braivo's AI is off", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", {
      organizations: [{ ...school, aiEnabled: false }],
      braivo: { ...added, uploadFile, addSource },
    });
    await screen.findByText("No material yet");
    // Said before anything is prepared: material can be added, not drafted from here.
    const form = screen.getByRole("form", { name: "Add material" });
    expect(form.textContent).toMatch(/off for this organization.*not draft a course from it here/);
    expectDesktopAgentGuide(form);
    // Neither the hint nor an empty form's refusal promises reading.
    expect(screen.queryByText(/for Braivo's AI to read/)).toBeNull();
    addMaterial({ title: "Mi libro", text: "" });
    expect(await screen.findByText("Paste the material's text.")).toBeTruthy();
    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "", file: pdf });
    const refused = await screen.findByText(/It cannot read the file/);
    expect(refused.textContent).toMatch(
      /off for this organization.*paste its text in the Text field/,
    );
    expect(uploadFile).not.toHaveBeenCalled();

    // Its text pasted, the file is kept beside it, unread.
    addMaterial({ title: "Mi libro", text: "Hola.", file: pdf });
    await vi.waitFor(() =>
      expect(addSource).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Hola.", original: "f".repeat(64) }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("says Braivo's AI is off, not the operator's settings, when it refuses reading", async () => {
    const off = new BraivoError(
      501,
      "Braivo answered 501 reading a file's text.",
      "This Braivo installation has no AI of its own: its operator has not set ANTHROPIC_API_KEY. Use your own desktop agent through braivo mcp.",
      "AI_UNAVAILABLE",
    );
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        readFileText: vi.fn().mockRejectedValue(off),
      },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });

    const alert = await screen.findByText(/off for this organization/);
    expect(alert.textContent).toMatch(/Ask whoever runs Braivo for you to turn it on/);
    expect(alert.textContent).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  test("keeps Braivo's words when storage, not its AI, refuses reading", async () => {
    const unstored =
      "This Braivo installation stores no files: its operator has not set BRAIVO_FILES.";
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        readFileText: vi
          .fn()
          .mockRejectedValue(new BraivoError(501, "Braivo answered 501.", unstored)),
      },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });

    expect(await screen.findByText(unstored)).toBeTruthy();
    expect(screen.queryByText(/off for this organization/)).toBeNull();
  });

  test("says a proxy cut off reading a file, and not an upload", async () => {
    const cutOff = new BraivoError(504, "Braivo answered 504 reading a file's text.");
    const uploadFile = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(504, "Braivo answered 504 uploading a file."))
      .mockResolvedValue({ fileId: "f".repeat(64) });
    renderAt("/example/sources", {
      braivo: { ...added, uploadFile, readFileText: vi.fn().mockRejectedValue(cutOff) },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "", file: pdf });
    expect(await screen.findByText("The material could not be added. Try again.")).toBeTruthy();
    addMaterial({ title: "Mi libro", text: "", file: pdf });

    expectProxyTimeoutExplained(await screen.findByText(/timed out/));
  });

  test("reads a file once, however often adding its pages is refused", async () => {
    const readFileText = vi.fn(async () => [{ page: "1", text: "Hola." }]);
    const addSource = vi
      .fn()
      .mockRejectedValueOnce(
        new BraivoError(400, "Braivo answered 400.", "The source's language must be a BCP 47 tag."),
      )
      .mockResolvedValueOnce("s1");
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        readFileText,
        addSource,
      },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "", language: "en_US", file: pdf });
    expect(await screen.findByText("The source's language must be a BCP 47 tag.")).toBeTruthy();
    addMaterial({ title: "Mi libro", text: "", language: "en-US", file: pdf });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(readFileText).toHaveBeenCalledTimes(1);
  });

  test("asks for text or a file, having neither, at the Text field and anew each time", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Nada", text: "  " });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Paste the material's text, or attach the file for Braivo's AI to read.",
    );
    const text = screen.getByLabelText("Text");
    expect(document.activeElement).toBe(text);
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(text.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    // Said under the field, where the focus is, not at the form's end.
    expect(text.closest("[data-slot=field]")?.contains(alert)).toBe(true);
    // The same check again is a new alert, announced again.
    addMaterial({ title: "Nada", text: "  " });
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(alert));
    expect(addSource).not.toHaveBeenCalled();
    // Typing answers it: the field is no longer marked.
    fireEvent.input(text, { target: { value: "Hola." } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text.getAttribute("aria-invalid")).toBeNull();
    expect(text.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
    // So does attaching the file instead.
    addMaterial({ title: "Nada", text: "  " });
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Original file"), {
      target: { files: [new File(["%PDF"], "nada.pdf", { type: "application/pdf" })] },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text.getAttribute("aria-invalid")).toBeNull();
  });

  test("adds nothing of a file whose pages are over what Braivo adds at once", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        readFileText: async () => [{ page: "1", text: "a".repeat(10_000_000) }],
        addSource,
      },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Braivo's AI read the file, but its text is over 10 MB, the most Braivo adds at once: split the file and add it a chapter at a time.",
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Adding the same material again adds nothing.",
    );
    expect(addSource).not.toHaveBeenCalled();
  });

  test("refuses more than Braivo adds at once before sending it, at the Text field", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Libro", text: "a".repeat(10_000_000) });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The text is over 10 MB, the most Braivo adds at once: add it a chapter at a time.",
    );
    expect(screen.getByLabelText("Text").closest("[data-slot=field]")?.contains(alert)).toBe(true);
    expect(addSource).not.toHaveBeenCalled();
  });

  test("marks the file a check refuses, and no field once Braivo refuses", async () => {
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        addSource: vi.fn().mockRejectedValue(new BraivoError(400, "Braivo answered 400.")),
      },
    });
    await screen.findByText("No material yet");
    const plain = new File(["Unit"], "unit.txt", { type: "text/plain" });

    addMaterial({ title: "Unit", text: "", file: plain });

    await screen.findByRole("alert");
    const file = screen.getByLabelText("Original file");
    expect(document.activeElement).toBe(file);
    expect(file.closest("[data-slot=field]")?.contains(screen.getByRole("alert"))).toBe(true);
    expect(file.getAttribute("aria-invalid")).toBe("true");
    addMaterial({
      title: "Unit",
      text: "Pasted.",
      file: new File(["%PDF"], "unit.pdf", { type: "application/pdf" }),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The material could not be added. Try again.",
    );
    expect(file.getAttribute("aria-invalid")).toBeNull();
  });

  test("gives up on adding material Braivo does not answer, keeping it to add again", async () => {
    const addSource = vi
      .fn()
      .mockImplementationOnce((_input, options?: { signal?: AbortSignal }) => stall(options))
      .mockResolvedValue("s1");
    const { router } = renderAt("/example/sources", { braivo: { ...added, addSource } });
    await screen.findByText("No material yet");

    vi.useFakeTimers();
    addMaterial({ title: "Unidad 1", text: "Hola." });
    expect(screen.getByRole("status").textContent).toBe("Adding…");
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The material could not be added. Check your connection and try again.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Unidad 1");
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));
    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
  });

  test("waits for a file's upload as long as its size needs, then gives up", async () => {
    const uploadFile = vi.fn((_input, options?: { signal?: AbortSignal }) => stall(options));
    renderAt("/example/sources", { braivo: { ...added, uploadFile } });
    await screen.findByText("No material yet");
    const pdf = new File([new Uint8Array(2_000_000)], "libro.pdf", { type: "application/pdf" });

    // 10 seconds, and 20 for 2 MB at 100 KB/s.
    expect(bodyDeadline(pdf.size)).toBe(30_000);
    vi.useFakeTimers();
    addMaterial({ title: "Mi libro", text: "Pasted.", file: pdf });
    await waitOut(29_999);
    expect(screen.getByRole("status").textContent).toBe("Uploading the file…");
    expect(screen.queryByRole("alert")).toBeNull();
    await waitOut(1);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The material could not be added. Check your connection and try again.",
    );
  });

  test.each(["uploadFile", "readFileText", "addSource"] as const)(
    "keeps the material of an owner signed out meanwhile, at %s, offering to sign in elsewhere",
    async (step) => {
      const { router } = renderAt("/example/sources", {
        braivo: {
          ...added,
          uploadFile: async () => ({ fileId: "f".repeat(64) }),
          readFileText: async () => [{ page: "1", text: "Hola." }],
          addSource: async () => "s1",
          [step]: vi.fn().mockRejectedValue(new BraivoError(401, "Signed out.")),
        },
      });
      await screen.findByText("No material yet");

      // No text, so the file is uploaded and read before the source is added.
      addMaterial({
        title: "Unidad 1",
        text: "",
        file: new File(["%PDF"], "unidad.pdf", { type: "application/pdf" }),
      });

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(
        "You were signed out. Sign in again in a new tab, then add the material again: what you entered stays here.",
      );
      const signIn = within(alert).getByRole("link", { name: "Sign in again in a new tab" });
      expect(signIn.getAttribute("href")).toBe("/login");
      expect(signIn.getAttribute("target")).toBe("_blank");
      expect(signIn.getAttribute("rel")).toBe("noopener");
      expect(router.history.location.pathname).toBe("/example/sources");
      expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Unidad 1");
    },
  );

  test("uploads the original first, and adds the source naming it, leaving out what was left blank", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", {
      braivo: { listSources: async () => [], uploadFile, addSource },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF-1.7"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "Hola.", url: " ", language: " ", file: pdf });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith(
      { organizationId: "org-1", file: pdf },
      { signal: expect.any(AbortSignal) },
    );
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({ url: undefined, language: undefined, original: "f".repeat(64) }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("says what Braivo refused, and what it could not send", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", {
      braivo: {
        listSources: async () => [],
        uploadFile: async () => {
          throw new BraivoError(
            501,
            "Braivo answered 501.",
            "This Braivo installation stores no files.",
          );
        },
        addSource,
      },
    });
    await screen.findByText("No material yet");

    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });
    addMaterial({ title: "Mi libro", text: "Hola.", file: pdf });
    expect(await screen.findByText("This Braivo installation stores no files.")).toBeTruthy();

    // Removed, as one too large is, so adding again keeps the text without it.
    const emptied = vi.spyOn(
      screen.getByLabelText("Original file") as HTMLInputElement,
      "value",
      "set",
    );
    for (const file of [
      new File(["?"], "libro"),
      new File(["Hola."], "libro.txt", { type: "text/plain" }),
    ]) {
      emptied.mockClear();
      addMaterial({ title: "Mi libro", text: "Hola.", file });
      expect(
        await screen.findByText(
          "Braivo cannot keep a plain-text file, or a file of unknown type, as an original, so it was removed. Add the material again to keep its text without it.",
        ),
      ).toBeTruthy();
      expect(emptied).toHaveBeenCalledWith("");
    }
    expect(addSource).not.toHaveBeenCalled();
  });

  /** A file of `type` claiming `size` bytes, so none are allocated. */
  const fileOf = (type: string, size: number) =>
    Object.defineProperty(new File(["?"], "libro", { type }), "size", { value: size });

  test("says an original is kept for the organization's managers, never shown to learners", async () => {
    renderAt("/example/sources", { braivo: added });
    await screen.findByText("No material yet");

    const hint = screen.getByText(
      "The PDF, slides, image, or recording the text comes from. Optional, at most 50 MB. Only those who manage the organization can open it; learners never see it.",
    );
    expect(screen.getByLabelText("Original file").getAttribute("aria-describedby")).toBe(hint.id);
  });

  test("refuses a file over 50 MB before sending anything, and takes exactly 50 MB", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", { braivo: { ...added, uploadFile, addSource } });
    await screen.findByText("No material yet");
    const pdfOf = (size: number) => fileOf("application/pdf", size);

    const emptied = vi.spyOn(
      screen.getByLabelText("Original file") as HTMLInputElement,
      "value",
      "set",
    );
    addMaterial({ title: "Mi libro", text: "Hola.", file: pdfOf(50_000_001) });
    expect(
      await screen.findByText(
        "The file is over 50 MB, the most Braivo keeps, so it was removed. Add the material again to keep its text without it.",
      ),
    ).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(addSource).not.toHaveBeenCalled();
    // Emptied, so adding again adds the text alone. Asserted on the setter: the
    // test's chosen file overrides `files`, which a browser empties with `value`.
    expect(emptied).toHaveBeenCalledWith("");

    // Whatever its type: a type Braivo refuses is no reason to keep it.
    emptied.mockClear();
    addMaterial({ title: "Mi libro", text: "Hola.", file: fileOf("text/plain", 50_000_001) });
    expect(emptied).toHaveBeenCalledWith("");

    addMaterial({ title: "Mi libro", text: "", file: pdfOf(50_000_001) });
    expect(
      await screen.findByText(
        "The file is over 50 MB, the most Braivo keeps, so it was removed. Paste its text in the Text field to add the material without it.",
      ),
    ).toBeTruthy();

    addMaterial({ title: "Mi libro", text: "Hola.", file: pdfOf(50_000_000) });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  const slides = fileOf("application/vnd.oasis.opendocument.presentation", 4);

  test("refuses a file Braivo's AI cannot read before uploading it, saying what to do instead", async () => {
    const uploadFile = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, uploadFile } });
    await screen.findByText("No material yet");

    for (const [file, refusal] of [
      [
        slides,
        "Braivo's AI reads PDFs and PNG, JPEG, GIF, or WebP images. Paste this file's text or transcript in the Text field to keep the file as its original.",
      ],
      [
        fileOf("application/pdf", 24_000_001),
        "Braivo's AI reads a PDF of at most 24 MB: split it, adding a chapter at a time, or paste its text in the Text field.",
      ],
      [
        fileOf("image/jpeg", 7_500_001),
        "Braivo's AI reads an image of at most 7.5 MB: save it smaller, or paste its text in the Text field.",
      ],
    ] as const) {
      addMaterial({ title: "Mi libro", text: "", file });
      await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(refusal));
    }
    expect(uploadFile).not.toHaveBeenCalled();
  });

  test.each([
    ["a file it cannot read, its text pasted, unread", "Hola.", slides, false],
    [
      "a PDF over 24 MB, its text pasted, unread",
      "Hola.",
      fileOf("application/pdf", 24_000_001),
      false,
    ],
    ["a PDF of exactly 24 MB, and has it read", "", fileOf("application/pdf", 24_000_000), true],
  ])("uploads %s", async (_label, text, file, read) => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const readFileText = vi.fn(async () => [{ page: "1", text: "Leído." }]);
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", { braivo: { ...added, uploadFile, readFileText, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Mi libro", text, file });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith({ organizationId: "org-1", file }, expect.anything());
    expect(readFileText).toHaveBeenCalledTimes(read ? 1 : 0);
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining(
        read
          ? { pages: [{ page: "1", text: "Leído." }], original: "f".repeat(64) }
          : { text, original: "f".repeat(64) },
      ),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("refuses a blank title before uploading or reading anything", async () => {
    const uploadFile = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, uploadFile } });
    await screen.findByText("No material yet");

    // Choosing the file titles the material from its name; then it is cleared.
    fireEvent.change(screen.getByLabelText("Original file"), {
      target: { files: [new File(["%PDF"], "libro.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));

    const title = screen.getByLabelText<HTMLInputElement>("Title");
    expect(title.validationMessage).toBe("Give the material a title.");
    expect(uploadFile).not.toHaveBeenCalled();
    // Typing clears it.
    fireEvent.input(title, { target: { value: "Mi libro" } });
    expect(title.validationMessage).toBe("");
  });

  test("links each source to its own page", async () => {
    renderAt("/example/sources", {
      braivo: { listSources: async () => [saludos] },
    });

    expect((await screen.findByRole("link", { name: "Saludos" })).getAttribute("href")).toBe(
      "/example/sources/s1",
    );
  });

  test("offers where a source is from, and the original it was extracted from", async () => {
    const url = "https://example.com/saludos";
    renderAt("/example/sources/s1", {
      braivo: { ...authoring(), getSource: async () => ({ ...saludos, url, original: "ab12" }) },
    });

    const original = await screen.findByRole("link", { name: "Download the original" });
    expect(original.getAttribute("href")).toBe("/api/organizations/org-1/files/ab12");
    expect(screen.getByRole("link", { name: "Where it is from" }).getAttribute("href")).toBe(url);
  });

  test("shows a source's first 20,000 characters, and all of a longer one on request", async () => {
    const shown = "a".repeat(19_999) + "b";
    const view = (text: string) =>
      renderAt("/example/sources/s1", {
        braivo: { ...authoring(), getSource: async () => ({ ...saludos, text }) },
      });

    view(shown);
    // Reachable by Tab, so the keyboard can scroll it, and named for whoever arrives there.
    const box = await screen.findByRole("region", { name: "Source text" });
    expect(box.textContent).toBe(shown);
    expect(box.tabIndex).toBe(0);
    expect(screen.queryByText(/^The first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all text" })).toBeNull();
    cleanup();

    view(`${shown}c`);
    expect(await screen.findByText(shown)).toBeTruthy();
    // Compared raw: a locale's grouping space, such as fr-FR's, is no plain space.
    expect(screen.getByText(/^The first/).textContent).toBe(
      `The first ${(20_000).toLocaleString()} of ${(20_001).toLocaleString()} characters.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all text" }));
    const text = screen.getByRole("region", { name: "Source text" });
    expect(text.textContent).toBe(`${shown}c`);
    // The button is gone, so the text it revealed takes the focus.
    expect(document.activeElement).toBe(text);
    expect(screen.queryByText(/^The first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all text" })).toBeNull();
  });

  test("cuts a source's text before a character it would split", async () => {
    const before = "a".repeat(19_999);
    renderAt("/example/sources/s1", {
      braivo: { ...authoring(), getSource: async () => ({ ...saludos, text: `${before}🙂c` }) },
    });

    const box = await screen.findByRole("region", { name: "Source text" });
    expect(box.textContent).toBe(before);
  });
});
