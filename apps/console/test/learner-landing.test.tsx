// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Where a bare `/` resumes on the installation's origin (access-59, ADR 0059),
// and `/join`, where someone managing none finds their schools.

import { rememberLastUsed } from "@braivo/auth-client";
import { activateLocale } from "@braivo/i18n";
import {
  BraivoError,
  type InvitationPage,
  type Membership,
  type Organization,
} from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { annex, school } from "./fixtures.ts";
import { renderAt, signInWithCode, stall, waitOut } from "./render.tsx";

const fernwood: Membership = {
  id: "org-fernwood",
  name: "Fernwood",
  learnDomain: "learn.fernwood.example",
};
const birchfield: Membership = { id: "org-birchfield", name: "Birchfield", learnDomain: null };
const fernwoodStart = "https://learn.fernwood.example/api/session/sign-in";

describe("a plain sign-in", () => {
  test("takes a learner to My learning, in `/`'s place, never asking their schools", async () => {
    const memberships = vi.fn(async () => [fernwood]);
    const { router, visit } = renderAt("/login", {
      signedIn: false,
      organizations: [],
      braivo: { listMemberships: memberships },
    });

    await signInWithCode();

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/learn", { replace: true }));
    expect(visit).toHaveBeenCalledTimes(1);
    expect(router.history.location.pathname).toBe("/");
    expect(memberships).not.toHaveBeenCalled();
  });

  test("offers Try again when the organizations go unread in time, then goes on", async () => {
    const listOrganizations = vi
      .fn()
      .mockImplementationOnce((options?: { signal?: AbortSignal }) => stall(options))
      .mockResolvedValueOnce([]);
    vi.useFakeTimers();
    const { visit } = renderAt("/", { braivo: { listOrganizations } });
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    expect(visit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/learn", { replace: true }));
    expect(listOrganizations).toHaveBeenCalledTimes(2);
  });

  test("resumes My learning for whoever last used it, staff included, asking nothing", async () => {
    rememberLastUsed("u1", { area: "learning" });
    const listOrganizations = vi.fn(async () => [school]);
    const { visit } = renderAt("/", { braivo: { listOrganizations } });

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/learn", { replace: true }));
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  test("resumes the console last used while it is theirs, else a school's, a personal organization no school", async () => {
    const own: Organization = { ...annex, id: "org-own", slug: "olive", personal: true };
    const braivo = { listCourses: async () => [] };
    rememberLastUsed("u1", { area: "console", organizationId: own.id });
    const resumed = renderAt("/", { organizations: [own, school], braivo });
    await vi.waitFor(() => expect(resumed.router.state.location.pathname).toBe("/olive"));
    cleanup();

    // No longer theirs: their school's, never their personal organization's.
    rememberLastUsed("u1", { area: "console", organizationId: "org-gone" });
    const stale = renderAt("/", { organizations: [own, school], braivo });
    await vi.waitFor(() => expect(stale.router.state.location.pathname).toBe("/example"));
    cleanup();

    // Owning only a personal organization, they learn.
    localStorage.clear();
    const { visit } = renderAt("/", { organizations: [own], braivo });
    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/learn", { replace: true }));
  });

  test("keeps the console for someone who teaches at one school and learns at another", async () => {
    const teaching: Organization = { ...school, administers: false, authors: false, teaches: true };
    const memberships = vi.fn(async () => [fernwood]);
    const { router, visit } = renderAt("/login", {
      signedIn: false,
      organizations: [teaching],
      braivo: { listMemberships: memberships, listCourses: async () => [] },
    });

    await signInWithCode();

    // The organization they teach in, at its own landing.
    await vi.waitFor(() => expect(router.history.location.pathname).toMatch(/^\/example\b/));
    // The console's own decides, never waiting on the learner's read.
    expect(memberships).not.toHaveBeenCalled();
    expect(visit).not.toHaveBeenCalled();
  });

  test("lets a learner of several schools choose, saying which has no site yet", async () => {
    const { router, visit } = renderAt("/join", {
      organizations: [],
      braivo: {
        listMemberships: async () => [birchfield, fernwood],
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
      },
    });

    expect(await screen.findByRole("heading", { name: "Where you learn" })).toBeTruthy();
    expect(router.history.location.pathname).toBe("/join");
    // The school it can open first, though the other comes first by name.
    const [first, second] = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(
      within(first!)
        .getByRole("link", { name: /Fernwood/ })
        .getAttribute("href"),
    ).toBe(fernwoodStart);
    expect(second!.textContent).toBe("BirchfieldIts site for learners is not available yet.");
    expect(within(second!).queryByRole("link")).toBeNull();
    // Braivo's title, not the console's: the page speaks to a learner.
    await vi.waitFor(() => expect(document.title).toBe("Where you learn · Braivo"));
    expect(screen.getByText(/Signed in as olive@example\.com\./)).toBeTruthy();
    // Choosing is a click; nothing leaves on its own.
    expect(visit).not.toHaveBeenCalled();
    // Learning, not setting up, is what the page is for: setup is asked for.
    expect(screen.queryByLabelText("Organization name")).toBeNull();
    expect(screen.getByRole("button", { name: "Set up an organization" })).toBeTruthy();
  });

  test("brings a learner of one school asking for /join there, to set up, not on to the school", async () => {
    // Signed out, as a link from Braivo's website finds them: the guard's
    // sign-in returns to `/join` (access-5), which sends no one on.
    const { router, visit } = renderAt("/join", {
      signedIn: false,
      organizations: [],
      braivo: {
        listMemberships: async () => [fernwood],
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
      },
    });

    await signInWithCode();

    expect(await screen.findByRole("button", { name: "Set up an organization" })).toBeTruthy();
    expect(router.history.location.pathname).toBe("/join");
    expect(screen.getByRole("link", { name: /Fernwood/ }).getAttribute("href")).toBe(fernwoodStart);
    expect(visit).not.toHaveBeenCalled();
  });

  test("lets a learner put setup down again, back to their schools", async () => {
    renderAt("/join", {
      organizations: [],
      braivo: {
        listMemberships: async () => [fernwood],
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Set up an organization" }));
    expect(await screen.findByLabelText("Organization name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Where you learn" })).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Set up an organization" }),
    );
  });

  test("keeps Back from leaving a setup under way, and offers it again once refused", async () => {
    const answer = Promise.withResolvers<Organization>();
    const setUpOrganization = vi.fn(() => answer.promise);
    renderAt("/join", {
      organizations: [],
      braivo: {
        listMemberships: async () => [fernwood],
        organizationSetup: async () => ({
          domain: "braivo.app",
          maySetUp: true,
          dataRegion: null,
          otherRegions: [],
        }),
        setUpOrganization,
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Set up an organization" }));
    fireEvent.change(await screen.findByLabelText("Organization name"), {
      target: { value: "Łąka" },
    });
    const back = screen.getByRole("button", { name: "Back" });
    expect((back as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    await vi.waitFor(() => expect(setUpOrganization).toHaveBeenCalledTimes(1));
    // Pending: whether it was made is not known yet, so no leaving.
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(back);
    expect(screen.getByLabelText("Organization name")).toBeTruthy();

    answer.reject(new BraivoError(409, "Braivo answered 409", "taken", "ADDRESS_TAKEN"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "laka.braivo.app is taken. Choose another address.",
    );
    expect((back as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(back);

    expect(await screen.findByRole("heading", { name: "Where you learn" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Set up an organization" }),
    );
  });

  test("lists a learner's schools in the chosen language, titled so", async () => {
    onTestFinished(() => activateLocale("en"));
    await activateLocale("pl");
    renderAt("/join", {
      organizations: [],
      braivo: { listMemberships: async () => [birchfield, fernwood] },
    });

    expect(await screen.findByRole("heading", { name: "Twoje szkoły" })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Twoje szkoły · Braivo"));
    expect(
      screen.getByText("Wybierz szkołę, aby do niej przejść. Zalogowano jako olive@example.com."),
    ).toBeTruthy();
    expect(screen.getByText("Strona dla uczniów nie jest jeszcze dostępna.")).toBeTruthy();
  });

  test("says a learner's one school has no site yet, rather than leave", async () => {
    const { visit } = renderAt("/join", {
      organizations: [],
      braivo: { listMemberships: async () => [birchfield] },
    });

    expect(await screen.findByText("Its site for learners is not available yet.")).toBeTruthy();
    expect(screen.getByText("Birchfield")).toBeTruthy();
    expect(visit).not.toHaveBeenCalled();
  });

  test("goes first where it was asked to, an invitation included, for a learner too", async () => {
    const invitation: InvitationPage = {
      organization: { name: "Example School" },
      status: "pending",
    };
    const { router, visit } = renderAt("/login?redirect=/invitations/inv-1", {
      signedIn: false,
      organizations: [],
      braivo: {
        listMemberships: async () => [fernwood],
        invitation: async () => invitation,
      },
    });

    await signInWithCode();

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/invitations/inv-1"));
    expect(visit).not.toHaveBeenCalled();
  });
});
