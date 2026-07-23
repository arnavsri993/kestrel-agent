import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface SandboxedCommandInput {
  command: string;
  args: string[];
  cwd: string;
  workspaceRoot: string;
  mode: "read_only" | "workspace_write" | "network_workspace_write";
  timeoutMs: number;
  environment?: Record<string, string>;
}

export interface SandboxedCommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxedCommandHandle {
  pid: number;
  completion: Promise<SandboxedCommandResult>;
  write(data: string): void;
  stop(): void;
  snapshot(): { running: boolean; stdout: string; stderr: string; durationMs: number };
}

const allowedCommands = new Set([
  "cat", "diff", "find", "git", "head", "ls", "make", "node", "npm", "npx",
  "pnpm", "pwd", "python3", "rg", "sed", "sort", "tail", "uniq", "wc"
]);

const ptyBridge = `import os,pty,select,signal,sys
pid,fd=pty.fork()
if pid==0:
 os.execv(sys.argv[1],sys.argv[1:])
def stop(sig,frame):
 try: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
signal.signal(signal.SIGTERM,stop)
inputs=[fd,0]
status=None
while status is None:
 readable,_,_=select.select(inputs,[],[],0.1)
 if fd in readable:
  try: data=os.read(fd,65536)
  except OSError: data=b''
  if data: os.write(1,data)
  else: inputs.remove(fd)
 if 0 in readable:
  data=os.read(0,65536)
  if data: os.write(fd,data)
  else: inputs.remove(0)
 done,status_value=os.waitpid(pid,os.WNOHANG)
 if done: status=status_value
 if fd not in inputs and status is None:
  done,status_value=os.waitpid(pid,0); status=status_value
sys.exit(os.waitstatus_to_exitcode(status))`;

function resolveExecutable(command: string): string {
  if (!allowedCommands.has(command)) throw new Error(`Command ${command} is not in the Workstrand executable allowlist.`);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the sanitized command allowlist.
    }
  }
  throw new Error(`Allowed command ${command} is not installed.`);
}

function quoteProfilePath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sandboxProfile(root: string, mode: SandboxedCommandInput["mode"]): string {
  const escapedRoot = quoteProfilePath(root);
  const userReadBoundary = `(deny file-read* (require-all (subpath "/Users") (require-not (subpath "${escapedRoot}"))))`;
  const ptyDevices = `(require-not (regex #"^/dev/(ttys[0-9A-Fa-f]+|(pty|tty)[pqrsPQRS][0-9A-Fa-f])$"))`;
  if (mode === "read_only") return `(version 1) (allow default) (deny network*) ${userReadBoundary} (deny file-write* (require-all (require-not (literal "/dev/null")) (require-not (literal "/dev/ptmx")) ${ptyDevices}))`;
  return `(version 1) (allow default) ${mode === "workspace_write" ? "(deny network*)" : ""} ${userReadBoundary} (deny file-write* (require-all (require-not (subpath "${escapedRoot}")) (require-not (literal "/dev/null")) (require-not (literal "/dev/ptmx")) ${ptyDevices}))`;
}

export class SandboxedCommandRunner {
  start(
    input: SandboxedCommandInput,
    options: { signal?: AbortSignal; interactive?: boolean; onProgress(payload: { stream: "stdout" | "stderr"; chunk: string }): void }
  ): SandboxedCommandHandle {
    if (process.platform !== "darwin") throw new Error("The current Workstrand command sandbox is implemented only for macOS.");
    const executable = resolveExecutable(input.command);
    const startedAt = Date.now();
    const profile = sandboxProfile(input.workspaceRoot, input.mode);
    const launch = options.interactive ? [resolveExecutable("python3"), "-u", "-c", ptyBridge, executable, ...input.args] : [executable, ...input.args];
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...launch], {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        GIT_OPTIONAL_LOCKS: "0"
        ,...(input.environment ?? {})
      },
      stdio: [options.interactive ? "pipe" : "ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let overflowed = false;
    const maximumOutputBytes = 1_000_000;
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        overflowed = true;
        child.kill("SIGTERM");
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
      options.onProgress({ stream, chunk: text });
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const abort = () => child.kill("SIGTERM");
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    let running = true;
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveCompletion({ code, signal }));
      }).then((result) => {
      running = false;
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Command execution was cancelled.");
      if (overflowed) throw new Error("Command output exceeded the 1 MB safety limit.");
      if (timedOut) throw new Error(`Command exceeded its ${input.timeoutMs} ms timeout.`);
      return {
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        exitCode: result.code ?? 128,
        signal: result.signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      };
    }).finally(() => {
      running = false;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    });
    return {
      pid: child.pid ?? 0,
      completion,
      write: (data) => {
        if (!options.interactive || !child.stdin) throw new Error("This background process was not started with interactive input.");
        if (!running || child.stdin.destroyed) throw new Error("Background process is no longer running.");
        if (Buffer.byteLength(data) > 65_536) throw new Error("Process input is limited to 64 KB per write.");
        child.stdin.write(data);
      },
      stop: () => { if (running) child.kill("SIGTERM"); },
      snapshot: () => ({ running, stdout, stderr, durationMs: Date.now() - startedAt })
    };
  }

  async run(
    input: SandboxedCommandInput,
    options: { signal: AbortSignal; onProgress(payload: { stream: "stdout" | "stderr"; chunk: string }): void }
  ): Promise<SandboxedCommandResult> {
    return this.start(input, options).completion;
  }
}
