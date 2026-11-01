// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import * as z from "zod";

import type { Model, ModelFile } from "./model.ts";

/**
 * What Braivo tells a model for one kind of request, as data: everything but
 * what a request fills in. Its `promptVersion` names it in the ledger and in
 * the evaluation harness, so a change to any word Braivo wrote is a new
 * version, and a new audience or material is not.
 */
export type Operation = {
  system: string;
  /** The user message, its `{{name}}` placeholders filled by each request. */
  template: string;
  /** Braivo's own words a request places into the template, such as a default or a clause said only sometimes. */
  parts: Readonly<Record<string, string>>;
  /** The answer, named to the model as a tool it calls. */
  tool: { name: string; description: string };
  /** The answer's shape: the tool's input schema, and the only shape Braivo reads. */
  schema: z.ZodType;
};

/**
 * The first 12 hex digits of SHA-256 over the operation, its schema as the
 * JSON Schema sent. Keys are not sorted: the model reads a schema's fields in
 * the order sent, so reordering them is a change of prompt.
 */
export function promptVersion(operation: Operation): string {
  const { system, template, parts, tool, schema } = operation;
  const sent = JSON.stringify({ system, template, parts, tool, schema: z.toJSONSchema(schema) });
  return createHash("sha256").update(sent).digest("hex").slice(0, 12);
}

/**
 * `template` with each `{{name}}` replaced by its value, in one pass, so a
 * value — material that happens to contain `{{…}}` — is never read as one.
 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`No value for the placeholder {{${name}}}.`);
    return value;
  });
}

/** Asks `model` exactly what `operation` says, so what is sent is what is versioned. */
export function answer(
  model: Model,
  operation: Operation,
  request: { values?: Record<string, string>; files?: readonly ModelFile[]; signal?: AbortSignal },
): Promise<unknown> {
  return model.answer({
    system: operation.system,
    prompt: fill(operation.template, request.values ?? {}),
    files: request.files,
    name: operation.tool.name,
    description: operation.tool.description,
    schema: z.toJSONSchema(operation.schema),
    signal: request.signal,
  });
}
