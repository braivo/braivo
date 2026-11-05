// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { invitationMail } from "./invitation.ts";

const input = {
  to: "ada@school.example",
  link: "https://braivo.example/invitations/inv-1",
  organization: "Fernwood",
  inviter: "Ana Kowalska",
  role: "author" as const,
  expiresAt: new Date("2026-11-08T23:30:00.000Z"),
};

describe("an invitation's mail", () => {
  test("names the school, the inviter, the role in plain words, the link, and the expiry", () => {
    const mail = invitationMail({ ...input, locale: "en" });

    expect(mail.to).toBe("ada@school.example");
    expect(mail.subject).toBe("Ana Kowalska invites you to Fernwood");
    expect(mail.text).toBe(
      "Ana Kowalska invites you to join Fernwood. As an author, you will manage and publish its learning content.\n\n" +
        "Accept the invitation: https://braivo.example/invitations/inv-1\n\n" +
        "The invitation expires on November 8, 2026. Sign in with this email address to accept it.\n\n" +
        "If you were not expecting it, ignore this email.",
    );
    expect(mail.html).toContain('href="https://braivo.example/invitations/inv-1"');
    expect(mail.html).toContain('<html lang="en">');
    expect(invitationMail({ ...input, role: "admin", locale: "en" }).text).toMatch(
      /As an administrator, you will manage its people, settings, and learning content\./,
    );
    expect(invitationMail({ ...input, role: "member", locale: "en" }).text).toMatch(
      /As a learner, you will practise its courses\./,
    );
  });

  test("speaks Polish, the date as Polish writes it", () => {
    const mail = invitationMail({ ...input, locale: "pl" });

    expect(mail.subject).toBe("Ana Kowalska zaprasza Cię do organizacji „Fernwood”");
    expect(mail.text).toContain("Zaproszenie wygasa 8 listopada 2026.");
    expect(invitationMail({ ...input, role: "member", locale: "pl" }).text).toContain(
      "Jako osoba ucząca się ćwiczysz na jej kursach.",
    );
    expect(mail.html).toContain('<html lang="pl">');
  });

  test("writes names into the HTML as text, never as markup", () => {
    const mail = invitationMail({
      ...input,
      organization: `<a href="https://evil.example">Fernwood</a>`,
      inviter: `Ana "&" O'Hara`,
      locale: "en",
    });

    expect(mail.html).not.toContain('<a href="https://evil.example"');
    expect(mail.html).toContain(
      "&lt;a href=&quot;https://evil.example&quot;&gt;Fernwood&lt;/a&gt;",
    );
    expect(mail.html).toContain("Ana &quot;&amp;&quot; O&#39;Hara");
  });
});
