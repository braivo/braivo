# Conventions in the apps

How `apps/console` and `apps/learn` build a page, beyond what their specs require. Follow them in a new page; change one here when a page needs otherwise.

## A page

- **Router options** go in each app's `router.tsx` (`createConsoleRouter`, `createLearnRouter`), which `main.tsx` and `routes.test.tsx` share, so tests run with production options. `Register` lives there too.
- **Tab title:** `head: (head) => pageHead(head, …)` from the app's `lib/title.ts`, page first: `<page> · <organization>`. The console names a learner `<learner> · <course>` and a source `<source> · Source`; learn titles only the course page (white-label-6).
- **Way back:** a page below a list names its parent as a small link above its heading, styled as on learn's course page and the console's learner report. The console header's breadcrumb stays `Organizations / <organization>`.
- **A course in the console** is checked to belong to the organization before anything about it is read: `readCourse` through the organization, or `readCourseInOrganization` when the page needs no authored course. Await it before the scoped reads (progress-9).
- **Console refusals** are in `apps/console/lib/refusals.ts` (`orNotFound`, `readCourseInOrganization`, `explainAiProxyTimeout`): reuse them.

## Failure and pending

- **A failed load:** the router's default `PageError` replaces only the failed page, focused, with Try again; a route's own `errorComponent` wins. Not-found messages are per route (`notFoundComponent`).
- **A failed action** keeps the page. Lock a control that may hold focus with `aria-disabled` and an early return while pending, `onClick={() => !pending && act()}`, rather than `disabled`, which drops its focus; a form's submit handler returns while pending too, since only a natively disabled button blocks Enter's implicit submission. Say what failed as `role="alert"`: "Could not <verb>. Try again." when retrying unchanged can work, clicking again to retry; otherwise the refusal's own way forward, such as reloading the course after a conflict, or `explainAiProxyTimeout`'s warning that a retry spends another AI request. In a header, the message goes on its own line under the row, never inside it, where at 320px it pushes the row's controls off screen.
- **A retry that can fail the same way twice** mounts a new `role="alert"` each time (a key counting failures), or a screen reader announces nothing new; the retry button keeps its node and focus.
- **Focus moved to a newly shown element** is set in `useLayoutEffect`, before paint: a passive effect can run after a test or assistive technology already sees the element unfocused.

## Text

- **A field that must not be blank:** `required` passes spaces. In the submit handler, `input.setCustomValidity("Enter your <thing>.")`, `reportValidity()`, and return; clear it in `onChange`. Not as typed: a value the browser restores fires no event.
- **An HTML `pattern`** compiles with the `v` flag: escape a literal `-` in a character class or keep it outside, or browsers ignore the whole pattern; a range such as `[0-9]` stays as it is.
- **Long words** (an email, a hostname, a link, a German compound): `wrap-break-word` on block text; `wrap-anywhere` on a flex or grid item or in a centred box, whose width the longest word sets, and on a button's label with `h-auto min-h-9 py-1.5 whitespace-normal`. Put it on the text, not a container whose short labels would inherit it; a label beside wrapping text gets `shrink-0`. `Heading` wraps already. Never truncate an identity. Test with an unhyphenated word: a hyphen hides the bug.

## TanStack Router (v1.170)

Observed behaviour, not documented contracts: recheck each after upgrading.

- A match gets an error boundary only if its route has an error component, its own or `defaultErrorComponent`; an error replaces that route's whole component, layout included. `notFound()` passes through error boundaries.
- An unmatched path renders the nearest matched ancestor's `notFoundComponent` with props `{}` (not the documented `isNotFound` and `routeId`), and that match's status stays `success`; a route's own `notFound()` sets `notFound`.
- The deepest `title` wins; `{ title: undefined }` emits an empty `<meta>`, so return `meta: []`. A reload ending in not-found keeps the old `loaderData`, hence `status === "success"` checks.
- `beforeLoad`s run before loaders, which orders mock calls in route tests.

## Testing a page

- An app's page is proved in its `routes.test.tsx`, a `packages/ui` composition's contract in `packages/ui/ui.test.tsx`. Grep for an existing test of the behaviour first: one pinning the old behaviour fails only in the full suite.
- Test the observable behaviour each guard enforces. Name each element a list assertion expects: `getAllByRole` still passes with one gone. When a behaviour applies to every repeat, include enough repeats that an implementation handling only the first fails.
- To look at a running page, agents use the Chrome DevTools MCP server in `.mcp.json`: pinned, since it runs on every contributor's machine; `--isolated`, a throwaway profile, so sessions in parallel worktrees do not fight over one; and it sends no usage statistics, nor trace URLs to CrUX.
- To look at a page without a database, run the app with `PORT=1 bunx vp dev --port <free port> --strictPort`, its `/api` proxied to a port nothing listens on, and answer its API in a browser script (Playwright) with `page.route((url) => url.pathname.startsWith("/api/"), …)`; the glob `**/api/**` also catches Vite's `/@fs/…/apps/server/api/client.ts` and blanks the page.
