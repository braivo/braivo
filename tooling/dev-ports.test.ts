// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_PORTS, demoPorts, readDevPorts, worktreePorts } from "./dev-ports.ts";

describe("dev ports", () => {
  test("are the main checkout's when nothing is set, or set blank", () => {
    expect(readDevPorts({})).toEqual({ server: 3000, learn: 5173, console: 5174 });
    expect(readDevPorts({ PORT: " ", BRAIVO_LEARN_PORT: "", BRAIVO_URL: "" })).toEqual(
      DEFAULT_PORTS,
    );
  });

  test("come from the variables the servers read, the console's from BRAIVO_URL", () => {
    expect(
      readDevPorts({
        PORT: "3020",
        BRAIVO_LEARN_PORT: "5193",
        BRAIVO_URL: "http://localhost:5194",
      }),
    ).toEqual({ server: 3020, learn: 5193, console: 5194 });
  });

  test("leave the console on its default when BRAIVO_URL names no port, as a tunnel's", () => {
    expect(readDevPorts({ BRAIVO_URL: "https://dev.example.com" }).console).toBe(5174);
  });

  test.each(["0", "65536", "3000.5", "abc"])("refuse PORT=%s", (value) => {
    expect(() => readDevPorts({ PORT: value })).toThrow(`PORT must be between 1 and 65535`);
  });

  test("refuse a console port BRAIVO_URL names but no server can listen on", () => {
    expect(() => readDevPorts({ BRAIVO_URL: "http://localhost:0" })).toThrow(
      `BRAIVO_URL's port must be between 1 and 65535, got "0"`,
    );
  });

  test("are 20 apart per worktree, the main checkout's first", () => {
    expect(worktreePorts(0)).toEqual(DEFAULT_PORTS);
    expect(worktreePorts(2)).toEqual({ server: 3040, learn: 5213, console: 5214 });
  });

  test("put a demo 10 above, between one worktree's and the next's", () => {
    expect(demoPorts(DEFAULT_PORTS)).toEqual({ server: 3010, learn: 5183, console: 5184 });
  });
});
