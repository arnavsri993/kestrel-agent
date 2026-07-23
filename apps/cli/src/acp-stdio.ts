import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createKestrelAcpAgent } from "@kestrel/agent-core";
import { openKestrel, resolveModelConfig } from "./state";

export interface AcpStdioOptions {
  model?: string;
  providers?: string[];
  workspace?: string;
}

export async function runAcpStdio(options: AcpStdioOptions = {}): Promise<void> {
  const config = resolveModelConfig(options);
  const core = openKestrel(options.workspace ? [options.workspace] : []);
  const application = createKestrelAcpAgent({ runtime: core.runtime, loop: core.agentLoop, model: config.model, providerIds: config.providers });
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const connection = application.connect(stream);
  const stop = () => connection.close(new Error("Kestrel ACP host stopped."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await connection.closed; }
  finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await core.close();
  }
}
