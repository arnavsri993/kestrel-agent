import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeManager } from "../apps/desktop/src/main/local-runtime-manager";

if (process.env.KESTREL_RUN_REAL_LOCAL_AI !== "1") {
  throw new Error(
    "Set KESTREL_RUN_REAL_LOCAL_AI=1 to acknowledge the approximately 420 MB runtime and smoke-model download.",
  );
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The managed local-AI smoke test requires an Apple Silicon Mac.");
}

const root = await mkdtemp(join(tmpdir(), "kestrel-real-local-ai-"));
const seenStages = new Set<string>();
const manager = new LocalRuntimeManager(root, (progress) => {
  if (seenStages.has(progress.stage)) return;
  seenStages.add(progress.stage);
  process.stdout.write(`${progress.stage}: ${progress.message}\n`);
});

try {
  const status = await manager.bootstrap("smollm2:135m");
  if (
    !status.managedRuntime ||
    !status.ollamaAvailable ||
    status.verifiedModel !== "smollm2:135m"
  ) {
    throw new Error("Managed local AI did not reach its verified ready state.");
  }
  process.stdout.write(
    `Real managed local-AI smoke passed with Ollama ${status.runtimeVersion} and ${status.verifiedModel}.\n`,
  );
} finally {
  await manager.stop();
  await rm(root, { recursive: true, force: true });
}
