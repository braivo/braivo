# Localization

Status: living; checked against the code on 2026-10-08.

A learner should not need English to sign in and learn, in any language Braivo supports. English is the source language and the fallback. Signing in, the sign-in mail, and learning are localized.

## Rules

- **localization-1:** Each app chooses its language when it starts, before its first React render: the language last chosen from a menu in that browser on that host, if Braivo still supports it, else the first of the browser's preferred languages Braivo supports, matched by its primary subtag (`pl-PL` is Polish), else English. The console's `/login` and its signed-in header have that menu, which switches the page at once, keeping what was typed and loading nothing again (a route's tab title follows on the next page), and keeps the choice only once the language has loaded (in `localStorage`, never carried between hosts), the last one made winning when an earlier one's language arrives after it; a language that fails to load says so, leaving the page as it was. The document's language is set to it. The loading message shown until the app first renders, which also stays when its language fails to load, follows the same choice. Supported: English and Polish. `packages/i18n/i18n.test.ts` (the choice, the stored one first, and its activation; `main.tsx`'s call untested), `apps/console/routes.test.tsx` (the menu), `packages/i18n/boot.test.ts` (the loading message in each app's `index.html`; its plugin in each app's Vite config untested)
- **localization-2:** Signing in is in the chosen language: the learn app's `/login` in each of its views, with its title; the console's `/login`, and its sign-in for a learn domain with that page's title; and a page there failing or still loading; accessible names included. The console keeps its name, Braivo Console. `packages/auth-client/sign-in.test.tsx`, `apps/learn/routes.test.tsx`, `apps/console/routes.test.tsx`
- **localization-3:** A refusal while signing in is worded by the app, from its code or status, never in the server's words; one it has no wording for gets a generic line. `packages/auth-client/sign-in.test.tsx`, `apps/console/routes.test.tsx`
- **localization-4:** Every supported language's catalog is complete and compiles, so English never stands in for a missing translation: an app's build fails on a translation missing or malformed (CI's build; the failure itself untested), and `bun run i18n:check` on marked copy not yet extracted, or extracted and not translated (CI).
- **localization-5:** After sign-in, the learn app's own copy is in the chosen language: the course list, empty or failed; signing out, and its failure; the course page in each of its states (a question and its grading, an answer not yet confirmed, a rest, caught up, nothing to practise, a course not found, a failure); and the screen for an address that names nothing, with its title. Times are written as the language writes them, in the browser's time zone, and counts in its plural forms. `apps/learn/routes.test.tsx`
- **localization-6:** The sign-in mail is in the supported language its code request's `Accept-Language` weighs highest (the apps send the language the page shows, so a language chosen from the menu, localization-1, holds for the mail too), matched by primary subtag, else English, as when the server asks itself, with no header: equal weights go by the header's order, and a range weighted `q=0`, `*`, or a malformed range picks nothing. Its subject, text, and HTML are in that language, the HTML marked with it; counts take the language's plural forms. Supported: English and Polish. `apps/server/mail/sign-in-code.test.ts`, `apps/server/auth/auth.test.ts`, `packages/auth-client/sign-in.test.tsx` (the header)

## Boundaries

- **Not here:** course content and the language it is authored or generated in ([generation](generation.md)); the browser's own validation messages, such as for a required field left empty, which Braivo does not control. Sign-in and the learn flow keep their rules in [access](access.md) and the [learner loop](learner-loop.md), which point here for language and never restate it.
- **Not yet:** the console past its sign-in pages, beyond its header (a shared component it shows, such as a source passage's page, already follows the language); an organization's language; a language menu in the learn app, which follows the browser, as a choice made on the console's `/login` is another host's.

## Decisions

- [ADR 0035](../adr/0035-lingui-localization.md): Lingui, the language chosen at start from a menu's stored choice, else the browser's, complete catalogs, failures worded from what the server answers, never its prose, the mail's language from its request.

## Gaps

| Gap                                                                                        | Impact                                                                | Next step                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The Polish has not been read by a native speaker.                                          | Wording may be stilted, or wrong.                                     | A Polish speaker reads the catalog and the mail before a pilot.      |
| An organization cannot have its learners see its language whatever their browser asks for. | A Polish school's learner whose browser prefers English sees English. | Decide when a school asks: the organization's language chosen first. |

## Entry points

`packages/i18n/index.tsx` (choosing and activating the language), `apps/console/components/language-menu.tsx` (the menu), `packages/i18n/locales.ts` (the languages, shared with the server), `packages/i18n/boot.ts` (the loading message, before the app starts), `apps/server/mail/sign-in-code.ts` (the mail's language and its words), `lingui.config.ts` (where copy is extracted from, into `packages/i18n/locales/`), `packages/auth-client/sign-in.tsx` (refusals worded from code or status), `apps/learn/routes/_signed-in/courses/$courseId.tsx` (counts and times).
