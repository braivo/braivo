// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A language model as Braivo asks one: instructions, the material, and the
 * JSON shape its answer must take. One operation, so a provider is one small
 * adapter (docs/adr/0029-server-drafting.md). What it answers is unchecked:
 * whoever asks validates it.
 */
export type Model = {
  answer(request: {
    system: string;
    prompt: string;
    /** Documents or images the prompt is about, read by the model before it. */
    files?: readonly ModelFile[];
    /** Names the answer to the model, as a tool it calls. */
    name: string;
    description: string;
    /** JSON Schema the answer is asked to follow. */
    schema: Record<string, unknown>;
    /** Aborts the request: whoever asked has gone, and its answer would be paid for unread. */
    signal?: AbortSignal;
  }): Promise<unknown>;
};

/** A file a model reads: a PDF, or an image in a format models take. */
export type ModelFile = { mediaType: string; bytes: Uint8Array };

/** The model did not answer usably: unreachable, refused, or cut short. Nothing was stored. */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

/** Longer than drafting a course from a textbook chapter takes, and no longer. */
const TIMEOUT_MS = 300_000;

/** Room for a course's worth of objectives and tasks as JSON. */
const MAX_TOKENS = 32_000;

/**
 * Anthropic's Messages API, over `fetch`: the answer is forced as a call to a
 * tool whose input schema is the shape asked for, which is how the API
 * returns structured output.
 */
export function anthropicModel(options: {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): Model {
  const send = options.fetch ?? globalThis.fetch;

  return {
    async answer({ system, prompt, files = [], name, description, schema, signal }) {
      // The dialect marker is JSON Schema's, not a property the API reads.
      const inputSchema = { ...schema };
      delete inputSchema.$schema;
      let response: Response;
      try {
        response = await send("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: MAX_TOKENS,
            system,
            messages: [
              {
                role: "user",
                content: [...files.map(fileBlock), { type: "text", text: prompt }],
              },
            ],
            tools: [{ name, description, input_schema: inputSchema }],
            tool_choice: { type: "tool", name },
          }),
          signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
        });
      } catch (error) {
        throw new ModelUnavailable(`The model could not be reached: ${String(error)}`);
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelUnavailable(`The model answered ${response.status}.`);
      }
      // Its fields read as unknown: any answer but the expected one is the model failing (generation-12),
      // never a TypeError that would surface as a bare 500.
      const message = ((await response.json().catch(() => null)) ?? {}) as {
        stop_reason?: unknown;
        content?: unknown;
      };
      if (message.stop_reason === "max_tokens") {
        throw new ModelUnavailable(
          "The model's answer was cut short; send less at once — a chapter, not a book.",
        );
      }
      const blocks: unknown[] = Array.isArray(message.content) ? message.content : [];
      const call = blocks.find(
        (block): block is { input?: unknown } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          block.name === name,
      );
      if (!call) throw new ModelUnavailable("The model answered without the shape asked for.");
      return call.input;
    },
  };
}

/** A PDF as a document, anything else as an image: the two kinds the API reads. */
function fileBlock({ mediaType, bytes }: ModelFile) {
  const source = {
    type: "base64",
    media_type: mediaType,
    data: Buffer.from(bytes).toString("base64"),
  };
  return mediaType === "application/pdf" ? { type: "document", source } : { type: "image", source };
}
