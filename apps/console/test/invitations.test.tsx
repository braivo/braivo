// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { InvitationPage, InvitationResult, PendingInvitation } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { renderAt } from "./render.tsx";

// Inviting from Members (access-50, 51) and accepting at `/invitations/<id>`
// (access-52, 53), Braivo and Better Auth stubbed.

/** An invitation to Example School for the signed-in account, as the console shows it. */
const forOlive = (overrides: Partial<InvitationPage> = {}): InvitationPage => ({
  organization: { name: "Example School", slug: "example" },
  status: "pending",
  recipient: true,
  role: "author",
  inviter: { name: "Ada Admin" },
  ...overrides,
});

/** The page someone signed out, or on another account, reads: the name alone. */
const nameOnly = (overrides: Partial<InvitationPage> = {}): InvitationPage => ({
  organization: { name: "Example School" },
  status: "pending",
  ...overrides,
});

const pending = (id: string, email: string): PendingInvitation => ({
  id,
  email,
  role: "author",
  inviter: { name: "Olive Owner" },
  expiresAt: "2026-06-08T12:00:00.000Z",
});

/** A clipboard that keeps what is written to it, for this test alone. */
function stubClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  onTestFinished(() => {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  return writeText;
}

/** Better Auth's `accept-invitation`, answering `error` or accepting. */
const acceptAnswering = (error?: { status: number; code?: string }) =>
  vi.fn(async (_path: string, _options: unknown) => ({ data: error ? null : {}, error }));

/** Fills Members' invite form and sends it. */
async function invite(email: string, role: "Author" | "Admin" = "Author") {
  fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: email } });
  fireEvent.click(
    within(screen.getByRole("radiogroup", { name: "Role" })).getByRole("radio", { name: role }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

describe("invitations", () => {
  test("an admin invites an author, copies the link, and the author accepts into the console", async () => {
    const writeText = stubClipboard();
    const invited: PendingInvitation[] = [];
    const inviteStub = vi.fn(
      async (_organizationId: string, invitation: { email: string; role: string }) => {
        invited.push(pending("inv-1", invitation.email));
        return {
          outcome: "invited",
          invitation: { ...pending("inv-1", invitation.email), role: invitation.role },
          emailSent: true,
        } satisfies InvitationResult;
      },
    );
    const $fetch = acceptAnswering();
    const { router } = renderAt("/example/settings/members", {
      braivo: {
        invite: inviteStub,
        listInvitations: async () => [...invited],
        invitation: async () => forOlive(),
        listCourses: async () => [],
      },
      $fetch,
    });

    await invite("  Ada@School.Example ");

    expect(inviteStub).toHaveBeenCalledWith(
      "org-1",
      { email: "ada@school.example", role: "author" },
      expect.objectContaining({ headers: { "Accept-Language": "en" } }),
    );
    await vi.waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((status) => status.textContent === "Invitation sent to ada@school.example."),
      ).toBe(true),
    );
    const listed = within(await screen.findByRole("region", { name: "Invitations" }));
    expect(listed.getByText("ada@school.example")).toBeTruthy();
    expect(listed.getByText("Invited by Olive Owner. Expires on June 8, 2026.")).toBeTruthy();
    fireEvent.click(listed.getByRole("button", { name: "Copy link" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = writeText.mock.calls[0]![0];
    expect(link).toBe(`${window.location.origin}/invitations/inv-1`);

    // The invitee opens it, signed in with the invited email.
    await router.navigate({ href: new URL(link).pathname });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join Example School" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/^Ada Admin invited you\. There, you will manage and publish/),
    ).toBeTruthy();
    expect(screen.getByText("Signed in as olive@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join Example School as an author" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
    expect($fetch).toHaveBeenCalledWith(
      "/organization/accept-invitation",
      expect.objectContaining({ method: "POST", body: { invitationId: "inv-1" } }),
    );
  });

  test("says when the invitation's email could not be sent, and what an address already holds", async () => {
    const answers: InvitationResult[] = [
      {
        outcome: "invited",
        invitation: { ...pending("inv-2", "bo@school.example") },
        emailSent: false,
      },
      { outcome: "already a member", roles: ["author"] },
      { outcome: "already invited", role: "admin" },
    ];
    renderAt("/example/settings/members", {
      braivo: { invite: async () => answers.shift()!, listInvitations: async () => [] },
    });

    await invite("bo@school.example");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "bo@school.example is invited, but the email could not be sent. Copy the link below and send it to them.",
    );
    await invite("avery@school.example", "Admin");
    await vi.waitFor(() =>
      expect(screen.getByText("avery@school.example is already a member, as Author.")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await invite("cy@school.example");
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "cy@school.example is already invited, as Admin. Their invitation stays as it is.",
        ),
      ).toBeTruthy(),
    );
  });

  test("shows someone signed out the school's name and leads them to sign in, then back", async () => {
    const { router } = renderAt("/invitations/inv-1", {
      signedIn: false,
      braivo: { invitation: async () => nameOnly() },
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Join Example School" }),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Invitation to Example School"));
    fireEvent.click(screen.getByRole("link", { name: "Sign in to accept" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ redirect: "/invitations/inv-1" });
  });

  test("tells another account the invitation is not theirs, and signs it out to use another", async () => {
    const { auth } = renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () =>
          auth.signOut.mock.calls.length > 0 ? nameOnly() : nameOnly({ recipient: false }),
      },
    });

    expect(
      await screen.findByRole("heading", { name: "This invitation was sent to another email" }),
    ).toBeTruthy();
    expect(screen.getByText(/You are signed in as olive@example\.com\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use another account" }));

    expect(await screen.findByRole("link", { name: "Sign in to accept" })).toBeTruthy();
  });

  test.each([
    [
      "expired",
      nameOnly({ status: "expired" }),
      "This invitation has expired",
      "Ask Example School to send a new one.",
    ],
    [
      "unknown",
      undefined,
      "This invitation has expired",
      "Ask whoever invited you to send a new one.",
    ],
    [
      "cancelled",
      nameOnly({ status: "canceled" }),
      "This invitation was cancelled",
      "If you still need to join, ask Example School.",
    ],
  ])(
    "says when an invitation is %s, offering nothing to accept",
    async (_case, page, heading, text) => {
      renderAt("/invitations/inv-1", { braivo: { invitation: async () => page } });

      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    },
  );

  test("continues into the console from an invitation already accepted", async () => {
    const { router } = renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () => forOlive({ status: "accepted" }),
        listCourses: async () => [],
      },
    });

    expect(
      await screen.findByRole("heading", { name: "You have joined Example School" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test("keeps the page when joining is refused, saying why", async () => {
    const $fetch = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { status: 403, code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED" },
      })
      .mockResolvedValueOnce({ data: null, error: { status: 500 } });
    renderAt("/invitations/inv-1", {
      braivo: { invitation: async () => forOlive({ role: "admin" }) },
      $fetch,
    });

    const join = await screen.findByRole("button", { name: "Join Example School as an admin" });
    fireEvent.click(join);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Example School has no room for new members. Contact them.",
    );
    fireEvent.click(join);
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not join. Try again."),
    );
  });

  test("tells an account already a member, by another way, that it belongs, its role kept", async () => {
    const { router } = renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () => forOlive({ role: "admin", member: true }),
        listCourses: async () => [],
      },
    });

    expect(
      await screen.findByRole("heading", { name: "You already belong to Example School" }),
    ).toBeTruthy();
    expect(screen.getByText("Your role there stays as it is.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test.each([
    ["already a member", { status: 400, code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" }],
    ["made a member meanwhile, failing", { status: 500 }],
  ])("reads the invitation again when refused as %s", async (_case, error) => {
    let reads = 0;
    renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () => (++reads > 1 ? forOlive({ member: true }) : forOlive()),
      },
      $fetch: acceptAnswering(error),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Join Example School as an author" }),
    );

    expect(
      await screen.findByRole("heading", { name: "You already belong to Example School" }),
    ).toBeTruthy();
  });

  test("shows the page for another account once signed in as one elsewhere", async () => {
    let reads = 0;
    renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () => (++reads > 1 ? nameOnly({ recipient: false }) : forOlive()),
      },
      $fetch: acceptAnswering({ status: 403, code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Join Example School as an author" }),
    );

    expect(
      await screen.findByRole("heading", { name: "This invitation was sent to another email" }),
    ).toBeTruthy();
  });

  test("carries nothing from one invitation to the next, not even a late answer", async () => {
    let answer!: (value: { data: null; error: { status: number; code: string } }) => void;
    const $fetch = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { status: 403, code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED" },
      })
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { router } = renderAt("/invitations/first", {
      braivo: {
        invitation: async (id: string) =>
          forOlive({ organization: { name: `School ${id}`, slug: id } }),
      },
      $fetch,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Join School first as an author" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "School first has no room for new members. Contact them.",
    );
    await router.navigate({ to: "/invitations/$invitationId", params: { invitationId: "second" } });
    await screen.findByRole("button", { name: "Join School second as an author" });
    expect(screen.queryByRole("alert")).toBeNull();

    // Pressed on a third, which is left before Better Auth answers.
    await router.navigate({ to: "/invitations/$invitationId", params: { invitationId: "third" } });
    fireEvent.click(await screen.findByRole("button", { name: "Join School third as an author" }));
    await router.navigate({ to: "/invitations/$invitationId", params: { invitationId: "fourth" } });
    const fourth = await screen.findByRole("button", { name: "Join School fourth as an author" });
    answer({ data: null, error: { status: 403, code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED" } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fourth.getAttribute("aria-disabled")).not.toBe("true");
    expect(router.state.location.pathname).toBe("/invitations/fourth");
  });

  test("sends someone signed in but not yet named to name themselves first", async () => {
    const { router } = renderAt("/invitations/inv-1", {
      name: "",
      braivo: { invitation: async () => forOlive() },
    });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ redirect: "/invitations/inv-1" });
  });
});
