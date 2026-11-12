# 0062: The native apps sign in with Google's and Apple's ID tokens, on the installation's origin

Status: accepted (2026-11-10), implemented (2026-11-10); amends [ADR 0018](0018-sign-in-and-invitations.md) (Google by redirect alone)

## Context

The native learner apps ([braivo/mobile](https://github.com/braivo/mobile)) sign in on the installation's origin with an email code (access-1). Google signs in there by redirect alone, with Better Auth's ID-token sign-in off (access-30). For an app, a redirect ends in the browser's cookies, not the app's: each app would need a callback and a handoff of the session from the browser, as a learn domain has (ADR 0018). Each platform's own sign-in instead hands the app an ID token, which the server can exchange for its session as it does a code.

An iOS app that offers Google must also offer an option that keeps the email private (App Store guideline 4.8): Sign in with Apple. An email code does not qualify.

## Decision

- **The apps sign in with a provider's ID token at Better Auth's `POST /api/auth/sign-in/social`:** Google on Android and iOS, Apple on iOS, beside the email code. An iOS app offers Google only where Apple is offered too. The web is unchanged.
- **Each token carries a nonce Braivo issued, spent once.** The app gets one from `POST /api/sign-in/nonce`: random, good for 10 minutes, stored as its hash, and rate-limited per client as codes are. It gives the provider the nonce's SHA-256 and sends the raw nonce with the token.
  - A `before` hook runs on every request that carries an ID token. It redeems the nonce atomically, before Better Auth verifies anything, and passes the hash on for Better Auth to compare with the token's claim. An unknown, expired, or spent nonce is refused.
  - No token, leaked or stored, carries what redeems it, so none is accepted twice.
  - Better Auth checks the signature, issuer, expiry, and audience. The audience is the installation's Google web client ID, which the apps name as their server client ID, or the apps' bundle IDs for Apple.
  - Better Auth's `link-social` stays closed.
- **Who a token signs in is decided as for Google's redirect (access-30):** a verified email, and only while it is still the account's.
  - **Where the provider controls the mailbox,** its token makes an account, signs in to the one with that email, or signs in again. For Google, that's `@gmail.com` and Workspace accounts. For Apple, it's Apple's own mail domains (`@icloud.com`, `@me.com`, `@mac.com`) and Hide My Email addresses. Such a token proves the mailbox as a code does, confirming an account's unconfirmed email ([ADR 0063](0063-apple-identities-on-addresses-apple-does-not-control.md)).
  - **Any other Google address** is sent to a code, as now.
  - **Any other Apple address** is governed by ADR 0063.
  - **An Apple identity already linked signs in to its account whatever address its token now carries,** and the account's email stays as it is. A person changes that address by choosing to share or hide their email after stopping and starting again, or by changing their Apple Account's. Refusing them would leave no way back to an account made with a Hide My Email address whose forwarding has stopped.
- **A provider's name fills only an empty one (access-5).** Apple sends a name once, on the first authorization, and outside the token. The app sends it in `idToken.user` and keeps it until the server confirms the sign-in, since a failed attempt spends its nonce. Braivo writes the name only where the account has none, never through `updateUserInfoOnLink`, which renames.
- **The session is the installation's cookie, as after a code,** which each app keeps across launches. Requests are JSON with the host's own `Origin` (access-4, access-28).
- **Apple's authorization is kept revocable.** As soon as Apple's token is verified, Braivo exchanges the authorization code the app sent, which is good once and for minutes, for a refresh token.
  - It keeps the refresh token, encrypted, only if the exchange names the same Apple subject.
  - A failed exchange is logged and changes nothing else.
  - Erasing the account revokes the token at Apple first. If no token is kept or Apple refuses, the erasure goes on, and tells the person to remove the app from their Apple Account's settings.
- **The secrets are the server's:** Google's client secret and Apple's signing key, team ID, and key ID. An app ships only public identifiers.

## Alternatives rejected

- **The redirect in a browser sheet:** a callback and a session handoff in each app, and on iOS an Apple web flow its users never otherwise see.
- **The nonce as Better Auth checks it**, required but chosen by the client: a token sent with the nonce read from its own claim is accepted until it expires.
- **Apple on the web:** Google and codes serve it; Apple's web flow adds a Services ID and a callback for no need yet.
- **A Braivo token instead of the cookie:** a second kind of session for every route to accept.

## Consequences

- With the implementation, these change: access-1 (the apps' sign-ins); access-30 (ID tokens on these terms, and Apple's rule); access-4 (the nonce route); and access-49 (Apple's revocation).
- **A refused token, or an answer that never arrives, spends its nonce.** The app then starts again with a new nonce and a new sheet. Restoring the nonce would reopen the replay it closes.
- **Hide My Email:**
  - It makes an account apart from the learner's school address, and that account has no invitation. A Braivo account is never linked to an Apple identity under a different email. The apps tell such a learner, while they have no school, that an invitation needs the email it was sent to.
  - An installation offers Apple only once its sending domain is registered with Apple's private email relay and its mail passes Apple's SPF or DKIM checks. Otherwise that account receives no code, and is unreachable from Android or the web.
- **App Store:** an app that creates accounts must let them be deleted from within it. That holds for codes already. Today access-49's erasure is the operator's alone, so the App Store release waits on a learner's own request to erase their account, a decision of its own.
- **Deferred:**
  - Apple's server-to-server notifications (consent revoked, account deleted, and relay forwarding turned off or on, which a person can do for each app);
  - a school's own branded app.
