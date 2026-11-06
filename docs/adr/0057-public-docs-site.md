# 0057: Public documentation is a static Fumadocs site on Astro, `apps/docs`, in this repository

Status: accepted (2026-11-06)

## Context

Educators, and those who host or integrate Braivo, need its documentation as a site. [ADR 0004](0004-one-application-origin.md) keeps marketing out of this repository, as what it says and the scripts it runs are not the open-source product's.

Documentation differs: it describes that product, self-hosters need it, and it changes with the code it describes (`apps/server/api/quickstart.test.ts` runs a guide as written). Its pages will be interactive, with MDX components, and such a page has to be rendered where it is written: its author previews it, and CI builds it with the code it describes.

## Decision

**`apps/docs` is a Fumadocs site on Astro** (`@fumadocs/astro`), built to static files, with Fumadocs' static search, so no server is needed. `bun run build` builds it and `bun run dev` serves it, like the other apps. It uses Fumadocs' own components and neutral theme, not `packages/ui`.

**Who reads what decides where it lives.** `apps/docs/content/` holds what people using Braivo read, as MDX, each URL's section a folder of its own: `content/guides/` at `/guides/`, and `content/docs/`, the reference as it comes, at `/docs/`. `docs/` holds what engineers working on Braivo read: product, architecture, glossary, specs, and ADRs. Each page has one source.

**The build is neutral.** Its configuration names no hosted installation, and no analytics provider. An installation may publish the site or leave its operators to read the pages on GitHub, which renders MDX as a document, heading anchors included. The console's links to guides stay on GitHub, which every installation can reach and none has to host. A page's prose may still name a real address that serves everyone, such as the installer's.

**What an installation changes, it sets at build:**

- `BRAIVO_DOCS_BASE`, default `/`, is where the site sits. It reaches Fumadocs' page tree and, through one override of MDX's link, the links in a page, since Astro has no router to add it.
- `BRAIVO_DOCS_BRAND` names a directory to use in place of `apps/docs/brand/`: the site's name and links, its stylesheet, and what goes in each page's head. A fork brands the site without changing a file of this repository, so merging from here cannot conflict.

**The site occupies two paths under its base**, `guides/` and `docs/`, with its assets and search index under `docs/`, so it can share a host with another site, which keeps the rest. Publishing it that way is the host's own routing.

**The site never shares an origin with the console or a learn app.** It holds no session, calls no API, and takes no input, so it is the one app with an exception to [ADR 0049](0049-app-security-headers.md): its `_headers` keeps `frame-ancestors 'none'` and the rest of that policy, but allows inline scripts, which Astro's islands and Fumadocs' theme write into every page. Keeping this origin apart also means documentation reserves no slugs.

## Alternatives rejected

- **TanStack Start**, as this workspace's apps use its router. Tried beside Astro on the same guides, and it works. But it prerenders by crawling a local server, which failed to connect in 2 of about 14 builds, unexplained; a static host cannot answer the server functions of Fumadocs' example, so its loaders would depart from it; and its bundles were larger. Its router carries the base, and a dead link fails its build, both of which take a little of our own code on Astro.
- **Only the content here, as plain Markdown, with the site kept elsewhere.** It adds no framework dependency here. But pages would be limited to what GitHub renders, and a page with components could not be previewed by its author or built by this repository's CI. It was the better choice while pages were plain Markdown; interactive pages end that.
- **Next.js.** A second kind of application server, where Fumadocs supports static sites without one.
- **React Router.** Supported and static; not tried, as nothing suggested it would beat either above.
- **Astro's own CSP hashes**, in place of the exception. Tried: pages kept their text, but its policy blocked inline scripts and styles the pages need, and tabs stopped working.
- **All of `docs/` on the site.** It is for engineers, and stays readable on GitHub.
- **A copy of each page for the site.** Two sources, and a test running a guide could pass while the site shows another.

## Consequences

- This repository takes on Astro and Fumadocs, MIT: about 370 packages in a standalone trial, React and Tailwind included.
- `@fumadocs/astro` is young, begun in October 2026 and at 0.2.1. It is pinned exactly, and each upgrade gets a look at the rendered site. Should it be abandoned, the pages are portable MDX and TanStack Start is the known way back.
- Astro's build does not fail on a dead link, so `bun run docs:check` checks the pages' links and anchors, which covers more than a crawl would. An unknown MDX component does fail the build.
- `apps/docs` is the one app not on TanStack Router, so [ADR 0016](0016-route-files.md) and `docs/apps.md` do not apply to it. Its `.astro` files stay few and thin, as `vp check` does not type-check their templates.
- On GitHub, a page shows its frontmatter as a table, and components as whatever GitHub makes of them. A self-hoster reading there gets less than the site, in proportion to how interactive a page is.
- Pages' paths change, for every link into them. Anyone holding a GitHub link to an old guide gets a 404.
