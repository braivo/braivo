# 0018: One sign-in on Braivo's origin, invitations to organizations, and a learner session per learn domain

Status: accepted (2026-09-25), partly implemented (see Consequences).

## Context

Today the console signs people in with email and password at `/login` and `/signup`, and the learn app at `/login` on each organization's domain ([ADR 0004](0004-one-application-origin.md)). So:

- nothing proves an email belongs to whoever signs up with it;
- learners have no way in: nothing adds an account to an organization;
- any account could create an organization and own it, though whether self-serve onboarding is wanted is undecided;
- a learn domain holds the account's whole session and takes its credentials, which is why only operator-controlled domains qualify; and Google's callback, built from Better Auth's one `baseURL`, could not complete there anyway.

## Decision

**Signing in establishes identity; membership and organization creation establish access.** One global identity on the installation's origin; on each learn domain, a session scoped to its organization.

- **One `/login` on the installation's origin** (`braivo.app` on Cloud), for everyone: an **email code** (Better Auth's `emailOTP`) and **Google**. No passwords, no `/signup`. Google is optional per installation. A code, not a link: it works across devices, and mail scanners cannot spend it.
- **Any verified identity may have an account; an account alone reaches nothing.** Proving an email signs someone in and makes their account if needed; `/login` never says whether one existed. After a first sign-in, a user without a display name supplies one before continuing.
- **The operator creates organizations.** The prospective owner signs in once; the operator then creates the organization from the command line for that user, who becomes its owner. The console creates none. Self-serve creation waits for a product need, and is additive when it comes. (Better Auth's `allowUserToCreateOrganization: false` refuses sessions only; a call naming the user, as the command makes, still runs every hook.)
- **Invitations add people to an existing organization**, as one of two things: a learner (`member`) or an administrator (`admin`). No owner invitations; ownership comes from creation. The invitee opens `/invitations/<invitation>` on Braivo's origin, signs in, and accepts — only as a verified identity whose email matches the invitation (Better Auth's `requireEmailVerificationOnInvitation`; on mismatch, "This invitation was sent to another email"). A learner then goes to the organization's learn domain, an administrator to its console.
- **A learner invitation needs a learn domain, checked on the server at both ends:** created only when the organization has one, and accepted only while it still does (Better Auth's `beforeCreateInvitation` and `beforeAcceptInvitation`); otherwise the invitation stays pending and the invitee is told the site is not ready. The invitation names the organization only; the domain, one per organization ([ADR 0004](0004-one-application-origin.md)), is looked up when needed.
- **Membership stays enrollment**: a `member` reaches every course of their organization. Course enrollment waits for a customer who needs it.
- **A learn domain holds a learner session, never the account's.** Better Auth's session stays in a host-only cookie on the installation's origin; cross-subdomain cookies are never enabled. The learner session, Braivo's own, fixes a user and an organization, is accepted only on that organization's domain and only by learner routes, and grants no membership: those routes still check current membership on every request, so removing a learner takes effect at once. Learn domains then need none of Better Auth's endpoints, and an operator's domain and a customer's differ only in who holds DNS.
- **Braivo's origin hands the learner session over; the browser never names where to:**
  1. The learn app's sign-in navigates to its own `/api`, which records a handoff (organization and hostname from the request's host, a relative return path, a nonce, an expiry), sets the nonce in a cookie on that hostname, and redirects to Braivo's `/login?handoff=<id>`.
  2. Braivo's origin signs the person in, refuses if they are no longer a member, and redirects to `https://<stored hostname>/api/session/handoff?code=<code>` with a single-use code of about a minute.
  3. That route redeems the code only alongside the handoff's nonce cookie — otherwise anyone could sign a victim into the sender's account — sets the learner session cookie, and redirects to the stored path, so the app never loads with a credential in its URL.

  This is OAuth's authorization code flow in miniature, and OAuth's rules settle questions it raises: the handoff is a pushed authorization request, `/api/session/handoff` on its stored hostname the registered redirect URI, and the nonce cookie stands in for PKCE's verifier, binding redemption to the browser that began it. Braivo builds it rather than becoming an OAuth provider, since both ends are its own; Better Auth's `oneTimeToken` moves the whole session and binds nothing.

- **Shared devices:** signing out of a learn domain ends its learner session only, and with a session already open `/login` asks "Continue as Ada" or "Use another account" (which signs Ada out first) before handing over. Signing out of the console ends the global session.
- **Settings chosen, not inherited:** Google only with a Google-verified email; email codes hashed, with a deliberate lifetime and attempt limit; code sending rate limited per address and per client, which works only behind a proxy that sets the client address (README, Deployment).

## Alternatives rejected

- **Accounts only where there is a reason for them** (first version). Authority carried through the code and Google round trips to stop an identity that reaches nothing; and "there is no account" enumerates accounts.
- **The account's session on operator-controlled domains, a scoped one on customer-owned** (first version). Two sign-in designs, and Better Auth reachable from learn domains.
- **Bootstrapping an owner by invitation.** An invitation needs an inviting member, which a new organization lacks.
- **An invitation naming a learn domain.** It freezes a hostname that may change before acceptance.
- **A return URL from the browser.** The handoff records the hostname from the domain mapping.
- **Passwords alongside**, needing verification and reset; **a separate `/signup`**, a question Braivo need not ask; **signing in on each learn domain**, credentials on hostnames an organization may control; **magic links**, which fail across devices and are spent by mail scanners; **course enrollment now**, a second access model with no customer asking.

## Consequences

- An installation must send email; Google needs an OAuth client.
- Email ownership is proven at every sign-in; unused accounts accumulate, reaching nothing.
- With learner sessions in place, a customer-owned domain may be registered: whoever controls it reaches only that organization's learner sessions ([ADR 0004](0004-one-application-origin.md)).
- The learn app's sign-in page is on Braivo's origin, branded as the organization, with Braivo's address in the location bar.
- `/login` and `/invitations` are reserved from slugs; `signup` leaves the list with the route.
- To build, in dependency order — invitations need the handoff, since an account made by email code has no password for today's learn-domain sign-in:
  1. email-code `/login` with the name step and settings above, replacing `/signup` and the password form; the command that creates an organization for an existing user and the console's creation form removed (both done);
  2. the learner session and handoff, replacing learn-domain sign-in, and learn domains dropped from Better Auth's trusted origins; `/login?handoff=` names the organization and the domain it returns to ("Sign in to Acme Learning"), without Braivo's branding;
  3. learner and administrator invitations;
  4. the pilot, then Google.
