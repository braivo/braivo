# 0018: Accounts on Braivo's origin, invitations to organizations, and learners signing in on each learn domain

Status: accepted (2026-09-25), amended (2026-10-11: a learn domain signs in by its own code), partly implemented (see Consequences)

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
- **The operator creates organizations, or lets people set up their own.** The operator creates one from the command line for an account that has signed in once, its owner. An installation that sets `BRAIVO_SELF_SERVE_DOMAIN` (`braivo.app` on Cloud) also lets anyone signed in who owns no organization set one up in the console, its owner, at `<slug>.<that domain>`: a name and that address, nothing more. Off by default: a self-hosted school's `/login` takes any email, and its organizations are its operator's to make. One per owner, a limit of this path alone, not a defence against squatting (whoever has many emails has many accounts): more take the operator. The operator serves the domain's subdomains (wildcard DNS and certificate) before setting it. Better Auth's own creation endpoint stays closed (`allowUserToCreateOrganization: false` refuses sessions only); both paths call it naming the user, which runs every hook.
- **Invitations add people to an existing organization**, as one of two things: a learner (`member`) or an administrator (`admin`). No owner invitations; ownership comes from creation. The invitee opens `/invitations/<invitation>` on Braivo's origin, signs in, and accepts — only as a verified identity whose email matches the invitation (Better Auth's `requireEmailVerificationOnInvitation`; on mismatch, "This invitation was sent to another email"). A learner then goes to the organization's learn domain, an administrator to its console.
- **A learner invitation needs a learn domain, checked on the server at both ends:** created only when the organization has one, and accepted only while it still does (Better Auth's `beforeCreateInvitation` and `beforeAcceptInvitation`); otherwise the invitation stays pending and the invitee is told the site is not ready. The invitation names the organization only; the domain, the latest the organization registered ([ADR 0004](0004-one-application-origin.md)), is looked up when needed.
- **Membership stays enrollment**: a `member` reaches every course of their organization. Course enrollment waits for a customer who needs it.
- **A learn domain holds a learner session, never the account's.** Better Auth's session stays in a host-only cookie on the installation's origin; cross-subdomain cookies are never enabled. The learner session, Braivo's own, fixes a user and an organization, is accepted only on the domain it was handed to, while that serves the organization, and only by learner routes and the session's own endpoints. It grants no membership: those routes still check current membership on every request, so removing a learner takes effect at once. Learn domains then need none of Better Auth's endpoints, and an operator's domain and a customer's differ only in who holds DNS.
- **A learn domain signs its learners in on its own `/login`, by a code good there alone,** so a learner never leaves their school's site to type a code, and the page wears the organization's name throughout. The code is Braivo's, not Better Auth's: sent for that hostname and the organization it serves, with the rules of Better Auth's codes (access-1, access-2), kept as an HMAC under the installation's secret, since six digits plainly hashed a database leak would reverse, and redeemed only there, while the hostname still serves that organization, as a learner session for a member. It never opens the account's session, and Better Auth's codes open no learner session, so whoever controls the domain gains nothing by reading what is typed there. A right code from someone not yet a member makes their account, as `/login` does, so the operator can add it, and stays good, so the same code signs in once they are added. A new account is named there, only while it has no name: a learn domain never renames an account, and naming one is the only thing it writes to an account. The mail names the site the code is for, the installation's host or the learn domain, so a code asked for somewhere is recognizably not for anywhere else.
- **Google's round trip goes through the installation's origin, Google's one callback, and hands back:** the learn domain's "Continue with Google" starts a handoff marked as Google's, and the installation's `/login` starts Google at once, unless an account is open there, which it offers first as always.
- **For Google, Braivo's origin hands the learner session over; the browser never names where to:**
  1. The learn app's sign-in navigates to its own `/api`, which records a handoff (organization and hostname from the request's host, a relative return path, a nonce, an expiry), sets the nonce in a cookie on that hostname, and redirects to Braivo's `/login?handoff=<id>`.
  2. Braivo's origin signs the person in, checks that they are still a member, then redirects to `https://<stored hostname>/api/session/handoff?code=<code>` with a single-use code of about a minute.
  3. That route redeems the code only alongside the handoff's nonce cookie — otherwise anyone could sign a victim into the sender's account — sets the learner session cookie, and redirects to the stored path, so the app never loads with a credential in its URL.

  This is OAuth's authorization code flow in miniature, and OAuth's rules settle questions it raises: the handoff is a pushed authorization request, `/api/session/handoff` on its stored hostname the registered redirect URI, and the nonce cookie stands in for PKCE's verifier, binding redemption to the browser that began it. Braivo builds it rather than becoming an OAuth provider, since both ends are its own; Better Auth's `oneTimeToken` moves the whole session and binds nothing.

- **Shared devices:** signing out of a learn domain ends its learner session only, and with a session already open `/login` asks "Continue as Ada" or "Use another account" (which signs Ada out first) before handing over. Signing out of the console ends the global session.
- **Settings chosen, not inherited:** Google only with a Google-verified email, and only while it is still the account's (no email changes yet); email codes hashed, with a deliberate lifetime and attempt limit; code sending rate limited per address and per client, which works only behind a proxy that sets the client address (README, Deployment).

## Alternatives rejected

- **Accounts only where there is a reason for them** (replaced). Authority carried through the code and Google round trips to stop an identity that reaches nothing; and "there is no account" enumerates accounts.
- **The account's session on operator-controlled domains, a scoped one on customer-owned** (replaced). Two sign-in designs, and Better Auth reachable from learn domains.
- **The operator alone creating organizations** (replaced). Every new teacher at `braivo.app` waited on a person, meeting an empty console that told them to ask.
- **A lock per account around setup**: it would hold a pooled connection while Better Auth's creation takes another, so a burst as large as the pool deadlocks. Setup instead rechecks ownership after creating and undoes its own organization, as it does on any failure before the address is registered; one account's simultaneous setups may then all fail, and a retry works.
- **Creating the organization in Braivo's own transaction**: it would bypass Better Auth's hooks and slug rules, and one per owner would still need a lock, or an index the operator's command must not hit.
- **Self-serve on every installation**, or **without a learn domain**: the first would let any email make organizations on a school's own installation; the second would leave a new organization with nowhere for its learners until the operator acted.
- **Bootstrapping an owner by invitation.** An invitation needs an inviting member, which a new organization lacks.
- **An invitation naming a learn domain.** It freezes a hostname that may change before acceptance.
- **A return URL from the browser.** The handoff records the hostname from the domain mapping.
- **Password sign-in on learn domains until the handoff** (replaced): an account made by email code has no password, so it could not learn until step 2.
- **Passwords alongside**, needing verification and reset; **a separate `/signup`**, a question Braivo need not ask; **signing in on each learn domain with the account's credentials** (replaced by codes good there alone), which would give the account's session to whoever controls the hostname; **magic links**, which fail across devices and are spent by mail scanners; **course enrollment now**, a second access model with no customer asking.

## Consequences

- An installation must send email ([ADR 0033](0033-email-over-smtp.md)); Google needs an OAuth client.
- Email ownership is proven at every sign-in; unused accounts accumulate, reaching nothing.
- With learner sessions in place, a customer-owned domain may be registered: whoever controls it reaches only that organization's learner sessions ([ADR 0004](0004-one-application-origin.md)).
- The learn app's sign-in page is on the learn domain, under the organization's name; only Google's round trip passes Braivo's address.
- Accepted risk (by the maintainer, 2026-10-11): learners learn to type codes on their school's domain, so whoever controls a customer-owned domain could show a page asking for the code the installation's `/login` sends, asked for on their behalf, and use it there. The mail naming its site is the mitigation, not a guarantee; it is why the operator registers a customer-owned domain only after checking who asks for it ([ADR 0004](0004-one-application-origin.md)). Subdomains of the self-serve domain run Braivo's own learn app, which an organization cannot change.
- `/login` and `/invitations` are reserved from slugs; with self-serve, `www` and `demo` too, subdomains Braivo's marketing and demo use ([ADR 0004](0004-one-application-origin.md)).
- With self-serve, an AI key is spent only by the organizations `BRAIVO_AI_ORGANIZATIONS` lists, which the server then requires, or anyone could spend the operator's credits.
- To build, in this order:
  1. done: the command that creates an organization for an existing user, with the console's creation form removed; and email-code `/login` with the name step and settings above, replacing `/signup` and every password form;
  2. done: the learner session and handoff, replacing learn-domain sign-in and no longer accepting the account sessions learn domains held, and learn domains dropped from Better Auth's trusted origins; `/login?handoff=` names the organization and the domain it returns to ("Sign in to Acme Learning"), without Braivo's branding. A handoff lasts 15 minutes, its code 60 seconds within them; a learner session a week, renewed by use, as Better Auth's are. In development the learn app runs on the installation's own host, where it signs in by code;
  3. done: Google at `/login`, a learn domain's included, for an installation with an OAuth client; back from Google for a learn domain, the account is offered as any open session is;
     3b. done: a learn domain's own `/login`, by its own codes, with Google started at once when chosen there;
  4. learner and administrator invitations;
  5. the pilot.
