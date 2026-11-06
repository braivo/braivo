// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { navigate } from "astro:transitions/client";
import { type SerializedPageTree, useFumadocsLoader } from "fumadocs-core/source/client";
import type { TOCItemType } from "fumadocs-core/toc";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/astro";
import type { ReactNode } from "react";

import DocsSearch from "#components/search";

export interface DocsProps {
  pathname: string;
  params: Record<string, string | undefined>;
  tree: SerializedPageTree;
  title: string;
  description?: string;
  toc: TOCItemType[];
  children?: ReactNode;
}

/** The React island of a page; its content arrives rendered, as children. */
export function Docs({ pathname, params, tree, title, description, toc, children }: DocsProps) {
  const data = useFumadocsLoader({ tree });
  return (
    <RootProvider
      pathname={pathname}
      params={params}
      navigate={navigate}
      search={{ SearchDialog: DocsSearch }}
    >
      <DocsLayout nav={{ title: "Braivo" }} tree={data.tree}>
        <DocsPage toc={toc}>
          <DocsTitle>{title}</DocsTitle>
          <DocsDescription>{description}</DocsDescription>
          {children}
        </DocsPage>
      </DocsLayout>
    </RootProvider>
  );
}
