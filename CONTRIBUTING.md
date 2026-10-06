# Contributing to Braivo

Thank you for helping. Before you start:

- **Read the design first.** [`docs/product.md`](docs/product.md) covers what Braivo is and is not. [`AGENTS.md`](AGENTS.md) covers how the repository works, and it applies to people as much as to coding agents. Then read the spec in [`docs/specs/`](docs/specs/) for the area you are changing.
- **Propose before you build.** For anything larger than a fix, open an issue first, or a draft pull request if the change is easier to show in code, so we can agree on the change before you finish it. A draft that does not fit the product or its specs may be closed.
- **Run the gates.** Before you open a pull request, run `bunx vp check`, `bun run test`, `bun run build`, `bun run i18n:check`, and `bun run license:check`; CI runs them too.

## The Contributor License Agreement

Braivo is published under [AGPL-3.0-only](LICENSE), and it is also sold under commercial licenses, which fund its development. To offer both, Konstantin Tarkus, who sells them, needs sufficient rights in contributors' work to license Braivo under either. Contributing under the AGPL alone does not grant that right, so the first time you contribute, you sign the [Braivo Contributor License Agreement](docs/cla/v1.md).

- **You keep any copyright you own.** You grant a license, not ownership. Whatever else the work you own and contribute is licensed under, it is also licensed under the AGPL.
- **You sign this version once, in your pull request.** Until you do, its CLA check fails and prints the file to add, `docs/cla/v1/<your GitHub user ID>.md`, and the one line it holds, with your login and ID filled in. Put your full name in place of `<your full name>`, commit the file, and push: the check runs again.
- **Does your employer own what you write?** Then ask hello@braivo.app before you sign: it may need to sign an agreement of its own. Ask too if you cannot legally enter an agreement yourself, for example because of your age.
- **Everyone whose commits are in a pull request signs.** Only the pull request's opener can sign in it. Anyone else with commits in it who has not signed opens a pull request of their own holding only their signature file; once that is merged, rerun the check on the first one. Co-authors named only in `Co-authored-by` lines are not checked, but they sign too.
- **Commit with an email your GitHub account has,** so GitHub attributes your commits to you.
- **Copyright lines name the copyright holder.** A file you create and own carries your name in its header, whether or not an AI tool helped write it. A file you substantially change may add your line beneath those already there. Either way the license line stays `AGPL-3.0-only`:

  ```ts
  // SPDX-FileCopyrightText: 2026 Your Name
  // SPDX-License-Identifier: AGPL-3.0-only
  ```

- **Credit material from elsewhere.** If your pull request includes code or text you did not write, say where it comes from and under which license. That holds for AI-generated output too: you are answerable for what you submit.

The reasoning behind the agreement and the check is in [ADR 0036](docs/adr/0036-contributor-license-agreement.md).
