// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type Member } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { renderAt } from "./render.tsx";

// Giving and taking roles and removing members in Members (access-56), Braivo stubbed.

/** Olive (`u1`) is the account signed in, an owner; Otto another owner. */
const roster = (): Member[] => [
  { userId: "u1", name: "Olive Owner", roles: ["owner"] },
  { userId: "u2", name: "Lee Learner", roles: ["member"] },
  { userId: "u3", name: "Ada Admin", roles: ["admin"] },
  { userId: "u4", name: "Otto Owner", roles: ["member", "owner"] },
];

/** Opens a member's menu. */
async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Change or remove ${name}` }), {
    key: "Enter",
  });
  return within(await screen.findByRole("menu"));
}

const statusSays = (text: string) =>
  vi.waitFor(() =>
    expect(screen.getAllByRole("status").some((status) => status.textContent === text)).toBe(true),
  );

describe("members", () => {
  test("offer changing or removing everyone but owners and oneself", async () => {
    renderAt("/example/settings/members", { braivo: { listMembers: async () => roster() } });

    expect(
      await screen.findByRole("button", { name: "Change or remove Lee Learner" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change or remove Ada Admin" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change or remove Olive Owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change or remove Otto Owner" })).toBeNull();
    const menu = await openMenu("Ada Admin");
    // Their role is the one checked.
    expect(menu.getByRole("menuitemradio", { name: "Admin" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(menu.getByRole("menuitemradio", { name: "Learner" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  test("tell two members of one name apart, in the row, the menu, the dialog, and what is said", async () => {
    const removeMember = vi.fn(async () => {});
    renderAt("/example/settings/members", {
      braivo: {
        listMembers: async () => [
          ...roster(),
          { userId: "user-aaaaaa", name: "Ana Kowalska", roles: ["member"] },
          { userId: "user-bbbbbb", name: "Ana Kowalska", roles: ["member"] },
        ],
        removeMember,
      },
    });

    expect(
      await screen.findByRole("button", { name: "Change or remove Ana Kowalska bbbbbb" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Change or remove Ana Kowalska aaaaaa" }),
    ).toBeTruthy();
    const rows = screen.getAllByRole("row").map(({ textContent }) => textContent);
    expect(rows).toEqual(
      expect.arrayContaining(["Ana KowalskaaaaaaaLearner", "Ana KowalskabbbbbbLearner"]),
    );
    // A name no one else has stays bare.
    expect(screen.getByRole("button", { name: "Change or remove Lee Learner" })).toBeTruthy();

    fireEvent.click(
      (await openMenu("Ana Kowalska bbbbbb")).getByRole("menuitem", { name: "Remove…" }),
    );
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByRole("heading", { name: "Remove Ana Kowalska bbbbbb?" })).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Remove" }));

    await statusSays("Ana Kowalska bbbbbb was removed.");
    expect(removeMember).toHaveBeenCalledWith("org-1", "user-bbbbbb", expect.anything());
  });

  test("give a learner the author role, said once applied, and take it back", async () => {
    let members = roster();
    const setMemberRole = vi.fn(async (_organizationId: string, userId: string, role: string) => {
      members = members.map((each) => (each.userId === userId ? { ...each, roles: [role] } : each));
      return members.find((each) => each.userId === userId)!;
    });
    renderAt("/example/settings/members", {
      braivo: { listMembers: async () => members, setMemberRole },
    });

    fireEvent.click((await openMenu("Lee Learner")).getByRole("menuitemradio", { name: "Author" }));

    await statusSays("Lee Learner is now Author.");
    expect(setMemberRole).toHaveBeenCalledWith("org-1", "u2", "author", expect.anything());
    const row = () =>
      screen.getAllByRole("row").find((each) => /Lee Learner/.test(each.textContent ?? ""))!;
    await vi.waitFor(() => expect(row().textContent).toBe("Lee LearnerAuthor"));

    fireEvent.click(
      (await openMenu("Lee Learner")).getByRole("menuitemradio", { name: "Learner" }),
    );

    await statusSays("Lee Learner is now Learner.");
    expect(setMemberRole).toHaveBeenLastCalledWith("org-1", "u2", "member", expect.anything());
    // Choosing the role held sends nothing.
    fireEvent.click(
      (await openMenu("Lee Learner")).getByRole("menuitemradio", { name: "Learner" }),
    );
    expect(setMemberRole).toHaveBeenCalledTimes(2);
  });

  test("remove a member only once asked, saying their history stays", async () => {
    let members = roster();
    const removeMember = vi.fn(async (_organizationId: string, userId: string) => {
      members = members.filter((each) => each.userId !== userId);
    });
    renderAt("/example/settings/members", {
      braivo: { listMembers: async () => members, removeMember },
    });

    fireEvent.click((await openMenu("Ada Admin")).getByRole("menuitem", { name: "Remove…" }));
    const dialog = within(await screen.findByRole("alertdialog", { name: "Remove Ada Admin?" }));
    expect(dialog.getByText(/Their learning history is kept\./)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Keep them" }));
    expect(removeMember).not.toHaveBeenCalled();
    // Kept, the focus is back on their menu's button.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Change or remove Ada Admin" }),
      ),
    );

    fireEvent.click((await openMenu("Ada Admin")).getByRole("menuitem", { name: "Remove…" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );

    await statusSays("Ada Admin was removed.");
    expect(removeMember).toHaveBeenCalledWith("org-1", "u3", expect.anything());
    await vi.waitFor(() => expect(screen.queryByText("Ada Admin")).toBeNull());
    expect(document.activeElement).toBe(screen.getAllByRole("heading", { name: "Members" })[1]);
  });

  test("say someone removed meanwhile is no longer a member, not to try again", async () => {
    let members = roster();
    renderAt("/example/settings/members", {
      braivo: {
        listMembers: async () => members,
        removeMember: async () => {
          // Another administrator removed them first.
          members = members.filter(({ userId }) => userId !== "u3");
          throw new BraivoError(404, "No such member.", undefined, "MEMBER_NOT_FOUND");
        },
      },
    });

    fireEvent.click((await openMenu("Ada Admin")).getByRole("menuitem", { name: "Remove…" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe("Ada Admin is no longer a member.");
    await vi.waitFor(() => expect(screen.queryByText("Ada Admin")).toBeNull());
  });

  test("say a refusal and read the page again, but keep it after a lost connection", async () => {
    let reads = 0;
    let members = roster();
    renderAt("/example/settings/members", {
      braivo: {
        listMembers: async () => {
          reads++;
          return members;
        },
        removeMember: async () => {
          throw new TypeError("Failed to fetch");
        },
        setMemberRole: async () => {
          // Made an owner meanwhile, by whoever runs Braivo.
          members = members.map((each) =>
            each.userId === "u3" ? { ...each, roles: ["owner"] } : each,
          );
          throw new BraivoError(409, "Not here.", undefined, "MEMBER_IS_OWNER");
        },
      },
    });

    fireEvent.click((await openMenu("Ada Admin")).getByRole("menuitem", { name: "Remove…" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not remove Ada Admin. Try again.",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Change or remove Ada Admin" }),
    );
    const readsBefore = reads;

    fireEvent.click((await openMenu("Ada Admin")).getByRole("menuitemradio", { name: "Author" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Ada Admin is an owner now, whose membership is not changed here.",
      ),
    );
    await vi.waitFor(() => expect(reads).toBe(readsBefore + 1));
    // Read again: an owner now, whom no one here changes.
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Change or remove Ada Admin" })).toBeNull(),
    );
    // Their menu gone, the focus goes to the table's heading.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByRole("heading", { name: "Members" })[1]),
    );
  });
});
