// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type LearningDecision } from "@braivo/server/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { routeTree } from "./routeTree.gen.ts";

afterEach(cleanup);

/**
 * The app as a learner reaches it, at `path`, with Braivo and the session
 * stubbed: the route tree is the real one, so gating and loading are too.
 */
function renderAt(
  path: string,
  options: { signedIn: boolean; nextObjective?: () => Promise<LearningDecision | undefined> },
) {
  const nextObjective = vi.fn(options.nextObjective ?? (async () => undefined));
  const auth = {
    getSession: async () => ({
      data: options.signedIn ? { user: { name: "Ada Learner" } } : null,
      error: null,
    }),
  } as unknown as AppContext["auth"];
  const braivo = { nextObjective } as unknown as AppContext["braivo"];

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, braivo },
  });
  render(<RouterProvider router={router} />);

  return { nextObjective, router };
}

describe("the learn app", () => {
  test("sends a signed-out learner to sign in, and asks Braivo nothing", async () => {
    const { nextObjective, router } = renderAt("/courses/c1", { signedIn: false });

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ redirect: "/courses/c1" });
    expect(nextObjective).not.toHaveBeenCalled();
  });

  test("shows what to learn next in a course", async () => {
    const { nextObjective } = renderAt("/courses/c1", {
      signedIn: true,
      nextObjective: async () => ({ objectiveId: "o1", modelVersion: "v1", intent: "introduce" }),
    });

    expect(await screen.findByRole("heading", { name: "Learn something new" })).toBeTruthy();
    expect(screen.getByText("Objective o1")).toBeTruthy();
    expect(nextObjective).toHaveBeenCalledWith("c1", { signal: expect.any(AbortSignal) });
  });

  test("shows how likely a review is to be recalled", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextObjective: async () => ({
        objectiveId: "o1",
        modelVersion: "v1",
        intent: "review",
        retrievability: 0.354,
        stability: 1,
      }),
    });

    expect(await screen.findByText("Likely to recall: 35%.")).toBeTruthy();
  });

  test("tells a caught-up learner so", async () => {
    renderAt("/courses/c1", { signedIn: true });

    expect(await screen.findByText("You are all caught up")).toBeTruthy();
  });

  test("reads a course Braivo will not show as not found, not as caught up", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextObjective: async () => {
        throw new BraivoError(404, "not found");
      },
    });

    expect(
      await screen.findByText("This course does not exist, or is not one of yours."),
    ).toBeTruthy();
  });
});
