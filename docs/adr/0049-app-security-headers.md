# 0049: Each app ships its security policy as `_headers`, and runs no inline script

Status: accepted (2026-10-28)

## Context

Neither app sent a Content-Security-Policy, so any site could frame the console's handoff, whose "Continue" click is exactly what framing hijacks (access-14), or a learn domain's sign-in. The server serves no app ([ADR 0004](0004-one-application-origin.md)): a static host or proxy does, Cloudflare's static assets on Braivo Cloud and whatever a self-hoster chooses. Both `index.html` files ran inline scripts before the first paint and the first render: the console's icons and theme, and the boot message's language from `@braivo/i18n/boot`.

## Decision

**Each app's `public/_headers` is its policy**, in the format Cloudflare's static assets read, which Vite copies into `dist/`: `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`, with `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. Braivo Cloud applies it with no change of its own; a self-hoster's host sends the same headers ([deployment guide](../guides/deployment.md)). HSTS stays the proxy's.

**No inline script.** What must run before the first paint is a blocking classic script from the app's origin: the console's `public/head.js` in `<head>`, and the file `bootLanguage()` emits under a name from its content, also in `<head>`. Blocking, nothing paints before they ran, so a dark page never flashes light and the loading message is shown in the visitor's language however slowly the script arrives; while it has not, the page stays blank, and if it fails, the message is English. The message's words are in the HTML in every language for that reason: a script at the end of `<body>` rewriting them lets the browser paint them first. `tooling/app-headers.test.ts` fails on an inline script in either `index.html` or on losing `frame-ancestors 'none'` or `script-src 'self'`.

**Two exceptions, low risk.** `style-src 'unsafe-inline'`, as Radix positions popovers through `style` attributes, and `bootLanguage()`'s `<style>` shows the loading message's copy in the page's language; `img-src` and `font-src` allow `data:`, as Vite inlines an asset under 4 KB, Manrope's Cyrillic-ext subset among them. Neither runs script, and `img-src` and `connect-src` keep the requests an injected style could make on the app's origin, so it cannot send what its selectors read to another site.

## Alternatives rejected

- **Hashes of the inline scripts.** Each edit, and every change to the boot copy, changes a hash the policy must restate.
- **`script-src 'unsafe-inline'`.** It gives up what the policy is for: an injected script would run.
- **Nonces.** They need a server rendering each page; the apps are static files.
- **The server sending the headers.** It serves the API, not the apps; a header there would not reach the pages.
- **Not inlining fonts** (`build.assetsInlineLimit`), keeping `font-src 'self'`. A setting each app must remember for a risk a font does not carry.
