// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type LearnerProgressReport } from "@braivo/server/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { createConsoleRouter } from "./router.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const members = [
  { userId: "u1", name: "Olive Owner", roles: ["owner"] },
  { userId: "u2", name: "Lee Learner", roles: ["member"] },
];

/** Braivo's overview of `course-1`: every member counted, by name, and every objective. */
const courseProgress = async () => ({
  modelVersion: "v1",
  learners: [
    { ...members[1]!, standings: { unseen: 0, acquiring: 1, retained: 0, due: 1 } },
    { ...members[0]!, standings: { unseen: 2, acquiring: 0, retained: 0, due: 0 } },
  ],
  objectives: [
    {
      objectiveId: "greetings",
      title: "Greetings",
      standings: { unseen: 1, acquiring: 1, retained: 0, due: 0 },
    },
    {
      objectiveId: "numbers",
      title: "Numbers",
      standings: { unseen: 1, acquiring: 0, retained: 0, due: 1 },
    },
  ],
});

const school = { id: "org-1", name: "Example School", slug: "example" };
const annex = { id: "org-2", name: "Annex", slug: "annex" };

/**
 * The console as an owner reaches it, with Braivo and Better Auth stubbed. The
 * route tree is the real one. The owner manages `school` alone unless a test
 * says otherwise.
 */
function renderAt(
  path: string,
  stubs: {
    signedIn?: boolean;
    /** The account's name, once signed in: none for one an emailed code just made. */
    name?: string;
    braivo?: object;
    organizations?: (typeof school)[];
    /** Better Auth's device flow: `device(query)`, with `approve` and `deny` on it. */
    device?: object;
  } = {},
) {
  const account = { name: stubs.name ?? "Olive Owner", email: "olive@example.com" };
  let signedIn = stubs.signedIn ?? true;
  const auth = {
    getSession: async () => ({ data: signedIn ? { user: { ...account } } : null, error: null }),
    emailOtp: { sendVerificationOtp: vi.fn(async () => ({ error: null })) },
    signIn: {
      emailOtp: vi.fn(async () => {
        signedIn = true;
        return { data: { user: { ...account } }, error: null };
      }),
    },
    updateUser: vi.fn(async ({ name }: { name: string }) => {
      account.name = name;
      return { error: null };
    }),
    signOut: vi.fn(async () => {
      signedIn = false;
      return { error: null };
    }),
    device: stubs.device,
  };
  const visit = vi.fn<AppContext["visit"]>();

  const router = createConsoleRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    context: {
      auth: auth as unknown as AppContext["auth"],
      braivo: {
        listOrganizations: async () => stubs.organizations ?? [school],
        listMembers: async () => members,
        courseProgress,
        ...stubs.braivo,
      } as unknown as AppContext["braivo"],
      visit,
    },
  });
  render(<RouterProvider router={router} />);

  return { auth, router, visit };
}

/** Signs in from `/login` as a person would: an email, then the code mailed to it. */
async function signInWithCode() {
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "owner@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

/** A course as authored, one objective taught by a passage and practised by a task. */
const beginners = {
  id: "course-1",
  title: "Beginners",
  objectives: [
    {
      id: "greetings",
      title: "Greetings",
      citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
      tasks: [
        {
          id: "t1",
          kind: "choice" as const,
          prompt: "Hello, in Spanish?",
          options: ["Hola", "Adiós"],
          answer: 0,
          explanation: "Adiós is goodbye.",
          citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
        },
      ],
    },
    { id: "numbers", title: "Numbers", citations: [], tasks: [] },
  ],
  sources: [{ id: "s1", title: "Unidad 1", createdAt: "2026-06-01T00:00:00.000Z" }],
};

/** Braivo's `readCourse`, answering `course-1` and refusing any other as Braivo does. */
async function readCourse({ courseId }: { courseId: string }) {
  if (courseId === beginners.id) return beginners;
  throw new BraivoError(404, "Braivo answered 404.");
}

/** A device-flow stub: `pending` for a known code, an error for any other. */
function deviceFlow(status = "pending") {
  const device = Object.assign(
    vi.fn(async ({ query }: { query: { user_code: string } }) =>
      query.user_code === "ABCD2345"
        ? { data: { user_code: "ABCD2345", status, client_id: "braivo-cli" }, error: null }
        : { data: null, error: { error: "invalid_request", error_description: "Invalid" } },
    ),
    {
      approve: vi.fn(async () => ({ data: { success: true }, error: null })),
      deny: vi.fn(async () => ({ data: { success: true }, error: null })),
    },
  );
  return device;
}

describe("the console", () => {
  test.each([
    ["their only organization", [school], "/example"],
    ["the picker, among several", [school, annex], "/organizations"],
    ["the picker, which says there are none", [], "/organizations"],
  ])("sends an owner at / to %s", async (_case, organizations, where) => {
    const { router } = renderAt("/", { organizations, braivo: { listCourses: async () => [] } });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe(where));
  });

  test("returns an owner at / to the organization they last opened, while it is theirs", async () => {
    const organizations = [school, annex];
    const braivo = { listCourses: async () => [] };
    renderAt("/annex", { organizations, braivo });
    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    cleanup();

    const { router } = renderAt("/", { organizations, braivo });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/annex"));
    cleanup();

    // Found by ID, and opened at its current slug.
    const renamed = renderAt("/", {
      organizations: [school, { ...annex, slug: "annex-school" }],
      braivo,
    });
    await vi.waitFor(() => expect(renamed.router.state.location.pathname).toBe("/annex-school"));
    cleanup();

    const left = renderAt("/", { organizations: [school], braivo });
    await vi.waitFor(() => expect(left.router.state.location.pathname).toBe("/example"));
  });

  test("asks an account an emailed code just made for its name, then goes where it was headed", async () => {
    const { auth, router } = renderAt("/example", {
      signedIn: false,
      name: "",
      braivo: { listCourses: async () => [] },
    });

    await signInWithCode();
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
    expect(router.history.location.pathname).toBe("/login");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalledWith({ name: "Olive" });
    expect(router.history.location.pathname).toBe("/example");
  });

  test("lets no account without a name past sign-in, however it arrives", async () => {
    // Signed in, then gone before naming the account: the next visit asks again.
    const { auth, router } = renderAt("/example", {
      name: "",
      braivo: { listCourses: async () => [] },
    });

    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
    expect(router.state.location.search).toEqual({ redirect: "/example" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  describe("signing in for a learn domain", () => {
    const springo = { organization: { name: "Springo" }, hostname: "learn.springo.app" };
    const url = "https://learn.springo.app/api/session/handoff?code=c1";

    test("names the organization and its domain, not Braivo, and hands the account over", async () => {
      const completeHandoff = vi.fn(async () => url);
      const { visit } = renderAt("/login?handoff=h1", {
        signedIn: false,
        braivo: { handoff: async () => springo, completeHandoff },
      });

      expect(await screen.findByRole("heading", { name: "Sign in to Springo" })).toBeTruthy();
      expect(screen.getByText(/learn\.springo\.app/)).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Sign in to Springo"));
      expect(screen.queryByText(/Braivo/)).toBeNull();
      await signInWithCode();

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
      expect(completeHandoff).toHaveBeenCalledWith("h1");
    });

    test("offers the account already signed in, or another", async () => {
      const completeHandoff = vi.fn(async () => url);
      const { auth, visit } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => springo, completeHandoff },
      });

      const offered = await screen.findByRole("button", { name: "Continue as Olive Owner" });
      // Offered, not used: nothing is handed over until it is chosen.
      expect(completeHandoff).not.toHaveBeenCalled();
      expect(visit).not.toHaveBeenCalled();
      fireEvent.click(offered);
      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
      expect(completeHandoff).toHaveBeenCalledOnce();
      expect(auth.signOut).not.toHaveBeenCalled();
      cleanup();

      const other = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => springo, completeHandoff: async () => url },
      });
      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));
      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(other.auth.signOut).toHaveBeenCalledOnce();
    });

    test("says when the account is not a member, offering another", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => springo,
          completeHandoff: async () => {
            throw new BraivoError(403, "Braivo answered 403.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(await screen.findByText("This account is not a member of Springo.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Use another account" })).toBeTruthy();
    });

    test("asks the next account for its email, after one that had no name", async () => {
      renderAt("/login?handoff=h1", {
        name: "",
        braivo: {
          handoff: async () => springo,
          completeHandoff: async () => {
            throw new BraivoError(403, "Braivo answered 403.");
          },
        },
      });

      // Offered by email, so another person can switch rather than name it.
      fireEvent.click(await screen.findByRole("button", { name: "Continue as olive@example.com" }));
      fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));

      expect(await screen.findByLabelText("Email")).toBeTruthy();
    });

    test("lets another person switch from an account left without a name, naming nothing", async () => {
      const { auth } = renderAt("/login?handoff=h1", {
        name: "",
        braivo: { handoff: async () => springo, completeHandoff: async () => url },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));

      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(auth.updateUser).not.toHaveBeenCalled();
    });

    test("asks to sign in again when the session ended meanwhile", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => springo,
          completeHandoff: async () => {
            throw new BraivoError(401, "Braivo answered 401.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(await screen.findByText("You were signed out. Sign in again.")).toBeTruthy();
      expect(screen.getByLabelText("Email")).toBeTruthy();
    });

    test("leads back to the domain from expiry reached while signing in", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => springo,
          completeHandoff: async () => {
            throw new BraivoError(404, "Braivo answered 404.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      // Focused, as the button pressed is gone.
      const heading = await screen.findByRole("heading", { name: "This sign-in has expired" });
      expect(document.activeElement).toBe(heading);
      expect(document.title).toBe("This sign-in has expired");
      // The domain is known by then: a new sign-in is one click away.
      expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
        "https://learn.springo.app/login",
      );
    });

    test("names no account it did not read, when continuing must be tried again", async () => {
      const completeHandoff = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(url);
      const { visit } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => springo, completeHandoff },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));
      await signInWithCode();
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
    });

    test("tells a server's failure from a lost connection, offering to continue again", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => springo,
          completeHandoff: async () => {
            throw new BraivoError(500, "Braivo answered 500.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Continue as Olive Owner" })).toBeTruthy();
    });

    test("says when it has expired", async () => {
      renderAt("/login?handoff=gone", { braivo: { handoff: async () => undefined } });

      const heading = await screen.findByRole("heading", { name: "This sign-in has expired" });
      // Nothing was focused to move from.
      expect(document.activeElement).not.toBe(heading);
      expect(screen.queryByLabelText("Email")).toBeNull();
      // Nothing says where it came from.
      expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
      // Not Braivo's name, on the way back to an organization's site.
      await vi.waitFor(() => expect(document.title).toBe("This sign-in has expired"));
    });
  });

  test("lets an owner approve their own tool, naming it and the code", async () => {
    const device = deviceFlow();
    renderAt("/device?user_code=ABCD2345", { device });

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.getByText(/Braivo's command-line tool/)).toBeTruthy();
    expect(screen.getByText("ABCD2345")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
    expect(device.approve).toHaveBeenCalledWith({ userCode: "ABCD2345" });
    expect(device.deny).not.toHaveBeenCalled();
  });

  test("sends one decision at a time", async () => {
    const device = deviceFlow();
    let answer!: () => void;
    device.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ data: { success: true }, error: null });
        }),
    );
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    answer();

    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
    expect(device.deny).not.toHaveBeenCalled();
  });

  test("lets an owner decide again when the answer could not be sent", async () => {
    const device = deviceFlow();
    device.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/could not record your answer/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
  });

  test("lets an owner deny a code they did not start", async () => {
    const device = deviceFlow();
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Denied. Nothing was signed in.")).toBeTruthy();
    expect(device.approve).not.toHaveBeenCalled();
  });

  test("asks for the code when the link was not followed, and says when it is wrong", async () => {
    const device = deviceFlow();
    renderAt("/device", { device });

    fireEvent.change(await screen.findByLabelText("Code shown in your terminal"), {
      target: { value: "WRONG999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/not valid, or has expired/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("offers nothing to approve for a code already answered", async () => {
    renderAt("/device?user_code=ABCD2345", { device: deviceFlow("approved") });

    expect(await screen.findByText("This code was already approved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("returns a signed-out owner to the code they followed once they sign in", async () => {
    const { router } = renderAt("/device?user_code=ABCD2345", {
      signedIn: false,
      device: deviceFlow(),
    });

    await signInWithCode();

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(router.history.location.search).toBe("?user_code=ABCD2345");
  });

  test("returns an owner to the page they asked for once they sign in", async () => {
    const { auth, router } = renderAt("/example", {
      signedIn: false,
      braivo: { listCourses: async () => [] },
    });

    await screen.findByLabelText("Email");
    expect(router.history.location.pathname).toBe("/login");
    await signInWithCode();

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      type: "sign-in",
    });
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      otp: "123456",
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(router.history.location.pathname).toBe("/example");
  });

  test("leads from an organization to its sources", async () => {
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    expect((await screen.findByRole("link", { name: "Sources" })).getAttribute("href")).toBe(
      "/example/sources",
    );
  });

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
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("es")).toBeTruthy();
    expect(within(second!).getByText("Original kept")).toBeTruthy();
  });

  /** Fills the add form; `file` goes in as the original. */
  function addMaterial(fields: { title: string; text: string; language?: string; file?: File }) {
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: fields.title } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: fields.text } });
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

  test("adds pasted text as a source, leaving out what was left blank, and opens it", async () => {
    const addSource = vi.fn(async () => "s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola.", language: "es" });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(addSource).toHaveBeenCalledWith({
      organizationId: "org-1",
      title: "Unidad 1",
      text: "Hola.",
      url: undefined,
      language: "es",
      original: undefined,
    });
  });

  test("keeps the form still while it is sent, so nothing typed meanwhile is lost", async () => {
    let answer!: () => void;
    const addSource = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = () => resolve("s1");
        }),
    );
    renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    // The fieldset disables every field in it, as browsers do; the test DOM does not apply it.
    expect(screen.getByLabelText("Title").closest("fieldset")?.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Add material" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    answer();
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
    const addSource = vi.fn(() => adding.promise);
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource, listCourses: async () => [] },
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
    expect(uploading).toBe(signal);
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
    );
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

  test("asks for text or a file, having neither", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Nada", text: "  " });

    expect(
      await screen.findByText(
        "Paste the material's text, or attach the file for Braivo's AI to read.",
      ),
    ).toBeTruthy();
    expect(addSource).not.toHaveBeenCalled();
  });

  test("uploads the original first, and adds the source naming it", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", {
      braivo: { listSources: async () => [], uploadFile, addSource },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF-1.7"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "Hola.", file: pdf });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith(
      { organizationId: "org-1", file: pdf },
      { signal: expect.any(AbortSignal) },
    );
    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ original: "f".repeat(64) }));
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

    for (const file of [
      new File(["?"], "libro"),
      new File(["Hola."], "libro.txt", { type: "text/plain" }),
    ]) {
      addMaterial({ title: "Mi libro", text: "Hola.", file });
      expect(
        await screen.findByText(
          "The original file must be a PDF, a document, or an image; plain text goes in the Text field.",
        ),
      ).toBeTruthy();
    }
    expect(addSource).not.toHaveBeenCalled();
  });

  const saludos = {
    id: "s1",
    title: "Saludos",
    text: "Hola significa hello.",
    language: "es",
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  const hello = { sourceId: "s1", quote: "Hola significa hello." };

  /** A draft of two objectives, the first with two tasks, and one thing left out. */
  const drafted = {
    objectives: [
      {
        key: "d1",
        title: "Say hello",
        citations: [hello],
        tasks: [
          {
            kind: "choice",
            prompt: "Hello?",
            options: ["Hola", "Adiós"],
            answer: 0,
            citations: [hello],
          },
          {
            kind: "choice",
            prompt: "Hi?",
            options: ["Hola", "Gracias"],
            answer: 0,
            citations: [hello],
          },
        ],
      },
      {
        key: "d2",
        title: "Say goodbye",
        citations: [hello],
        tasks: [
          {
            kind: "choice",
            prompt: "Bye?",
            options: ["Adiós", "Hola"],
            answer: 0,
            citations: [hello],
          },
        ],
      },
    ],
    refused: ["Objective 0, task 2, quote 0: the quote does not occur in the source."],
  };

  function authoring() {
    return {
      getSource: async () => saludos,
      draftCourse: vi.fn(async () => drafted),
      acceptDraft: vi.fn(async (): Promise<string> => "course-1"),
      readCourse,
    };
  }

  test("links each source to its own page", async () => {
    renderAt("/example/sources", {
      braivo: { listSources: async () => [saludos] },
    });

    expect((await screen.findByRole("link", { name: "Saludos" })).getAttribute("href")).toBe(
      "/example/sources/s1",
    );
  });

  test("offers the original a source was extracted from, to compare against", async () => {
    renderAt("/example/sources/s1", {
      braivo: { ...authoring(), getSource: async () => ({ ...saludos, original: "ab12" }) },
    });

    const link = await screen.findByRole("link", { name: "Download the original" });
    expect(link.getAttribute("href")).toBe("/api/organizations/org-1/files/ab12");
  });

  test("drafts a course from a source, keeps what the owner keeps, and creates it", async () => {
    const braivo = authoring();
    const { router } = renderAt("/example/sources/s1", { braivo });

    expect(await screen.findByText("Hola significa hello.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Learners"), { target: { value: "grade 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft a course" }));

    // Reviewed before anything is stored, with what Braivo left out said.
    expect(await screen.findByText(drafted.refused[0]!)).toBeTruthy();
    expect(braivo.draftCourse).toHaveBeenCalledWith(
      { organizationId: "org-1", sourceId: "s1", audience: "grade 2" },
      { signal: expect.any(AbortSignal) },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep “Hi?”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    // What was kept, and only that.
    expect(braivo.acceptDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      sourceId: "s1",
      title: "Saludos",
      objectives: [{ ...drafted.objectives[0], tasks: [drafted.objectives[0]!.tasks[0]] }],
    });
  });

  test("creates a course with the owner's corrections to a proposed task", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello?”" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Question"));
    // An open edit is not yet part of the course.
    expect(
      (screen.getByRole("button", { name: "Create course" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hi, in Spanish?" } });
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));
    fireEvent.change(screen.getByLabelText("Why the answer is right"), {
      target: { value: "Adiós is goodbye." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Hi, in Spanish?")).toBeTruthy();
    // Back where the edit was opened from, now named by the corrected question.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit “Hi, in Spanish?”" }),
      ),
    );
    // An edit left open on an objective then dropped closes with it.
    fireEvent.click(screen.getByRole("button", { name: "Edit “Hi?”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 1" }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    const [{ objectives }] = braivo.acceptDraft.mock.calls[0] as unknown as [
      { objectives: { tasks: object[] }[] },
    ];
    expect(objectives[0]!.tasks[0]).toEqual({
      kind: "choice",
      prompt: "Hi, in Spanish?",
      options: ["Hola", "Adiós"],
      answer: 1,
      explanation: "Adiós is goodbye.",
      citations: [hello],
    });
  });

  test("creates a course with the owner's correction to an objective's title", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    const title = await screen.findByRole("textbox", { name: "Objective 1" });
    expect((title as HTMLInputElement).required).toBe(true);
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    // Checked like the course's title, before anything is locked in, with
    // focus taken to it from the button at the bottom.
    expect(await screen.findByText("Give objective 1 a title.")).toBeTruthy();
    expect(document.activeElement).toBe(title);
    expect(screen.getByRole("article", { name: "Objective 1" })).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();

    // The first to fix in page order, even with the course title also blank.
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "" } });
    screen.getByRole("button", { name: "Create course" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Saludos" } });

    fireEvent.change(title, { target: { value: " Greet someone " } });
    expect(screen.getByRole("article", { name: "Objective 1: Greet someone" })).toBeTruthy();
    // A dropped objective's title is not sent, so it is not checked either.
    fireEvent.change(screen.getByRole("textbox", { name: "Objective 2" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    expect(braivo.acceptDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      sourceId: "s1",
      title: "Saludos",
      objectives: [{ ...drafted.objectives[0], title: "Greet someone" }],
    });
  });

  test("says why a course could not be drafted, or created", async () => {
    const braivo = {
      ...authoring(),
      draftCourse: vi.fn(async (): Promise<typeof drafted> => {
        throw new BraivoError(
          403,
          "Braivo answered 403.",
          "This organization may not draft with this installation's AI.",
        );
      }),
    };
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    expect(
      await screen.findByText("This organization may not draft with this installation's AI."),
    ).toBeTruthy();

    braivo.draftCourse.mockImplementation(async () => drafted);
    braivo.acceptDraft.mockImplementation(async () => {
      throw new BraivoError(409, "Braivo answered 409.", "Key d1 names another objective.");
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    expect(await screen.findByText("Key d1 names another objective.")).toBeTruthy();
  });

  test("stops a draft nobody is waiting for once the owner leaves the page", async () => {
    let signal: AbortSignal | undefined;
    const draftCourse = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>(() => {});
    });
    const { router } = renderAt("/example/sources/s1", {
      braivo: { ...authoring(), draftCourse },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  test("reviews no draft on another source's page than the one it was drafted from", async () => {
    const { router } = renderAt("/example/sources/s1", { braivo: authoring() });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    expect(await screen.findByRole("button", { name: "Create course" })).toBeTruthy();
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s2" },
    });

    expect(await screen.findByRole("button", { name: "Draft a course" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create course" })).toBeNull();
  });

  test("leaves a review usable when the course is created while the owner is leaving", async () => {
    const creating = Promise.withResolvers<string>();
    const braivo = {
      ...authoring(),
      // The other source still loading when the course is created.
      getSource: ({ sourceId }: { sourceId: string }) =>
        sourceId === "s1" ? Promise.resolve(saludos) : new Promise(() => {}),
    };
    braivo.acceptDraft.mockImplementation(() => creating.promise);
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    void router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s2" },
    });
    creating.resolve("course-1");
    await creating.promise;
    // Changing their mind before the other source loads.
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s1" },
    });

    expect(router.history.location.pathname).toBe("/example/sources/s1");
    // Sent again, it finishes as created, and opens the course.
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
  });

  test("leaves an owner on the page they returned to when the course they left is created", async () => {
    const creating = Promise.withResolvers<string>();
    const braivo = { ...authoring(), listCourses: async () => [] };
    braivo.acceptDraft.mockImplementation(() => creating.promise);
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s1" },
    });
    creating.resolve("course-1");
    await creating.promise;

    expect(router.history.location.pathname).toBe("/example/sources/s1");
  });

  test("refuses an overlong course title before sending anything", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "C".repeat(501) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(await screen.findByText("Keep the title of the course to 500 characters.")).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
  });

  test("refuses a title Braivo cannot store as text before sending anything", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Saludos\u0000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(
      await screen.findByText(
        "Remove the characters in the title of the course that are not text.",
      ),
    ).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
  });

  test("asks for a title before sending anything, since what is sent is locked in", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(await screen.findByText("Give the course a title.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Course title"));
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Course title").closest("fieldset")?.disabled).toBe(false);
  });

  test("finishes a course as reviewed when creating it failed halfway", async () => {
    const braivo = authoring();
    braivo.acceptDraft.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keep “Hi?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    // Tasks are stored by now: the review is locked, so a retry cannot differ.
    const retry = await screen.findByRole("button", { name: "Try again" });
    const hi = screen.getByRole("checkbox", { name: "Keep “Hi?”" });
    expect(hi.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(retry);

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    // Sent again as first reviewed, "Hi?" still dropped.
    const [first, second] = braivo.acceptDraft.mock.calls as unknown as unknown[][];
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("Hi?");
  });

  test("lists the organizations the owner is in", async () => {
    renderAt("/organizations");

    const link = await screen.findByRole("link", { name: "Example School" });
    expect(link.getAttribute("href")).toBe("/example");
  });

  test("names the organization in view on its pages, and nowhere else", async () => {
    renderAt("/annex", { organizations: [school, annex], braivo: { listCourses: async () => [] } });
    const current = await screen.findByRole("link", { name: "Annex" });
    expect(current.getAttribute("href")).toBe("/annex");
    cleanup();

    renderAt("/organizations", { organizations: [school, annex] });
    await screen.findByRole("link", { name: "Annex" });
    expect(screen.getAllByRole("link", { name: "Annex" })).toHaveLength(1);
  });

  test("titles an organization's pages so tabs tell apart pages and organizations", async () => {
    const braivo = {
      listCourses: async () => [{ id: "course-1", title: "Beginners" }],
      listSources: async () => [saludos],
      getSource: async () => saludos,
      readCourse,
      learnerProgress: async () => ({ modelVersion: "v1", objectives: [] }),
    };
    const titles = {
      "/example": "Courses · Example School",
      "/example/sources": "Sources · Example School",
      "/example/sources/s1": "Saludos · Source · Example School",
      "/example/courses/course-1": "Beginners · Example School",
      "/example/courses/course-1/learners/u2": "Lee Learner · Beginners · Example School",
      // Nothing found to name: the console's own.
      "/example/courses/elsewhere": "Braivo Console",
    };

    for (const [path, title] of Object.entries(titles)) {
      renderAt(path, { braivo });
      await vi.waitFor(() => expect(document.title).toBe(title));
      cleanup();
    }
  });

  test("stops naming a course in its tab once a reload finds it gone", async () => {
    let gone = false;
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => {
          if (gone) throw new BraivoError(404, "Braivo answered 404.");
          return readCourse(input);
        },
      },
    });
    await vi.waitFor(() => expect(document.title).toBe("Beginners · Example School"));

    gone = true;
    await router.invalidate();

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Braivo Console"));
  });

  test("tells someone who manages no organization where to go, and who they are", async () => {
    renderAt("/organizations", { organizations: [] });

    expect(await screen.findByText("You don't manage any organizations")).toBeTruthy();
    expect(screen.getByText(/Open the site your school/)).toBeTruthy();
    expect(screen.getByText("Signed in as olive@example.com.")).toBeTruthy();
  });

  test("reads a slug that is not one of the owner's organizations as not found", async () => {
    const listCourses = vi.fn();
    renderAt("/elsewhere", { braivo: { listCourses } });

    expect(
      await screen.findByText("This organization does not exist, or you do not manage it."),
    ).toBeTruthy();
    expect(listCourses).not.toHaveBeenCalled();
  });

  test("reads a path below an organization that names no page as nothing, not the organization", async () => {
    renderAt("/example/courses", { braivo: { listCourses: async () => [] } });

    expect(await screen.findByText("There is nothing here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Example School" })).toBeTruthy();
    expect(screen.queryByText(/This organization does not exist/)).toBeNull();
  });

  test("leads from a path that names nothing back to the organizations", async () => {
    renderAt("/organizations/elsewhere");

    fireEvent.click(await screen.findByRole("link", { name: "Organizations" }));

    expect(await screen.findByRole("link", { name: "Example School" })).toBeTruthy();
  });

  test("fails a page that could not load in its place, under the header, until tried again", async () => {
    const listCourses = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([beginners]);
    renderAt("/example", { braivo: { listCourses } });

    const failure = await screen.findByRole("region", { name: "Something went wrong." });
    expect(document.activeElement).toBe(failure);
    expect(screen.getByRole("link", { name: "Example School" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Beginners" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong.")).toBeNull();
  });

  test("reads an organization Braivo refuses as not found", async () => {
    renderAt("/example", {
      braivo: {
        listCourses: async () => {
          throw new BraivoError(403, "forbidden");
        },
      },
    });

    expect(
      await screen.findByText("This organization does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("reads a course its organization does not have as not found", async () => {
    renderAt("/example/courses/elsewhere", { braivo: { readCourse } });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("asks nothing scoped to a course before that course is the organization's", async () => {
    const learnerProgress = vi.fn();
    const listMembers = vi.fn(async () => members);
    renderAt("/example/courses/elsewhere/learners/u2", {
      braivo: {
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
        learnerProgress,
        listMembers,
      },
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
    // An owner of both organizations could read this report; what they may not
    // do is pair it with another organization's roster.
    expect({
      learnerProgress: learnerProgress.mock.calls,
      listMembers: listMembers.mock.calls,
    }).toEqual({ learnerProgress: [], listMembers: [] });
  });

  test("asks nothing about a course's learners until the course is its own", async () => {
    const progress = vi.fn(courseProgress);
    renderAt("/example/courses/elsewhere", {
      braivo: { readCourse, courseProgress: progress },
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
    expect(progress.mock.calls).toEqual([]);
  });

  test("reads a course as not found when Braivo refuses its learners", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        courseProgress: async () => {
          throw new BraivoError(404, "Braivo answered 404.");
        },
      },
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("shows what a course teaches: each objective's passages, and its tasks' answers", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const greetings = await screen.findByRole("article", { name: "1. Greetings" });
    expect(within(greetings).getAllByText("Hola.")).toHaveLength(2);
    expect(within(greetings).getAllByText("Unidad 1")).toHaveLength(2);
    expect(within(greetings).getByText("Hello, in Spanish?")).toBeTruthy();
    expect(within(greetings).getByText("Correct answer").closest("li")?.textContent).toBe(
      "Hola Correct answer",
    );
    expect(within(greetings).getByText("Adiós is goodbye.")).toBeTruthy();

    const numbers = screen.getByRole("article", { name: "2. Numbers" });
    expect(within(numbers).getByText("No tasks: learners are not asked about it.")).toBeTruthy();
  });

  test("retires a task only once the owner confirms, then reads the course again", async () => {
    // Braivo reads the course without a task once it is retired.
    let retired = false;
    const retireTasks = vi.fn(async () => {
      retired = true;
    });
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      if (!retired) return course;
      const [greetings, ...rest] = course.objectives;
      return { ...course, objectives: [{ ...greetings!, tasks: [] }, ...rest] };
    });
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: reading, retireTasks },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retire “Hello, in Spanish?”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(retireTasks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    const confirming = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirming).getByRole("button", { name: "Retire" }));

    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    expect(retireTasks).toHaveBeenCalledWith({ organizationId: "org-1", taskIds: ["t1"] });
    // The task is gone with its button, so a keyboard user resumes at its objective.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" })),
    );
  });

  test("says so when a task could not be retired", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        retireTasks: async () => {
          throw new BraivoError(503, "Braivo answered 503.");
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    expect(await screen.findByText("The task could not be retired. Try again.")).toBeTruthy();
    // Still there to try again, and focused to.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retire" }));
  });

  test("corrects a task with its passages, then reads the course again", async () => {
    let corrected = false;
    let answer!: () => void;
    const defineTasks = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = () => {
            corrected = true;
            resolve(["t2"]);
          };
        }),
    );
    // Options kept in their order, which the correction must keep too.
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      const shown = corrected ? { ...task!, id: "t2", answer: 1 } : task!;
      return {
        ...course,
        objectives: [{ ...greetings!, tasks: [{ ...shown, keepOrder: true as const }] }, ...rest],
      };
    });
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, defineTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(defineTasks).toHaveBeenCalledWith({
      organizationId: "org-1",
      tasks: [
        {
          objectiveId: "greetings",
          kind: "choice",
          prompt: "Hello, in Spanish?",
          options: ["Hola", "Adiós"],
          answer: 1,
          explanation: "Adiós is goodbye.",
          keepOrder: true,
          citations: [{ sourceId: "s1", quote: "Hola." }],
          replaces: "t1",
        },
      ],
    });
    // While it is sent, the edit can be neither changed nor cancelled.
    expect(screen.getByRole("button", { name: "Cancel" }).closest("fieldset")?.disabled).toBe(true);

    answer();
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Correct answer").closest("li")?.textContent).toBe(
      "Adiós Correct answer",
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" })),
    );
  });

  test("leaves a task as it was when its edit is cancelled, or fails", async () => {
    const defineTasks = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockRejectedValueOnce(new BraivoError(409, "Braivo answered 409.", "Task 0 replaces…"));
    renderAt("/example/courses/course-1", { braivo: { readCourse, defineTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hi, in Spanish?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const failed = await screen.findByText("The task could not be corrected. Try again.");
    // Still open with the edit, to save again, and the reason focused.
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Hi, in Spanish?");
    expect(document.activeElement).toBe(failed.closest("[role=alert]"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Someone changed or retired this task since the page loaded."),
    ).toBeTruthy();
    expect(defineTasks).toHaveBeenCalledTimes(2);
    // Saving again cannot help: reloading shows the course as stored.
    fireEvent.click(screen.getByRole("button", { name: "Reload the course" }));
    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" }));
  });

  test("closes an edit whose task a reload no longer lists", async () => {
    let reloaded = false;
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      const other = { ...task!, id: "t3", prompt: "Goodbye, in Spanish?" };
      // Someone else corrected "Hello, in Spanish?" meanwhile, into t4.
      const tasks = reloaded ? [{ ...task!, id: "t4" }] : [task!, other];
      return { ...course, objectives: [{ ...greetings!, tasks }, ...rest] };
    });
    const retireTasks = vi.fn(async () => {
      reloaded = true;
    });
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, retireTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    const edit = screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" });
    expect((edit as HTMLButtonElement).disabled).toBe(false);
  });

  test("counts each learner's objectives by standing, linking to their progress", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const learners = await screen.findByRole("region", { name: "Learners" });
    const [header, ...rows] = within(learners).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Learner", "Not started", "Learning", "Retained", "Due for review"]);
    expect(
      rows.map((row) => {
        const learner = within(row).getByRole("rowheader");
        return [
          within(learner).getByRole("link").textContent,
          ...within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ];
      }),
    ).toEqual([
      ["Lee Learner", "0", "1", "0", "1"],
      ["Olive Owner", "2", "0", "0", "0"],
    ]);
    expect(within(rows[0]!).getByText("member")).toBeTruthy();
    expect(within(rows[1]!).getByText("owner")).toBeTruthy();
    expect(within(learners).getByRole("link", { name: "Lee Learner" }).getAttribute("href")).toBe(
      "/example/courses/course-1/learners/u2",
    );
  });

  test("counts each objective's learners by standing, in content order", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const objectives = await screen.findByRole("region", { name: "Progress by objective" });
    const [header, ...rows] = within(objectives).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Objective", "Not started", "Learning", "Retained", "Due for review"]);
    expect(
      rows.map((row) => [
        within(row).getByRole("rowheader").textContent,
        ...within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ]),
    ).toEqual([
      ["Greetings", "1", "1", "0", "0"],
      ["Numbers", "1", "0", "0", "1"],
    ]);
  });

  test("shows where a learner stands on each objective, by title", async () => {
    const report: LearnerProgressReport = {
      modelVersion: "v1",
      objectives: [
        {
          objectiveId: "o1",
          title: "Greetings",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 1,
          retrievability: 0.42,
          due: true,
          dueAt: "2026-06-02T00:00:00.001Z",
          evidence: [
            { outcome: "failure", at: "2026-05-30T00:00:00.000Z" },
            { outcome: "failure", at: "2026-05-31T00:00:00.000Z" },
            { outcome: "success", at: "2026-06-01T00:00:00.000Z" },
          ],
        },
        { objectiveId: "o2", title: "Numbers", phase: "unseen", evidence: [] },
      ],
    };
    const learnerProgress = vi.fn(async () => report);
    const listCourses = vi.fn(async () => [{ id: "course-1", title: "Beginners" }]);
    const listMembers = vi.fn(async () => members);
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: { learnerProgress, listCourses, listMembers },
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    const [header, greetings, numbers] = screen.getAllByRole("row");
    // The last evidence may have been graded outside Braivo, so not "Last attempted".
    expect(within(header!).getByRole("columnheader", { name: "Last evidence" })).toBeTruthy();
    expect(within(greetings!).getByRole("rowheader", { name: "Greetings" })).toBeTruthy();
    expect(within(greetings!).getByText("Due for review, 42% recall")).toBeTruthy();
    expect(within(header!).getByRole("columnheader", { name: "Review due" })).toBeTruthy();
    expect(
      within(greetings!).getByText(new Date("2026-06-02T00:00:00.001Z").toLocaleString()),
    ).toBeTruthy();
    // Counted, so a learner who failed many times does not read like one who failed once.
    expect(within(header!).getByRole("columnheader", { name: "Evidence" })).toBeTruthy();
    const counted = within(greetings!).getByLabelText("Greetings: 1 success, 2 failures");
    expect(counted.textContent).toBe("1 success, 2 failures");
    // Dated on request, newest first.
    const details = counted.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(counted);
    expect(details.open).toBe(true);
    expect(
      within(greetings!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `${new Date("2026-06-01T00:00:00.000Z").toLocaleString()}: success`,
      `${new Date("2026-05-31T00:00:00.000Z").toLocaleString()}: failure`,
      `${new Date("2026-05-30T00:00:00.000Z").toLocaleString()}: failure`,
    ]);
    expect(within(numbers!).getByText("Not started")).toBeTruthy();
    expect(
      within(numbers!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Not started", "—", "—", "—"]);
    // Every id here is an interchangeable string, so a read scoped to the wrong
    // one type-checks; these assertions are what hold the tenant boundary.
    const options = { signal: expect.any(AbortSignal) };
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "course-1", learnerId: "u2" },
      options,
    );
    expect(listCourses).toHaveBeenCalledWith("org-1", options);
    expect(listMembers).toHaveBeenCalledWith("org-1", options);
  });

  test("reads progress Braivo will not show as not found", async () => {
    renderAt("/example/courses/course-1/learners/u9", {
      braivo: {
        learnerProgress: async () => {
          throw new BraivoError(404, "not found");
        },
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
      },
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
  });
});
