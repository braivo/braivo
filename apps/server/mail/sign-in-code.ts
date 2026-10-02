// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Mail } from "./index.ts";

/**
 * The message carrying a sign-in code. Plain strings rather than a template
 * engine: one short message, and its only variable is digits Better Auth
 * generated, so nothing needs escaping. The HTML is one centered column of
 * inline styles, which every mail client renders; the text says the same.
 */
export function signInCodeMail(input: { to: string; code: string; minutes: number }): Mail {
  const { to, code, minutes } = input;
  const expiry = `It works once, for ${minutes} minutes.`;
  const ignore = "If you did not ask for it, ignore this email: nothing happens without the code.";
  return {
    to,
    subject: `${code} is your sign-in code`,
    text: `Enter ${code} to sign in. ${expiry}\n\n${ignore}`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#32325d">
    <div style="max-width:420px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;text-align:center">
      <p style="margin:0 0 16px;font-size:16px;line-height:24px">Enter this code to sign in:</p>
      <p style="margin:0 0 16px;font-size:36px;font-weight:600;letter-spacing:0.25em;font-family:Menlo,Consolas,monospace">${code}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#525f7f">${expiry}</p>
      <p style="margin:0;font-size:14px;line-height:20px;color:#8898aa">${ignore}</p>
    </div>
  </body>
</html>`,
  };
}
