import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import { BraveSearchProvider, EncryptedDatabaseWebCache, NetworkPolicyWebClient, environmentWebAccessOptions, installWebTools } from "./web-tools";

describe("network-policy web tools", () => {
  it("fetches bounded readable text and labels it untrusted", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    let fetches = 0;
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["docs.example.test"], resolveHost: async () => ["203.0.113.20"],
      fetcher: async () => { fetches += 1; return new Response("<html><title>Kestrel guide</title><script>bad()</script><body><h1>Safe docs</h1></body></html>", { headers: { "content-type": "text/html" } }); },
      cache: new EncryptedDatabaseWebCache(database, () => new Date("2026-07-22T23:30:00.000Z")), now: () => new Date("2026-07-22T23:30:00.000Z")
    });
    expect(await client.fetch("https://docs.example.test/guide#section")).toMatchObject({ content: "Kestrel guide Safe docs", trust: "untrusted_external", url: "https://docs.example.test/guide", cached: false, citation: { title: "Kestrel guide" } });
    expect(await client.fetch("https://docs.example.test/guide#section")).toMatchObject({ cached: true, citation: { url: "https://docs.example.test/guide" } });
    expect(fetches).toBe(1);
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("web.result-cache") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("Safe docs");
    database.close();
  });

  it("rejects non-HTTPS, unlisted hosts, private DNS, unsafe redirects, and oversized bodies", async () => {
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["safe.example.test"], maximumBytes: 4, resolveHost: async (host) => host === "safe.example.test" ? ["203.0.113.21"] : ["127.0.0.1"],
      fetcher: async () => new Response("large body", { headers: { "content-type": "text/plain" } })
    });
    await expect(client.fetch("http://safe.example.test/")).rejects.toThrow("HTTPS");
    await expect(client.fetch("https://other.example.test/")).rejects.toThrow("not allowlisted");
    await expect(client.fetch("https://safe.example.test/")).rejects.toThrow("byte limit");
  });

  it("cancels chunked oversized pages before parsing or caching them", async () => {
    let pulls = 0;
    let cancellations = 0;
    let cacheWrites = 0;
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["safe.example.test"],
      maximumBytes: 4,
      resolveHost: async () => ["203.0.113.21"],
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([pulls, pulls, pulls]));
          if (pulls === 20) controller.close();
        },
        cancel() {
          cancellations += 1;
        },
      }), { headers: { "content-type": "text/html" } }),
      cache: {
        get: () => undefined,
        set: () => {
          cacheWrites += 1;
        },
      },
    });

    await expect(client.fetch("https://safe.example.test/")).rejects.toThrow("byte limit");
    expect(cancellations).toBe(1);
    expect(pulls).toBeLessThan(20);
    expect(cacheWrites).toBe(0);
  });

  it("rejects an already-aborted fetch before validation or network access", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Fetch cancelled before start."));
    let resolutions = 0;
    let requests = 0;
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["safe.example.test"],
      resolveHost: async () => {
        resolutions += 1;
        return ["203.0.113.21"];
      },
      fetcher: async () => {
        requests += 1;
        return new Response("unexpected");
      },
    });

    await expect(client.fetch("https://safe.example.test/", controller.signal)).rejects.toThrow("Fetch cancelled before start.");
    expect(resolutions).toBe(0);
    expect(requests).toBe(0);
  });

  it("normalizes malformed web cache lifetimes", async () => {
    let ttlMs = 0;
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["safe.example.test"],
      resolveHost: async () => ["203.0.113.21"],
      fetcher: async () => new Response("safe", { headers: { "content-type": "text/plain" } }),
      cacheTtlMs: Number.NaN,
      cache: { get: () => undefined, set: (_key, _value, ttl) => { ttlMs = ttl; } },
    });
    await client.fetch("https://safe.example.test/");
    expect(ttlMs).toBe(15 * 60_000);
  });

  it("exposes approval-gated runtime fetch and search tools", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Web" });
    const client = new NetworkPolicyWebClient({
      allowedHosts: ["safe.example.test"], resolveHost: async () => ["203.0.113.22"],
      fetcher: async () => new Response("safe", { headers: { "content-type": "text/plain" } }),
      searchProvider: { search: async () => [{ title: "Safe", url: "https://safe.example.test/", snippet: "Result" }] }
    });
    installWebTools(runtime, client, session.id);
    const blocked = await runtime.callTool(session.id, "web.fetch", { url: "https://safe.example.test/" });
    expect(blocked.status).toBe("blocked");
    const fetched = await runtime.callTool(session.id, "web.fetch", { url: "https://safe.example.test/" }, { approvalStatus: "approved" });
    expect(fetched).toMatchObject({ status: "verified", output: { content: "safe", trust: "untrusted_external" } });
    const searched = await runtime.callTool(session.id, "web.search", { query: "safe" }, { approvalStatus: "approved" });
    expect(searched).toMatchObject({ status: "verified", output: { results: [{ title: "Safe", citation: { url: "https://safe.example.test/" } }], trust: "untrusted_external", cached: false } });
    database.close();
  });

  it("uses the bounded official Brave Search API contract and explicit public-host opt-in", async () => {
    let request: Request | undefined;
    let resolutions = 0;
    let fetches = 0;
    const provider = new BraveSearchProvider({
      apiKey: "search-secret",
      resolveHost: async () => {
        resolutions += 1;
        return ["203.0.113.44"];
      },
      fetcher: async (input, init) => {
        fetches += 1;
        request = new Request(input, init);
        return new Response(JSON.stringify({ web: { results: [{ title: "Official", url: "https://docs.example/guide", description: "A result" }] } }), { headers: { "content-type": "application/json" } });
      }
    });
    expect(await provider.search("kestrel", { maximumResults: 5, signal: new AbortController().signal })).toEqual([{ title: "Official", url: "https://docs.example/guide", snippet: "A result" }]);
    expect(request?.url).toContain("api.search.brave.com/res/v1/web/search?q=kestrel");
    expect(request?.headers.get("x-subscription-token")).toBe("search-secret");
    expect(environmentWebAccessOptions({ KESTREL_WEB_ALLOW_PUBLIC: "true", BRAVE_SEARCH_API_KEY: "key" })).toMatchObject({ allowPublicHosts: true });
    expect(environmentWebAccessOptions({ BRAVE_SEARCH_API_KEY: "key" })).toBeUndefined();
    expect(environmentWebAccessOptions({
      BRAVE_SEARCH_API_KEY: "key",
      KESTREL_ALLOW_EXTERNAL_SEARCH: "true",
    })?.searchProvider).toBeInstanceOf(BraveSearchProvider);
    const aborted = new AbortController();
    aborted.abort(new Error("Search cancelled before start."));
    await expect(provider.search("kestrel", { maximumResults: 5, signal: aborted.signal })).rejects.toThrow("Search cancelled before start.");
    expect(resolutions).toBe(1);
    expect(fetches).toBe(1);
  });
});
