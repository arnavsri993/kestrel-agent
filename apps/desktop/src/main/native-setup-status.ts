import { arch, cpus, platform, totalmem } from "node:os";
import type { LocalRuntimeStatus, SetupSystemProfile } from "@kestrel/shared-types";
import { readBoundedResponseBytes } from "@kestrel/agent-core";
import { LocalRuntimeManager, MANAGED_OLLAMA_MANIFEST } from "./local-runtime-manager";

export const NATIVE_LOCAL_RUNTIME_UNAVAILABLE = "Native Chromium can verify an already-installed Ollama model at 127.0.0.1:11434. Automatic runtime installation and model downloads are unavailable; install through Ollama or use a provider account.";
export interface NativeLocalSelection { model: string; verifiedAt: string }

export function nativeSystemProfile(): SetupSystemProfile {
	return { platform: platform(), architecture: arch(), memoryBytes: totalmem(), logicalCpus: Math.max(1, cpus().length) };
}

/** Uses only the fixed loopback service. No shell, download, server startup,
 * model installation, ambient API credentials, or untrusted endpoint selection. */
export class NativeLocalRuntime {
	private readonly manager: LocalRuntimeManager;
	constructor(root: string, private readonly fetcher: typeof fetch = fetch) {
		this.manager = new LocalRuntimeManager(root, () => {}, { fetch: (input, options) => fetcher(input, { ...options, redirect: "error" }) });
	}

	async status(selection?: NativeLocalSelection): Promise<LocalRuntimeStatus> {
		const base = { automaticSupported: false, managedRuntime: false, runtimeDownloadBytes: MANAGED_OLLAMA_MANIFEST.bytes };
		try {
			const detected = await this.manager.listModels(1_500);
			// Onboarding treats a nonempty model list as configured. Discovered
			// models stay unavailable until guarded setup has selected a Core route.
			const selected = selection ? detected.find(model => model.name === selection.model) : undefined;
			return { ...base, ollamaAvailable: true, source: "external", localModels: selected ? [selected] : [], detectedModels: detected.slice(0, 200),
				...(selected && selection ? { verifiedModel: selected.name, verifiedAt: selection.verifiedAt } : {}),
			};
		} catch {
			return { ...base, ollamaAvailable: false, source: "none", localModels: [], unavailableReason: NATIVE_LOCAL_RUNTIME_UNAVAILABLE };
		}
	}

	async verify(model: string, signal: AbortSignal): Promise<NativeLocalSelection> {
		const budget = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
		try {
			const models = await this.manager.listModels(1_500, budget);
			budget.throwIfAborted();
			const installed = models.find(item => item.name === model || item.name === `${model}:latest`);
			if (!installed || installed.name.length > 200) throw new Error("Model is not installed.");
			const details = await this.fetcher("http://127.0.0.1:11434/api/show", { method: "POST", redirect: "error", signal: budget,
				headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: installed.name }) });
			if (!details.ok) throw new Error("Model capabilities are unavailable.");
			const description = JSON.parse(new TextDecoder().decode(await readBoundedResponseBytes(details, 262_144, "Model details exceeded the limit.")));
			if (!Array.isArray(description.capabilities) || !description.capabilities.includes("completion") || !description.capabilities.includes("tools"))
				throw new Error("Choose an installed model with confirmed tool support for Kestrel tasks.");
			const response = await this.fetcher("http://127.0.0.1:11434/api/chat", {
				method: "POST", redirect: "error", signal: budget,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: installed.name, messages: [{ role: "user", content: "Reply with OK." }], think: false, stream: false, keep_alive: 0, options: { num_predict: 32 } }),
			});
			if (!response.ok) throw new Error("Local inference failed.");
			const bytes = await readBoundedResponseBytes(response, 65_536, "Local verification response exceeded the limit.");
			const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
			budget.throwIfAborted();
			if (!value || typeof value !== "object" || !("message" in value) || !value.message || typeof value.message !== "object" || !("content" in value.message) || typeof value.message.content !== "string" || !value.message.content.trim()
				|| !("done" in value) || value.done !== true) throw new Error("Local inference did not complete.");
			return { model: installed.name, verifiedAt: new Date().toISOString() };
		} catch (error) {
			throw new Error(signal.aborted ? "Local model setup was cancelled." : error instanceof Error && error.message === "Choose an installed model with confirmed tool support for Kestrel tasks." ? error.message : "The installed local model did not complete a real chat response. Start Ollama, choose a model with tool support, and try again. No model was downloaded.");
		}
	}
}
