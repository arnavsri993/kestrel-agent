import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { CoreSupervisor } from "@kestrel/core-service/core-supervisor";
import { nodeCoreProcess } from "@kestrel/core-service/node-core-process";
import type { CoreRequest } from "@kestrel/shared-types";
import { assertTrustedShell, browserUrl, HostCommandSchema } from "./bridge-policy";

const hostRoot = fileURLToPath(new URL("../", import.meta.url));
const shellUrl = pathToFileURL(join(hostRoot, "ui/index.html")).href;

export async function launchChromiumHost(options: {
  headless?: boolean;
  secureEnvironment?: NodeJS.ProcessEnv;
  model?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "kestrel-chromium-preview-"));
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const closed = new Promise<void>((done) => { finish = done; });
  const supervisor = new CoreSupervisor(undefined, undefined, {
    processFactory: () => nodeCoreProcess({
      executable: process.execPath,
      entryPath: resolve(hostRoot, "../core-service/out/index.js"),
      env: { HOME: root, PATH: process.env.PATH, KESTREL_DATA_DIR: root },
    }),
  });
  const close = () => closing ??= (async () => {
    try { await supervisor.stop(); }
    finally {
      await browser?.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
      finish();
    }
  })();
  try {
    await supervisor.start({
      databasePath: join(root, "core.sqlite"),
      encryptionKeyBase64: randomBytes(32).toString("base64"),
      workspaceRoots: [], configuredWorkspaceRoots: [],
      pluginRoots: [], managedPluginRoots: [], learnedSkillRoot: join(root, "skills"),
      secureEnvironment: options.secureEnvironment ?? {},
    });
    async function request(command: CoreRequest) {
      const result = await supervisor.request(command);
      if (!result.ok) throw new Error(result.error);
      return result;
    }
    // Conversation-only preview: the model receives no tool definitions.
    // No tool approval or workspace access is silently granted by this host.
    await request({ type: "create-personality", personality: {
      id: "chromium-conversation", name: "Chromium conversation",
      description: "Conversation in the Chromium preview",
      instructions: "Answer the user directly. This conversation has no tools or browser context.",
      toolNames: [], memoryScope: "isolated",
    } });
    const sessions: { id: string; title: string }[] = [];
    let sessionId = "";
    let activeStream: string | undefined;
    const tabs = new Map<string, Page>();
    const newConversation = async () => {
      const result = await request({ type: "runtime-create-session", title: "New conversation", kind: "conversation" });
      if (!result.session) throw new Error("Agent Core did not create a conversation.");
      sessions.push({ id: result.session.id, title: result.session.title });
      sessionId = result.session.id;
    };
    await newConversation();
    browser = await chromium.launch({ headless: options.headless ?? false, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1180, height: 800 } });
    const shell = await context.newPage();
    const state = async () => {
      const messages = await request({ type: "runtime-list-messages", sessionId });
      const providers = await request({ type: "runtime-list-providers" });
      const browserTabs = await Promise.all([...tabs].map(async ([id, page]) => ({
        id, url: page.url(), title: await page.title().catch(() => "Browser tab"),
      })));
      return {
        sessionId, sessions, messages: messages.messages ?? [],
        providers: providers.providers?.filter((provider) => provider.id !== "auto").map((provider) => provider.id) ?? [],
        model: options.model ?? "auto", busy: !!activeStream, tabs: browserTabs,
      };
    };
    await shell.exposeBinding("kestrelHost", async (source, input: unknown) => {
      assertTrustedShell({ samePage: source.page === shell, mainFrame: source.frame === shell.mainFrame(), url: source.frame.url() }, shellUrl);
      const command = HostCommandSchema.parse(input);
      switch (command.type) {
        case "state": return state();
        case "new-conversation":
          if (activeStream) throw new Error("Stop the current response before creating a conversation.");
          await newConversation(); return state();
        case "select-conversation":
          if (activeStream) throw new Error("Stop the current response before switching conversations.");
          if (!sessions.some((session) => session.id === command.id)) throw new Error("Unknown conversation.");
          sessionId = command.id; return state();
        case "send": {
          if (activeStream) throw new Error("A response is already running.");
          activeStream = randomUUID();
          try {
            const providers = await request({ type: "runtime-list-providers" });
            if (!providers.providers?.some((provider) => provider.id === command.provider)) throw new Error("This provider is not configured.");
            const result = await request({ type: "runtime-run-agent", sessionId, message: command.message,
              model: command.model, providerIds: [command.provider], maximumTurns: 1,
              personalityId: "chromium-conversation", streamId: activeStream, approvalStatus: "pending" });
            const session = sessions.find((entry) => entry.id === sessionId);
            if (session?.title === "New conversation") session.title = command.message.slice(0, 60);
            return { ...await state(), result };
          } finally { activeStream = undefined; }
        }
        case "cancel":
          if (activeStream) await request({ type: "runtime-cancel-stream", streamId: activeStream });
          return { ok: true };
        case "open-tab": {
          if (tabs.size >= 16) throw new Error("Close a browser tab before opening another.");
          const url = browserUrl(command.url);
          const page = await context.newPage();
          const id = randomUUID();
          tabs.set(id, page);
          page.on("close", () => tabs.delete(id));
          try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
          catch { await page.close(); throw new Error("Could not open that URL."); }
          await page.bringToFront();
          return { id };
        }
        case "focus-tab": {
          const tab = tabs.get(command.id);
          if (!tab) throw new Error("This tab is closed.");
          await tab.bringToFront(); return { ok: true };
        }
        case "close-tab": await tabs.get(command.id)?.close(); return { ok: true };
      }
    });
    // The binding belongs to this page only and checks the exact main-frame URL
    // on every call. Web tabs have no privileged Kestrel transport.
    await shell.goto(shellUrl);
    browser.on("disconnected", () => { void close(); });
    shell.on("close", () => { void close(); });
    return { shell, browser, supervisor, closed, close };
  } catch (error) { await close(); throw error; }
}
