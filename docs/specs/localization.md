# Localization

Status: living; checked against the code on 2026-10-06.

A learner should not need English to sign in and learn, in any language Braivo supports. English is the source language and the fallback. Today signing in and learning are localized; the sign-in mail is English (see Gaps).

## Rules

- **localization-1:** Each app chooses its language once, when it starts, before its first React render: the first of the browser's preferred languages Braivo supports, matched by its primary subtag (`pl-PL` is Polish), else English. Nothing is stored or carried between hosts, and the document's language is set to it. Supported: English and Polish. `packages/i18n/i18n.test.ts` (the choice and its activation; `main.tsx`'s call untested)
- **localization-2:** Signing in is in the chosen language: the learn app's `/login` in each of its views, with its title; the console's `/login`, and its sign-in for a learn domain with that page's title; and a page there failing or still loading; accessible names included. The console keeps its name, Braivo Console. `packages/auth-client/sign-in.test.tsx`, `apps/learn/routes.test.tsx`, `apps/console/routes.test.tsx`
- **localization-3:** A refusal while signing in is worded by the app, from its code or status, never in the server's words; one it has no wording for gets a generic line. `packages/auth-client/sign-in.test.tsx`, `apps/console/routes.test.tsx`
- **localization-4:** Every supported language's catalog is complete and compiles, so English never stands in for a missing translation: an app's build fails on a translation missing or malformed (CI's build; the failure itself untested), and `bun run i18n:check` on marked copy not yet extracted, or extracted and not translated (CI).
- **localization-5:** After sign-in, the learn app's own copy is in the chosen language: the course list, empty or failed; signing out, and its failure; the course page in each of its states (a question and its grading, an answer not yet confirmed, a rest, caught up, nothing to practise, a course not found, a failure); and the screen for an address that names nothing, with its title. Times are written as the language writes them, in the browser's time zone, and counts in its plural forms. `apps/learn/routes.test.tsx`

## Boundaries

- **Not here:** course content and the language it is authored or generated in ([generation](generation.md)); the browser's own validation messages, such as for a required field left empty, which Braivo does not control. Sign-in and the learn flow keep their rules in [access](access.md) and the [learner loop](learner-loop.md), which point here for language and never restate it.
- **Not yet:** the static `index.html` loading message shown until an app first renders; the console past its sign-in pages (a shared component it shows, such as a source passage's page, already follows the language); an organization's language, or a learner's own choice.

## Decisions

- [ADR 0035](../adr/0035-lingui-localization.md): Lingui, the language chosen once from the browser's, complete catalogs, failures worded from what the server answers, never its prose, the mail's language from its request.

## Gaps

| Gap                                                                                        | Impact                                                                | Next step                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The sign-in mail is English.                                                               | A Polish learner's code arrives in English.                           | The mail in the language its request asks for (plan, L3).            |
| The Polish has not been read by a native speaker.                                          | Wording may be stilted, or wrong.                                     | A Polish speaker reads the catalog before a pilot (plan, L4).        |
| An organization cannot have its learners see its language whatever their browser asks for. | A Polish school's learner whose browser prefers English sees English. | Decide when a school asks: the organization's language chosen first. |

## Entry points

`packages/i18n/index.tsx` (choosing and activating the language), `lingui.config.ts` (where copy is extracted from, into `packages/i18n/locales/`), `packages/auth-client/sign-in.tsx` (refusals worded from code or status), `apps/learn/routes/_signed-in/courses/$courseId.tsx` (counts and times).
