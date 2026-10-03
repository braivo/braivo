// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An organization's page `head`: the page, then the organization, so tabs tell
 * them apart and a narrow tab keeps the page. Only on success: a reload ending
 * in not-found keeps the old loader data, which must not name the page then.
 * Otherwise the console's own title stands.
 */
export function pageHead(
  { match }: { match: { status: string; context: { organization: { name: string } } } },
  page: string | undefined,
) {
  return {
    meta:
      match.status === "success" && page !== undefined
        ? [{ title: `${page} · ${match.context.organization.name}` }]
        : [],
  };
}
