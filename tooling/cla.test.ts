// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import {
  type Account,
  type PullRequest,
  check,
  signatureLine,
  signaturePath,
  signatureTemplate,
} from "./cla.ts";

const ada: Account = { id: 1, login: "ada" };
const bob: Account = { id: 2, login: "bob" };
const owner: Account = { id: 197134, login: "koistya" };
const braivoBot: Account = { id: 329773053, login: "braivo[bot]" };
const dependabot: Account = { id: 49699333, login: "dependabot[bot]" };

const code = { path: "apps/server/index.ts", status: "modified", changes: 1 };

function signing(account: Account, line = signatureLine(account, "Ada Lovelace")) {
  return {
    path: signaturePath(account),
    status: "added",
    changes: 1,
    // The patch GitHub lists for a new file: each line it adds marked `+`.
    patch: `@@ -0,0 +1 @@\n${line
      .split("\n")
      .map((added) => `+${added}`)
      .join("\n")}\n\\ No newline at end of file`,
  };
}

const withdrawing = (account: Account, changes = 0, suffix = "") => ({
  path: `docs/cla/v1/withdrawn/${account.id}${suffix}.md`,
  previous: signaturePath(account),
  status: "renamed",
  changes,
});

function pull(opener: Account, change: Partial<PullRequest> = {}): PullRequest {
  return { opener, commits: [{ sha: "a".repeat(40), author: opener }], files: [code], ...change };
}

const nobody = new Set<number>();
const signed = (...accounts: Account[]) => new Set(accounts.map(({ id }) => id));

describe("the CLA check", () => {
  test("passes a pull request whose opener signed before", () => {
    expect(check(pull(ada), signed(ada))).toEqual([]);
  });

  test("refuses an unsigned opener, and tells them the file and line to add", () => {
    const [problem] = check(pull(ada), nobody);
    expect(problem).toContain(signaturePath(ada));
    expect(problem).toContain(signatureTemplate(ada));
  });

  test("passes the opener who signs in this pull request, with the exact line", () => {
    expect(check(pull(ada, { files: [code, signing(ada)] }), nobody)).toEqual([]);
  });

  test("accepts the signer's name, and a line ending as Windows ends it", () => {
    for (const name of ["Ada", "Ada King, Countess of Lovelace", "Ада Лавлейс"]) {
      expect(check(pull(ada, { files: [signing(ada, signatureLine(ada, name))] }), nobody)).toEqual(
        [],
      );
    }
    expect(
      check(pull(ada, { files: [signing(ada, `${signatureLine(ada, "Ada")}\r`)] }), nobody),
    ).toEqual([]);
  });

  test("refuses, once, a signature that is not the line or names nobody", () => {
    for (const line of [
      "I agree.",
      signatureTemplate(ada),
      signatureLine(ada, ""),
      signatureLine(ada, " Ada"),
      signatureLine(bob, "Ada"),
      `${signatureLine(ada, "Ada")}\nand more`,
    ]) {
      expect(check(pull(ada, { files: [signing(ada, line)] }), nobody)).toEqual([
        expect.stringContaining(signatureTemplate(ada)),
      ]);
    }
  });

  test("refuses signing for someone else", () => {
    const problems = check(pull(ada, { files: [signing(ada), signing(bob)] }), nobody);
    expect(problems).toEqual([expect.stringContaining(signaturePath(bob))]);
  });

  test("refuses changing the agreement or a signature already given, whoever opens it", () => {
    for (const opener of [ada, owner, braivoBot, dependabot]) {
      for (const file of [
        { path: "docs/cla/v1.md", status: "modified", changes: 1 },
        { path: signaturePath(bob), status: "modified", changes: 1 },
        { path: signaturePath(bob), status: "removed", changes: 1 },
        { path: "docs/other.md", previous: signaturePath(bob), status: "renamed", changes: 0 },
        withdrawing(bob, 1),
      ]) {
        expect(check(pull(opener, { files: [file] }), signed(ada))).toHaveLength(1);
      }
    }
  });

  test("lets only Konstantin Tarkus and his bot add a version or record a withdrawal", () => {
    const changes = [{ path: "docs/cla/v2.md", status: "added", changes: 9 }, withdrawing(bob)];
    for (const opener of [owner, braivoBot]) {
      expect(check(pull(opener, { files: changes }), nobody)).toEqual([]);
      // Withdrawing again, after signing again.
      expect(check(pull(opener, { files: [withdrawing(bob, 0, "-2")] }), nobody)).toEqual([]);
      for (const version of ["v0", "v01"]) {
        const odd = { path: `docs/cla/${version}.md`, status: "added", changes: 9 };
        expect(check(pull(opener, { files: [odd] }), nobody)).toHaveLength(1);
      }
      for (const suffix of ["-x", "-1", "-02"]) {
        expect(check(pull(opener, { files: [withdrawing(bob, 0, suffix)] }), nobody)).toHaveLength(
          1,
        );
      }
    }
    for (const opener of [ada, dependabot]) {
      expect(check(pull(opener, { files: changes }), signed(ada))).toHaveLength(2);
    }
  });

  test("refuses a commit by an unsigned author, who signs in a pull request of their own", () => {
    const carried = { commits: [{ sha: "b".repeat(40), author: bob }] };
    expect(check(pull(ada, carried), signed(ada))).toEqual([
      expect.stringContaining("pull request of their own"),
    ]);
    expect(check(pull(ada, carried), signed(ada, bob))).toEqual([]);
  });

  test("refuses a commit attributed to no GitHub account", () => {
    expect(
      check(pull(ada, { commits: [{ sha: "c".repeat(40), author: null }] }), signed(ada)),
    ).toEqual([expect.stringContaining("ccccccc")]);
  });

  test("exempts the maintainer's and the bots' own commits only", () => {
    for (const exempt of [owner, braivoBot, dependabot]) {
      expect(check(pull(exempt), nobody)).toEqual([]);
      expect(
        check(pull(ada, { commits: [{ sha: "e".repeat(40), author: exempt }] }), signed(ada)),
      ).toEqual([]);
      expect(
        check(pull(exempt, { commits: [{ sha: "f".repeat(40), author: bob }] }), nobody),
      ).toEqual([expect.stringContaining("pull request of their own")]);
    }
  });
});
