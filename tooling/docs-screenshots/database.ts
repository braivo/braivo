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

/**
 * Gives the course titled `title` the number `number`, as the database would
 * have picked one at random (ADR 0044): the address in a picture stays the same
 * from run to run. The scratch database is this script's own fixture.
 */
export async function numberCourse(
  { url }: ScratchDatabase,
  title: string,
  number: number,
): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rowCount } = await client.query("UPDATE course SET number = $1 WHERE title = $2", [
      number,
      title,
    ]);
    if (rowCount !== 1) throw new Error(`Expected one course titled ${title}, found ${rowCount}.`);
  } finally {
    await client.end();
  }
}
