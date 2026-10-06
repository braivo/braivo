# 0035: Lingui for learner-facing localization

Status: accepted (2026-10-06)

## Context

Schools need their learners served in languages other than English ([localization](../specs/localization.md)), and the mechanism chosen for the first will carry every later language, and the console's copy when it follows. English is the source language. Copy is written and reviewed mostly by coding agents, and a learner passes two hosts, the installation's and the organization's ([ADR 0004](0004-one-application-origin.md)).

## Decision

- **Lingui for web copy**: English written where it is rendered, message IDs generated from it, ICU plurals, PO catalogs versioned with the code. Translator context is added where the same or short English could be translated two ways.
- **The language is chosen once, when an app starts**: the best supported one among the browser's preferences, else English. Its catalog is loaded before the first render and the document's language set to it. No preference is stored or carried between hosts; both read the same browser.
- **Every supported catalog is complete and compiles.** English is the fallback for an unsupported language, never for a missing translation, so a release cannot ship a supported language with gaps.
- **Locale-sensitive formatting follows the chosen language**, without changing which time zone a time is shown in.
- **Failures are worded by the client from what the server answers in machine-readable form**: an error code, or an HTTP status where that is all there is. One it has no wording for gets generic localized copy; server or provider prose is never shown to a learner. Where Braivo's own API needs a distinction worded differently, it answers a code of its own.
- **The sign-in mail's language is the best supported one in the code request's `Accept-Language`**, else English. One short mail does not justify server-side localization machinery, so its translations are typed templates beside it.

## Alternatives rejected

- **Typed dictionaries, no library.** Smaller at first, but plurals, rich text, extraction, and catalog checks would each become Braivo's to build as more copy is localized.
- **Key-based frameworks** (i18next, Paraglide). Workable, but keys move the English away from where it is rendered, which is where this codebase's copy is written and reviewed.
- **A stored or organization-chosen language.** Deferred until a learner or a school must override the browser. It would take precedence in choosing the language without changing the mechanism.

## Consequences

- Translations change with the code, reviewed as a diff.
- A catalog check proves the catalogs complete and in step with the marked copy; it cannot see copy nobody marked, which localized screen tests and review catch.
- Adding a language takes at least a catalog, the mail's templates, and a fluent reader's review.
