// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Step, Steps } from "fumadocs-ui/components/steps";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";

/** What a page may use; `wrapper` gives its content the prose styles. */
export default {
  ...defaultMdxComponents,
  Step,
  Steps,
  wrapper: DocsBody,
};
