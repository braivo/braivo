// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The email Braivo sends, and the transports it leaves by.

export { signInCodeMail } from "./sign-in-code.ts";
export { logMail, type Mail, type SendMail, smtpMail } from "./transport.ts";
