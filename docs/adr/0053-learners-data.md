# 0053: The operator exports and erases learners' data on its controller's instruction, and an erasure survives a restore

Status: proposed (2026-11-01). Points marked _counsel_ await a lawyer's confirmation before this is accepted; the rest is decided. Once accepted, it amends [ADR 0032](0032-learner-history.md)'s deferred retention and [ADR 0031](0031-ai-limits.md)'s ledger. Not legal advice.

## Context

A school is the controller of what it records about its pupils, and the installation's operator its processor. One account can belong to several schools, while its sign-in identity (email, Google link, sessions, connected AI apps) is installation-wide. Pupils may be minors, so requests often come from parents. A school must be able to promise a parent that a pupil's data is exported or erased on request, within the legal deadline, without anyone writing SQL.

Before this, only SQL did it. Deleting `user` cascades most of what names the account, but leaves the rows keyed by an email (verification rows, learn domains' sign-in codes, invitations) and handoffs never completed. Nothing erased one school's history, nothing exported anything, nothing expired but sessions, and a restore from backup would bring an erased pupil back.

## Decision

### Who asks, and who authorizes

- **A school instructs only for its own records.** Its written instruction names one organization and maps to a school-scope export or erasure of that organization's history, with an explicit choice about ending membership. It never authorizes an account-scope export or erasure, which would disclose or destroy another school's records, or reaches the learner's own organization ([ADR 0046](0046-material-in-steps.md)). The instruction comes from the school's contracted controller contact; for a sole-trader tutor, that is the tutor, even though they also teach. An app role or a sender address alone is not authority.
- **Account scope is the account holder's own verified request.** The operator is probably the controller of the installation-wide account layer for its own purposes (_counsel_), but that alone does not authorize disclosing or erasing schools' records: for an account-scope export or erasure alike, each school holding records gives a documented, possibly standing, instruction, and retention exceptions are settled before an account erasure runs. Telling the schools afterwards is not authorization.
- **Verification.** By default, a request bound to a completed fresh sign-in, never a live code emailed to the operator. Email possession never proves parental authority. Shared family mailboxes, lost access, disputed guardianship, and a child exercising their own rights go to a manual exception path: each school decides for its records, and the account layer's follow the operator's documented procedure, resting on its controller role (_counsel_, above); the operator never judges parental authority for a school. One school's confirmation of a parent never authorizes disclosure at another. The rules on representing a minor are the applicable national law's, not GDPR's consent age for online services (_counsel_).
- **Delivery.** A school-scope export goes to the instructing school, or to the person directly when the school instructs so; an account-scope export to the verified account holder or their verified representative, never to a school. Transfer is secure and expiring, and working copies are deleted afterwards. The file is not the whole art. 15 answer: purposes, recipients, and retention come with it, in a cover letter the runbook templates; art. 20 portability is narrower.
- **Deadlines and register.** One restricted register records each request on receipt (received, scope, requester's role, instruction reference, due date, done), never exported data; forwards a school's request to it promptly; tracks the controller's due date; and escalates a missing instruction rather than waiting for it to be complete. The operator's target to a school is contractual, counted from a complete instruction, not a GDPR deadline. The operator's own account requests run on art. 12(3)'s month, extended only with reasons given within it (_counsel_: how clarifying identity affects the clock).
- **A school that has left.** Its pupils' rights continue while their data is held: a manual path to the former controller or its successor, set in the termination terms; data already deleted is said to be so. An account erasure never substitutes for a request about one former school.

### Operations

Each is an operator's command with an explicit scope, run with the server's environment; no API route, MCP tool, or console page reaches any of them ([ADR 0050](0050-tools-read-learner-data.md) draws the line for tools; this goes further, as nothing over HTTP does it).

- **Export**, read-only, one scope flag of two: what one organization recorded of the learner, with enough of each task to read the answer by, or the account's (every organization's records, a departed school's retained history included, plus the account layer). A field allowlist, never a row dump: no secret, token, code, hash, IP address, or user agent, and a school's export holds no session or other organization. Versioned JSON, written to a new file only the operator's user reads, status apart from it. The fields are access-47's, the format the deployment guide's.
- **One school's history erased:** its attempts and evidence, its learner sessions, its handoffs and sign-in codes for the person, and its invitations to the email, with or without ending membership. A per-learner, per-organization **history epoch** fences it: an answer begun before the erasure and resent after (an unfinished attempt from an open tab, an integration's retry) is refused rather than recreating the history. The epoch lives outside membership, so ending membership and rejoining does not reset it. Writers of attempts and evidence take the same per-learner, per-organization lock as the erasure, recheck access and the epoch inside it, and persist in one transaction.
- **The account erased:** the `user` row with what cascades from it, then the rows keyed by the email that no foreign key reaches (verification identifiers naming it, sign-in codes, invitations), after the same locks on every organization the person has records or membership at. An inventory test classifies every table and every column naming a person, failing on one unclassified, so a new one cannot slip past the export or erasure.
- **Confirmation** before anything destructive names the installation (database host and name), the account, the organization, and the counts, and asks for the slug or email typed back. Erasure reports done only after commit, and reads of attempts and evidence are never served from a cache.

### Retention

- **A departed learner's history** is kept for a period the school sets in its agreement, by default 12 months after membership ends, so a learner returning after a summer or a skipped term keeps it (ADR 0032); a longer period needs a stated reason. It is a defensible default, not a safe harbour. When membership ended is recorded by every removal and cleared on rejoining; a history already departed when this ships starts its clock at the first sweep, never back-dated from last practice.
- **A monthly sweep** lists what is due and the operator confirms it by a due date, so the longest delay is the period plus one interval, stated in the promise. With each sweep, each school gets a roster report of its members and their last practice there, or none, to confirm or remove; never acted on automatically, and activity at another school does not count. No sign-in tracking is built for it.
- **An account with no membership and no retained history anywhere** is erased after a documented grace period, starting when that state is first recorded, rechecked at deletion, the account holder warned first. This rests on the operator controlling the account layer (_counsel_).
- **A school leaving the installation** has its own runbook, not the sweep: the school chooses return or deletion, access ends on an agreed date, a retrieval window follows (a contract term, not an art. 28 deadline), then its records and file bytes are deleted in order, other schools' untouched. The ordinary departure period never overrides end-of-service instructions (_counsel_: art. 28(3)(g), its exceptions, and whether any learner-history purpose survives).
- **Expired authentication rows** of every kind (both sessions, verification, sign-in codes, handoffs, device codes, OAuth tokens and assertions) are swept monthly, a backstop to the cleanup that already runs as new ones are written.
- **The AI ledger** keeps its user for a window an actual investigation need justifies, or until the month closes if none does, then nulls it; rows are deleted after 12 months, the current month kept for the quota. Nulling is minimization, not anonymization: in a one-person organization the user is obvious.
- **Backups:** the promise to parents gives the verified maximum across every recoverable copy.
- **The register** is kept for a period counsel approves, with a purpose-specific justification (_counsel_); replay records (below) until no recoverable copy from before the erasure remains.

### Minimization

Braivo calls no Google API and lists no sessions, so neither has a purpose: console sessions stop storing the IP address and user agent, and accounts stop storing Google's access, refresh, and ID tokens, whatever the provider. Both by Better Auth's database hooks on create and update, never `disableIpTracking`, which also turns off Better Auth's rate limiting; `get-access-token`, `refresh-token`, and `account-info`, which need stored tokens, are disabled. The columns stay, as Better Auth generates them, and stay null. Values already stored go with the databases' reset before the first release ([ADR 0005](0005-postgresql-drizzle.md)); none holds a real user. Reversible: a later Google feature asks for its own scope with a new consent, and keeps those tokens for that purpose.

### Surviving a restore

- **A durable replay log outside the database and its backups,** in the register's restricted store but logically separate from it, with its own retention. Each record follows a versioned, validated schema: the scope, user ID, organization ID, epoch, whether membership ended (a restored database cannot say), an HMAC of the normalized email with its matching rule's version, and the intent and done times. The replay never parses the register's prose, and fails closed on a malformed or missing entry.
- **Intent before deletion:** written under the erasure's lock, once nothing can refuse it and before anything is deleted, marked done after commit, so a crash between the two leaves a pending intent, never an unrecorded erasure, and a refused erasure leaves no intent a replay would carry out; pending intents are reconciled with the replay.
- **The email's HMAC,** keyed by an operator secret kept outside the database and its backups, covers email-keyed rows with no user: a restore between a code request and first sign-in, or an invitation to an address never registered. It is personal data, not anonymization.
- **A school-scope replay restores the fence:** it erases that organization's history up to the recorded epoch, never what was collected after, and puts the epoch back.
- **After any restore, the replay runs before the service reopens,** idempotently, rehearsed in the restore drill. No distributed transaction, no service beyond the store.

## Alternatives rejected

- **The operator verifying requesters directly:** it would judge parental authority it cannot check, and act as the schools' controller.
- **Self-service in the apps:** identity checks and minors' consent would come first; screens wait until requests arrive.
- **Keeping history until someone asks:** no limit, hard to justify under storage limitation.
- **Erasing history when membership ends:** contradicts ADR 0032 (a returning learner keeps it) and loses what the school may need.
- **Keeping Google's tokens, IP, and user agent for a security review:** a purpose nobody uses, a retention period, and fields in every export.
- **`disableIpTracking`:** stops IP resolution, and with it Better Auth's rate limiting.
- **A shorter backup window and re-erasing by hand from the register:** manual and error-prone; **no point-in-time restore:** loses the backup's purpose.
- **Writing the log only after the erasure:** a crash after commit leaves an erasure nothing records.
- **Reading the email from the restored user row instead of an HMAC:** misses rows with no user.
- **The epoch on membership:** ending membership and rejoining would reset it, letting an old resend through.
- **A row dump for exports:** a new column would leak by default; an allowlist fails closed.

## Consequences

- Every operation is the operator's, in a terminal with the database's credentials, rehearsed on synthetic accounts. The deployment guide gives the export's format; the runbook and the cover letter's template, explaining the file to the person it describes, join it before the first real request is served.
- An attempt carries the epoch it was begun under, and a stale one is refused distinctly, so the learn app ends that attempt rather than retrying it; an integration sends the epoch it read.
- Material that names a pupil (a source, its tasks, an objective's title) carries no learner key, so no erasure here reaches it; its redaction is a separate decision.
- The operator's own documents carry what the platform cannot: the register, the contractual target, the backup window, and where the replay log and its key are kept.
