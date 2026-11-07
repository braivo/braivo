// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Client } from "pg";

export type ScratchDatabase = { target: string; name: string; url: string };

/** A database beside `target`'s, named so it can only be this script's. */
export async function createScratchDatabase(target: string): Promise<ScratchDatabase> {
  const name = `braivo_screenshots_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const client = new Client({ connectionString: target });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  const url = new URL(target);
  url.pathname = `/${name}`;
  return { target, name, url: url.href };
}

export async function dropScratchDatabase({ target, name }: ScratchDatabase): Promise<void> {
  const client = new Client({ connectionString: target });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
