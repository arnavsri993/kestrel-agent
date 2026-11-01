import { arch, cpus, platform, totalmem } from "node:os";
import type { LocalRuntimeProgress, LocalRuntimeStatus, SetupSystemProfile } from "@kestrel/shared-types";
import { readBoundedResponseBytes } from "@kestrel/agent-core";
import { LocalRuntimeManager, type ManagerDependencies } from "./local-runtime-manager";

export const NATIVE_LOCAL_RUNTIME_UNAVAILABLE = "Use guided local setup or install Ollama through its official application.";
export interface NativeLocalSelection { model: string; verifiedAt: string }

export function nativeSystemProfile(): SetupSystemProfile {
	return { platform: platform(), architecture: arch(), memoryBytes: totalmem(), logicalCpus: Math.max(1, cpus().length) };
}

/** Uses only the fixed loopback service. No shell, download, server startup,
 * model installation, ambient API credentials, or untrusted endpoint selection. */
export class NativeLocalRuntime {
	private readonly manager: LocalRuntimeManager;
	private readonly fetcher: typeof fetch;
	constructor(root: string, fetcher: typeof fetch = fetch, emit: (event: LocalRuntimeProgress) => void = () => {}, dependencies: ManagerDependencies = {}) {
		this.fetcher = fetcher;
		this.manager = new LocalRuntimeManager(root, event => {
			if (event.stage === "ready") return;
			const messages: Record<LocalRuntimeProgress["stage"], string> = {
				detecting: "Checking the local model service.", "downloading-runtime": "Downloading the local runtime.",
				"verifying-runtime": "Verifying the runtime checksum.", "installing-runtime": "Installing the local runtime in Kestrel's private data.",
				"starting-runtime": "Starting Kestrel's local model service.", "downloading-model": "Downloading the selected model.",
				"verifying-model": "Verifying the selected model.", ready: "Local setup is ready.",
				cancelled: "Local setup stopped. Check for partial model downloads.", error: "Local setup could not be completed.",
			};
			emit({ ...event, message: messages[event.stage] });
		}, {
			...dependencies, fetch: (input, options) => fetcher(input, String(input).startsWith("http://127.0.0.1:") ? { ...options, redirect: "error" } : options),
		});
	}

	async status(selection?: NativeLocalSelection): Promise<LocalRuntimeStatus> {
		const status = await this.manager.status();
		const detected = status.localModels;
		const selected = selection ? detected.find(model => model.name === selection.model) : undefined;
		return { ...status, localModels: selected ? [selected] : [], detectedModels: detected.slice(0, 200),
			verifiedModel: selected && selection ? selected.name : undefined, verifiedAt: selected && selection ? selection.verifiedAt : undefined };
	}

	async bootstrap(model: string, signal: AbortSignal, options: { commit: (selection: NativeLocalSelection, signal: AbortSignal) => Promise<void>; rollback: () => Promise<void>; transaction: <T>(work: () => Promise<T>, rollback: () => Promise<void>, signal: AbortSignal) => Promise<T> }): Promise<NativeLocalSelection> {
		let selection: NativeLocalSelection | undefined;
		const cancel = () => this.manager.cancel();
		signal.throwIfAborted();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			await this.manager.bootstrap(model, {
				verify: async (requested, operationSignal) => { selection = await this.verify(requested, operationSignal); },
				commit: async operationSignal => { if (!selection) throw new Error("Local model verification did not complete."); await options.commit(selection, operationSignal); },
				rollback: options.rollback, transaction: options.transaction,
			});
			if (!selection) throw new Error("Local model verification did not complete.");
			return selection;
		} catch (error) {
			if (signal.aborted) throw new Error(signal.reason instanceof Error && signal.reason.message === "Local model setup timed out."
				? "Local model setup timed out. Partial downloads may remain in Ollama."
				: "Local model setup was cancelled. Partial downloads may remain in Ollama.");
			throw error;
		} finally { signal.removeEventListener("abort", cancel); }
	}

	async downloadModelOnly(model: string, signal: AbortSignal) {
		const cancel = () => this.manager.cancel();
		signal.throwIfAborted();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			const models = await this.manager.downloadModelOnly(model);
			signal.throwIfAborted();
			return models;
		} catch (error) {
			if (signal.aborted) throw new Error(signal.reason instanceof Error && signal.reason.message === "Local model setup timed out."
				? "Local model setup timed out. Partial downloads may remain in Ollama."
				: "Local model setup was cancelled. Partial downloads may remain in Ollama.");
			throw error;
		} finally { signal.removeEventListener("abort", cancel); }
	}

	async startManagedIfInstalled(signal?: AbortSignal): Promise<void> { await this.manager.startManagedIfInstalled(signal); }
	async stop(): Promise<void> { await this.manager.stop(); }

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
