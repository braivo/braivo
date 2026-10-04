# White-label

Status: living; checked against the code on 2026-10-03.

Each organization's learners use the learn app on the organization's own hostname, which wears its name and serves its courses alone; its content owners manage it in one console at `braivo.app/<slug>` (product.md, core job 6). Which hostname serves which organization is a database row, not configuration.

Each app calls `/api` on its own origin; which hostname reaches which app and the API is the deployment's routing (see Boundaries):

| Origin                                           | Serves                                                | Session                         | Hostname controlled by |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------- | ---------------------- |
| `BRAIVO_URL` (`braivo.app` on Cloud)             | Console at `/`, sign-in, `/api`                       | The account's, host-only cookie | Operator               |
| An organization's domain (`acme.braivo.app`)     | That organization's learn app, `/api`                 | A learner session, handed over  | Operator               |
| A customer's own domain (`learn.school.example`) | The same                                              | A learner session, handed over  | Customer               |
| `www.braivo.app`                                 | Marketing, Braivo Cloud only, outside this repository | None                            | Braivo                 |

## Rules

- **white-label-1:** An organization has at most one learn domain, and a hostname serves at most one organization, both held by the database too, even against concurrent registrations. Deleting an organization deletes its domain: the hostname is no longer trusted, and another organization may register it. `apps/server/application/domains.test.ts`, `apps/server/auth/origin.test.ts`
- **white-label-2:** The operator registers a domain with `braivo organization add-domain --slug <slug> --hostname <hostname>`. The hostname is stored lowercased and must be what `URL#hostname` gives back, or no request's host would match it: ASCII labels of letters, digits, and inner hyphens, 1 to 63 characters each, 253 in all; no scheme, port, path, trailing dot, or IP address; an internationalized name in its `xn--` form. Public DNS is not required (`training` qualifies). The database refuses a hostname in capitals. `apps/server/application/domains.test.ts`, `apps/server/auth/origin.test.ts`
- **white-label-3:** Registering refuses `BRAIVO_URL`'s hostname, whatever its case, which reaches every organization whatever its row says; a slug no organization has; a hostname another organization has, naming it; and a second domain for an organization, naming the first. The same mapping again succeeds, at once or later, so provisioning may retry. `apps/server/application/domains.test.ts`
- **white-label-4:** The host a request was sent to is a ceiling on which organization a course route reaches: on `BRAIVO_URL`'s host, any; on an organization's domain, that organization alone; on any other host, none, so deleting a domain's row revokes access rather than widening it. It grants nothing. When the request has a session, a course outside the ceiling answers exactly as a missing one, 404, so a domain learns nothing about other organizations. The course routes are a course's `…/next`, `…/activity`, and `…/attempts`, and a learner's progress report; a course's overview is read on the installation's host alone (progress-12), and `GET /api/courses` lists a domain's own courses alone (learner-loop-2). On a host that is neither, no session holds either, so what each route answers there is in `apps/server/api/index.ts`. `apps/server/api/app.test.ts`, `apps/server/application/learner-in-course.test.ts`, `apps/server/application/activity.test.ts`
- **white-label-5:** `GET /api/organization`, needing no session, answers the name of the organization the request's host serves, or 404 when it serves none, with `Cache-Control: private, no-store`. `apps/server/api/app.test.ts`
- **white-label-6:** The learn app reads that name before sign-in, shows it, and uses it in the page title. With an organization named `Springo`, the title is `Springo`, or `Spanish · Springo` on a course named Spanish; on a host serving no organization, those titles are `Learning` and `Spanish`. A failure to read the organization leaves the app unbranded rather than down. `apps/learn/routes.test.tsx`
- **white-label-7:** The console's URL names the organization, never the session: Better Auth's active organization is unused. `/<slug>` is resolved among the organizations the user manages: a slug they do not manage reads as not found, and a path below one they manage that names no page says only that there is nothing here. `/` signed in opens the organization last opened in this browser while the user still manages it, else the only one they manage, else `/organizations`. `apps/console/routes.test.tsx`

| Path                                                          | Page                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/`                                                           | Signed in: as white-label-7 says. Anonymous: `/login`                                         |
| `/organizations`                                              | Organizations the user manages (`owner` or `admin`); managing none, where learners go instead |
| `/device`                                                     | Approving a content owner's tool, by the code it showed ([access](access.md))                 |
| `/<slug>`, `/<slug>/courses/<course>`, `…/learners/<learner>` | The organization's console                                                                    |
| `/login`                                                      | Sign-in ([access](access.md))                                                                 |

- **white-label-8:** A slug is lowercase letters, digits, and single hyphens, at most 63 characters, and none of the reserved `api`, `assets`, `device`, `invitations`, `login`, and `organizations`, which `/<slug>` would shadow; every root-level console route is reserved. An organization is never created with a malformed or reserved slug (through creation, only a reserved one tested), and its slug never changes: an update naming a different one is refused, the current one resent accepted. `apps/server/auth/slug.test.ts`, `apps/server/auth/auth.test.ts`

## Boundaries

- Who may sign in, hold a learner session, and reach which route, and which request origins are trusted: [access](access.md). Those checks consult the hostname-to-organization mapping this spec owns; the host ceiling never grants, and access decides within it.
- What a learner's course routes do: [learner loop](learner-loop.md); a learner's report and a course's overview: [progress](progress.md).
- DNS, TLS, and which app each host serves stay the operator's: the server answers `/api` alone and reads the organization from the request's `Host`, which a proxy in front must pass. Only SQL replaces or removes a domain.
- Not here yet: branding beyond the name, changing a slug, and moving an organization to another hostname (see Gaps).

## Decisions

- [ADR 0004](../adr/0004-one-application-origin.md): origins, console at `/<slug>`, the host ceiling, one domain per organization, the organization's own domain allowed, marketing on `www`.
- [ADR 0018](../adr/0018-sign-in-and-invitations.md): learner sessions per learn domain, which admit customer-owned domains.
- [ADR 0016](../adr/0016-route-files.md): route files, including `$organizationSlug/route.tsx` as a layout.

## Gaps

| Gap                                         | Impact                                                           | Next step                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Slugs cannot be changed                     | A typo in a slug is permanent without SQL                        | Owner or admin rename with the warning (ADR 0004)                          |
| Branding is the name only                   | Weak white-label: no logo, colours, or favicon                   | A branding slice: which fields, where stored, how the learn app loads them |
| Only SQL replaces or removes a learn domain | Moving an organization to another hostname needs database access | A command when an organization first needs to move                         |
| No deployment packaging for multiple hosts  | Self-hosters must build their own proxy that passes `Host`       | Deployment docs or packaging (README, Deployment)                          |

## Entry points

`apps/server/application/host.ts` (the host ceiling), `apps/server/application/domains.ts` (registering a domain), `apps/server/auth/slug.ts` (slugs), `apps/console/routes/_signed-in/$organizationSlug/route.tsx` (resolving a slug), `apps/learn/routes/__root.tsx` (branding).
