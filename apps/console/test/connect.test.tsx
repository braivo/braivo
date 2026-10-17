// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { school, annex } from "./fixtures.ts";
import {
  renderAt,
  signInWithCode,
  REVIEWER_PASSWORD,
  signInWithPassword,
  stall,
  waitOut,
} from "./render.tsx";

/** What approving or denying a code sends Better Auth. */
type Decision = { userCode: string; fetchOptions?: { signal?: AbortSignal } };

/** A device-flow stub: `status` for a known code, an error for any other. */
function deviceFlow(status = "pending") {
  const device = Object.assign(
    vi.fn(
      async ({
        query,
      }: {
        query: { user_code: string };
        fetchOptions?: { signal?: AbortSignal };
      }) =>
        ["ABCD2345", "EFGH6789"].includes(query.user_code)
          ? { data: { user_code: query.user_code, status, client_id: "braivo-cli" }, error: null }
          : {
              data: null,
              error: { status: 400, error: "invalid_request", error_description: "Invalid" },
            },
    ),
    {
      approve: vi.fn(async (_decision: Decision) => ({ data: { success: true }, error: null })),
      deny: vi.fn(async (_decision: Decision) => ({ data: { success: true }, error: null })),
    },
  );
  return device;
}

describe("the console", () => {
  describe("connecting an AI app", () => {
    /** The signed query Better Auth sent the browser with, as `/api/oauth/*` wraps it. */
    const query = "client_id=c1&scope=braivo%3Aauthor&sig=s";
    const request = `r.${btoa(query).replaceAll("+", "-").replaceAll("/", "_")}`;
    /** Better Auth answering the page: the client named Claude, then `answers` by path. */
    const betterAuth = (answers: Record<string, unknown> = {}) =>
      vi.fn(async (path: string, _options?: object) =>
        path === "/oauth2/public-client-prelogin"
          ? { data: { client_name: "Claude" }, error: null }
          : { data: answers[path] ?? {}, error: null },
      );
    const learnerOnly: Organization = {
      ...annex,
      id: "org-3",
      name: "Night School",
      administers: false,
    };

    test("asks which organization the app works in, among those the person manages", async () => {
      const $fetch = betterAuth({ "/oauth2/continue": { url: "/api/oauth/consent?next" } });
      const { visit } = renderAt(`/consent?step=organization&request=${request}`, {
        $fetch,
        organizations: [school, annex, learnerOnly],
      });

      expect(
        await screen.findByRole("heading", { name: "Which organization should Claude work in?" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Example School" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Night School" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Annex" }));

      // Kept on the session first, then the authorization resumed.
      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/api/oauth/consent?next"));
      expect($fetch.mock.calls.slice(1)).toEqual([
        [
          "/organization/set-active",
          { method: "POST", body: { organizationId: annex.id }, signal: expect.any(AbortSignal) },
        ],
        [
          "/oauth2/continue",
          {
            method: "POST",
            body: { postLogin: true, oauth_query: query, organizationId: annex.id },
            signal: expect.any(AbortSignal),
          },
        ],
      ]);
    });

    test("resumes after a reviewer signs in with a password, as after a code", async () => {
      const consent = `/consent?step=organization&request=${request}`;
      const { auth } = renderAt(`/login?method=password&redirect=${encodeURIComponent(consent)}`, {
        signedIn: false,
        $fetch: betterAuth(),
      });

      await signInWithPassword("wrong");
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "That email and password do not match.",
      );
      await signInWithPassword();

      expect(
        await screen.findByRole("heading", { name: "Which organization should Claude work in?" }),
      ).toBeTruthy();
      expect(auth.signIn.email).toHaveBeenLastCalledWith(
        expect.objectContaining({ email: "reviewer@example.com", password: REVIEWER_PASSWORD }),
      );
    });

    test("tells someone managing none, and lets them send the app back", async () => {
      const $fetch = betterAuth({ "/oauth2/consent": { url: "https://claude.ai/back?error=x" } });
      const { visit } = renderAt(`/consent?step=organization&request=${request}`, {
        $fetch,
        organizations: [learnerOnly],
      });

      expect(
        await screen.findByRole("heading", { name: "You don't manage any organizations" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("https://claude.ai/back?error=x"));
      expect($fetch).toHaveBeenLastCalledWith("/oauth2/consent", {
        method: "POST",
        body: { accept: false, oauth_query: query },
        signal: expect.any(AbortSignal),
      });
    });

    test("names the organization chosen when asking for consent", async () => {
      const $fetch = betterAuth({ "/oauth2/consent": { url: "https://claude.ai/back?code=c" } });
      const { visit } = renderAt(`/consent?request=${request}`, {
        $fetch,
        organizations: [school, annex],
        getSession: async () => ({
          data: {
            user: { id: "u1", name: "Olive Owner" },
            session: { activeOrganizationId: annex.id },
          },
          error: null,
        }),
      });

      expect(
        await screen.findByRole("heading", { name: "Let Claude work in Annex?" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("https://claude.ai/back?code=c"));
      expect($fetch).toHaveBeenLastCalledWith("/oauth2/consent", {
        method: "POST",
        body: { accept: true, oauth_query: query, organizationId: annex.id },
        signal: expect.any(AbortSignal),
      });
    });

    /** Approving, refused with `error`; where the page then stands. */
    async function refusedWith(error: object) {
      const $fetch = vi.fn(async (path: string, _options?: object) =>
        path === "/oauth2/public-client-prelogin"
          ? { data: { client_name: "Claude" }, error: null }
          : { data: null, error },
      );
      const { visit } = renderAt(`/consent?request=${request}`, {
        $fetch,
        organizations: [school, annex],
        getSession: async () => ({
          data: {
            user: { id: "u1", name: "Olive Owner" },
            session: { activeOrganizationId: annex.id },
          },
          error: null,
        }),
      });
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      return visit;
    }

    test("says so when another tab chose another organization since", async () => {
      const visit = await refusedWith({ status: 403, code: "ACTIVE_ORGANIZATION_CHANGED" });

      expect(
        await screen.findByRole("heading", {
          name: "Another organization was chosen in another tab. Start again in Claude.",
        }),
      ).toBeTruthy();
      expect(visit).not.toHaveBeenCalled();
    });

    test("blames no other tab for another refusal, such as no longer managing it", async () => {
      const visit = await refusedWith({ status: 403, error: "access_denied" });

      expect(
        await screen.findByRole("heading", {
          name: "Could not connect Claude. Check your access, then start again in Claude.",
        }),
      ).toBeTruthy();
      expect(visit).not.toHaveBeenCalled();
    });

    test("gives up on an answer Braivo does not take in time, saying which was being sent", async () => {
      const $fetch = vi.fn(async (path: string, options?: { signal?: AbortSignal }) =>
        path === "/oauth2/public-client-prelogin"
          ? { data: { client_name: "Claude" }, error: null }
          : stall(options),
      );
      const { visit } = renderAt(`/consent?request=${request}`, {
        $fetch,
        organizations: [school, annex],
        getSession: async () => ({
          data: {
            user: { id: "u1", name: "Olive Owner" },
            session: { activeOrganizationId: annex.id },
          },
          error: null,
        }),
      });
      const approve = await screen.findByRole("button", { name: "Approve" });

      vi.useFakeTimers();
      fireEvent.click(approve);
      expect(approve.textContent).toBe("Approving…");
      expect(screen.getByRole("button", { name: "Deny" }).getAttribute("aria-disabled")).toBe(
        "true",
      );
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not record your answer. Try again.",
      );
      expect(approve.textContent).toBe("Approve");
      expect(approve.getAttribute("aria-disabled")).toBe("false");
      expect(visit).not.toHaveBeenCalled();
    });

    test("marks the organization being chosen, and gives up on it in time", async () => {
      const $fetch = vi.fn(async (path: string, options?: { signal?: AbortSignal }) =>
        path === "/oauth2/public-client-prelogin"
          ? { data: { client_name: "Claude" }, error: null }
          : stall(options),
      );
      renderAt(`/consent?step=organization&request=${request}`, {
        $fetch,
        organizations: [school, annex],
      });

      const chosen = await screen.findByRole("button", { name: "Annex" });

      vi.useFakeTimers();
      fireEvent.click(chosen);
      expect(chosen.getAttribute("aria-busy")).toBe("true");
      const other = screen.getByRole("button", { name: "Example School" });
      expect(other.getAttribute("aria-busy")).toBe("false");
      expect(other.getAttribute("aria-disabled")).toBe("true");
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not record your answer. Try again.",
      );
      expect(chosen.getAttribute("aria-busy")).toBe("false");
    });

    test.each([
      ["choosing an organization", "/consent?step=organization", "Annex"],
      // A new session has no organization chosen to consent for.
      ["approving", "/consent?", "Approve"],
    ])(
      "sends someone signed out before %s to sign in, then back to choosing",
      async (_case, page, button) => {
        let signedIn = true;
        const $fetch = vi.fn(async (path: string, _options?: object) =>
          path === "/oauth2/public-client-prelogin"
            ? { data: { client_name: "Claude" }, error: null }
            : { data: null, error: { status: 401 } },
        );
        const { router, visit } = renderAt(`${page}&request=${request}`, {
          $fetch,
          organizations: [school, annex],
          getSession: async () => ({
            data: signedIn
              ? {
                  user: { id: "u1", name: "Olive Owner" },
                  session: { activeOrganizationId: annex.id },
                }
              : null,
            error: null,
          }),
        });
        const target = await screen.findByRole("button", { name: button });
        signedIn = false;

        fireEvent.click(target);

        expect(await screen.findByLabelText("Email address")).toBeTruthy();
        expect(router.state.location.search).toEqual({
          redirect: `/consent?step=organization&request=${encodeURIComponent(request)}`,
        });
        expect(visit).not.toHaveBeenCalled();
      },
    );

    test("shows a client's ID when it is a URL, which identifies it, and claims no more", async () => {
      const byUrl = "client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fmetadata&sig=s";
      renderAt(`/consent?step=organization&request=r.${btoa(byUrl)}`, {
        $fetch: betterAuth(),
        organizations: [school],
      });

      expect(await screen.findByText("Client ID: https://claude.ai/oauth/metadata")).toBeTruthy();
      expect(screen.queryByText(/details come from/)).toBeNull();
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
    expect(device.approve).toHaveBeenCalledWith({
      userCode: "ABCD2345",
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
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
    const deny = screen.getByRole("button", { name: "Deny" });
    fireEvent.click(deny);
    expect(deny.getAttribute("aria-disabled")).toBe("true");
    expect(deny.matches(":disabled")).toBe(false);
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

  test("gives up on a decision Braivo does not take in time, showing it meanwhile", async () => {
    const device = deviceFlow();
    device.approve.mockImplementationOnce(({ fetchOptions }) => stall(fetchOptions));
    renderAt("/device?user_code=ABCD2345", { device });
    const approve = await screen.findByRole("button", { name: "Approve" });

    vi.useFakeTimers();
    fireEvent.click(approve);
    expect(approve.textContent).toBe("Approving…");
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Braivo could not record your answer. Try again.",
    );
    expect(approve.textContent).toBe("Approve");
    fireEvent.click(approve);
    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
  });

  test("says a code given up on was approved after all, when it reached Braivo late", async () => {
    let status = "pending";
    const device = deviceFlow();
    device.mockImplementation(async ({ query }) => ({
      data: { user_code: query.user_code, status, client_id: "braivo-cli" },
      error: null,
    }));
    device.approve
      .mockImplementationOnce(({ fetchOptions }) => stall(fetchOptions))
      .mockResolvedValueOnce({
        data: null,
        error: {
          status: 400,
          error: "invalid_request",
          error_description: "Device code already processed",
        },
      } as never);
    renderAt("/device?user_code=ABCD2345", { device });
    const approve = await screen.findByRole("button", { name: "Approve" });
    vi.useFakeTimers();
    fireEvent.click(approve);
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();
    await screen.findByRole("alert");
    // The approval given up on reaches Braivo now.
    status = "approved";

    fireEvent.click(approve);

    const outcome = await screen.findByRole("heading", {
      name: "Signed in. You can go back to your terminal.",
    });
    expect(document.activeElement).toBe(outcome);
  });

  test.each([
    ["still pending", undefined],
    [
      "unread in time",
      ({ fetchOptions }: { fetchOptions?: { signal?: AbortSignal } }) => stall(fetchOptions),
    ],
  ])("keeps a refusal whose code is %s, unlocked to decide again", async (_case, reread) => {
    const device = deviceFlow();
    device.approve.mockResolvedValueOnce({
      data: null,
      error: { status: 400, error: "invalid_request", error_description: "Invalid" },
    } as never);
    renderAt("/device?user_code=ABCD2345", { device });
    const approve = await screen.findByRole("button", { name: "Approve" });
    if (reread) device.mockImplementationOnce(reread);

    vi.useFakeTimers();
    fireEvent.click(approve);
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe("Invalid");
    expect(approve.getAttribute("aria-disabled")).toBe("false");
  });

  test("sends an owner signed out meanwhile to sign in, and back to the code", async () => {
    const device = deviceFlow();
    device.approve.mockResolvedValueOnce({
      data: null,
      error: { status: 401, error: "unauthorized", error_description: "" },
    } as never);
    const { auth, router } = renderAt("/device?user_code=ABCD2345", { device });
    const approve = await screen.findByRole("button", { name: "Approve" });
    await auth.signOut();

    fireEvent.click(approve);

    expect(await screen.findByLabelText("Email address")).toBeTruthy();
    expect(router.state.location.search).toEqual({ redirect: "/device?user_code=ABCD2345" });
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

  test("never shows one code's decision on another, even one answered late", async () => {
    const device = deviceFlow();
    let answer!: () => void;
    device.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ data: { success: true }, error: null });
        }),
    );
    const { router } = renderAt("/device?user_code=ABCD2345", { device });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    // Back in history, or a second terminal's link: another code, still pending.
    await router.navigate({ to: "/device", search: { user_code: "EFGH6789" } });
    expect(await screen.findByText("EFGH6789")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.getAttribute("aria-disabled")).toBe("false");
    // The first code's approval answers now, and must not land on this one.
    await act(async () => answer());

    expect(screen.getByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.queryByText(/Signed in/)).toBeNull();
  });

  test("leaves one code's failed answer off another", async () => {
    const device = deviceFlow();
    device.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { router } = renderAt("/device?user_code=ABCD2345", { device });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(/could not record your answer/);

    await router.navigate({ to: "/device", search: { user_code: "EFGH6789" } });

    expect(await screen.findByText("EFGH6789")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("says each wrong code typed in is wrong, once Braivo has refused it", async () => {
    const device = deviceFlow();
    renderAt("/device", { device });
    const input = (await screen.findByLabelText("Code shown in your terminal")) as HTMLInputElement;
    const continueButton = screen.getByRole("button", { name: "Continue" });

    let previous: HTMLElement | null = null;
    for (const code of ["WRONG111", "WRONG222", "WRONG333"]) {
      let answer!: () => void;
      device.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () =>
              resolve({
                data: null,
                error: { status: 400, error: "invalid_request", error_description: "Invalid" },
              });
          }),
      );
      fireEvent.change(input, { target: { value: code } });
      fireEvent.click(continueButton);
      await vi.waitFor(() =>
        expect(device).toHaveBeenLastCalledWith({ query: { user_code: code } }),
      );
      // Nothing is said about a code before Braivo answers.
      expect(screen.queryByRole("alert")).toBe(previous);
      answer();

      // A new alert each time, so it can be announced again; an unchanged one gives no new alert.
      const alert = await vi.waitFor(() => {
        const current = screen.getByRole("alert");
        expect(current).not.toBe(previous);
        return current;
      });
      expect(alert.textContent).toMatch(/not valid, or has expired/);
      previous = alert;
    }
  });

  test("refuses a code of only spaces without navigating", async () => {
    // Already at a refused code, so leaving it would show.
    const { router } = renderAt("/device?user_code=WRONG999", { device: deviceFlow() });
    const input = (await screen.findByLabelText("Code shown in your terminal")) as HTMLInputElement;
    await screen.findByRole("alert");

    // Set without an input event, as a browser restoring the form would.
    input.value = "   ";
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(input.validationMessage).toBe("Enter the code.");
    expect(router.history.location.search).toBe("?user_code=WRONG999");
    expect(screen.getByRole("alert").textContent).toMatch(/not valid/);
    fireEvent.change(input, { target: { value: " ABCD2345 " } });
    expect(input.validationMessage).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
  });

  test("lets an owner try again when the code could not be looked up", async () => {
    const device = deviceFlow();
    device.mockResolvedValueOnce({
      data: null,
      error: { status: 500, error: "server_error", error_description: "" },
    });
    renderAt("/device?user_code=ABCD2345", { device });

    // Not "not valid": nothing was said about the code, which may still be good.
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.queryByText(/not valid/)).toBeNull();
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
});
