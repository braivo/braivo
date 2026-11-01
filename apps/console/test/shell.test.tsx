// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale } from "@braivo/i18n";
import { BraivoError, type Organization } from "@braivo/server/client";
import { i18n } from "@lingui/core";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { PAGE_SCROLLER } from "../lib/page-scroller.ts";
import { school, annex, beginners, readCourse, saludos, authoring } from "./fixtures.ts";
import { stall, openAccountMenu, waitOut, renderAt } from "./render.tsx";

async function signOutFromMenu() {
  fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Sign out" }));
}

describe("the console", () => {
  test.each([
    ["their only organization", [school], "/example"],
    // Listed by name, as Braivo lists them.
    ["the first among several", [annex, school], "/annex"],
    ["setting one up, managing none", [], "/join"],
  ])("sends an owner at / to %s", async (_case, organizations, where) => {
    const { router } = renderAt("/", { organizations, braivo: { listCourses: async () => [] } });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe(where));
  });

  test("returns an owner at / to the organization they last opened, while it is theirs", async () => {
    const organizations = [school, annex];
    const braivo = { listCourses: async () => [] };
    renderAt("/annex", { organizations, braivo });
    expect(await screen.findByText("No courses yet")).toBeTruthy();
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

  test("names the account in its menu, and signs an owner out, saying so when it could not and letting them try again", async () => {
    const { auth, router } = renderAt("/example", { braivo: { listCourses: async () => [] } });
    const refused = Promise.withResolvers<{ error: { status: number } }>();
    auth.signOut.mockReturnValueOnce(refused.promise as never);
    auth.signOut.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const menu = await openAccountMenu();
    expect(within(menu).getByText("Olive Owner")).toBeTruthy();
    expect(within(menu).getByText("olive@example.com")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    // Locked while it is sent.
    const reopened = await openAccountMenu();
    const locked = within(reopened).getByRole("menuitem", { name: "Sign out" });
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(locked);
    expect(auth.signOut).toHaveBeenCalledOnce();
    fireEvent.keyDown(reopened, { key: "Escape" });
    refused.resolve({ error: { status: 500 } });
    const first = await screen.findByRole("alert");
    expect(first.textContent).toBe("Could not sign out. Try again.");
    await signOutFromMenu();
    await vi.waitFor(() => expect(auth.signOut).toHaveBeenCalledTimes(2));
    // A new alert, so the repeat is announced too.
    const second = await screen.findByRole("alert");
    expect(second.textContent).toBe("Could not sign out. Try again.");
    expect(second).not.toBe(first);
    expect(router.state.location.pathname).toBe("/example");

    await signOutFromMenu();
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  test("keeps the page when signing out does not finish in time, saying so", async () => {
    const { auth, router } = renderAt("/example", { braivo: { listCourses: async () => [] } });
    auth.signOut.mockImplementationOnce((options?: { fetchOptions?: { signal?: AbortSignal } }) =>
      stall(options?.fetchOptions),
    );
    const menu = await openAccountMenu();

    vi.useFakeTimers();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    const signOut = within(await openAccountMenu()).getByRole("menuitem", { name: "Sign out" });
    expect(signOut.getAttribute("aria-disabled")).toBeNull();
    expect(router.state.location.pathname).toBe("/example");
  });

  test("chooses the theme and the language from the account menu, a person's choices", async () => {
    onTestFinished(async () => {
      localStorage.clear();
      document.documentElement.classList.remove("dark");
      await activateLocale("en");
    });
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    const themes = within(await openAccountMenu()).getByRole("group", { name: "Theme" });
    fireEvent.click(within(themes).getByRole("menuitemradio", { name: "Dark" }));
    await vi.waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));

    // Not a row of its own in the sidebar.
    expect(screen.queryByRole("button", { name: /^Language/ })).toBeNull();
    const languages = within(await openAccountMenu()).getByRole("group", { name: "Language" });
    const english = within(languages).getByRole("menuitemradio", { name: "English" });
    expect(english.getAttribute("aria-checked")).toBe("true");
    // Without a leading icon, its words under the other items'.
    expect(english.hasAttribute("data-inset")).toBe(true);
    fireEvent.click(within(languages).getByRole("menuitemradio", { name: "Polski" }));
    expect(await screen.findByRole("button", { name: "Konto: Olive Owner" })).toBeTruthy();
  });

  test("says under the sidebar's toggle when a language could not load, as a new alert, until another is chosen", async () => {
    onTestFinished(async () => {
      vi.restoreAllMocks();
      localStorage.clear();
      await activateLocale("en");
    });
    const { auth } = renderAt("/example", { braivo: { listCourses: async () => [] } });
    auth.signOut.mockResolvedValueOnce({ error: { status: 500 } } as never);
    const load = vi.spyOn(i18n, "loadAndActivate").mockImplementation(() => {
      throw new Error("Catalog failed");
    });

    const chooseFromLanguageMenu = async (name: string) => {
      fireEvent.keyDown(await screen.findByRole("button", { name: /^(Account|Konto): / }), {
        key: "Enter",
      });
      fireEvent.click(await screen.findByRole("menuitemradio", { name }));
    };
    await signOutFromMenu();
    const signOutFailure = await screen.findByText("Could not sign out. Try again.");
    await chooseFromLanguageMenu("Polski");
    const alert = await screen.findByText("Could not change the language. Try again.");
    // A new alert, though it replaces another, so it is announced too.
    expect(alert).not.toBe(signOutFailure);
    expect(alert.getAttribute("role")).toBe("alert");
    // In the page's header, after its row, never inside it (docs/apps.md).
    expect(alert.closest("header")).toBeTruthy();
    expect(
      alert.previousElementSibling?.contains(
        screen.getByRole("button", { name: /^(Collapse sidebar|Zwiń panel boczny)$/ }),
      ),
    ).toBe(true);

    load.mockRestore();
    await chooseFromLanguageMenu("Polski");
    expect(await screen.findByRole("button", { name: "Konto: Olive Owner" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("offers to try again when the session cannot be checked in time", async () => {
    let answering = false;
    vi.useFakeTimers();
    renderAt("/example", {
      braivo: { listCourses: async () => [] },
      getSession: (options?: { fetchOptions?: { signal?: AbortSignal } }) =>
        answering
          ? Promise.resolve({
              data: { user: { name: "Olive Owner", email: "o@example.com" } },
              error: null,
            })
          : stall(options?.fetchOptions),
    });
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    answering = true;
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Account: Olive Owner" })).toBeTruthy();
  });

  describe("the sidebar", () => {
    /** The sidebar's own element, its `data-state` expanded or collapsed. */
    const sidebar = () => document.querySelector('[data-slot="sidebar"]');

    test("leads an organization's pages: the organization first, then its sections, the one shown marked", async () => {
      const { router } = renderAt("/example", {
        braivo: { listCourses: async () => [], listSources: async () => [], readCourse },
      });
      const nav = await screen.findByRole("navigation", { name: "Example School" });
      const courses = within(nav).getByRole("link", { name: "Courses" });
      const sources = within(nav).getByRole("link", { name: "Sources" });
      expect(courses.getAttribute("href")).toBe("/example");
      expect(sources.getAttribute("href")).toBe("/example/sources");
      // In order: the organization, its sections, the account (the language in its menu).
      const named = Array.from(
        sidebar()?.querySelectorAll("a, button") ?? [],
        (element) => element.getAttribute("aria-label") ?? element.textContent,
      );
      expect(named).toEqual([
        "Organization: Example School",
        "Courses",
        "Sources",
        "Groups",
        "Account: Olive Owner",
      ]);
      // No logo and breadcrumb above the page: the sidebar names the organization.
      expect(screen.queryByRole("link", { name: /^braivo/ })).toBeNull();

      const marked = () => [courses, sources].map((link) => link.getAttribute("aria-current"));
      expect(marked()).toEqual(["page", null]);
      await act(() =>
        router.navigate({
          to: "/$organizationSlug/courses/$courseId",
          params: { organizationSlug: "example", courseId: "course-1" },
        }),
      );
      // A course's page is in Courses, not Courses' own page.
      await vi.waitFor(() => expect(marked()).toEqual(["true", null]));
      fireEvent.click(sources);
      await vi.waitFor(() => expect(marked()).toEqual([null, "page"]));
    });

    test("collapses to a rail and expands again, holding across pages and settings", async () => {
      renderAt("/example", {
        braivo: { listCourses: async () => [], listSources: async () => [] },
      });
      fireEvent.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
      expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");

      // Still the way around, each named.
      fireEvent.click(screen.getByRole("link", { name: "Sources" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Sources" })).toBeTruthy();
      expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");
      expect(screen.getByRole("button", { name: "Organization: Example School" })).toBeTruthy();

      fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Settings" }));
      fireEvent.click(await screen.findByRole("link", { name: "Back to Example School" }));
      const expand = await screen.findByRole("button", { name: "Expand sidebar" });
      expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");

      fireEvent.click(expand);
      expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    });

    test("starts each page at the top of the surface it scrolls in", async () => {
      renderAt("/example/sources", {
        braivo: { listCourses: async () => [], listSources: async () => [] },
      });
      await screen.findByRole("heading", { level: 1, name: "Sources" });
      const scroller = document.querySelector(PAGE_SCROLLER);
      expect(scroller?.contains(screen.getByRole("heading", { level: 1 }))).toBe(true);
      (scroller as HTMLElement).scrollTop = 300;

      fireEvent.click(screen.getByRole("link", { name: "Courses" }));
      await screen.findByRole("heading", { level: 1, name: "Courses" });
      await vi.waitFor(() => expect(scroller?.scrollTop).toBe(0));
    });

    describe("on a phone", () => {
      /** 375px wide, under the sidebar's 768px breakpoint, before the app reads it. */
      function onPhone() {
        const { happyDOM } = window as unknown as {
          happyDOM: { setViewport(viewport: { width: number }): void };
        };
        const width = window.innerWidth;
        happyDOM.setViewport({ width: 375 });
        onTestFinished(() => happyDOM.setViewport({ width }));
      }

      test("opens a drawer, closed by navigating or its button, the focus back on what opened it", async () => {
        onPhone();
        const { router } = renderAt("/example", {
          braivo: { listCourses: async () => [], listSources: async () => [] },
        });
        const open = await screen.findByRole("button", { name: "Open navigation" });
        // Closed, nothing of it on the page.
        expect(screen.queryByRole("link", { name: "Sources" })).toBeNull();

        fireEvent.click(open);
        // Named in the page's language, not shadcn's English.
        const drawer = await screen.findByRole("dialog", { name: "Navigation" });
        fireEvent.click(within(drawer).getByRole("link", { name: "Sources" }));
        await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example/sources"));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(open));

        fireEvent.click(open);
        fireEvent.click(
          within(await screen.findByRole("dialog")).getByRole("button", {
            name: "Close navigation",
          }),
        );
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(open));
      });

      test("closes the drawer for the page already shown too, from a section or the organization menu", async () => {
        onPhone();
        renderAt("/example", { braivo: { listCourses: async () => [] } });
        const open = await screen.findByRole("button", { name: "Open navigation" });

        fireEvent.click(open);
        const drawer = await screen.findByRole("dialog", { name: "Navigation" });
        fireEvent.click(within(drawer).getByRole("link", { name: "Courses" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(open));

        fireEvent.click(open);
        fireEvent.keyDown(
          within(await screen.findByRole("dialog")).getByRole("button", {
            name: "Organization: Example School",
          }),
          { key: "Enter" },
        );
        fireEvent.click(
          within(await screen.findByRole("menu")).getByRole("menuitem", {
            name: "Example School",
          }),
        );
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(open));
      });

      test("names the organization beside what opens the drawer, closed", async () => {
        onPhone();
        renderAt("/annex", {
          organizations: [annex, school],
          braivo: { listCourses: async () => [] },
        });
        await screen.findByRole("button", { name: "Open navigation" });
        // Beside the toggle, not only in the drawer or the tab's title.
        const header = () => screen.getByRole("button", { name: "Open navigation" }).parentElement;
        await vi.waitFor(() => expect(header()?.textContent).toBe("Annex"));
        expect(screen.queryByRole("dialog")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
        fireEvent.keyDown(
          within(await screen.findByRole("dialog")).getByRole("button", {
            name: "Organization: Annex",
          }),
          { key: "Enter" },
        );
        fireEvent.click(
          within(await screen.findByRole("menu")).getByRole("menuitem", {
            name: "Example School",
          }),
        );
        await vi.waitFor(() => expect(header()?.textContent).toBe("Example School"));
      });

      test("says in the drawer when signing out from it failed, each time", async () => {
        onPhone();
        const { auth } = renderAt("/example", { braivo: { listCourses: async () => [] } });
        auth.signOut.mockResolvedValue({ error: { status: 500 } } as never);
        fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
        const drawer = await screen.findByRole("dialog");

        await signOutFromMenu();
        const first = await within(drawer).findByRole("alert");
        expect(first.textContent).toBe("Could not sign out. Try again.");
        await signOutFromMenu();
        // A new alert, so it is announced again.
        await vi.waitFor(() => expect(within(drawer).getByRole("alert")).not.toBe(first));
      });
    });
  });

  test("titles an organization's pages so tabs tell apart pages and organizations", async () => {
    const braivo = {
      listCourses: async () => [
        { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
      ],
      listSources: async () => [saludos],
      getSource: async () => saludos,
      readCourse,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [],
      }),
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

  test("reads a slug that is not one of the owner's organizations as not found", async () => {
    const listCourses = vi.fn();
    renderAt("/elsewhere", { braivo: { listCourses } });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This organization does not exist, or you do not work in it.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
    expect(listCourses).not.toHaveBeenCalled();
  });

  test("reads a path below an organization that names no page as nothing, not the organization", async () => {
    renderAt("/example/courses", { braivo: { listCourses: async () => [] } });

    expect(
      await screen.findByRole("heading", { level: 1, name: "There is nothing here." }),
    ).toBeTruthy();
    // A way back on a phone, whose sidebar is a closed drawer.
    expect(screen.getByRole("link", { name: "Go to Example School" }).getAttribute("href")).toBe(
      "/example",
    );
    expect(screen.getByRole("button", { name: "Organization: Example School" })).toBeTruthy();
    expect(screen.queryByText(/This organization does not exist/)).toBeNull();
  });

  test("leads from a path that names nothing back home, to an organization managed", async () => {
    renderAt("/join/elsewhere", { braivo: { listCourses: async () => [] } });

    fireEvent.click(await screen.findByRole("link", { name: "Go home" }));

    expect(
      await screen.findByRole("button", { name: "Organization: Example School" }),
    ).toBeTruthy();
  });

  test("fails a page that could not load in its place, beside the sidebar, until tried again", async () => {
    const listCourses = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([beginners]);
    renderAt("/example", { braivo: { listCourses } });

    const failure = await screen.findByRole("region", { name: "Something went wrong." });
    expect(document.activeElement).toBe(failure);
    expect(screen.getByRole("button", { name: "Organization: Example School" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Beginners" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong.")).toBeNull();
  });

  test("shows that a slow first visit is on its way, before any of the page", async () => {
    const loading = Promise.withResolvers<Organization[]>();
    renderAt("/example", {
      braivo: { listOrganizations: () => loading.promise, listCourses: async () => [beginners] },
    });

    expect(await screen.findByRole("status", { name: "Loading" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Organization: / })).toBeNull();
    loading.resolve([school]);
    expect(await screen.findByRole("link", { name: "Beginners" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
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

  test("leads from a course or a source back to its list, without the sidebar", async () => {
    // In the page, as the sidebar is a closed drawer on a phone, and just above its heading.
    const parentOf = async (name: string) => {
      const main = await screen.findByRole("main");
      const heading = await within(main).findByRole("heading", { level: 1 });
      const link = within(main).getByRole("link", { name });
      expect(link.nextElementSibling).toBe(heading);
      return link.getAttribute("href");
    };

    renderAt("/example/courses/course-1", { braivo: { readCourse } });
    expect(await parentOf("Courses")).toBe("/example");
    cleanup();

    renderAt("/example/sources/s1", { braivo: { ...authoring(), getSource: async () => saludos } });
    expect(await parentOf("Sources")).toBe("/example/sources");
  });
});
