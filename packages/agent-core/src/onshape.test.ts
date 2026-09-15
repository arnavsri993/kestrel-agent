import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import { OnshapeClient, installOnshapeTools, parseOnshapeDocument } from "./onshape";

const url = "https://cad.onshape.com/documents/aaaaaaaaaaaaaaaaaaaaaaaa/w/bbbbbbbbbbbbbbbbbbbbbbbb/e/cccccccccccccccccccccccc";
it("signs only the official bounded read endpoint and retains revision context", async () => {
 let requests = 0;
 const client = new OnshapeClient({ accessKey: "fixture-access", secretKey: "fixture-secret" }, async (input, options) => {
  requests++;
  const target = new URL(String(input)); const headers = new Headers(options?.headers);
  expect(target.origin).toBe("https://cad.onshape.com"); expect(options?.redirect).toBe("error"); expect(options?.method).toBe("GET");
  const expected = createHmac("sha256", "fixture-secret").update(["GET", headers.get("On-Nonce"), headers.get("Date"), "application/json", target.pathname, "", ""].join("\n").toLowerCase()).digest("base64");
  expect(headers.get("Authorization")).toBe(`On fixture-access:HmacSHA256:${expected}`);
  return Response.json([{ id: "cccccccccccccccccccccccc", name: "Fixture part", elementType: "PARTSTUDIO", microversionId: "dddddddddddddddddddddddd" }]);
 });
 const result = await client.inspect(url);
 expect(result.elements[0]?.microversionId).toBe("dddddddddddddddddddddddd"); expect(result.editable).toBe(false);
 await expect(client.inspect(url.replace("cad.onshape.com", "attacker.example"))).rejects.toThrow("clean");
 await expect(client.inspect(`${url}?token=secret`)).rejects.toThrow("clean");
 expect(requests).toBe(1); expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

it("enforces exact document context grants before Onshape requests", async () => {
 const database = new KestrelDatabase(":memory:", createEncryptionKey()); const runtime = new AgentRuntime(database, []); let requests = 0;
 const client = new OnshapeClient({ accessKey: "fixture-access", secretKey: "fixture-secret" }, async () => { requests++; return Response.json([{ id: "cccccccccccccccccccccccc", name: "Fixture" }]); });
 installOnshapeTools(runtime, client); const parent = runtime.createSession({ title: "CAD fixture", kind: "agent", allowedTools: ["onshape.inspect"] });
 try {
  await expect(runtime.callTool(parent.id, "onshape.inspect", { documentUrl: url })).rejects.toThrow("not granted");
  runtime.setResourceGrants(parent.id, [{ connectionId: client.connectionId, resourceId: parseOnshapeDocument(url).resourceId, capability: "read" }]);
  expect((await runtime.callTool(parent.id, "onshape.inspect", { documentUrl: url })).status).toBe("verified");
  await expect(runtime.callTool(parent.id, "onshape.inspect", { documentUrl: url.replace("/w/", "/v/") })).rejects.toThrow("not granted");
  expect(requests).toBe(1);
 } finally { database.close(); }
});
