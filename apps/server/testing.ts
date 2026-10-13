// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support for suites outside this app that drive a real server, as
// `@braivo/server/testing`: the CLI's and MCP's. Nothing here is part of the
// server's behaviour.

export { signInWithCode } from "./auth/testing.ts";
export { createTestApi } from "./api/testing.ts";
export {
  createCourse,
  createObjectives,
  readCourseObjectives,
  readSource,
  recordEvidence,
} from "./persistence/index.ts";
