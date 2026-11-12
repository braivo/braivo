# 0063: An Apple identity on an address Apple does not control signs in, but confirms nothing

Status: accepted (2026-11-10), amended (2026-11-10: no device or connection granted while unconfirmed; a lapsed link revoked when the next is made or spent), implemented (2026-11-10); amends [ADR 0018](0018-sign-in-and-invitations.md) (every account's email verified)

## Context

An Apple Account's email may be one Apple does not host, such as a Gmail or school address. Apple verified it once, and nothing shows that the verification still holds after the mailbox changes hands. access-30 sends such a Google address to a code. For Apple, that would leave a learner who signed in with Apple at a dead end, which App Review rejects: an app that offers Sign in with Apple may not refuse those who use it ([ADR 0062](0062-native-apps-sign-in-with-id-tokens.md)).

## Decision

- **Apple's token on such an address makes an account when none has that email, and signs in to it again by Apple's subject.** The account's email stays unconfirmed.
- **An unconfirmed email reaches nothing that an email names, nor anything another person could inherit.** Each refuses the account, saying that its email is unconfirmed, until the email is confirmed:
  - an invitation (ADR 0018);
  - the operator's commands that find an account by its email;
  - setting up a school;
  - approving a device's sign-in or granting a connection, whose credentials could outlive the account changing hands.

  A personal organization holds only the account's own material, so it is allowed.

- **A code, or a token from a provider that controls the mailbox (ADR 0062), confirms the email.**
  - **Confirmed in a session the account's Apple identity signed in:** nothing else changes. The app asks for this code itself, while signed in with Apple, before anything that needs a confirmed email.
  - **First confirmed anywhere else, including a sign-in by code on the web or a learn domain:** the Apple identity is unlinked, its token revoked, and every other session of the account ended. Once confirmed, later sign-ins by code change nothing. Whoever now holds the mailbox is not taken to be the Apple Account's holder, and a session already open would otherwise outlast the unlinking.
- **Apple's token on such an address, for an email another account holds, however made, is linked by a code.**
  - Braivo refuses the sign-in and returns a link ID, which is stored as its hash, spent once, and holds the verified Apple identity and its exchanged token for 10 minutes. A link that lapses revokes the token, when the next link is made or spent, there being no jobs to do it on time ([ADR 0046](0046-material-in-steps.md)), unless its identity is linked, or held by another live link, by then.
  - The app sends a code to the same email. A code sign-in that carries the link ID for that same email links Apple to the account, confirms its email, and signs in, with no second Apple sheet.
  - An account holds one Apple identity: linking another unlinks the old one, revokes its token, and ends every other session of the account.

## Alternatives rejected

- **Google's rule for Apple too:** a learner whose Apple Account uses another address could never sign in with Apple.
- **A code before Apple's first sign-in on such an address:** an extra step after Sign in with Apple, which App Review flags. The code comes instead when the learner needs a confirmed email.
- **Keeping the Apple identity, or its sessions, when someone else confirms the email:** whoever had the address before keeps signing in, and is inside every school its new holder joins.
- **Accounts keyed by Apple's subject alone:** two accounts for one person who also signs in by code.
- **Fencing each credential's issuance against a confirmation elsewhere,** instead of refusing devices and connections while unconfirmed: a check inside every issuing path, Better Auth's own, which a device redemption already under way would still pass.
- **Linking with a second Apple sign-in after the code:** a second sheet, and a second route that must redeem nonces.

## Consequences

- **Residual:** an address's new holder inherits what an earlier holder's Apple sign-in put in the account before they confirmed it: practice history, and a personal organization's material. This needs a reassigned address, and the former holder signing in first. That is rare enough to accept, as for any account an email names.
- **Residual: a confirmed Apple link outlives the mailbox.** Suppose a learner confirmed their address and kept their Apple link, and the address is later reassigned, as a school may recycle a student's. The new holder signs in by code to the confirmed account, and the former holder still signs in with Apple, into any school the account still belongs to. This needs a reassigned address and a school that did not remove its departed member, so it is accepted. Google avoids it only because access-30 refuses such addresses. If it is ever narrowed, the way is a link that lapses unless a code is entered in its Apple session now and then.
- **A learner who first confirms outside the app,** such as by accepting an invitation in a browser after signing in there by code, is signed out of the app. The app says why, and offers Sign in with Apple again, which links with one code. Accepting invitations in the app, confirming within its Apple session, waits for the app to open invitation links.
- With the implementation, these change:
  - access-1 (the unconfirmed email);
  - access-30 (Apple's rule and linking by code);
  - access-31 (setup's confirmed email);
  - the invitation and operator rules that find an account by its email;
  - the learn domain's account lookup, which today assumes every email is confirmed.
