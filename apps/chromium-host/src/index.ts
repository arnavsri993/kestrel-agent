import { launchChromiumHost } from "./host";

// Only explicitly supported provider configuration crosses bootstrap IPC.
// Nothing from a desktop profile, provider login cache or Keychain is imported.
const providerKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "NOUS_API_KEY", "NOUS_BASE_URL", "NOUS_MODEL"];
const secureEnvironment = Object.fromEntries(providerKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
const host = await launchChromiumHost({
  secureEnvironment,
  model: process.env.KESTREL_CHROMIUM_MODEL ?? process.env.NOUS_MODEL ?? process.env.OPENAI_MODEL ?? "auto",
});
process.once("SIGINT", () => { void host.close(); });
process.once("SIGTERM", () => { void host.close(); });
console.log("Chromium preview is running with a temporary profile. Close its Kestrel tab to stop.");
await host.closed;
