import { z } from "zod";

export const HostCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("new-conversation") }).strict(),
  z.object({ type: z.literal("select-conversation"), id: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("send"), message: z.string().trim().min(1).max(20_000), provider: z.string().min(1).max(100), model: z.string().trim().min(1).max(200), readBrowser: z.boolean().default(false), navigateBrowser: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("resolve-approval"), runId: z.string().min(1).max(200), executionId: z.string().min(1).max(200), decision: z.enum(["approved", "rejected"]) }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("open-tab"), url: z.string().max(8_000) }).strict(),
  z.object({ type: z.literal("focus-tab"), id: z.string().regex(/^tab-[a-f0-9-]{36}$/) }).strict(),
  z.object({ type: z.literal("close-tab"), id: z.string().regex(/^tab-[a-f0-9-]{36}$/) }).strict(),
]);

export function assertTrustedShell(source: { samePage: boolean; mainFrame: boolean; url: string }, shellUrl: string): void {
  if (!source.samePage || !source.mainFrame || source.url !== shellUrl) {
    throw new Error("Only the local Kestrel shell can access the host bridge.");
  }
}

export function browserUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter an http or https URL without embedded credentials.");
  }
  return url.href;
}
