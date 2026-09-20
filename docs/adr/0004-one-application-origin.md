# 0004: One application origin, addressed by organization

Status: accepted (2026-09-16), not yet implemented. Supersedes the origin layout in [ADR 0003](0003-workspace-layout.md).

## Context

[ADR 0003](0003-workspace-layout.md) served two apps from one origin: a learner app at `/` and a content-owner console at `/console/`. That put both on Braivo's own origin, which suits neither. The learner app is white-label: it runs for one organization under that organization's brand and domain — a vocabulary app at `springo.app`, say — and at `demo.braivo.app` as Braivo's own demonstration ([product.md](../product.md)). The console is Braivo's: the same organization's content owners manage it at `braivo.app/springo`. So braivo.app has one application to serve, the console.

Content owners work in organizations, and one person may belong to several: a school and its test copy, or schools they consult for. The application needs a stable address for each, and the white-label promise needs the same application to work under a customer's own hostname.

## Decision

**The application owns the root of its origin**, and every organization's pages live under that organization's slug:

```text
/                     no session: the home page (below); session: redirect to an organization (below)
/login, /signup       signing in
/<organization>       the organization's console
/<organization>/courses/<course>
/<organization>/learners, /<organization>/settings
```

- **The URL names the organization; the session does not decide it.** An organization is always read from the request — the path here, the hostname on a custom domain — and access to it is checked as [ADR 0006](0006-better-auth.md) requires. The session only remembers which organization `/` sends someone to last.
- **Signed in, `/` goes to the last organization while it is still theirs.** If it was deleted or they left it, `/` goes to the only organization they are in, or to a picker when there are several, or to creating one when there are none — which is where a new sign-up lands.
- **"Organization" is the one name**, in code, docs, and UI, and the URL segment is its slug. ("Workspace" already means the Vite+ workspace here.)
- **Slugs cannot shadow the application's own paths.** Organization slugs exclude a reserved list — at least `login`, `signup`, `home`, `pricing`, `about`, `api`, and `assets` — enforced where organizations are created. A new root-level path, marketing or otherwise, joins the list before it ships, and an organization already holding that slug has to be moved first.
- **A custom domain drops the slug.** On an organization's own domain the hostname identifies the organization, so no slug appears: `springo.app/…` for its learners, or a console under a domain like `portal.acme.com`, where `/courses` is `/acme/courses` on braivo.app. Resolving the organization therefore goes through one function that reads the host first and the path second; routes never parse the slug themselves.
- **Anonymous `/` is the product's front page.** On braivo.app that is the marketing site, and `/home` renders it for anyone, with `/` as its canonical URL, so links and search results point at the bare domain. A self-hosted installation has no marketing site, and its `/` sends an anonymous visitor to `/login`.
- **The learn app runs on the organization's origin, not on braivo.app.** `apps/learn` serves each organization's learners under that organization's domain, and Braivo's demonstration at `demo.braivo.app`, with public example courses such as `/italian`. The rules below for sharing braivo.app with marketing do not reach it.
- **Each origin that serves an app also serves `/api`**, so the apps keep calling a same-origin API and the origin checks of [ADR 0003](0003-workspace-layout.md) stand. A separate API hostname (`api.braivo.app`) is for server-to-server integrators, who send neither cookies nor an `Origin`.
- **URLs do not dictate deployment.** Marketing, the console, and the learn app stay separate apps, and a router in front of the origin dispatches by host and path. On Braivo Cloud that router, the Braivo marketing site, and custom-domain provisioning belong to the managed service, outside this repository; resolving an organization from its host stays here ([product.md](../product.md)).

### What sharing an origin with marketing requires

Any script on a marketing page runs with the application's origin, so the whole origin is held to the application's standard:

- sessions only in `HttpOnly` cookies — never a token in `localStorage` or `sessionStorage`;
- a strict Content Security Policy for every page on the origin, marketing included;
- third-party scripts only when reviewed, and none injected by a CMS or tag manager;
- application code in bundles that marketing pages never load.

If marketing ever needs scripts that cannot meet this, marketing moves to its own origin rather than the rules bending.

## Alternatives rejected

- **`console.braivo.app`.** Origin isolation from marketing for free, but a subdomain for the only application Braivo has, and longer addresses for every page in it.
- **`braivo.app/console/<organization>`.** A path segment that says nothing, on every URL, to separate an application from a site it does not need separating from.
- **`/home` as the canonical marketing URL.** Backlinks and search results belong on the bare domain, which people expect to be the company's site.
- **`learn.braivo.app` as the learn app's home.** Learners belong on their content owner's domain, under its brand; a Braivo subdomain would put Braivo's name where the customer's goes, and `demo.` says what the one Braivo hosts is for.
- **The organization from the session alone.** URLs could not be shared between colleagues, and a second tab could not show a second organization.

## Consequences

- Addresses are short and shareable (`braivo.app/acme/courses/italian-a1`), and several organizations can be open at once.
- The origin's security rules above are a standing constraint on marketing, not a one-time review.
- Organization creation gains slug validation against the reserved list, and a slug becomes something whose change breaks links; renaming needs redirects or is disallowed.
- To implement, in this repository:
  - `apps/console` is served from `/`, not `/console/`, with routes under `/$organization`, sign-in at `/login` and `/signup`, and `/` sending a signed-in owner to an organization as described above;
  - `apps/learn` resolves its organization from the host it is served on;
  - organization resolution, host then path, lives in one place;
  - the reserved slug list is enforced where organizations are created;
  - Better Auth stops taking one configured origin as the only trusted one. `BRAIVO_URL`
    is its single base URL and so its only trusted origin, which would refuse every write
    from a learn app on an organization's own domain. What replaces it keeps trusting the
    configured application origin, trusts an organization's domain only while Braivo
    resolves that domain to that organization, and fails closed otherwise — per request,
    not a static list that trusts whatever is on it forever.
