import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

type JsonObject = Record<string, unknown>;

export interface ChatGptOAuthStatus {
  connected: boolean;
  accountType?: "chatgpt" | "apiKey";
  email?: string;
  planType?: string;
}

interface ChatGptOAuthManagerOptions {
  executable: string;
  openExternal(url: string): Promise<void>;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "CODEX_HOME",
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
  ] as const;
  const environment: NodeJS.ProcessEnv = { LOG_FORMAT: "json" };
  for (const key of allowed) if (source[key]) environment[key] = source[key];
  return environment;
}

function safeAuthUrl(raw: string): string {
  const url = new URL(raw);
  const allowedHost =
    url.hostname === "chatgpt.com" ||
    url.hostname.endsWith(".chatgpt.com") ||
    url.hostname === "openai.com" ||
    url.hostname.endsWith(".openai.com");
  if (url.protocol !== "https:" || !allowedHost)
    throw new Error("Codex returned an unexpected ChatGPT sign-in URL.");
  return url.toString();
}

function statusFrom(value: unknown): ChatGptOAuthStatus {
  const account = object(object(value)?.account);
  if (!account) return { connected: false };
  if (account.type === "chatgpt") {
    return {
      connected: true,
      accountType: "chatgpt",
      ...(typeof account.email === "string" && account.email
        ? { email: account.email }
        : {}),
      ...(typeof account.planType === "string" && account.planType
        ? { planType: account.planType }
        : {}),
    };
  }
  if (account.type === "apiKey")
    return { connected: false, accountType: "apiKey" };
  return { connected: false };
}

/**
 * Starts the official Codex app-server only for account management. Codex owns
 * the browser OAuth callback, credential persistence, and token refresh;
 * Kestrel receives only non-secret account metadata.
 */
export class ChatGptOAuthManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private login:
    | {
        loginId: string;
        resolve(): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(private readonly options: ChatGptOAuthManagerOptions) {}

  async status(signal?: AbortSignal): Promise<ChatGptOAuthStatus> {
    await this.start();
    try {
      return statusFrom(
        await this.request("account/read", { refreshToken: false }, signal),
      );
    } finally {
      await this.close();
    }
  }

  async connect(signal?: AbortSignal): Promise<ChatGptOAuthStatus> {
    await this.start();
    try {
      const response = object(
        await this.request("account/login/start", { type: "chatgpt" }, signal),
      );
      if (
        response?.type !== "chatgpt" ||
        typeof response.loginId !== "string" ||
        typeof response.authUrl !== "string"
      )
        throw new Error("Codex did not start a ChatGPT OAuth flow.");
      const completed = this.waitForLogin(response.loginId, signal);
      try {
        await this.options.openExternal(safeAuthUrl(response.authUrl));
      } catch (error) {
        this.login?.reject(
          error instanceof Error
            ? error
            : new Error("The ChatGPT sign-in page could not be opened."),
        );
        await completed.catch(() => undefined);
        throw error;
      }
      await completed;
      const status = statusFrom(
        await this.request("account/read", { refreshToken: true }, signal),
      );
      if (!status.connected)
        throw new Error("ChatGPT sign-in completed without a usable account.");
      return status;
    } finally {
      await this.close();
    }
  }

  async cancel(): Promise<void> {
    const login = this.login;
    if (login) {
      void this.request("account/login/cancel", {
        loginId: login.loginId,
      }).catch(() => undefined);
      login.reject(new Error("ChatGPT sign-in was cancelled."));
    }
    await this.close();
  }

  private async start(): Promise<void> {
    if (this.child?.exitCode === null) return;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = spawn(this.options.executable, ["app-server", "--stdio"], {
      env: safeEnvironment(this.options.environment ?? process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(
        -MAX_STDERR_BYTES,
      );
    });
    child.once("error", (error) => this.ended(error));
    child.once("close", (code, signal) =>
      this.ended(
        new Error(
          `Codex account service exited ${
            signal ? `on ${signal}` : `with code ${code ?? "unknown"}`
          }${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-1_000)}` : ""}`,
        ),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.request("initialize", {
      clientInfo: {
        name: "kestrel_desktop",
        title: "Kestrel Desktop",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.write({ method: "initialized", params: {} });
  }

  private readStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) {
      this.failAll(new Error("Codex account response exceeded the safety limit."));
      void this.close();
      return;
    }
    while (this.stdoutBuffer.includes("\n")) {
      const index = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as unknown);
      } catch {
        this.failAll(new Error("Codex account service emitted malformed JSON."));
        void this.close();
      }
    }
  }

  private handleMessage(value: unknown): void {
    const message = object(value);
    if (!message) return;
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = object(message.error);
        pending.reject(
          new Error(
            typeof error?.message === "string"
              ? error.message.slice(0, 1_000)
              : "Codex account request failed.",
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (
      message.method === "account/login/completed" &&
      object(message.params)
    ) {
      const params = object(message.params)!;
      const login = this.login;
      if (!login || params.loginId !== login.loginId) return;
      if (params.success === true) login.resolve();
      else
        login.reject(
          new Error(
            typeof params.error === "string"
              ? params.error.slice(0, 1_000)
              : "ChatGPT sign-in failed.",
          ),
        );
    }
  }

  private waitForLogin(
    loginId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.login) throw new Error("ChatGPT sign-in is already in progress.");
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        const login = this.login;
        if (!login || login.loginId !== loginId) return;
        clearTimeout(login.timer);
        signal?.removeEventListener("abort", abort);
        this.login = undefined;
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("ChatGPT sign-in was cancelled."),
        );
      const timer = setTimeout(
        () => finish(new Error("ChatGPT sign-in timed out.")),
        this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
      );
      this.login = {
        loginId,
        timer,
        resolve: () => finish(),
        reject: (error) => finish(error),
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private request(
    method: string,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let abort!: () => void;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const fail = (error: Error) => {
        if (!this.pending.has(id)) return;
        cleanup();
        reject(error);
      };
      abort = () => {
        fail(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Codex account request was cancelled."),
        );
      };
      timer = setTimeout(() => {
        fail(new Error(`Codex ${method} request timed out.`));
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      try {
        this.write({ id, method, params });
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Codex account request failed."));
      }
    });
  }

  private write(message: JsonObject): void {
    const child = this.child;
    if (!child || child.exitCode !== null)
      throw new Error("Codex account service is not running.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private ended(error: Error): void {
    this.child = undefined;
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.login?.reject(error);
  }

  private async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
