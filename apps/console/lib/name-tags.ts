// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A tag for each person whose name another shares, from the end of their user
 * ID, long enough to tell them apart, so two Ana Kowalskas can be; none for a
 * name alone. Never an email, which a group's readers are not given
 * (access-26). Shown wherever one is chosen or named, a link's name included.
 */
export function sharedNameTags(
  people: Iterable<{ userId: string; name: string }>,
): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const { userId, name } of people)
    byName.set(name, (byName.get(name) ?? new Set()).add(userId));
  const tags = new Map<string, string>();
  for (const ids of byName.values()) {
    if (ids.size < 2) continue;
    let length = 6;
    const tag = (userId: string) => userId.slice(-length);
    while (new Set([...ids].map(tag)).size < ids.size) length += 1;
    for (const userId of ids) tags.set(userId, tag(userId));
  }
  return tags;
}

/** A person as named where a name alone may be ambiguous: with their tag, if any. */
export function nameWithTag(name: string, tag: string | undefined): string {
  return tag ? `${name} ${tag}` : name;
}
