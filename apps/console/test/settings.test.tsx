// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale } from "@braivo/i18n";
import { BraivoError } from "@braivo/server/client";
import { i18n } from "@lingui/core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { school, annex } from "./fixtures.ts";
import { stall, openAccountMenu, waitOut, renderAt } from "./render.tsx";

describe("the console", () => {
  describe("settings", () => {
    /** Types `name` as the account's name and saves it, once the page shows. */
    function saveName(name: string) {
      fireEvent.change(screen.getByLabelText("Your name"), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    }

    test("opens from the account menu, in the header's place, with their own navigation", async () => {
      const { router } = renderAt("/example", { braivo: { listCourses: async () => [] } });

      fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Settings" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
      expect(router.state.location.pathname).toBe("/example/settings/account");
      await vi.waitFor(() => expect(document.title).toBe("Profile · Example School"));
      expect(document.querySelector("header")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Account: / })).toBeNull();

      const nav = screen.getByRole("navigation", { name: "Settings" });
      const profile = within(nav).getByRole("link", { name: "Profile" });
      expect(profile.getAttribute("aria-current")).toBe("page");
      // Not lost with the menu's trigger, gone with the header.
      expect(document.activeElement).toBe(profile);
      expect(screen.getByText("olive@example.com")).toBeTruthy();

      fireEvent.click(within(nav).getByRole("link", { name: "Back to Example School" }));
      const account = await screen.findByRole("button", { name: "Account: Olive Owner" });
      expect(router.state.location.pathname).toBe("/example");
      // Not lost with settings' navigation: back on the menu that opened them.
      expect(document.activeElement).toBe(account);
    });

    test("list the organization's domains, the primary one first and marked", async () => {
      renderAt("/example/settings", {
        braivo: {
          listDomains: async () => ({
            domains: [{ hostname: "learn.example.com" }, { hostname: "example.braivo.app" }],
            claims: [],
            canAdd: false,
          }),
        },
      });

      const nav = await screen.findByRole("navigation", { name: "Settings" });
      fireEvent.click(within(nav).getByRole("link", { name: "Domains" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Domains" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Domains · Example School"));

      const [primary, other] = within(
        within(screen.getByRole("main")).getByRole("list"),
      ).getAllByRole("listitem");
      const link = within(primary!).getByRole("link", { name: "learn.example.com" });
      expect(link.getAttribute("href")).toBe("https://learn.example.com");
      // A new tab, told nothing of the console: no referrer, no opener.
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
      expect(within(primary!).getByText("Primary")).toBeTruthy();
      expect(within(other!).getByRole("link", { name: "example.braivo.app" })).toBeTruthy();
      expect(within(other!).queryByText("Primary")).toBeNull();
    });

    test("say learners have no site yet when no domain serves the organization", async () => {
      renderAt("/example/settings/domains", {
        braivo: { listDomains: async () => ({ domains: [], claims: [], canAdd: false }) },
      });
      expect(await screen.findByText(/Learners have no site to practise on yet/)).toBeTruthy();
      expect(within(screen.getByRole("main")).queryByRole("list")).toBeNull();
    });

    test("say there is no such setting when Braivo refuses its domains", async () => {
      renderAt("/example/settings/domains", {
        braivo: { listDomains: vi.fn().mockRejectedValue(new BraivoError(403, "Not permitted.")) },
      });
      expect(await screen.findByRole("heading", { name: "There is no such setting" })).toBeTruthy();
      expect(screen.queryByRole("heading", { level: 1, name: "Domains" })).toBeNull();
    });

    test("offer no way to add a domain where the installation cannot prove one", async () => {
      renderAt("/example/settings/domains");
      expect(await screen.findByRole("heading", { level: 1, name: "Domains" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Add a domain" })).toBeNull();
      expect(screen.queryByLabelText("Domain")).toBeNull();
    });

    /** A claim waiting for its records, as Braivo lists one. */
    const pendingClaim = (hostname: string) => ({
      hostname,
      status: {
        ready: false,
        records: [
          { type: "CNAME", name: hostname, value: "domains.braivo.app" },
          { type: "TXT", name: `_cf-custom-hostname.${hostname}`, value: `token-${hostname}` },
        ],
      },
    });

    /** Braivo's domains, holding what `claimDomain` claims, so a reload lists it. */
    function domainsStub() {
      const claims: ReturnType<typeof pendingClaim>[] = [];
      return {
        listDomains: vi.fn(async () => ({
          domains: [{ hostname: "example.braivo.app" }],
          claims: [...claims],
          canAdd: true,
        })),
        claimDomain: vi.fn(async (_organizationId: string, hostname: string) => {
          claims.push(pendingClaim(hostname));
          return pendingClaim(hostname);
        }),
      };
    }

    function addDomain(hostname: string) {
      fireEvent.change(screen.getByLabelText("Domain"), { target: { value: hostname } });
      fireEvent.click(screen.getByRole("button", { name: /^Add/ }));
    }

    test("list each domain waiting for DNS with the records to create, or that it cannot say", async () => {
      renderAt("/example/settings/domains", {
        braivo: {
          listDomains: async () => ({
            domains: [{ hostname: "example.braivo.app" }],
            claims: [
              pendingClaim("learn.example.com"),
              { hostname: "study.example.com", status: null },
            ],
            canAdd: true,
          }),
        },
      });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      const [learn, study] = within(waiting).getAllByRole("listitem");
      expect(within(learn!).getByRole("heading", { name: "learn.example.com" })).toBeTruthy();
      expect(within(learn!).getByText("Pending")).toBeTruthy();
      const rows = within(learn!)
        .getAllByRole("row")
        .map((row) => row.textContent);
      expect(rows).toEqual([
        "TypeNameValue",
        "CNAMElearn.example.comdomains.braivo.app",
        "TXT_cf-custom-hostname.learn.example.comtoken-learn.example.com",
      ]);
      expect(within(study!).getByText("Status unknown")).toBeTruthy();
      expect(within(study!).getByText(/Could not check this domain/)).toBeTruthy();
      expect(within(study!).queryByRole("table")).toBeNull();
    });

    test("say a claim's records are not available yet, rather than an empty table", async () => {
      renderAt("/example/settings/domains", {
        braivo: {
          listDomains: async () => ({
            domains: [],
            claims: [{ hostname: "learn.example.com", status: { ready: false, records: [] } }],
            canAdd: true,
          }),
        },
      });
      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      expect(within(waiting).getByText("Its records are not available yet.")).toBeTruthy();
      expect(within(waiting).queryByRole("table")).toBeNull();
    });

    test("copy a record's name or value, as a DNS provider wants it", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      onTestFinished(() => {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      });
      renderAt("/example/settings/domains", {
        braivo: {
          listDomains: async () => ({
            domains: [],
            claims: [pendingClaim("learn.example.com")],
            canAdd: true,
          }),
        },
      });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      fireEvent.click(within(waiting).getByRole("button", { name: "Copy TXT value" }));
      // Its name kept, so each record's button stays told apart; the copy announced instead.
      await vi.waitFor(() =>
        expect(
          within(waiting)
            .getAllByRole("status")
            .map((status) => status.textContent),
        ).toContain("Copied."),
      );
      expect(within(waiting).getByRole("button", { name: "Copy TXT value" })).toBeTruthy();
      expect(writeText).toHaveBeenCalledExactlyOnceWith("token-learn.example.com");
      fireEvent.click(within(waiting).getByRole("button", { name: "Copy CNAME name" }));
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("learn.example.com"));
    });

    test("add a domain, trimmed, then list it with its records", async () => {
      const braivo = domainsStub();
      renderAt("/example/settings/domains", { braivo });

      await screen.findByLabelText("Domain");
      // Mounted empty before it says anything, so the saying is announced.
      const status = within(screen.getByRole("region", { name: "Add a domain" })).getByRole(
        "status",
      );
      expect(status.textContent).toBe("");
      addDomain("  learn.example.com ");
      await vi.waitFor(() =>
        expect(status.textContent).toBe("Added learn.example.com. Create its DNS records above."),
      );
      expect(braivo.claimDomain).toHaveBeenCalledWith(
        "org-1",
        "learn.example.com",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      expect(within(waiting).getByText("domains.braivo.app")).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>("Domain").value).toBe("");
    });

    test("refuse a blank domain before sending it", async () => {
      const braivo = domainsStub();
      renderAt("/example/settings/domains", { braivo });

      await screen.findByLabelText("Domain");
      addDomain("   ");
      expect(screen.getByLabelText<HTMLInputElement>("Domain").validationMessage).toBe(
        "Enter a domain, such as learn.example.com.",
      );
      expect(braivo.claimDomain).not.toHaveBeenCalled();
    });

    test("say why a domain was refused, in a new alert each time, keeping what was typed", async () => {
      const braivo = domainsStub();
      braivo.claimDomain
        .mockRejectedValueOnce(new BraivoError(409, "taken", undefined, "DOMAIN_TAKEN"))
        .mockRejectedValueOnce(new BraivoError(400, "invalid", undefined, "DOMAIN_INVALID"))
        .mockRejectedValueOnce(new BraivoError(400, "reserved", undefined, "DOMAIN_RESERVED"))
        .mockRejectedValueOnce(new BraivoError(409, "added", undefined, "ALREADY_ADDED"));
      renderAt("/example/settings/domains", { braivo });
      await screen.findByLabelText("Domain");

      let last: HTMLElement | undefined;
      for (const said of [
        "Another organization already uses that domain.",
        "Enter a domain such as learn.example.com, without https:// or a path.",
        "That address is Braivo's own. Enter a domain your organization owns.",
        "That domain already serves your organization.",
      ]) {
        addDomain("learn.example.com");
        await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(said));
        expect(screen.getByRole("alert")).not.toBe(last);
        last = screen.getByRole("alert");
      }
      expect(screen.getByLabelText<HTMLInputElement>("Domain").value).toBe("learn.example.com");
    });

    test("drop why a domain was refused once the domain is edited", async () => {
      const braivo = domainsStub();
      braivo.claimDomain.mockRejectedValueOnce(
        new BraivoError(400, "invalid", undefined, "DOMAIN_INVALID"),
      );
      renderAt("/example/settings/domains", { braivo });
      await screen.findByLabelText("Domain");

      addDomain("https://learn.example.com");
      await screen.findByRole("alert");
      fireEvent.change(screen.getByLabelText("Domain"), {
        target: { value: "learn.example.com" },
      });

      expect(screen.queryByRole("alert")).toBeNull();
    });

    test("list a domain kept though it could not be served yet, saying to try again", async () => {
      const braivo = domainsStub();
      braivo.claimDomain.mockImplementationOnce(async (_organizationId, hostname) => {
        braivo.listDomains.mockResolvedValueOnce({
          domains: [],
          claims: [{ hostname, status: null } as never],
          canAdd: true,
        });
        throw new BraivoError(502, "failed", undefined, "PROVISIONING_FAILED");
      });
      renderAt("/example/settings/domains", { braivo });

      await screen.findByLabelText("Domain");
      addDomain("learn.example.com");
      expect((await screen.findByRole("alert")).textContent).toBe(
        "The domain was saved, but setting it up failed. Add it again to retry.",
      );
      expect(await screen.findByText("Status unknown")).toBeTruthy();
    });

    test("show claims read-only where the installation cannot check them", async () => {
      renderAt("/example/settings/domains", {
        braivo: {
          listDomains: async () => ({
            domains: [],
            claims: [{ hostname: "learn.example.com", status: null }],
            canAdd: false,
          }),
        },
      });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      expect(within(waiting).getByText(/This installation cannot check domains/)).toBeTruthy();
      expect(within(waiting).queryByRole("button")).toBeNull();
    });

    test("activate a verified domain, then list it first, saying so, its link focused", async () => {
      const verified = {
        ...pendingClaim("learn.example.com"),
        status: { ready: true, records: [] },
      };
      let activated = false;
      // The list read again after activating answers late: focus waits for it.
      const reread = Promise.withResolvers<void>();
      const braivo = {
        listDomains: vi.fn(async () => {
          if (!activated) {
            return {
              domains: [{ hostname: "example.braivo.app" }],
              claims: [verified],
              canAdd: true,
            };
          }
          await reread.promise;
          return {
            domains: [{ hostname: "learn.example.com" }, { hostname: "example.braivo.app" }],
            claims: [],
            canAdd: true,
          };
        }),
        activateDomain: vi.fn(async () => {
          activated = true;
        }),
      };
      renderAt("/example/settings/domains", { braivo });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      expect(within(waiting).getByText("Verified")).toBeTruthy();
      // The page's own, outside the sections, mounted empty.
      const status = screen.getAllByRole("status").find((region) => !region.closest("section"));
      expect(status?.textContent).toBe("");
      fireEvent.click(within(waiting).getByRole("button", { name: "Activate" }));
      await vi.waitFor(() => expect(braivo.listDomains).toHaveBeenCalledTimes(2));
      expect(status?.textContent).toBe("");
      reread.resolve();

      await vi.waitFor(() =>
        expect(status?.textContent).toBe("learn.example.com now serves your learners."),
      );
      expect(braivo.activateDomain).toHaveBeenCalledWith(
        "org-1",
        "learn.example.com",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const [primary] = within(
        within(screen.getByRole("main")).getAllByRole("list")[0]!,
      ).getAllByRole("listitem");
      expect(within(primary!).getByText("Primary")).toBeTruthy();
      expect(document.activeElement).toBe(
        within(primary!).getByRole("link", { name: "learn.example.com" }),
      );
      expect(screen.queryByRole("region", { name: "Not active yet" })).toBeNull();
    });

    test("say a domain is not ready yet, in a new alert each check, locked while checking", async () => {
      const checked = Promise.withResolvers<void>();
      const braivo = {
        listDomains: vi.fn(async () => ({
          domains: [],
          claims: [pendingClaim("learn.example.com")],
          canAdd: true,
        })),
        activateDomain: vi
          .fn()
          .mockReturnValueOnce(checked.promise)
          .mockRejectedValueOnce(new BraivoError(409, "not yet", undefined, "NOT_VERIFIED")),
      };
      renderAt("/example/settings/domains", { braivo });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      fireEvent.click(within(waiting).getByRole("button", { name: "Check and activate" }));
      const locked = within(waiting).getByRole("button", { name: /^Checking/ });
      expect(locked.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(locked);
      expect(braivo.activateDomain).toHaveBeenCalledOnce();

      checked.reject(new BraivoError(409, "not yet", undefined, "NOT_VERIFIED"));
      const said =
        "It is not ready yet: its records can take a few minutes to be found, and its certificate to be issued. Try again then.";
      await vi.waitFor(() => expect(within(waiting).getByRole("alert").textContent).toBe(said));
      const first = within(waiting).getByRole("alert");

      fireEvent.click(within(waiting).getByRole("button", { name: "Check and activate" }));
      await vi.waitFor(() => expect(within(waiting).getByRole("alert")).not.toBe(first));
      expect(within(waiting).getByRole("alert").textContent).toBe(said);
    });

    test("remove a domain once asked, focus on its button while removing, then on the heading", async () => {
      let domains = [
        { hostname: "learn.example.com", removable: true },
        { hostname: "example.braivo.app", removable: false },
      ];
      const removing = Promise.withResolvers<void>();
      const braivo = {
        listDomains: vi.fn(async () => ({ domains, claims: [], canAdd: true })),
        removeDomain: vi.fn(() => removing.promise),
      };
      renderAt("/example/settings/domains", { braivo });

      const list = within(await screen.findByRole("main")).getAllByRole("list")[0]!;
      const [learn, braivoApp] = within(list).getAllByRole("listitem");
      expect(within(braivoApp!).queryByRole("button", { name: /^Remove/ })).toBeNull();
      const remove = within(learn!).getByRole("button", { name: "Remove learn.example.com" });
      fireEvent.click(remove);
      const dialog = await screen.findByRole("alertdialog", { name: "Remove learn.example.com?" });
      expect(dialog.textContent).toMatch(/links to it stop working/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(remove));
      // Saying so, it opens nothing more meanwhile.
      expect(remove.textContent).toBe("Removing…");
      fireEvent.click(remove);
      expect(screen.queryByRole("alertdialog")).toBeNull();

      domains = [{ hostname: "example.braivo.app", removable: false }];
      removing.resolve();
      expect(braivo.removeDomain).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(
          screen.getAllByRole("status").find((region) => !region.closest("section"))?.textContent,
        ).toBe("Removed learn.example.com."),
      );
      expect(braivo.removeDomain).toHaveBeenCalledWith(
        "org-1",
        "learn.example.com",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.queryByRole("link", { name: "learn.example.com" })).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Domains" }),
      );
    });

    test("remove a claim, saying it can be added again", async () => {
      let claims = [pendingClaim("learn.example.com")];
      const braivo = {
        listDomains: vi.fn(async () => ({
          domains: [{ hostname: "example.braivo.app", removable: false }],
          claims,
          canAdd: true,
        })),
        removeDomain: vi.fn(async () => {
          claims = [];
        }),
      };
      renderAt("/example/settings/domains", { braivo });

      const waiting = await screen.findByRole("region", { name: "Not active yet" });
      fireEvent.click(within(waiting).getByRole("button", { name: "Remove learn.example.com" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Remove learn.example.com?" });
      expect(dialog.textContent).toMatch(/You can add it again later/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      await vi.waitFor(() =>
        expect(screen.queryByRole("region", { name: "Not active yet" })).toBeNull(),
      );
    });

    test("say why a domain was not removed, focus back on its button, which stays", async () => {
      // Read again, the list would say otherwise: another owner removed the
      // other domain meanwhile. Not read again, the explanation stays.
      let reads = 0;
      const braivo = {
        listDomains: vi.fn(async () => ({
          domains: [{ hostname: "learn.example.com", removable: reads++ === 0 }],
          claims: [],
          canAdd: true,
        })),
        removeDomain: vi
          .fn()
          .mockRejectedValue(new BraivoError(409, "last", undefined, "LAST_DOMAIN")),
      };
      renderAt("/example/settings/domains", { braivo });

      fireEvent.click(await screen.findByRole("button", { name: "Remove learn.example.com" }));
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(
        "It is the only domain your learners have. Add another first.",
      );
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Remove learn.example.com" }),
        ),
      );
      expect(braivo.listDomains).toHaveBeenCalledOnce();
    });

    test("carry nothing of a pending add over to another organization's domains", async () => {
      const adding = Promise.withResolvers<never>();
      const braivo = { ...domainsStub(), claimDomain: vi.fn(() => adding.promise) };
      const { router } = renderAt("/example/settings/domains", {
        organizations: [school, annex],
        braivo,
      });
      await screen.findByLabelText("Domain");
      addDomain("learn.example.com");
      expect(braivo.claimDomain).toHaveBeenCalledOnce();

      // As the browser's history can, from one organization's settings to another's.
      await router.navigate({ href: "/annex/settings/domains" });
      await vi.waitFor(() =>
        expect(screen.getByRole("link", { name: "Back to Annex" })).toBeTruthy(),
      );
      const input = screen.getByLabelText<HTMLInputElement>("Domain");
      expect(input.value).toBe("");
      expect(input.readOnly).toBe(false);
      // Example's add, refused only now, says nothing on Annex's page.
      await act(async () =>
        adding.reject(new BraivoError(409, "taken", undefined, "DOMAIN_TAKEN")),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy();
    });

    test("lock adding while it is sent, and say when it got no answer in time", async () => {
      const braivo = domainsStub();
      braivo.claimDomain.mockImplementationOnce(
        (_organizationId, _hostname, options?: { signal?: AbortSignal }) => stall(options),
      );
      renderAt("/example/settings/domains", { braivo });
      await screen.findByLabelText("Domain");

      vi.useFakeTimers();
      addDomain("learn.example.com");
      const button = screen.getByRole("button", { name: /^Adding/ });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByLabelText<HTMLInputElement>("Domain").readOnly).toBe(true);
      fireEvent.click(button);
      expect(braivo.claimDomain).toHaveBeenCalledOnce();
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not connect. Check your connection and try again.",
      );
      expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy();
    });

    test("rename the organization, trimmed, every page then naming it so", async () => {
      let organization = { ...school };
      const braivo = {
        listOrganizations: async () => [organization],
        renameOrganization: vi.fn(async (_organizationId: string, name: string) => {
          organization = { ...organization, name };
          return { name };
        }),
      };
      renderAt("/example/settings", { braivo });

      const nav = await screen.findByRole("navigation", { name: "Settings" });
      fireEvent.click(within(nav).getByRole("link", { name: "General" }));
      const input = await screen.findByLabelText<HTMLInputElement>("Organization name");
      expect(input.value).toBe("Example School");
      expect(screen.getByText(`${window.location.host}/example`)).toBeTruthy();

      const status = screen.getByRole("status");
      fireEvent.change(input, { target: { value: "  Fernwood  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(status.textContent).toBe("Saved."));
      expect(braivo.renameOrganization).toHaveBeenCalledWith(
        "org-1",
        "Fernwood",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(input.value).toBe("Fernwood");
      expect(await within(nav).findByRole("link", { name: "Back to Fernwood" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("General · Fernwood"));
    });

    test("rename the organization, the sidebar's switcher then listing it so", async () => {
      let organization = { ...school };
      const braivo = {
        listOrganizations: async () => [annex, organization],
        renameOrganization: async (_organizationId: string, name: string) => {
          organization = { ...organization, name };
          return { name };
        },
        listCourses: async () => [],
      };
      renderAt("/example/settings/general", { braivo });

      const input = await screen.findByLabelText<HTMLInputElement>("Organization name");
      fireEvent.change(input, { target: { value: "Fernwood" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      fireEvent.click(await screen.findByRole("link", { name: "Back to Fernwood" }));

      const trigger = await screen.findByRole("button", { name: /^Organization: / });
      fireEvent.keyDown(trigger, { key: "Enter" });
      const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["Annex", "Fernwood"]);
    });

    test("say why the organization was not renamed, in a new alert each time", async () => {
      const braivo = {
        renameOrganization: vi
          .fn()
          .mockRejectedValueOnce(new BraivoError(400, "invalid", undefined, "NAME_INVALID"))
          .mockRejectedValueOnce(new TypeError("Failed to fetch")),
      };
      renderAt("/example/settings/general", { braivo });

      const input = await screen.findByLabelText<HTMLInputElement>("Organization name");
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(input.validationMessage).toBe("Enter your organization's name.");
      expect(braivo.renameOrganization).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "Fernwood" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const first = await screen.findByRole("alert");
      expect(first.textContent).toBe("Enter a name of at most 100 characters.");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
      expect(screen.getByRole("alert").textContent).toBe("Could not save the name. Try again.");
      expect(input.value).toBe("Fernwood");
    });

    test("show another organization's name once switched to it, nothing typed or saving carried over", async () => {
      const saving = Promise.withResolvers<{ name: string }>();
      const braivo = { renameOrganization: vi.fn(() => saving.promise) };
      const { router } = renderAt("/example/settings/general", {
        organizations: [school, annex],
        braivo,
      });
      fireEvent.change(await screen.findByLabelText("Organization name"), {
        target: { value: "Typed for Example" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(braivo.renameOrganization).toHaveBeenCalledOnce();

      // As the browser's history can, from one organization's settings to another's.
      await router.navigate({ href: "/annex/settings/general" });
      const input = await vi.waitFor(() => {
        const field = screen.getByLabelText<HTMLInputElement>("Organization name");
        expect(field.value).toBe("Annex");
        return field;
      });
      // Example's save, answered only now, touches nothing of Annex's.
      await act(async () => saving.resolve({ name: "Typed for Example" }));
      expect(input.value).toBe("Annex");
      expect(input.readOnly).toBe(false);
      expect(screen.getByRole("status").textContent).toBe("");
      expect(screen.getByRole("link", { name: "Back to Annex" })).toBeTruthy();
    });

    test("give up renaming when it does not finish in time, saying so", async () => {
      const braivo = {
        renameOrganization: vi.fn(
          (_organizationId: string, _name: string, options?: { signal?: AbortSignal }) =>
            stall(options),
        ),
      };
      renderAt("/example/settings/general", { braivo });
      const input = await screen.findByLabelText<HTMLInputElement>("Organization name");
      fireEvent.change(input, { target: { value: "Fernwood" } });

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      // Locked while sent: a second click sends nothing.
      expect(screen.getByRole("button", { name: /^Saving/ }).getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(input.readOnly).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /^Saving/ }));
      expect(braivo.renameOrganization).toHaveBeenCalledOnce();
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not save the name. Try again.",
      );
      expect(input.value).toBe("Fernwood");
      expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      );
    });

    test("send an account signed out meanwhile to sign in, and back", async () => {
      const braivo = {
        renameOrganization: vi.fn().mockRejectedValue(new BraivoError(401, "Signed out.")),
      };
      const { auth, router } = renderAt("/example/settings/general", { braivo });
      fireEvent.change(await screen.findByLabelText("Organization name"), {
        target: { value: "Fernwood" },
      });
      await auth.signOut();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
      expect(router.state.location.pathname).toBe("/login");
      expect(router.state.location.search).toEqual({ redirect: "/example/settings/general" });
    });

    test("say a refusal that leaves them managing it, as any other failure", async () => {
      const braivo = {
        renameOrganization: vi.fn().mockRejectedValue(new BraivoError(403, "Refused.")),
      };
      renderAt("/example/settings/general", { braivo });
      fireEvent.change(await screen.findByLabelText("Organization name"), {
        target: { value: "Fernwood" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not save the name. Try again.",
      );
      expect(screen.getByLabelText<HTMLInputElement>("Organization name").value).toBe("Fernwood");
    });

    test("say the organization is not theirs once they no longer manage it", async () => {
      let organizations = [school];
      const braivo = {
        listOrganizations: async () => organizations,
        renameOrganization: vi.fn().mockRejectedValue(new BraivoError(403, "Not permitted.")),
      };
      renderAt("/example/settings/general", { braivo });
      fireEvent.change(await screen.findByLabelText("Organization name"), {
        target: { value: "Fernwood" },
      });
      organizations = [];

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(
        await screen.findByText("This organization does not exist, or you do not work in it."),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    test("list the members by name with their roles and the groups they teach, marking the account's own", async () => {
      // Every teacher is named as u4 is, so matching by name would make u4 teach.
      const group = (name: string, ...teacherIds: string[]) => ({
        id: name,
        organizationId: "org-1",
        name,
        teachers: teacherIds.map((userId) => ({ userId, name: "Lee Learner" })),
        learners: [],
        courses: [],
      });
      renderAt("/example/settings", {
        braivo: {
          listMembers: async () => [
            { userId: "u1", name: "Olive Owner", roles: ["owner", "admin"] },
            { userId: "u2", name: "Lee Learner", roles: ["member"] },
            { userId: "u3", name: "Ada Admin", roles: ["admin"] },
            { userId: "u4", name: "Lee Learner", roles: ["member"] },
          ],
          listGroups: async () => [group("7A", "u2"), group("7B", "u2", "u3", "u1"), group("8A")],
        },
      });

      const nav = await screen.findByRole("navigation", { name: "Settings" });
      fireEvent.click(within(nav).getByRole("link", { name: "Members" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Members · Example School"));
      expect(screen.getByText(/^4 members\./)).toBeTruthy();

      const rows = screen.getAllByRole("row").map((row) => row.textContent);
      expect(rows).toEqual([
        "NameRole",
        "Olive OwnerYouOwner and AdminTeaches 7B",
        "Lee LearnerLearnerTeaches 7A and 7B",
        "Ada AdminAdminTeaches 7B",
        "Lee LearnerLearner",
      ]);
    });

    test("show no members when Braivo refuses the groups, rather than teachers as only learners", async () => {
      renderAt("/example/settings/members", {
        braivo: { listGroups: vi.fn().mockRejectedValue(new BraivoError(403, "Not permitted.")) },
      });
      expect(await screen.findByRole("heading", { name: "There is no such setting" })).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
    });

    test("choose the theme and the language, each kept in this browser", async () => {
      onTestFinished(async () => {
        localStorage.clear();
        document.documentElement.classList.remove("dark");
        await activateLocale("en");
      });
      renderAt("/example/settings");

      const nav = await screen.findByRole("navigation", { name: "Settings" });
      fireEvent.click(within(nav).getByRole("link", { name: "Preferences" }));
      const themes = await screen.findByRole("radiogroup", { name: "Theme" });
      fireEvent.click(within(themes).getByRole("radio", { name: "Dark" }));
      await vi.waitFor(() =>
        expect(document.documentElement.classList.contains("dark")).toBe(true),
      );
      expect(localStorage.getItem("braivo-theme")).toBe("dark");
      fireEvent.click(within(themes).getByRole("radio", { name: "System" }));
      expect(localStorage.getItem("braivo-theme")).toBeNull();

      fireEvent.change(screen.getByLabelText("Language"), { target: { value: "pl" } });
      expect(await screen.findByRole("heading", { level: 1, name: "Preferencje" })).toBeTruthy();
      expect(screen.getByLabelText<HTMLSelectElement>("Język").value).toBe("pl");
    });

    test("say when a language could not load, a new alert each time, keeping the one shown", async () => {
      onTestFinished(async () => {
        vi.restoreAllMocks();
        await activateLocale("en");
      });
      renderAt("/example/settings/preferences");
      const select = await screen.findByLabelText<HTMLSelectElement>("Language");
      vi.spyOn(i18n, "loadAndActivate").mockImplementation(() => {
        throw new Error("Catalog failed");
      });

      fireEvent.change(select, { target: { value: "pl" } });
      const first = await screen.findByRole("alert");
      expect(first.textContent).toBe("Could not change the language. Try again.");
      expect(select.value).toBe("en");
      fireEvent.change(select, { target: { value: "pl" } });
      await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
    });

    /** Connected apps' own status, not its copy button's. */
    const said = () => screen.getAllByRole("status").find((region) => !region.closest("section"))!;

    test("list the account's connected apps, and disconnect one, keeping the other", async () => {
      let connections = [
        {
          id: "c1",
          client: { id: "https://claude.ai/oauth/mcp-oauth-client-metadata", name: "Claude" },
          organization: { id: "org-1", name: "Example School" },
          connectedAt: "2026-10-01T09:00:00.000Z",
        },
        {
          id: "c2",
          client: { id: "https://claude.ai/oauth/mcp-oauth-client-metadata", name: "Claude" },
          organization: { id: "org-2", name: "Annex" },
          connectedAt: "2026-10-02T09:00:00.000Z",
        },
      ];
      const disconnect = vi.fn(async (id: string) => {
        connections = connections.filter((connection) => connection.id !== id);
      });
      renderAt("/example/settings/connections", {
        braivo: { listConnections: async () => connections, disconnectConnection: disconnect },
      });

      expect(await screen.findByRole("heading", { level: 1, name: "Connected apps" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Connected apps · Example School"));
      const [first, second] = within(screen.getByRole("main")).getAllByRole("listitem");
      expect(within(first!).getByText("Claude")).toBeTruthy();
      expect(first!.textContent).toMatch(
        /https:\/\/claude\.ai\/oauth\/mcp-oauth-client-metadata · Example School · connected/,
      );
      expect(second!.textContent).toMatch(/Annex/);
      // Another app, or another organization, is connected the same way.
      expect(screen.getByRole("region", { name: "Connect an app" })).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", { name: "Disconnect Claude from Example School" }),
      );
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

      await vi.waitFor(() =>
        expect(said().textContent).toBe("Disconnected Claude from Example School."),
      );
      expect(disconnect.mock.calls.map(([id]) => id)).toEqual(["c1"]);
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
      const [kept, ...rest] = within(screen.getByRole("main")).getAllByRole("listitem");
      expect(kept!.textContent).toMatch(/Annex/);
      expect(rest).toEqual([]);

      // The same app again: focus moves again, and the status says something new.
      const button = screen.getByRole("button", { name: "Disconnect Claude from Annex" });
      button.focus();
      fireEvent.click(button);
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
      );
      await vi.waitFor(() => expect(said().textContent).toBe("Disconnected Claude from Annex."));
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    });

    test("say when an app could not be disconnected, a new alert each time, keeping it", async () => {
      const connection = {
        id: "c1",
        client: { id: "client-1", name: "Claude" },
        organization: { id: "org-1", name: "Example School" },
        connectedAt: "2026-10-01T09:00:00.000Z",
      };
      // Refused, then unanswered: each says which.
      const disconnect = vi
        .fn()
        .mockRejectedValueOnce(new BraivoError(500, "Failed."))
        .mockRejectedValue(new TypeError("Failed to fetch"));
      renderAt("/example/settings/connections", {
        braivo: { listConnections: async () => [connection], disconnectConnection: disconnect },
      });

      const button = await screen.findByRole("button", {
        name: "Disconnect Claude from Example School",
      });
      fireEvent.click(button);
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
      );
      const first = await screen.findByRole("alert");
      expect(first.textContent).toBe("Could not disconnect the app. Try again.");
      fireEvent.click(button);
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
      );
      await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not disconnect. Check your connection and try again.",
      );
      expect(within(screen.getByRole("main")).getAllByRole("listitem")).toHaveLength(1);
    });

    test("say an app is disconnected without reading the list again, which could fail", async () => {
      const connection = {
        id: "c1",
        client: { id: "client-1", name: "Claude" },
        organization: { id: "org-1", name: "Example School" },
        connectedAt: "2026-10-01T09:00:00.000Z",
      };
      const listConnections = vi
        .fn()
        .mockResolvedValueOnce([connection])
        .mockRejectedValue(new TypeError("Failed to fetch"));
      renderAt("/example/settings/connections", {
        braivo: { listConnections, disconnectConnection: async () => {} },
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Disconnect Claude from Example School" }),
      );
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
      );

      await vi.waitFor(() =>
        expect(said().textContent).toBe("Disconnected Claude from Example School."),
      );
      expect(screen.getByText("No AI app is connected to your account.")).toBeTruthy();
    });

    test("say no app is connected, and how to connect one, with the address to copy", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      onTestFinished(() => {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      });
      renderAt("/example/settings/connections", { braivo: { listConnections: async () => [] } });
      expect(await screen.findByText("No AI app is connected to your account.")).toBeTruthy();
      expect(within(screen.getByRole("main")).queryByRole("listitem")).toBeNull();

      const address = `${window.location.origin}/mcp`;
      const section = screen.getByRole("region", { name: "Connect an app" });
      expect(within(section).getByText(address)).toBeTruthy();
      const guide = within(section).getByRole("link", { name: "Step by step" });
      expect(guide.getAttribute("href")).toBe(
        "https://github.com/braivo/braivo/blob/main/docs/guides/assistants.md#connect",
      );
      expect(guide.getAttribute("target")).toBe("_blank");
      expect(guide.getAttribute("rel")).toBe("noreferrer");
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
      expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
      expect(writeText).toHaveBeenCalledExactlyOnceWith(address);
    });

    test("hide how to connect an app from someone administering no organization", async () => {
      renderAt("/example/settings/connections", {
        organizations: [{ ...school, administers: false }],
        braivo: { listConnections: async () => [] },
      });
      expect(await screen.findByText("No AI app is connected to your account.")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Connect an app" })).toBeNull();
    });

    test("lead back to the page they were opened from, by their link or by Escape", async () => {
      const { router } = renderAt("/example/sources", { braivo: { listSources: async () => [] } });

      fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Settings" }));
      const nav = await screen.findByRole("navigation", { name: "Settings" });
      // Across settings' own pages, the way back stays.
      fireEvent.click(within(nav).getByRole("link", { name: "General" }));
      await screen.findByLabelText("Organization name");
      expect(
        within(nav).getByRole("link", { name: "Back to Example School" }).getAttribute("href"),
      ).toBe("/example/sources");

      // A field keeps Escape: given time to navigate, it has not.
      fireEvent.keyDown(screen.getByLabelText("Organization name"), { key: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(router.state.location.pathname).toBe("/example/settings/general");

      fireEvent.keyDown(document.body, { key: "Escape" });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example/sources"));

      fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Settings" }));
      fireEvent.click(
        within(await screen.findByRole("navigation", { name: "Settings" })).getByRole("link", {
          name: "Back to Example School",
        }),
      );
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example/sources"));
    });

    test("lead back within the organization whose settings show, after another's", async () => {
      const { router } = renderAt("/example/sources", {
        organizations: [school, annex],
        braivo: { listSources: async () => [] },
      });
      fireEvent.click(within(await openAccountMenu()).getByRole("menuitem", { name: "Settings" }));
      await screen.findByRole("navigation", { name: "Settings" });

      // As the browser's history can, from one organization's settings to another's.
      await router.navigate({ href: "/annex/settings/members" });
      const nav = await screen.findByRole("navigation", { name: "Settings" });
      fireEvent.click(await within(nav).findByRole("link", { name: "Back to Annex" }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/annex"));
    });

    test("leave Escape to an open dialog, closing it, not settings", async () => {
      const { router } = renderAt("/example/settings/domains", {
        braivo: {
          listDomains: async () => ({
            domains: [
              { hostname: "learn.example.com", removable: true },
              { hostname: "example.braivo.app", removable: false },
            ],
            claims: [],
            canAdd: true,
          }),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Remove learn.example.com" }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.keyDown(dialog, { key: "Escape" });
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(router.state.location.pathname).toBe("/example/settings/domains");
    });

    test("scroll the page shown into the phone's row, clear of its fade, sideways alone", async () => {
      renderAt("/example/settings/account");
      const nav = await screen.findByRole("navigation", { name: "Settings" });
      const members = within(nav).getByRole("link", { name: "Members" });
      const row = members.closest("ul")!.parentElement!;
      // happy-dom lays nothing out: the row 300px wide, Members past its right
      // edge, so it comes to its fade's and focus ring's, 44px in.
      const box = (left: number, right: number) => () => ({ left, right }) as DOMRect;
      row.getBoundingClientRect = box(0, 300);
      members.getBoundingClientRect = box(400, 480);
      const scrollTo = vi.spyOn(window, "scrollTo");
      onTestFinished(() => scrollTo.mockRestore());

      fireEvent.click(members);
      await vi.waitFor(() => expect(row.scrollLeft).toBe(224));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    test("scroll a link tabbed to in the phone's row clear of either fade", async () => {
      renderAt("/example/settings/account");
      const nav = await screen.findByRole("navigation", { name: "Settings" });
      const profile = within(nav).getByRole("link", { name: "Profile" });
      const apps = within(nav).getByRole("link", { name: "Connected apps" });
      const row = apps.closest("ul")!.parentElement!;
      // happy-dom lays nothing out: each link inside the row's 300px, but
      // under a fade, whose clearance with the focus ring is 44px.
      const box = (left: number, right: number) => () => ({ left, right }) as DOMRect;
      row.getBoundingClientRect = box(0, 300);
      apps.getBoundingClientRect = box(180, 290);
      profile.getBoundingClientRect = box(15, 85);

      apps.focus();
      expect(row.scrollLeft).toBe(34);
      profile.focus();
      expect(row.scrollLeft).toBe(5);
    });

    test("fade the phone's row on each side hiding pages, and only there", async () => {
      renderAt("/example/settings/account");
      const nav = await screen.findByRole("navigation", { name: "Settings" });
      const row = within(nav).getByRole("link", { name: "Members" }).closest("ul")!.parentElement!;
      const fades = () =>
        ["mask-l", "mask-r"].filter((side) => row.className.includes(`max-md:${side}-from`));
      expect(fades()).toEqual([]);
      // happy-dom lays nothing out: the row 300px wide, its pages 600px.
      Object.defineProperties(row, {
        clientWidth: { value: 300 },
        scrollWidth: { value: 600 },
      });

      fireEvent.scroll(row);
      await vi.waitFor(() => expect(fades()).toEqual(["mask-r"]));
      row.scrollLeft = 150;
      fireEvent.scroll(row);
      await vi.waitFor(() => expect(fades()).toEqual(["mask-l", "mask-r"]));
      row.scrollLeft = 300;
      fireEvent.scroll(row);
      await vi.waitFor(() => expect(fades()).toEqual(["mask-l"]));
    });

    test("say a page they do not have is none, keeping their navigation and the way back", async () => {
      const { router } = renderAt("/example/settings/billing");

      expect(
        await screen.findByRole("heading", { level: 1, name: "There is no such setting" }),
      ).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Settings · Example School"));
      const nav = screen.getByRole("navigation", { name: "Settings" });
      fireEvent.click(within(nav).getByRole("link", { name: "Members" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
      expect(router.state.location.pathname).toBe("/example/settings/members");
    });

    test("open at the account's", async () => {
      const { router } = renderAt("/example/settings");
      expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
      expect(router.state.location.pathname).toBe("/example/settings/account");
    });

    test("rename the account, trimmed, and every page shows the new name", async () => {
      const { auth } = renderAt("/example/settings/account", {
        braivo: { listCourses: async () => [] },
      });

      await screen.findByLabelText("Your name");
      // Mounted empty before it says anything, so the saying is announced.
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("");
      saveName("  Ann Admin  ");
      await vi.waitFor(() => expect(status.textContent).toBe("Saved."));
      expect(auth.updateUser).toHaveBeenCalledWith(expect.objectContaining({ name: "Ann Admin" }));
      expect(screen.getByLabelText<HTMLInputElement>("Your name").value).toBe("Ann Admin");

      fireEvent.click(screen.getByRole("link", { name: "Back to Example School" }));
      expect(await screen.findByRole("button", { name: "Account: Ann Admin" })).toBeTruthy();
    });

    test("refuse a name of spaces alone before sending it", async () => {
      const { auth } = renderAt("/example/settings/account");

      await screen.findByLabelText("Your name");
      saveName("   ");
      const input = screen.getByLabelText<HTMLInputElement>("Your name");
      expect(input.validationMessage).toBe("Enter your name.");
      expect(auth.updateUser).not.toHaveBeenCalled();
    });

    test("keep the name typed when saving fails, saying so each time, and lock Save while it is sent", async () => {
      const { auth } = renderAt("/example/settings/account");
      const refused = Promise.withResolvers<{ error: { status: number } }>();
      auth.updateUser.mockReturnValueOnce(refused.promise as never);
      auth.updateUser.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await screen.findByLabelText("Your name");
      saveName("Ann Admin");
      const save = screen.getByRole("button", { name: /^Saving/ });
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByLabelText<HTMLInputElement>("Your name").readOnly).toBe(true);
      fireEvent.click(save);
      expect(auth.updateUser).toHaveBeenCalledOnce();
      refused.resolve({ error: { status: 500 } });
      const first = await screen.findByRole("alert");
      expect(first.textContent).toBe("Could not save your name. Try again.");

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(auth.updateUser).toHaveBeenCalledTimes(2));
      // A new alert, so the repeat is announced too.
      await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
      expect(screen.getByLabelText<HTMLInputElement>("Your name").value).toBe("Ann Admin");
      expect(screen.getByRole("status").textContent).toBe("");
    });

    test("give up saving when it does not finish in time, saying so", async () => {
      const { auth } = renderAt("/example/settings/account");
      auth.updateUser.mockImplementationOnce((options) => stall(options.fetchOptions));
      await screen.findByLabelText("Your name");

      vi.useFakeTimers();
      saveName("Ann Admin");
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not save your name. Try again.",
      );
      expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      );
    });

    test("send an account signed out meanwhile to sign in, and back", async () => {
      const { auth, router } = renderAt("/example/settings/account");
      auth.updateUser.mockResolvedValueOnce({ error: { status: 401 } } as never);
      await screen.findByLabelText("Your name");
      await auth.signOut();

      saveName("Ann Admin");
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
      expect(router.state.location.pathname).toBe("/login");
      expect(router.state.location.search).toEqual({ redirect: "/example/settings/account" });
    });
  });
});
