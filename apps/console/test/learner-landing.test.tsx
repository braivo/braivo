// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Where a plain sign-in at the installation's `/login` leads someone the
// console has nothing for: on to the school they learn at (access-59).

import {
  BraivoError,
  type InvitationPage,
  type Membership,
  type Organization,
} from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { school } from "./fixtures.ts";
import { renderAt, signInWithCode, stall, waitOut } from "./render.tsx";

const fernwood: Membership = {
  id: "org-fernwood",
  name: "Fernwood",
  learnDomain: "learn.fernwood.example",
};
const birchfield: Membership = { id: "org-birchfield", name: "Birchfield", learnDomain: null };
const fernwoodStart = "https://learn.fernwood.example/api/session/sign-in";

describe("a plain sign-in", () => {
  test("takes a learner of one school on to its learn domain, in `/`'s place", async () => {
    const { router, visit } = renderAt("/login", {
      signedIn: false,
      organizations: [],
      braivo: { listMemberships: async () => [fernwood] },
    });

    await signInWithCode();

    // The domain's own sign-in start, whose handoff offers this account
    // (access-12 to 14): no second code.
    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(fernwoodStart, { replace: true }));
    expect(visit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Taking you to Fernwood…");
    expect(screen.getByRole("link", { name: "Continue to Fernwood" }).getAttribute("href")).toBe(
      fernwoodStart,
    );
    expect(router.history.location.pathname).toBe("/");
  });

  test("offers Try again when the schools go unread in time, then takes a learner on", async () => {
    const listMemberships = vi
      .fn()
      .mockImplementationOnce((options?: { signal?: AbortSignal }) => stall(options))
      .mockResolvedValueOnce([fernwood]);
    const { visit } = renderAt("/login", {
      signedIn: false,
      organizations: [],
      braivo: { listMemberships },
    });
    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "zofia@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    const code = await screen.findByLabelText("Code");

    // Signed in, then Braivo stops answering: never a wait without end.
    vi.useFakeTimers();
    fireEvent.change(code, { target: { value: "123456" } });
    await vi.waitFor(() => expect(listMemberships).toHaveBeenCalledTimes(1));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    expect(visit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(fernwoodStart, { replace: true }));
    expect(listMemberships).toHaveBeenCalledTimes(2);
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
    const { router, visit } = renderAt("/login", {
      signedIn: false,
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

    await signInWithCode();

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

  test("says a learner's one school has no site yet, rather than leave", async () => {
    const { visit } = renderAt("/login", {
      signedIn: false,
      organizations: [],
      braivo: { listMemberships: async () => [birchfield] },
    });

    await signInWithCode();

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
