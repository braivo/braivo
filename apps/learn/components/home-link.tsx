// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Link, type LinkComponentProps } from "@tanstack/react-router";

import { useHome } from "#lib/home";

/** A link back home: My learning on the installation's origin, a school's home on its domain. */
export function HomeLink(props: Omit<LinkComponentProps<"a">, "to">) {
  return <Link {...props} to={useHome()} />;
}
