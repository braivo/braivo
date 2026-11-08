// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { lastUsed } from "@braivo/auth-client";
import type { Organization } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { OPTIONAL_READ_DEADLINE_MS } from "../lib/deadline.ts";
import { SPANISH_ID, activity } from "./fixtures.ts";
import { renderAt, stall, waitOut } from "./render.tsx";

// Braivo's own learn app on the installation's origin: My learning at `/learn`,
// a person's own course at `/c/<course ID>` (ADR 0059).

const GREEK_ID = "6b8f0000-0000-4000-8000-000000000001";
const greek = { id: GREEK_ID, number: 7559, title: "My Greek", urlLabel: "my-greek" };

function organization(name: string, slug: string, personal = false): Organization {
  return {
    id: slug,
    name,
    slug,
    learnDomain: `${slug}.example`,
    personal,
    administers: !personal,
    authors: true,
    teaches: false,
  };
}

describe("My learning at `/learn` on the installation's origin", () => {
  test("shows a signed-in account its own courses at once, and the way back to each school's console", async () => {
    const { learnerCourses, listOrganizations } = renderAt("/learn", {
      installation: true,
      signedIn: true,
      personalCourses: async () => [greek],
      listOrganizations: async () => [
        organization("Fernwood", "fernwood"),
        organization("Ada's own", "ada", true),
        organization("Oakridge", "oakridge"),
      ],
    });

    expect(await screen.findByRole("heading", { level: 1, name: "My learning" })).toBeTruthy();
    expect(screen.getByText("Ada Learner")).toBeTruthy();
    // Its own course by its ID, the one address that names it for everyone.
    expect(screen.getByRole("link", { name: "My Greek" }).getAttribute("href")).toBe(
      `/c/${GREEK_ID}`,
    );
    // Each school's console is the console's to load; a personal organization is no school.
    const consoles = screen.getByRole("region", { name: "Your organizations" });
    expect(
      within(consoles)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Fernwood", "/fernwood"],
      ["Oakridge", "/oakridge"],
    ]);
    // Not the schools' courses, which open on each school's domain.
    expect(learnerCourses).not.toHaveBeenCalled();
    expect(listOrganizations).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.title).toBe("My learning"));
    // What a later bare `/` resumes, this account's alone.
    expect(lastUsed("ada")).toEqual({ area: "learning" });
  });

  test("says there is nothing of their own yet, and stands without the consoles unread in time", async () => {
    vi.useFakeTimers();
    renderAt("/learn", {
      installation: true,
      signedIn: true,
      listOrganizations: (options) => stall(options),
    });
    await waitOut(OPTIONAL_READ_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByText("Nothing of your own yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Your organizations" })).toBeNull();
  });

  test("with nothing of their own, sends a learner on to each school's site, signed in", async () => {
    const { listMemberships } = renderAt("/learn", {
      installation: true,
      signedIn: true,
      listMemberships: async () => [
        { id: "fernwood", name: "Fernwood", learnDomain: "fernwood.example" },
        // No site yet, so nowhere to send them.
        { id: "annex", name: "Annex", learnDomain: null },
      ],
    });

    expect(await screen.findByText("Nothing of your own yet")).toBeTruthy();
    const schools = screen.getByRole("region", { name: "Your schools" });
    expect(
      within(schools)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([["Fernwood", "https://fernwood.example/api/session/sign-in"]]);
    expect(listMemberships).toHaveBeenCalledOnce();
  });

  test("is a school domain's own home there, never My learning under its brand", async () => {
    const { router, personalCourses } = renderAt("/learn", {
      hostOrganization: async () => ({ name: "Fernwood" }),
      signedIn: true,
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Your courses" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(personalCourses).not.toHaveBeenCalled();
  });
});

describe("a course at `/c/<course ID>` on the installation's origin", () => {
  test("opens one of the person's own, reloaded, and closes back to My learning", async () => {
    renderAt(`/c/${GREEK_ID}`, {
      installation: true,
      signedIn: true,
      personalCourses: async () => [greek],
      nextActivity: async () => activity,
    });

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("My Greek");
    fireEvent.click(screen.getByRole("link", { name: "Close" }));
    expect(await screen.findByRole("heading", { level: 1, name: "My learning" })).toBeTruthy();
  });

  test.each([
    ["a school's course by its ID", `/c/${SPANISH_ID}`],
    ["a number, which names a course within one organization alone", "/c/7559-my-greek"],
  ])("opens nothing there for %s", async (_, path) => {
    const { nextActivity } = renderAt(path, {
      installation: true,
      signedIn: true,
      personalCourses: async () => [greek],
      // As the server answers a number on the installation's host: none.
      learnerCourseByNumber: async () => undefined,
      nextActivity: async () => activity,
    });

    await screen.findByRole("region", {
      name: "This course does not exist, or is not one of yours.",
    });
    expect(nextActivity).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Your courses" }).getAttribute("href")).toBe("/learn");
  });

  test("fails a course named by ID while what the host serves is unread, asking again on Try again", async () => {
    let answered = false;
    const { host, nextActivity } = renderAt(`/c/${GREEK_ID}`, {
      installation: true,
      signedIn: true,
      hostOrganization: async () => {
        if (!answered) throw new TypeError("Failed to fetch");
        return undefined;
      },
      personalCourses: async () => [greek],
      nextActivity: async () => activity,
    });

    // Never guessed a school's domain, which would open any course by ID.
    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    expect(nextActivity).not.toHaveBeenCalled();
    answered = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("My Greek");
    expect(host.mock.calls.length).toBeGreaterThan(1);
  });

  describe("never substitutes Bob's equal-number course for Alice's private URL", () => {
    const ALICE_ID = "a11ce000-0000-4000-8000-000000007559";
    const BOB_ID = "b0b00000-0000-4000-8000-000000007559";
    const FERNWOOD_ID = "fe500000-0000-4000-8000-000000007559";
    const bobs = { id: BOB_ID, number: 7559, title: "Bob's Greek", urlLabel: "bobs-greek" };
    const fernwoods = {
      id: FERNWOOD_ID,
      number: 7559,
      title: "Fernwood's Greek",
      urlLabel: "greek",
    };
    // As Bob: his personal listing holds his own course alone.
    const asBob = (path: string) =>
      renderAt(path, {
        installation: true,
        signedIn: true,
        user: { id: "bob", name: "Bob" },
        personalCourses: async () => [bobs],
        // As the server answers a number on the installation's host: none.
        learnerCourseByNumber: async () => undefined,
        nextActivity: async () => activity,
      });

    test.each([
      ["Alice's private course", `/c/${ALICE_ID}`],
      ["the shared number", "/c/7559"],
      ["the school's course", `/c/${FERNWOOD_ID}`],
    ])("says %s is unavailable, asking nothing of it", async (_, path) => {
      const { nextActivity } = asBob(path);

      await screen.findByRole("region", {
        name: "This course does not exist, or is not one of yours.",
      });
      expect(nextActivity).not.toHaveBeenCalled();
      expect(screen.queryByText("Bob's Greek")).toBeNull();
    });

    test("opens Bob's own by its ID", async () => {
      const { nextActivity } = asBob(`/c/${BOB_ID}`);

      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Bob's Greek");
      expect(nextActivity).toHaveBeenCalledWith(BOB_ID, expect.anything());
    });

    test("finds the school's course by the number on its own domain", async () => {
      const { nextActivity } = renderAt("/c/7559-greek", {
        hostOrganization: async () => ({ name: "Fernwood" }),
        signedIn: true,
        learnerCourseByNumber: async (number) => (number === 7559 ? fernwoods : undefined),
        nextActivity: async () => activity,
      });

      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
        "Fernwood's Greek",
      );
      expect(nextActivity).toHaveBeenCalledWith(FERNWOOD_ID, expect.anything());
    });
  });

  test("sends a signed-out visitor through the console's sign-in, back to that course", async () => {
    const { visit } = renderAt(`/c/${GREEK_ID}`, { installation: true, signedIn: false });

    await vi.waitFor(() =>
      expect(visit).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(`/c/${GREEK_ID}`)}`),
    );
    // The learn app's own form is a misrouted host's, never shown here.
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });
});
