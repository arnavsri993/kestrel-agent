import { createHash, createHmac, randomBytes } from "node:crypto";
import { readBoundedResponseBytes } from "./bounded-http";
import type { AgentRuntime } from "./runtime";

// Document and authentication paths follow Onshape's public v10 API docs:
// https://onshape-public.github.io/docs/api-adv/documents/
// https://onshape-public.github.io/docs/auth/apikeys/
export function parseOnshapeDocument(value: string) {
 const url = new URL(value);
 if (url.origin !== "https://cad.onshape.com" || url.username || url.password || url.search || url.hash) throw new Error("Use a clean cad.onshape.com document URL without query parameters.");
 const match = /^\/documents\/([a-f0-9]{24})\/([wvm])\/([a-f0-9]{24})(?:\/e\/([a-f0-9]{24}))?\/?$/.exec(url.pathname);
 if (!match) throw new Error("Select a document workspace, version, or microversion URL.");
 const documentId = match[1]!; const contextType = match[2]!; const contextId = match[3]!;
 return { documentId, contextType, contextId, elementId: match[4], resourceId: `document:${documentId}:${contextType}:${contextId}` };
}

export class OnshapeClient {
 readonly connectionId: string;
 constructor(private readonly credentials: { accessKey: string; secretKey: string }, private readonly fetcher = fetch) {
  this.connectionId = `onshape:${createHash("sha256").update(credentials.accessKey).digest("hex").slice(0, 24)}`;
 }
 async inspect(documentUrl: string, signal?: AbortSignal) {
  const context = parseOnshapeDocument(documentUrl);
  const path = `/api/v10/documents/d/${context.documentId}/${context.contextType}/${context.contextId}/elements`;
  const nonce = randomBytes(18).toString("hex"); const date = new Date().toUTCString(); const contentType = "application/json";
  const signature = createHmac("sha256", this.credentials.secretKey).update(["GET", nonce, date, contentType, path, "", ""].join("\n").toLowerCase()).digest("base64");
  const response = await this.fetcher(`https://cad.onshape.com${path}`, { method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), headers: { Accept: "application/json", "Content-Type": contentType, "On-Nonce": nonce, Date: date, Authorization: `On ${this.credentials.accessKey}:HmacSHA256:${signature}` } });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Onshape authentication or document permission failed. Check the protected keys and selected document." : `Onshape read failed (HTTP ${response.status}).`);
  const bytes = await readBoundedResponseBytes(response, 1_000_000, "Onshape document listing exceeds the 1 MB read limit.");
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("Unsupported or oversized Onshape element listing.");
  const elements = raw.filter(item => item && typeof item === "object").map(item => ({ id: String(item.id ?? ""), name: String(item.name ?? "").slice(0, 2000), elementType: String(item.elementType ?? ""), microversionId: typeof item.microversionId === "string" ? item.microversionId : undefined }));
  if (context.elementId && !elements.some(item => item.id === context.elementId)) throw new Error("The selected element is unavailable in this document context.");
  return { ...context, elements, observedAt: new Date().toISOString(), snapshotHash: createHash("sha256").update(bytes).digest("hex"), coverage: "element metadata only", trust: "untrusted_external_content", editable: false };
 }
}

export function installOnshapeTools(runtime: AgentRuntime, client?: OnshapeClient) {
 runtime.registerExternalTool({ descriptor: { name: "onshape.inspect", title: "Inspect assigned Onshape document", description: "Read element metadata from an explicitly granted Onshape document context. Does not inspect full geometry, modify CAD, or verify physical fit.", category: "connector", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "connector", tags: ["cad", "onshape"] },
  inputSchema: { type: "object", properties: { documentUrl: { type: "string", maxLength: 1000 } }, required: ["documentUrl"], additionalProperties: false },
  resourceAccess: input => { if (!client) throw new Error("Onshape is not configured. Save its keys in Connections."); return [{ connectionId: client.connectionId, resourceId: parseOnshapeDocument(String(input.documentUrl)).resourceId, capability: "read" }]; },
  execute: ({ signal }, input) => { if (!client) throw new Error("Onshape is not configured."); return client.inspect(String(input.documentUrl), signal); },
 });
}
