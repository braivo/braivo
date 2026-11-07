// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Where a plain sign-in at the installation's `/login` leads someone the
// console has nothing for: on to the school they learn at (access-59).

import type { InvitationPage, Membership, Organization } from "@braivo/server/client";
import { screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { school } from "./fixtures.ts";
import { renderAt, signInWithCode } from "./render.tsx";

const fernwood: Membership = {
  id: "org-fernwood",
  name: "Fernwood",
  learnDomain: "learn.fernwood.example",
};
const birchfield: Membership = { id: "org-birchfield", name: "Birchfield", learnDomain: null };
const fernwoodStart = "https://learn.fernwood.example/api/session/sign-in";

describe("a plain sign-in", () => {
  test("takes a learner of one school on to its learn domain, in sign-in's place", async () => {
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
    const [first, second] = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(first!.textContent).toBe("BirchfieldIts site for learners is not available yet.");
    expect(within(first!).queryByRole("link")).toBeNull();
    expect(
      within(second!)
        .getByRole("link", { name: /Fernwood/ })
        .getAttribute("href"),
    ).toBe(fernwoodStart);
    expect(screen.getByText(/Signed in as olive@example\.com\./)).toBeTruthy();
    // Choosing is a click; nothing leaves on its own.
    expect(visit).not.toHaveBeenCalled();
    // Learning, not setting up, is what the page is for: setup is asked for.
    expect(screen.queryByLabelText("Organization name")).toBeNull();
    expect(screen.getByRole("button", { name: "Set up an organization" })).toBeTruthy();
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
