// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from "node:net";

import { afterEach, expect, test, vi } from "vite-plus/test";

import { createDatabase } from "./database.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("survives losing an idle connection, which no query is there to hear", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const database = createDatabase("postgres://localhost/unused");

  // What pg emits when PostgreSQL drops a connection the pool holds idle.
  expect(() => database.$client.emit("error", new Error("terminating connection"))).not.toThrow();
  expect(logged).toHaveBeenCalledWith("A database connection was lost:", "terminating connection");

  await database.$client.end();
  logged.mockClear();
  // Workers report the pool closing its own connections the same way.
  database.$client.emit("error", new Error("Stream was cancelled."));
  expect(logged).not.toHaveBeenCalled();
});

test("gives up on a server that accepts the connection and never answers", async () => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as { port: number };
  const database = createDatabase(`postgres://braivo@127.0.0.1:${port}/none`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  const query = database.$client.query("select 1");
  const refused = expect(query).rejects.toThrow(/timeout/);
  await vi.advanceTimersByTimeAsync(30_000);
  await refused;

  vi.useRealTimers();
  await database.$client.end();
  silent.close();
});
