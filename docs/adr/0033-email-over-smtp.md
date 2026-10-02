# 0033: Email goes out over SMTP, or to the log of an installation only its machine reaches

Status: proposed (2026-10-02)

## Context

People sign in with a code sent by email ([ADR 0018](0018-sign-in-and-invitations.md)), so an installation must send email, and invitations will too. A self-hosted installation may use any mail provider, or none of its own while someone tries Braivo on a laptop.

## Decision

- **SMTP, configured by URL.** `BRAIVO_SMTP_URL` (`smtp://` or `smtps://`, credentials in the URL) and `BRAIVO_MAIL_FROM`, the sender. Every provider offers SMTP and a self-hosted machine can run it, so no vendor is built in. Sent through Nodemailer, which handles TLS, authentication, and pooling.
- **Behind one function.** `SendMail` delivers one message, in text and HTML, to one address or throws (`apps/server/mail`); a function there composes each message (`signInCodeMail`), and tests pass an outbox that keeps it.
- **The log only on loopback.** Without `BRAIVO_SMTP_URL`, codes are written to the server's log if `BRAIVO_URL` is `localhost`, `127.0.0.1`, or `[::1]`, and the server then listens on that hostname alone, so whoever reads the log is whoever signs in; anywhere else, `serve` refuses to start. Otherwise a deployment that forgot the setting would answer that codes were sent while nobody received them, and keep live credentials in its logs.
- **Sent while the request waits.** A sign-in code is useless late, and a failure should reach the person asking rather than a queue nobody watches.

## Alternatives rejected

- **A provider's HTTP API** (Resend, Postmark, SES). One vendor for every installation; each offers SMTP anyway.
- **A setting choosing log or SMTP.** One more variable to get wrong; loopback already says nobody else is signing in.
- **A queue with retries.** Infrastructure for messages that expire in minutes.

## Consequences

- A deployment sets two variables, or does not start.
- Messages are English, with an HTML body of plain strings and inline styles (no template engine until a message needs more than a sentence and a code), and do not name the organization: a code sent from a learn domain says nothing of whose site it is. Branding comes with the learn domain's handoff page, which names the organization.
- A slow SMTP server slows sign-in; acceptable until it is measured.
