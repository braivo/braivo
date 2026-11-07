// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Step, Steps } from "fumadocs-ui/components/steps";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { ReactNode } from "react";

/**
 * Questions that open in place. Not Fumadocs' accordion: a page's content is
 * rendered once, at build, and never hydrated, so Radix's would never open, and
 * it leaves a closed answer out of the HTML. `<details>` opens without
 * JavaScript, keeps every answer in the page for search engines and Find, and is
 * announced as a disclosure. Styled in `styles.css`.
 */
function Accordions({ children }: { children?: ReactNode }) {
  return <div className="accordions">{children}</div>;
}

function Accordion({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <details className="accordion">
      <summary>{title}</summary>
      <div className="accordion-body">{children}</div>
    </details>
  );
}

/** What a page may use; `wrapper` gives its content the prose styles. */
export default {
  ...defaultMdxComponents,
  Accordion,
  Accordions,
  Step,
  Steps,
  wrapper: DocsBody,
};
