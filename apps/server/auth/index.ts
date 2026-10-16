// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Identity, sessions, and organization membership. `application` never imports
// this module: identity is resolved at the edge and passed in as user IDs.
// See docs/adr/0006-better-auth.md.

export type { Auth } from "./auth.ts";
export { AUTHOR_SCOPE, createAuth, ORGANIZATION_CLAIM, SIGN_IN_CODE } from "./auth.ts";
export type { ClientMetadataFetch } from "./client-metadata.ts";
export { addMember, createOrganization, createOwnedOrganization } from "./organization.ts";
export { registerOAuthClient, removeOAuthClient } from "./oauth-client.ts";
export {
  generateReviewerPassword,
  removeReviewerPassword,
  setReviewerPassword,
} from "./reviewer.ts";
export { isOrganizationOrigin } from "./origin.ts";
