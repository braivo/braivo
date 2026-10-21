// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LookupAddress } from "node:dns";
import { createServer, request } from "node:http";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  aliasGoogleJwks,
  type ClientMetadataFetch,
  fetchPinned,
  fetchStrictlyPublic,
  pinnedLookup,
} from "./client-metadata.ts";

// DNS and HTTPS are mocked: what a host resolves to, what the transport asked
// `node:https` for, and how many times, and the answer, if any (none is a
// connection error). Only the fallback test opens sockets, on loopback.
const dns = vi.hoisted(() => ({
  answer: Promise.resolve([] as LookupAddress[]),
  lookups: 0,
}));
const https = vi.hoisted(() => ({
  asked: undefined as RequestOptions | undefined,
  requests: 0,
  answer: undefined as { status: number; headers?: Record<string, string> } | undefined,
  response: undefined as Readable | undefined,
}));
vi.mock("node:dns/promises", () => ({
  lookup: () => {
    dns.lookups++;
    return dns.answer;
  },
}));
vi.mock("node:https", async () => {
  const { Readable } = await import("node:stream");
  return {
    request: (_url: URL, options: RequestOptions, respond: (response: unknown) => void) => {
      https.asked = options;
      https.requests++;
      const { answer } = https;
      const connection = {
        once: (_event: "error", fail: (error: Error) => void) => {
          if (!answer) queueMicrotask(() => fail(new Error("not connected in tests")));
          return connection;
        },
        end: () => {
          if (answer) {
            const response = { statusCode: answer.status, headers: answer.headers ?? {} };
            https.response = Object.assign(Readable.from([]), response);
            queueMicrotask(() => respond(https.response));
          }
          return connection;
        },
      };
      return connection;
    },
  };
});

afterEach(() => {
  dns.answer = Promise.resolve([]);
  dns.lookups = 0;
  Object.assign(https, { asked: undefined, requests: 0, answer: undefined, response: undefined });
});

const resolvesTo = (...addresses: string[]) => {
  dns.answer = Promise.resolve(
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
};

/** Asks a server listening on IPv4 alone, through a lookup answering `addresses`. */
async function statusThrough(addresses: LookupAddress[]) {
  const server = createServer((_, response) => response.end("{}"));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number | string>((answered) => {
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        agent: false,
        autoSelectFamily: true,
        lookup: pinnedLookup(addresses),
        signal: AbortSignal.timeout(5_000),
      };
      request(`http://client.example:${port}/`, options)
        .once("response", (response) => answered(response.resume().statusCode!))
        .once("error", (error: NodeJS.ErrnoException) => answered(error.code ?? error.message))
        .end();
    });
  } finally {
    server.close();
  }
}

describe("a client's metadata", () => {
  test("is reached on another address the host resolved to when the first refuses", async () => {
    // Bun resolves IPv6 first; a machine with no IPv6 route then refused Claude.
    const addresses = [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ];
    expect(await statusThrough(addresses)).toBe(200);
    // Pinned to the first alone, as Better Auth's transport is, it is not:
    // refused, or unreachable where IPv6 is off.
    expect(await statusThrough(addresses.slice(0, 1))).toEqual(expect.stringMatching(/^E[A-Z]+$/));
  });

  test("is fetched from the addresses checked, resolved once, as its own host", async () => {
    resolvesTo("2606:4700:4700::1111", "1.1.1.1");
    const asked = fetchPinned("https://client.example/client.json", {
      headers: { host: "elsewhere.example" },
    });
    await expect(asked).rejects.toThrow("not connected in tests");
    expect(dns.lookups).toBe(1);
    expect(https.asked).toMatchObject({
      autoSelectFamily: true,
      headers: { host: "client.example" },
      servername: "client.example",
    });
    const offered = await new Promise((answer) =>
      https.asked!.lookup!("client.example", { all: true }, (_, addresses) => answer(addresses)),
    );
    expect(offered).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  test.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.1"],
    ["link-local, cloud metadata", "169.254.169.254"],
    ["shared address space", "100.100.100.200"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique local", "fc00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
  ])(
    "is refused when its host resolves to a %s address, beside a public one",
    async (_, address) => {
      // Every address is a fallback the connection may take, so each is checked.
      resolvesTo("1.1.1.1", address);
      await expect(fetchPinned("https://client.example/client.json")).rejects.toThrow(
        "public addresses only",
      );
      expect(https.asked).toBeUndefined();
    },
  );

  test("is refused over HTTP", async () => {
    await expect(fetchPinned("http://client.example/client.json")).rejects.toThrow("over HTTPS");
  });

  test("stops waiting for its host to resolve when the request is aborted", async () => {
    dns.answer = new Promise(() => {});
    const aborting = new AbortController();
    const asked = fetchPinned(
      new Request("https://client.example/client.json", { signal: aborting.signal }),
    );
    aborting.abort(new Error("the caller gave up"));
    await expect(asked).rejects.toThrow("the caller gave up");
  });

  test("stops waiting for its host to resolve after ten seconds", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      dns.answer = new Promise(() => {});
      const asked = fetchPinned("https://client.example/client.json");
      expect(timeout).toHaveBeenCalledWith(10_000);
      deadline.abort(new Error("ten seconds passed"));
      await expect(asked).rejects.toThrow("ten seconds passed");
    } finally {
      timeout.mockRestore();
    }
  });

  test("is refused at once for a request already aborted, its host never resolved", async () => {
    const asked = fetchPinned(
      new Request("https://client.example/client.json", { signal: AbortSignal.abort() }),
    );
    await expect(asked).rejects.toThrow(/abort/i);
    expect(dns.lookups).toBe(0);
  });

  test("handles its lookup failing after the request was aborted", async () => {
    let fail!: (error: Error) => void;
    dns.answer = new Promise((_, reject) => (fail = reject));
    const aborting = new AbortController();
    const asked = fetchPinned(
      new Request("https://client.example/client.json", { signal: aborting.signal }),
    );
    aborting.abort(new Error("the caller gave up"));
    await expect(asked).rejects.toThrow("the caller gave up");
    fail(new Error("the host is unknown")); // unhandled, it would fail the run
  });

  test("answers a redirect as it is, never following it", async () => {
    resolvesTo("1.1.1.1");
    https.answer = { status: 302, headers: { location: "http://127.0.0.1/" } };
    const answer = await fetchPinned("https://client.example/client.json");
    expect([answer.status, answer.headers.get("location"), https.requests]).toEqual([
      302,
      "http://127.0.0.1/",
      1,
    ]);
  });

  test("is refused, not thrown at the server, when its server answers a status no Response takes", async () => {
    resolvesTo("1.1.1.1");
    https.answer = { status: 600 };
    await expect(fetchPinned("https://client.example/client.json")).rejects.toThrow(RangeError);
    expect(https.response?.destroyed).toBe(true);
  });
});

describe("a client's metadata on a Worker", () => {
  const strictlyPublicWorker = { compatibilityFlags: { global_fetch_strictly_public: true } };

  /** The global `fetch` answering `answer`, keeping what it was asked, beside `Cloudflare`. */
  const stubFetch = (cloudflare: unknown, answer = () => new Response("{}")) => {
    vi.stubGlobal("Cloudflare", cloudflare);
    const fetched: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetched.push(input as Request);
      return answer();
    });
    return fetched;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("is fetched through the runtime, as asked but for redirects, which are returned", async () => {
    // Better Auth asks for `error`, which Workers refuse, and refuses a 3xx itself.
    const fetched = stubFetch(strictlyPublicWorker, () =>
      Response.redirect("https://elsewhere.example/", 302),
    );
    const aborting = new AbortController();

    const answer = await fetchStrictlyPublic("https://client.example/client.json", {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: aborting.signal,
    });
    aborting.abort();

    const [asked] = fetched;
    expect([fetched.length, asked!.url, asked!.redirect, asked!.headers.get("accept")]).toEqual([
      1,
      "https://client.example/client.json",
      "manual",
      "application/json",
    ]);
    expect(asked!.signal.aborted).toBe(true);
    expect([answer.status, answer.headers.get("location")]).toEqual([
      302,
      "https://elsewhere.example/",
    ]);
  });

  test.each([
    ["http://client.example/client.json", "over HTTPS"],
    ["https://127.0.0.1/client.json", "must be public"],
    ["https://[::1]/client.json", "must be public"],
    ["https://localhost/client.json", "must be public"],
  ])("is refused at %s, nothing fetched", async (url, refusal) => {
    const fetched = stubFetch(strictlyPublicWorker);

    await expect(fetchStrictlyPublic(url)).rejects.toThrow(refusal);
    expect(fetched).toEqual([]);
  });

  test.each([
    ["a Worker without global_fetch_strictly_public", { compatibilityFlags: {} }],
    ["a Worker telling no flags", {}],
    ["anything but a Worker", undefined],
  ])("is never fetched on %s", async (_, cloudflare) => {
    const fetched = stubFetch(cloudflare);

    await expect(fetchStrictlyPublic("https://client.example/client.json")).rejects.toThrow(
      "global_fetch_strictly_public",
    );
    expect(fetched).toEqual([]);
  });

  test("is only read", async () => {
    const fetched = stubFetch(strictlyPublicWorker);

    await expect(
      fetchStrictlyPublic("https://client.example/client.json", { method: "POST" }),
    ).rejects.toThrow("only read");
    expect(fetched).toEqual([]);
  });
});

describe("Google's keys on another origin", () => {
  const document = "https://accountlinking.google.com/client.json";
  const gstatic =
    "https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json";
  const alias = "https://accountlinking.google.com/.well-known/braivo-cross-origin-jwks";

  /** `aliasGoogleJwks` over a fetch answering `answer`, keeping what it was asked. */
  const aliased = (answer: (url: string) => Response) => {
    const asked: Parameters<ClientMetadataFetch>[] = [];
    const fetch = aliasGoogleJwks(async (input, init) => {
      asked.push([input, init]);
      return answer(input instanceof Request ? input.url : String(input));
    });
    return { fetch, asked };
  };

  test("are named to Better Auth on the document's origin, fetched from their own", async () => {
    const { fetch, asked } = aliased((url) =>
      url === document
        ? Response.json(
            { client_id: document, jwks_uri: gstatic },
            { headers: { etag: '"1"', "content-length": "999" } },
          )
        : Response.json({ keys: [] }),
    );
    const init = { headers: { accept: "application/json" }, signal: new AbortController().signal };

    const answer = await fetch(document, init);
    expect([answer.headers.get("etag"), answer.headers.get("content-length")]).toEqual([
      '"1"',
      null,
    ]);
    expect(await answer.json()).toEqual({ client_id: document, jwks_uri: alias });
    expect(await (await fetch(alias, init)).json()).toEqual({ keys: [] });
    expect(asked).toEqual([
      [document, init],
      [gstatic, init],
    ]);

    // Asked as a request, the keys are asked for as one too.
    const aborting = new AbortController();
    await fetch(
      new Request(alias, { headers: { accept: "application/json" }, signal: aborting.signal }),
    );
    aborting.abort();
    const forwarded = asked[2]![0] as Request;
    expect([forwarded.url, forwarded.headers.get("accept"), forwarded.signal.aborted]).toEqual([
      gstatic,
      "application/json",
      true,
    ]);
  });

  test.each([
    ["another client's document", "https://client.example/client.json", { jwks_uri: gstatic }],
    ["one naming other keys", document, { jwks_uri: "https://www.gstatic.com/other.json" }],
  ])("are left as they are in %s", async (_, url, named) => {
    const { fetch } = aliased(() => Response.json({ client_id: url, ...named }));

    expect(await (await fetch(url)).json()).toEqual({ client_id: url, ...named });
  });

  test("are left named in a document over Better Auth's 5 KiB, for it to refuse", async () => {
    // Whitespace that rewriting would drop, bringing it under the limit.
    const padded = `{"client_id":"${document}",${" ".repeat(6 * 1024)}"jwks_uri":"${gstatic}"}`;
    const { fetch } = aliased(
      () => new Response(padded, { headers: { "content-type": "application/json" } }),
    );

    expect(await (await fetch(document)).text()).toBe(padded);
  });

  test("are not aliased in a redirect or a refusal, which pass as they came", async () => {
    const redirected = Response.json({ client_id: document, jwks_uri: gstatic });
    Object.defineProperty(redirected, "redirected", { value: true });
    expect(await aliased(() => redirected).fetch(document)).toBe(redirected);

    const refused = new Response("not JSON", { status: 404 });
    expect(await aliased(() => refused).fetch(document)).toBe(refused);
  });

  test("are aliased leaving keys on the document's own origin whole, up to Better Auth's 64 KiB", async () => {
    const keysUri = "https://accountlinking.google.com/keys.json";
    const keys = { keys: [{ kty: "RSA", n: "x".repeat(32 * 1024), e: "AQAB" }] };
    expect(await (await aliased(() => Response.json(keys)).fetch(keysUri)).json()).toEqual(keys);

    const large = aliased(() => Response.json({ keys: [{ n: "x".repeat(64 * 1024) }] }));
    await expect(large.fetch(keysUri)).rejects.toThrow("too large");
  });
});
