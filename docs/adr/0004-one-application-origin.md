# 0004: Application origins and organization addressing

Status: accepted (2026-09-16), partly implemented (2026-09-25; see Consequences). Supersedes the origin layout in [ADR 0003](0003-workspace-layout.md).

## Context

[ADR 0003](0003-workspace-layout.md) served a learner app at `/` and the console at `/console/` of one Braivo origin, which suits neither. The learn app is white-label: it runs for one organization under that organization's brand and domain — `springo.app`, say — and as Braivo's demonstration at `demo.braivo.app` ([product.md](../product.md)). The console is Braivo's: Springo's content owners manage it at `braivo.app/springo`.

One person may belong to several organizations — a school and its test copy, schools they consult for — so each needs a stable, shareable address.

## Decision

**The console owns the root of Braivo's origin**, and organizations live there by slug, as on Linear and GitHub:

```text
/                                no session: /login (Cloud: www first, below); session: an organization
/login                           signing in (ADR 0018)
/invitations/<invitation>        accepting an invitation (ADR 0018)
/organizations                   the organizations someone manages
/<organization>                  the organization's console
/<organization>/courses/<course>
/<organization>/learners, …/settings
```

- **The request names the organization, never the session**: the path here, the hostname on a learn domain, with access checked as [ADR 0006](0006-better-auth.md) requires. Better Auth's active organization is unused; opening an organization writes nothing.
- **The host is a ceiling.** On an organization's domain the API answers another organization's course with 404, even to someone entitled to it, so no domain shows another's material under its brand; on a host that is neither an organization's nor the installation's, it answers every course so, and removing a domain's row revokes what it reaches.
- **Signed in, `/` returns to the organization last opened in that browser** — remembered by ID, opened at its current slug, and only while they still manage it — else their only one, else `/organizations`. That page lists the organizations they manage; managing none, it says learners use the learning site their school provides. Organizations are created by the operator ([ADR 0018](0018-sign-in-and-invitations.md)). The last one opened is a browser preference, not session state: switching writes nothing, and a remembered ID grants nothing.
- **The console's organizations are those someone manages**, as `owner` or `admin` (`GET /api/organizations`). A school someone only studies at, as a `member`, is not one of them.
- **"Organization" is the one name** in code, docs, and UI. ("Workspace" means the Vite+ workspace here.)
- **A slug has one spelling, and an `owner` or `admin` may change it.** Lowercase letters, digits, and single hyphens, at most 63 characters, checked wherever a slug is set. Before a change the console warns that existing links break and that the old slug is free for another organization to take. No redirects, aliases, or slug history until someone needs them. A slug change does not touch the learn domain.
- **Root-level paths are reserved from slugs**, since `/<slug>` would shadow them. The list, in `apps/server/auth/slug.ts`, holds application routes only; a new route joins it before it ships (a test checks the console's), and if an organization already holds the word, the route takes another name or the organization moves.
- **Marketing lives on `www.braivo.app`; `braivo.app` serves the application alone**, so marketing may use analytics and tag managers without their scripts running on the application's origin, and reserves no slugs. On Braivo Cloud the router in front sends a bare `braivo.app/` without a session cookie to `www`, so a visitor learns what Braivo is while someone signed in lands in their organization; marketing links to `/login`, which the app always serves. A self-hosted installation has no marketing site.
- **An organization's domain serves its learn app, and nothing else; an organization has at most one.** The hostname identifies the organization, so no slug appears: `springo.app/…`. Anything needing the learn domain — an invitation, a session handoff — names the organization and looks it up. The console stays on Braivo's origin: the server resolves hosts, the console resolves slugs, and nothing resolves both.
- **The learn app serves each organization's learners on its domain**; `demo.braivo.app` is Braivo's own deployment of it. Learners join by invitation and sign in on Braivo's origin ([ADR 0018](0018-sign-in-and-invitations.md)). Until then the learn app signs learners in but never up, and the API refuses sign-up on any host but the installation's.
- **Every origin that serves an app also serves `/api`**, so apps call a same-origin API and [ADR 0003](0003-workspace-layout.md)'s origin checks stand. Whether integrators get an API hostname of their own is decided with their credential.
- **URLs do not dictate deployment.** Marketing, console, and learn app stay separate apps behind a router that dispatches by host and path. On Braivo Cloud the router, the marketing site, and domain provisioning are the managed service's; resolving an organization from its host stays here ([product.md](../product.md)). `organization_domain` records which hostname serves which organization, written by whoever verifies the domain — Braivo Cloud or the operator — never by the organization's members.
- **Until learn domains hold sessions scoped to their organization, only hostnames the operator controls may be registered.** Today Better Auth and Braivo's writes trust `https://<hostname>` for a registered hostname, so the account's session cookie lives there and learners enter credentials there. Whoever controls that hostname's DNS or content could take sessions that act in every organization the user is in. So on Braivo Cloud only hostnames under a domain Braivo holds qualify, and self-hosted only the operator's own. Once [ADR 0018](0018-sign-in-and-invitations.md)'s learner sessions exist, which reach one organization, a domain the organization owns may be registered too.

## Alternatives rejected

- **Marketing on the bare domain, beside the application**, as Linear and GitHub do (first version). Every marketing page would be held to the application's script policy — strict CSP, reviewed third-party scripts only, no tag manager — which Braivo's marketing needs to break, and every marketing page would be a reserved slug, tying this public repository to the private site.
- **`console.braivo.app`.** A subdomain for Braivo's only application, lengthening every address.
- **`braivo.app/console/<organization>`**, or **`braivo.app/organizations/<organization>`** (briefly adopted). A segment that says nothing on every shared address; the reserved list it avoids is a small price.
- **`learn.braivo.app`.** Learners belong on their content owner's domain, under its brand.
- **The last organization in the session**, as Better Auth's active organization: a server write on every switch, racing between tabs, for a browser preference.
- **The organization from the session alone.** URLs could not be shared, and two tabs could not show two organizations.
- **Trusting a verified customer domain with the account's session.** Verification proves who controls the hostname — exactly who could then take sessions valid everywhere.
- **The console on an organization's domain** (first version). A resolver reading host then path, and the account that manages every organization on a hostname one of them controls.

## Consequences

- Addresses are shareable (`braivo.app/acme/courses/italian-a1`), and several organizations can be open at once.
- `braivo.app`'s script policy is the application's alone.
- Changing a slug breaks bookmarks and shared links, knowingly; redirects get built when an organization needs its old links kept.
- Done in this repository:
  - the console at `/`, with `/$organizationSlug` routes, `/login` and `/signup`, `/organizations`, and `/` as above;
  - the learn app resolves its organization from its host (`GET /api/organization`) and presents itself under its name;
  - `/organizations` listing only what someone manages, with an empty state saying where learners go; organizations created by the operator's command ([ADR 0018](0018-sign-in-and-invitations.md));
  - slug format and reserved list, application routes only, enforced at creation;
  - Better Auth and Braivo's writes trust `BRAIVO_URL`'s origin and `https://<hostname>` for a registered hostname, failing closed otherwise;
  - the host ceiling on the learner's course routes;
  - at most one domain per organization.
- Still open:
  - slug changes by an `owner` or `admin`, with the warning (today refused);
  - on Braivo Cloud, marketing on `www` and the router's redirect, outside this repository;
  - domains organizations own, once learner sessions exist.
