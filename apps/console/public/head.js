// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Run by `index.html` as a blocking classic script in `<head>`, before the first
// paint and before any module: a file, not inline, so the policy in `_headers`
// allows scripts from the origin alone.

// Braivo's icons, except on a learn domain's sign-in (a non-empty `?handoff=`,
// as the route reads it), which wears no Braivo branding (ADR 0018). That page
// is marked instead, so its loading screen keeps the neutral theme
// (styles.css); the root route keeps the mark after.
if (new URLSearchParams(location.search).get("handoff")) {
  document.documentElement.dataset.learnDomain = "";
} else {
  for (const [rel, href] of [
    ["icon", "/favicon.svg"],
    ["apple-touch-icon", "/apple-touch-icon.png"],
  ]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    document.head.append(link);
  }
}

// The theme, so a dark page never flashes light: `ThemeProvider`'s rule and
// storage key (`braivo-theme`), restated as no module has loaded yet.
{
  // Unreadable storage (blocked by policy, say) is no choice: the system's.
  let theme = null;
  try {
    theme = localStorage.getItem("braivo-theme");
  } catch {}
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (theme === "dark" || (theme !== "light" && dark)) {
    document.documentElement.classList.add("dark");
  }
}
