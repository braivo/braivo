// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The CLA check (docs/adr/0036-contributor-license-agreement.md): a pull
 * request passes once its opener and every commit's GitHub-attributed author
 * have signed `docs/cla/v1.md`, or its opener signs in it. Co-authors named in
 * trailers, and material from elsewhere, are left to review.
 *
 * CI runs it on `pull_request_target`, from the default branch's checkout, so
 * a pull request cannot change its own check. It reads the pull request through
 * the API and never runs, or checks out, the code under review. To reproduce
 * one locally: `PULL_NUMBER=<n> GITHUB_TOKEN=$(gh auth token) bun run cla:check`.
 */

const agreement = "docs/cla/v1.md";
const signatures = "docs/cla/v1";

/**
 * Who never signs: Konstantin Tarkus, and bots that act for him or bump
 * versions. By numeric ID, which a renamed or re-registered login cannot take.
 */
const signatureExempt: ReadonlySet<number> = new Set([
  197134, // koistya
  49699333, // dependabot[bot]
  329773053, // braivo[bot]
]);

/**
 * Who may add a version of the agreement or record a withdrawal: Konstantin
 * Tarkus, and `braivo[bot]`, the identity that opens his pull requests and so
 * is trusted as he is. Not Dependabot.
 */
const administrators: ReadonlySet<number> = new Set([197134, 329773053]);

export type Account = { id: number; login: string };

export type PullRequest = {
  opener: Account;
  /** A commit's author is `null` when its email is linked to no GitHub account. */
  commits: { sha: string; author: Account | null }[];
  /** Changed files; `previous` is a renamed file's old path, `changes` its changed lines. */
  files: { path: string; previous?: string; status: string; changes: number; patch?: string }[];
};

export function signaturePath(account: Account): string {
  return `${signatures}/${account.id}.md`;
}

/** The line a signature file holds, word for word but for the signer's name. */
export function signatureLine(account: Account, name: string): string {
  return `I, ${name} (GitHub @${account.login}, user ${account.id}), agree to the Braivo Contributor License Agreement v1.`;
}

/** The line the check prints, for the signer to put their name in. */
export function signatureTemplate(account: Account): string {
  return signatureLine(account, "<your full name>");
}

function isSignature(content: string | undefined, account: Account): boolean {
  const [before, after] = signatureLine(account, "\0").split("\0") as [string, string];
  const name =
    content?.startsWith(before) && content.endsWith(after)
      ? content.slice(before.length, -after.length)
      : "";
  // A name, not the template's placeholder copied as is.
  return /^\S(?:[^\n]*\S)?$/.test(name) && !/^<.*>$/.test(name);
}

/**
 * Why a change under `docs/cla/` is refused, if it is. Once signed, the
 * agreement and every signature stay as they are: an administrator may add a
 * new version, or move a signature unchanged to `withdrawn/`. Unchanged means
 * no changed lines: this guards the record against mistakes, not against
 * the administrators, who control the check anyway.
 */
function claProblem(file: PullRequest["files"][number], opener: Account): string | undefined {
  const own = signaturePath(opener);
  if (file.path === own && file.status === "added") {
    if (isSignature(added(file.patch), opener)) return undefined;
    return `${own} must hold exactly this line, with your full name in place of the placeholder:\n\n    ${signatureTemplate(opener)}`;
  }
  if (administrators.has(opener.id)) {
    if (file.status === "added" && /^docs\/cla\/v[1-9]\d*\.md$/.test(file.path)) return undefined;
    const id = file.previous?.match(/^docs\/cla\/v1\/(\d+)\.md$/)?.[1];
    // An optional `-2`, `-3`, … suffix avoids a collision after signing again.
    const withdrawal =
      id !== undefined &&
      new RegExp(`^${signatures}/withdrawn/${id}(-([2-9]|[1-9]\\d+))?\\.md$`).test(file.path);
    if (withdrawal && file.status === "renamed" && file.changes === 0) return undefined;
  }
  return `${file.path}: the agreement and the signatures given never change. A changed agreement is a new version, and a withdrawal moves a signature, unchanged, to ${signatures}/withdrawn/.`;
}

/**
 * What stops the pull request from passing; none when it may merge.
 * `signed` holds the IDs whose signatures the base branch has.
 */
export function check(pull: PullRequest, signed: ReadonlySet<number>): string[] {
  const problems: string[] = [];
  // The opener's own signature file, if this pull request touches it, either
  // signs or is already reported: one message for a bad line, not two.
  let touchesOwnSignature = false;

  for (const file of pull.files) {
    if (![file.path, file.previous].some((path) => path?.startsWith("docs/cla/"))) continue;
    const problem = claProblem(file, pull.opener);
    if (problem) problems.push(problem);
    touchesOwnSignature ||= file.path === signaturePath(pull.opener);
  }

  const signers = new Map([[pull.opener.id, pull.opener]]);
  for (const { sha, author } of pull.commits) {
    if (author) signers.set(author.id, author);
    else
      problems.push(
        `Commit ${sha.slice(0, 7)}'s author email is linked to no GitHub account: commit with an email your account has, so the commit is attributed to you.`,
      );
  }

  for (const signer of signers.values()) {
    if (signatureExempt.has(signer.id) || signed.has(signer.id)) continue;
    if (signer.id === pull.opener.id) {
      if (!touchesOwnSignature)
        problems.push(
          `@${signer.login} has not signed ${agreement}. To sign, add ${signaturePath(signer)} to this pull request, holding this line with your full name:\n\n    ${signatureTemplate(signer)}`,
        );
    } else {
      problems.push(
        `@${signer.login} wrote commits here but has not signed ${agreement}. They sign in a pull request of their own that adds ${signaturePath(signer)}; once it is merged, rerun this check.`,
      );
    }
  }

  return problems;
}

/** The content a new file's patch adds, without a trailing newline. */
function added(patch: string | undefined): string | undefined {
  return patch
    ?.split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1).replace(/\r$/, ""))
    .join("\n");
}

async function main(): Promise<void> {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    PULL_NUMBER: number,
    HEAD_SHA: head,
  } = process.env;
  if (!repository || !token || !number)
    throw new Error("Set GITHUB_REPOSITORY, GITHUB_TOKEN, and PULL_NUMBER.");

  const request = (path: string) =>
    fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  const failed = async (path: string, response: Response) =>
    new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  const get = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    if (!response.ok) throw await failed(path, response);
    return (await response.json()) as T;
  };
  const exists = async (path: string): Promise<boolean> => {
    const response = await request(path);
    if (response.status === 404) return false;
    if (!response.ok) throw await failed(path, response);
    return true;
  };
  const all = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await get<T[]>(`${path}?per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  };

  type Pull = {
    user: Account;
    head: { sha: string };
    base: { ref: string };
    commits: number;
    changed_files: number;
  };
  // A push, or a new base branch, since this run's event gets a run of its
  // own: this one must not pass on what it did not see, so it checks before
  // reading and again before passing.
  const unchanged = async (expected: Pull | undefined): Promise<Pull> => {
    const pull = await get<Pull>(`pulls/${number}`);
    const sha = expected?.head.sha ?? head ?? pull.head.sha;
    if (pull.head.sha !== sha || (expected && pull.base.ref !== expected.base.ref))
      throw new Error("The pull request changed during the check; its newer run decides.");
    return pull;
  };

  const pull = await unchanged(undefined);
  // The API lists at most 250 commits and 3,000 files; past that it would pass
  // on what it never saw.
  if (pull.commits > 250 || pull.changed_files > 3000)
    throw new Error("Too large to check: at most 250 commits and 3,000 changed files.");

  const commits = await all<{ sha: string; author: Account | null }>(`pulls/${number}/commits`);
  const files = await all<{
    filename: string;
    previous_filename?: string;
    status: string;
    changes: number;
    patch?: string;
  }>(`pulls/${number}/files`);

  // Read from the base branch as it is now, not from the checkout: a rerun
  // keeps its first run's commit, and must see a signature merged since.
  const signed = new Set<number>();
  for (const author of [pull.user, ...commits.map(({ author }) => author)]) {
    if (!author || signatureExempt.has(author.id) || signed.has(author.id)) continue;
    const path = `contents/${signaturePath(author)}?ref=${encodeURIComponent(pull.base.ref)}`;
    if (await exists(path)) signed.add(author.id);
  }

  const problems = check(
    {
      opener: pull.user,
      commits: commits.map(({ sha, author }) => ({
        sha,
        author: author && { id: author.id, login: author.login },
      })),
      files: files.map((file) => ({
        path: file.filename,
        previous: file.previous_filename,
        status: file.status,
        changes: file.changes,
        patch: file.patch,
      })),
    },
    signed,
  );

  if (problems.length === 0) {
    await unchanged(pull);
    console.log("The opener and every commit's author have signed the CLA.");
    return;
  }
  console.error(
    `The CLA check failed. Why Braivo asks: CONTRIBUTING.md.\n\n- ${problems.join("\n- ")}`,
  );
  process.exitCode = 1;
}

if (import.meta.main) await main();
