# Deployment

**There is no deployment packaging yet**: no image, no static serving, no supported proxy configuration. `bun run serve` serves the API and nothing else. Self-hosting is what Braivo is for, and this repository holds everything an installation runs, but building the apps and putting them in front of the API is yours to arrange until it is packaged.

```bash
bun run serve
curl -i http://localhost:3000/api/courses/<course-id>/next   # 401 without a session
```

The server mounts Better Auth at `/api/auth/*` and serves the learning API alongside it.

## Before you expose it

> [!WARNING]
> Do not expose the server directly. Put it behind a proxy that sets `X-Forwarded-For` itself and blocks direct access to the backend, and set `NODE_ENV=production`.

`NODE_ENV=production` enables Better Auth's rate limiting on its own endpoints. That limit is keyed on `X-Forwarded-For`, and the server does not give Better Auth the connection's address, so with nothing in front of it every caller shares one bucket per endpoint — 120 code requests and 120 sign-in attempts for the whole installation, each until a minute passes without an admitted one — and any caller can sidestep it by sending that header themselves. Braivo's own routes are not rate limited in any environment.

## The apps

Each app is served at the root of an origin that also serves `/api` from this server ([ADR 0004](../adr/0004-one-application-origin.md)). `apps/console` goes on `BRAIVO_URL`'s origin; `apps/learn` goes on a domain serving one organization. A proxy in front must pass the `Host` header through unchanged. ADR 0004 is only partly implemented, so a procedure written today would describe a layout still changing.

## Organizations

The operator creates organizations, for an account that has signed in once, with the same environment as `serve`; the console creates none unless self-serve is on, below ([ADR 0018](../adr/0018-sign-in-and-invitations.md)):

```bash
bun apps/server/cli/index.ts organization create --name "My School" --slug my-school --owner owner@example.com
bun apps/server/cli/index.ts organization add-member --slug my-school --email learner@example.com
```

`add-member` adds someone who has signed in once; `--role admin` makes them a content owner too.

**Privacy policy and terms.** `BRAIVO_PRIVACY_URL` and `BRAIVO_TERMS_URL`, absolute http or https URLs to pages you host, add "By continuing, you agree to the Terms and Privacy Policy" under `/login`'s sign-in, where an account is made; set both or neither. Unset, sign-in asks agreement to nothing: set them before inviting anyone beyond a pilot.

**Self-serve.** `BRAIVO_SELF_SERVE_DOMAIN`, a domain such as `braivo.app`, lets anyone signed in who owns no organization set one up in the console, served at `<slug>.<domain>`; one each. Serve the learn app on every subdomain first: wildcard DNS, a wildcard certificate, and a proxy passing `Host`. With it, an AI key needs `BRAIVO_AI_ORGANIZATIONS`, or the server refuses to start. Unset, only the operator creates organizations. Locally, `localhost` serves each at `<slug>.localhost`, as in [the API guide](api.md#an-organizations-domain-locally).

### An organization's domain

The learn app presents itself as the organization whose domain serves it, per an `organization_domain` row mapping the hostname to the organization, and Braivo trusts that origin only while the row exists ([ADR 0004](../adr/0004-one-application-origin.md)). The operator registers one per organization with `organization add-domain --slug <slug> --hostname <hostname>`; DNS, TLS, and routing it to Braivo are set up outside Braivo. Learners sign in on `BRAIVO_URL`'s `/login`, which hands the domain a learner session of its own. To try it locally, see [the API guide](api.md#an-organizations-domain-locally).

## Configuration

**Origin**

- `BRAIVO_URL`: the public origin this installation is served from. Better Auth builds callback URLs from it, so it must match how the server is actually reached.
- `PORT`: 3000 by default.

**Email.** People sign in with a code sent to their email ([ADR 0033](../adr/0033-email-over-smtp.md)).

- `BRAIVO_SMTP_URL`: an SMTP server as `smtps://user:password@host`, or `smtp://`, upgraded with STARTTLS where the server offers it.
- `BRAIVO_MAIL_FROM`: the sender, such as `Braivo <signin@example.com>`.

Unset, codes are written to the server's log, but only while `BRAIVO_URL` is `localhost`, `127.0.0.1`, or `[::1]`, and the server then listens there alone; anywhere else `serve` refuses to start. An address gets one code a minute.

**AI.** Braivo's own drafting and reading of PDFs and photos, for content owners without a desktop agent ([ADR 0029](../adr/0029-server-drafting.md), [ADR 0030](../adr/0030-server-extraction.md), [ADR 0031](../adr/0031-ai-limits.md)).

- `ANTHROPIC_API_KEY`: enables it. Unset, those routes answer 501, and content owners draft with their own agents through `braivo mcp`.
- `BRAIVO_AI_MODEL`: the model, `claude-sonnet-5` by default.
- `BRAIVO_AI_ORGANIZATIONS`: comma-separated organization IDs allowed to use the key. Unset means every organization, and is refused with `BRAIVO_SELF_SERVE_DOMAIN`; an empty value or `*` is invalid, and the server refuses to start.
- `BRAIVO_AI_MONTHLY_LIMIT`: how many AI requests each organization may make in a calendar month — a count, not a spending cap, since one request costs more than another. Every request is recorded in `ai_request` either way.

AI requests may run for up to five minutes, so configure the proxy for that; nginx's `proxy_read_timeout`, for one, defaults to 60 seconds. A request the proxy cuts off may still count toward the organization's limit.

**Google sign-in.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, an OAuth client from Google Cloud's console, add "Continue with Google" to `/login`; set both or neither. The client's authorized redirect URI is `BRAIVO_URL` followed by `/api/auth/callback/google`, such as `http://localhost:3000/api/auth/callback/google` locally; there Google returns to the API's port, not the console's, so open the console yourself, already signed in. Only a Google account whose email Google has verified makes or signs in to an account this way ([ADR 0018](../adr/0018-sign-in-and-invitations.md)).

**Files.** `BRAIVO_FILES` is where uploaded original files, such as the PDFs sources were extracted from, are stored ([ADR 0028](../adr/0028-original-files.md)):

- an absolute path on this machine, or
- `s3://<bucket>` in any S3-compatible store, with `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_REGION` as Bun's S3 client reads them. For Cloudflare R2, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`; for Google Cloud Storage, `https://storage.googleapis.com` with an HMAC key.

Unset, the installation keeps no files and its file routes answer 501. Braivo accepts original-file uploads up to 50 MB and source requests up to 10 MB. Configure the proxy to accept at least those sizes; nginx's `client_max_body_size` defaults to 1 MB.
