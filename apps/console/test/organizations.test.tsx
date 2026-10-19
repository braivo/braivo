// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type Organization } from "@braivo/server/client";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { school, annex, readCourse } from "./fixtures.ts";
import { renderAt, stall, waitOut } from "./render.tsx";

describe("the console", () => {
  test("sends an owner from /join to their organization, setup being theirs already", async () => {
    const { router } = renderAt("/join", {
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: false,
          dataRegion: null,
          otherRegions: [],
        }),
        listCourses: async () => [],
      },
    });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test("shows an organization's page without waiting on whether setup is offered", async () => {
    renderAt("/example", {
      organizations: [school, annex],
      braivo: { organizationSetup: () => new Promise(() => {}), listCourses: async () => [] },
    });

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    // Switching, meanwhile, offered as for anyone managing several.
    fireEvent.keyDown(screen.getByRole("button", { name: /^Organization: / }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Set up an organization" })).toBeNull();
    cleanup();

    // With one organization, it alone meanwhile.
    renderAt("/example", {
      braivo: { organizationSetup: () => new Promise(() => {}), listCourses: async () => [] },
    });
    expect(await screen.findByText("No courses yet")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Organization: Example School" }), {
      key: "Enter",
    });
    const alone = await screen.findByRole("menu");
    expect(
      within(alone)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Example School"]);
  });

  test("offers setup once a read of whether it may succeeds, after one that failed", async () => {
    const eligible = { domain: "braivo.app", maySetUp: true, dataRegion: null, otherRegions: [] };
    const organizationSetup = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(eligible);
    const { router } = renderAt("/example", {
      braivo: { organizationSetup, listCourses: async () => [], listSources: async () => [] },
    });
    expect(await screen.findByText("No courses yet")).toBeTruthy();
    const setUp = { name: "Set up an organization" };
    const openSwitcher = async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: /^Organization: / }), { key: "Enter" });
      return screen.findByRole("menu");
    };
    expect(within(await openSwitcher()).queryByRole("menuitem", setUp)).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Read again on the next navigation, not left out for good.
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });
    expect(within(await openSwitcher()).getByRole("menuitem", setUp)).toBeTruthy();
  });

  test("keeps an admin's open menu while whether they may set one up is read again", async () => {
    const eligible = { domain: "braivo.app", maySetUp: true, dataRegion: null, otherRegions: [] };
    const organizationSetup = vi
      .fn()
      .mockResolvedValueOnce(eligible)
      .mockReturnValue(new Promise(() => {}));
    const { router } = renderAt("/example", {
      braivo: { organizationSetup, listCourses: async () => [] },
    });
    fireEvent.keyDown(await screen.findByRole("button", { name: /^Organization: / }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu");

    await act(() => router.invalidate());

    expect(organizationSetup).toHaveBeenCalledTimes(2);
    expect(menu.isConnected).toBe(true);
    expect(within(menu).getByRole("menuitem", { name: "Set up an organization" })).toBeTruthy();
  });

  test("keeps an admin's open menu when reading again whether they may set one up fails", async () => {
    const eligible = { domain: "braivo.app", maySetUp: true, dataRegion: null, otherRegions: [] };
    const organizationSetup = vi
      .fn()
      .mockResolvedValueOnce(eligible)
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const { router } = renderAt("/example", {
      braivo: { organizationSetup, listCourses: async () => [] },
    });
    fireEvent.keyDown(await screen.findByRole("button", { name: /^Organization: / }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu");

    await act(() => router.invalidate());
    // Unknown, not refused: the last answer stands.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(organizationSetup).toHaveBeenCalledTimes(2);
    expect(menu.isConnected).toBe(true);
    expect(within(menu).getByRole("menuitem", { name: "Set up an organization" })).toBeTruthy();
  });

  test("offers no setup form where Braivo says the account may not", async () => {
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: false,
          dataRegion: null,
          otherRegions: [],
        }),
      },
    });

    expect(await screen.findByText("You don't manage any organizations")).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });

  test("stops offering setup once the admin has set one up", async () => {
    const organizations: Organization[] = [school];
    let maySetUp = true;
    const { router } = renderAt("/example", {
      organizations,
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization: async ({ name, slug }: { name: string; slug: string }) => {
          const created = {
            id: "org-own",
            name,
            slug,
            learnDomain: `${slug}.braivo.app`,
            administers: true,
            authors: true,
            teaches: false,
          };
          organizations.push(created);
          maySetUp = false;
          return created;
        },
        listCourses: async () => [],
      },
    });
    await screen.findByRole("button", { name: /^Organization: / });

    await router.navigate({ to: "/join" });
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Own" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/own"));

    // Back where setup was offered, its page cached: offered no longer.
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    fireEvent.keyDown(await screen.findByRole("button", { name: /^Organization: / }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Example School", "Own"]);
  });

  test("offers an admin owning none setup, from the switcher to /join", async () => {
    const organizationSetup = async () => ({
      domain: "braivo.app",
      maySetUp: true,
      dataRegion: null,
      otherRegions: [],
    });
    const { router } = renderAt("/example", {
      braivo: { organizationSetup, listCourses: async () => [] },
    });

    // One organization, and still a switcher: its last item is setting one up.
    fireEvent.keyDown(await screen.findByRole("button", { name: /^Organization: / }), {
      key: "Enter",
    });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Set up an organization" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/join"));
    expect(await screen.findByLabelText("Organization name")).toBeTruthy();
    // Under the header, the logo leading to `/`, not an organization's sidebar.
    expect(screen.getByRole("banner").contains(screen.getByRole("link", { name: /^braivo/ }))).toBe(
      true,
    );
    expect(screen.getByRole("link", { name: /^braivo/ }).getAttribute("href")).toBe("/");
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
    // The language a menu of its own, for whoever cannot read the page yet.
    expect(screen.getByRole("button", { name: "Language: English" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sidebar|navigation/ })).toBeNull();
    // Not new here: no word on where learners go.
    expect(screen.queryByText(/Here to learn\?/)).toBeNull();
  });

  test("switches between the organizations an owner manages from the sidebar, each at its home", async () => {
    // From a course's page: no course carries over to another organization.
    const { router } = renderAt("/annex/courses/course-1", {
      organizations: [annex, school],
      braivo: { readCourse },
    });
    // By keyboard: Radix's menus ignore a bare click.
    const trigger = await screen.findByRole("button", { name: "Organization: Annex" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Annex", "Example School"]);
    expect(items[0]?.getAttribute("aria-current")).toBe("page");
    expect(items[1]?.getAttribute("aria-current")).toBeNull();
    fireEvent.click(items[1] as HTMLElement);

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test("asks where a new organization's data is stored, only where the installation says", async () => {
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: "EU",
          otherRegions: [{ region: "US", setupUrl: null }],
        }),
      },
    });

    const region = (await screen.findByLabelText("Data region")) as HTMLSelectElement;
    expect(region.value).toBe("EU");
    expect(screen.getByRole("option", { name: "European Union" })).toBeTruthy();
    // Listed, never chosen, until its installation is open.
    const unopened = screen.getByRole("option", { name: "United States (coming soon)" });
    expect((unopened as HTMLOptionElement).disabled).toBe(true);
    cleanup();

    // Nothing else to choose: said, not asked.
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: "EU",
          otherRegions: [],
        }),
      },
    });

    expect(await screen.findByText("European Union")).toBeTruthy();
    expect(screen.getByText("Data region")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    cleanup();

    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
      },
    });

    expect(await screen.findByLabelText("Organization name")).toBeTruthy();
    expect(screen.queryByText("Data region")).toBeNull();
  });

  test("trades the form for a link to another region's own installation", async () => {
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: "EU",
          otherRegions: [{ region: "US", setupUrl: "https://us.braivo.app/join" }],
        }),
      },
    });
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Fernwood" },
    });

    fireEvent.change(screen.getByLabelText("Data region"), { target: { value: "US" } });
    expect(screen.getByText(/set up on its own site, where you sign in again/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Go to the United States site" });
    expect(link.getAttribute("href")).toBe("https://us.braivo.app/join");
    // Nothing asked here, nor sent.
    expect(screen.queryByRole("textbox", { name: "Organization name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create organization" })).toBeNull();

    // Back to this installation's region: what was typed is still there.
    fireEvent.change(screen.getByLabelText("Data region"), { target: { value: "EU" } });
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe("Fernwood");
    expect(screen.getByText("fernwood.braivo.app")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create organization" })).toBeTruthy();
  });

  test("tells someone who manages no organization where to go, and who they are", async () => {
    renderAt("/join", { organizations: [] });

    expect(await screen.findByText("You don't manage any organizations")).toBeTruthy();
    expect(screen.getByText(/Open the site your school/)).toBeTruthy();
    expect(screen.getByText("Signed in as olive@example.com.")).toBeTruthy();
  });

  test("sets up an organization for someone new, at the address its name makes or one edited", async () => {
    const organizations: Organization[] = [];
    const setUpOrganization = vi.fn(async ({ name, slug }: { name: string; slug: string }) => {
      const created = {
        id: "org-new",
        name,
        slug,
        learnDomain: `${slug}.braivo.app`,
        administers: true,
        authors: true,
        teaches: false,
      };
      organizations.push(created);
      return created;
    });
    renderAt("/join", {
      organizations,
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
        listCourses: async () => [],
      },
    });

    const name = await screen.findByLabelText("Organization name");
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Szkoła Łąka" } });
    // Shown, not asked.
    expect(screen.getByText("szkola-laka.braivo.app")).toBeTruthy();
    expect(screen.queryByLabelText("Learners' site")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit learners' site" }));
    const address = screen.getByLabelText("Learners' site") as HTMLInputElement;
    expect(document.activeElement).toBe(address);
    expect(address.value).toBe("szkola-laka");
    // Announced whole: the domain beside it, and that it is permanent.
    const described = address.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described.map((id) => document.getElementById(id)?.textContent).join(" ")).toBe(
      ".braivo.app This address cannot be changed later.",
    );
    fireEvent.change(address, { target: { value: "laka" } });
    fireEvent.change(name, { target: { value: "Szkoła Łąka w Lesie" } });
    expect(address.value).toBe("laka");
    // A learner who came here is still told where to go, and anyone who they are.
    expect(screen.getByText(/Open the site your school/)).toBeTruthy();
    expect(screen.getByText(/to add olive@example\.com\.$/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
    expect(setUpOrganization).toHaveBeenCalledExactlyOnceWith(
      { name: "Szkoła Łąka w Lesie", slug: "laka" },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("link", { name: "laka.braivo.app" })).toBeTruthy();
  });

  test("creates at the address the name makes, unedited", async () => {
    const setUpOrganization = vi.fn(async ({ name, slug }: { name: string; slug: string }) => ({
      id: "org-new",
      name,
      slug,
      learnDomain: null,
    }));
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });

    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Pimsleur" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    await vi.waitFor(() =>
      expect(setUpOrganization).toHaveBeenCalledExactlyOnceWith(
        { name: "Pimsleur", slug: "pimsleur" },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("sends one setup however often it is submitted while pending", async () => {
    const answered = Promise.withResolvers<Organization>();
    const setUpOrganization = vi.fn(() => answered.promise);
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });
    const name = await screen.findByLabelText("Organization name");
    fireEvent.change(name, { target: { value: "Pimsleur" } });

    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    const pending = await screen.findByRole("button", { name: "Creating…" });
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    expect((name as HTMLInputElement).readOnly).toBe(true);
    const edit = screen.getByRole("button", { name: "Edit learners' site" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(edit);
    expect(screen.queryByLabelText("Learners' site")).toBeNull();
    // Enter in a field submits past aria-disabled.
    fireEvent.submit(name);
    fireEvent.click(pending);
    expect(setUpOrganization).toHaveBeenCalledTimes(1);

    // No answer: it may have been made, so not "try again".
    answered.reject(new Error("unreachable"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not confirm the organization was created. Reload this page to check before trying again.",
    );
    expect(screen.getByRole("button", { name: "Create organization" })).toBeTruthy();
  });

  test("gives up on a setup Braivo does not answer in time, as it may have been made", async () => {
    const setUpOrganization = vi.fn((_organization: object, options?: { signal?: AbortSignal }) =>
      stall(options),
    );
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Pimsleur" },
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not confirm the organization was created. Reload this page to check before trying again.",
    );
  });

  test.each([
    [
      "an answer it could not read",
      new BraivoError(201, "Braivo answered 201 with a body that is not JSON."),
    ],
    ["a server error", new BraivoError(500, "Braivo answered 500.")],
  ])(
    "tells someone to reload before trying again after %s, as it may have been made",
    async (_case, error) => {
      const setUpOrganization = vi.fn(async () => {
        throw error;
      });
      renderAt("/join", {
        organizations: [],
        braivo: {
          organizationSetup: async () => ({
            domain: "braivo.app",
            maySetUp: true,
            dataRegion: null,
            otherRegions: [],
          }),
          setUpOrganization,
        },
      });
      fireEvent.change(await screen.findByLabelText("Organization name"), {
        target: { value: "Fernwood" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not confirm the organization was created. Reload this page to check before trying again.",
      );
    },
  );

  test("says someone signed out meanwhile was, not to try again", async () => {
    const setUpOrganization = vi.fn(async () => {
      throw new BraivoError(401, "Braivo answered 401.");
    });
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Fernwood" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You were signed out. Sign in again.",
    );
  });

  test("opens the address when the name makes none, saying what one is", async () => {
    const setUpOrganization = vi.fn();
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });

    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "東京" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    const address = screen.getByLabelText("Learners' site") as HTMLInputElement;
    expect(address.validationMessage).toBe(
      "Enter an address of lowercase letters, digits, and single hyphens.",
    );
    expect(setUpOrganization).not.toHaveBeenCalled();

    // A name that makes one makes it good again.
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Tokyo" } });
    expect(address.value).toBe("tokyo");
    expect(address.validationMessage).toBe("");
  });

  test("says why an organization was not set up, each time, opening the address", async () => {
    const taken = "laka.braivo.app is taken. Choose another address.";
    const setUpOrganization = vi.fn(async () => {
      throw new BraivoError(409, "Braivo answered 409", taken, "ADDRESS_TAKEN");
    });
    renderAt("/join", {
      organizations: [],
      braivo: {
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Łąka" },
    });
    const create = screen.getByRole("button", { name: "Create organization" });

    fireEvent.click(create);
    const first = await screen.findByRole("alert");
    expect(first.textContent).toBe(taken);
    const address = screen.getByLabelText("Learners' site") as HTMLInputElement;
    expect(address.value).toBe("laka");

    // Editing clears Braivo's refusal; an address it would not take is refused
    // before sending.
    fireEvent.change(address, { target: { value: "Łąka" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(create);
    expect(address.validationMessage).toBe(
      "Use lowercase letters, digits, and single hyphens between them.",
    );
    expect(setUpOrganization).toHaveBeenCalledTimes(1);

    fireEvent.change(address, { target: { value: "laka" } });
    fireEvent.click(await screen.findByRole("button", { name: "Create organization" }));
    await vi.waitFor(() => expect(setUpOrganization).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
    expect(address.value).toBe("laka");
    // A typed address stays as the name changes, and so does its refusal.
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Łąka w Lesie" },
    });
    expect(screen.getByRole("alert").textContent).toBe(taken);
  });

  test("offers no setup where the operator creates organizations", async () => {
    renderAt("/join", { organizations: [] });

    expect(await screen.findByText("You don't manage any organizations")).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });
});
