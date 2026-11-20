import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import {
	RendererRequestSchema,
	type RendererResponse,
} from "@kestrel/shared-types";
import { ExternalSecretManager } from "./external-secret-manager";
import type {
	CredentialBroker,
	ResolvedExternalCredentials,
} from "./credential-broker";
import { NATIVE_EXTERNAL_SECRET_REQUEST_TYPES } from "./native-external-secret-requests";

export { NATIVE_EXTERNAL_SECRET_REQUEST_TYPES } from "./native-external-secret-requests";

type ExternalSecretDependencies = ConstructorParameters<
	typeof ExternalSecretManager
>[2];

type Options = {
	root: string;
	broker: CredentialBroker;
	mutateSettings<T>(mutation: () => Promise<T>, rollback?: () => Promise<void>, validate?: () => void): Promise<T>;
	reconfigure<T>(
		mutation: () => Promise<T>,
		rollback?: () => Promise<void>,
		validate?: () => void,
		shouldRestoreCore?: () => boolean,
	): Promise<T>;
	dependencies?: ExternalSecretDependencies;
	shouldRestoreCore?: () => boolean;
};

const BUSY = "External secret settings are already being changed.";
const CLOSED = "The native external-secret host is shutting down.";
const ABORTED = "The native external-secret request was cancelled.";
const OPAQUE_EXTERNAL_SECRET_IDS = [
	"external-secret-configuration",
	"external-secret-onepassword-token",
	"external-secret-bitwarden-token",
] as const;
type OpaqueSnapshot = Record<(typeof OPAQUE_EXTERNAL_SECRET_IDS)[number], string | undefined>;

function safeError(type: string): string {
	switch (type) {
		case "external-secret-list":
			return "External secret status is unavailable.";
		case "external-secret-save":
			return "External secret settings could not be saved.";
		case "external-secret-sync":
			return "The selected secret source could not be verified.";
		case "external-secret-install-bitwarden":
			return "Bitwarden installation or Core restart did not complete. Check source status before retrying.";
		case "external-secret-remove":
			return "External secret settings could not be removed.";
		default:
			return "Invalid native external-secret request.";
	}
}

export class NativeExternalSecretHost {
	private readonly manager: ExternalSecretManager;
	private active: Promise<unknown> | undefined;
	private activeController: AbortController | undefined;
	private readonly lifetimeController = new AbortController();
	private readonly runtimeCredentialTasks = new Set<Promise<ResolvedExternalCredentials>>();
	private staged: ResolvedExternalCredentials | undefined;
	private closing = false;
	private explicitBitwardenInstall = false;
	private operationSignal: AbortSignal | undefined;
	private coreReconfigurationActive = false;
	private activeReconfigurationToken: symbol | undefined;
	private readonly reconfigurationContext = new AsyncLocalStorage<symbol>();

	constructor(private readonly options: Options) {
		const suppliedFetch = options.dependencies?.fetch ?? fetch;
		const suppliedExecute = options.dependencies?.execute;
		this.manager = new ExternalSecretManager(
			options.root,
			options.broker,
			{
				...options.dependencies,
				execute: suppliedExecute ?? ((file, args, execution) =>
					this.executeProvider(file, args, execution)),
				// The shared manager supports automatic BWS bootstrap, but native Core
				// only permits its pinned network install from the explicit UI action.
				fetch: (input, init) => {
					if (!this.explicitBitwardenInstall)
						return Promise.reject(new Error("Bitwarden installation requires an explicit request."));
					const signals = [init?.signal, this.operationSignal, this.lifetimeController.signal].filter(
					(signal): signal is AbortSignal => Boolean(signal),
				);
				const signal = signals.length === 0
					? undefined
					: signals.length === 1
						? signals[0]
						: AbortSignal.any(signals);
				return suppliedFetch(input, { ...init, ...(signal ? { signal } : {}) });
				},
			},
		);
	}

	private async serialize<T>(
		externalSignal: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (this.closing) throw new Error(CLOSED);
		if (this.active) throw new Error(BUSY);
		externalSignal?.throwIfAborted();
		const controller = new AbortController();
		const abort = () => controller.abort(externalSignal?.reason);
		externalSignal?.addEventListener("abort", abort, { once: true });
		this.activeController = controller;
		this.operationSignal = controller.signal;
		const operation = Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return work(controller.signal);
		});
		this.active = operation;
		try {
			return await operation;
		} finally {
			externalSignal?.removeEventListener("abort", abort);
			if (this.active === operation) {
				this.active = undefined;
				this.activeController = undefined;
				this.operationSignal = undefined;
			}
		}
	}

	private async reconfigure<T>(
		signal: AbortSignal,
		mutation: () => Promise<T>,
		rollback?: () => Promise<void>,
	): Promise<T> {
		if (this.coreReconfigurationActive) throw new Error(BUSY);
		const token = Symbol("native external-secret Core reconfiguration");
		this.coreReconfigurationActive = true;
		this.activeReconfigurationToken = token;
		try {
			return await this.reconfigurationContext.run(
				token,
				() => this.options.reconfigure(
					async () => {
						signal.throwIfAborted();
						const result = await mutation();
						signal.throwIfAborted();
						return result;
					},
					rollback,
					() => signal.throwIfAborted(),
					this.options.shouldRestoreCore,
				),
			);
		} finally {
			this.coreReconfigurationActive = false;
			this.activeReconfigurationToken = undefined;
		}
	}

	private async snapshotOpaqueSecrets(): Promise<OpaqueSnapshot> {
		const snapshot = {} as OpaqueSnapshot;
		for (const id of OPAQUE_EXTERNAL_SECRET_IDS)
			snapshot[id] = await this.options.broker.getOpaqueSecret(id);
		return snapshot;
	}

	private async restoreOpaqueSecrets(snapshot: OpaqueSnapshot): Promise<void> {
		for (const id of OPAQUE_EXTERNAL_SECRET_IDS) {
			const value = snapshot[id];
			if (value === undefined) await this.options.broker.removeOpaqueSecret(id);
			else await this.options.broker.setOpaqueSecret(id, value);
		}
		await this.manager.invalidateVerification();
	}

	async runtimeCredentials(): Promise<ResolvedExternalCredentials> {
		if (this.closing) throw new Error(CLOSED);
		this.lifetimeController.signal.throwIfAborted();
		this.operationSignal?.throwIfAborted();
		const inOwnedReconfiguration =
			this.coreReconfigurationActive &&
			this.reconfigurationContext.getStore() === this.activeReconfigurationToken;
		if (this.activeController && !inOwnedReconfiguration)
			throw new Error(BUSY);
		const task = this.resolveRuntimeCredentials();
		this.runtimeCredentialTasks.add(task);
		try {
			const credentials = await task;
			this.lifetimeController.signal.throwIfAborted();
			this.operationSignal?.throwIfAborted();
			return credentials;
		} finally {
			this.runtimeCredentialTasks.delete(task);
		}
	}

	private async resolveRuntimeCredentials(): Promise<ResolvedExternalCredentials> {
		const inOwnedReconfiguration =
			this.coreReconfigurationActive &&
			this.reconfigurationContext.getStore() === this.activeReconfigurationToken;
		if (this.staged) {
			if (!inOwnedReconfiguration || this.activeController?.signal.aborted) {
				this.staged = undefined;
				return this.manager.resolveEnabled();
			}
			const value = this.staged;
			this.staged = undefined;
			this.operationSignal?.throwIfAborted();
			return value;
		}
		const resolved = await this.manager.resolveEnabled();
		this.lifetimeController.signal.throwIfAborted();
		this.operationSignal?.throwIfAborted();
		return resolved;
	}

	async handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
		if (this.closing) return { ok: false, error: CLOSED };
		if (externalSignal?.aborted) return { ok: false, error: ABORTED };
		const parsed = RendererRequestSchema.safeParse(raw);
		if (
			!parsed.success ||
			!NATIVE_EXTERNAL_SECRET_REQUEST_TYPES.has(parsed.data.type)
		) {
			return { ok: false, error: "Invalid native external-secret request." };
		}
		const request = parsed.data;
		let committed = false;
		if (this.active) return { ok: false, error: BUSY };
		try {
			if (request.type === "external-secret-list") {
				externalSignal?.throwIfAborted();
				const state = await this.manager.status();
				externalSignal?.throwIfAborted();
				return {
					ok: true,
					externalSecretSources: this.publicSources(state.sources),
					externalSecretConfiguration: state.configuration,
				};
			}
			if (request.type === "external-secret-save") {
				return await this.serialize(externalSignal, async (signal) => {
					this.staged = undefined;
					let previous: OpaqueSnapshot | undefined;
					await this.options.mutateSettings(async () => {
						signal.throwIfAborted();
						previous = await this.snapshotOpaqueSecrets();
						signal.throwIfAborted();
						await this.manager.save(request.configuration, {
							...(request.onePasswordToken
								? { onePasswordToken: request.onePasswordToken }
								: {}),
							...(request.bitwardenToken
								? { bitwardenToken: request.bitwardenToken }
								: {}),
						});
						signal.throwIfAborted();
					}, async () => {
						if (previous) await this.restoreOpaqueSecrets(previous);
					}, () => signal.throwIfAborted());
					committed = true;
					return this.publicState();
				});
			}
			if (request.type === "external-secret-sync") {
				return await this.serialize(externalSignal, async (signal) => {
					this.staged = undefined;
					await this.reconfigure(signal, async () => {
						const resolved = await this.manager.resolveEnabled();
						signal.throwIfAborted();
						const state = await this.manager.status();
						signal.throwIfAborted();
						const source = state.sources.find(
							(candidate) => candidate.id === request.providerId,
						);
						if (
							!source ||
							source.state !== "verified" ||
							source.resolvedCredentialIds.length === 0 ||
							Object.keys(resolved.values).length === 0
						)
							throw new Error("Selected source was not verified.");
						this.staged = resolved;
					});
					if (this.staged) {
						this.staged = undefined;
						throw new Error("Core did not consume the staged credentials.");
					}
					committed = true;
					return this.publicState();
				});
			}
			if (request.type === "external-secret-install-bitwarden") {
				return await this.serialize(externalSignal, async (signal) => {
					this.staged = undefined;
					let previous: OpaqueSnapshot | undefined;
					await this.reconfigure(signal, async () => {
						signal.throwIfAborted();
						previous = await this.snapshotOpaqueSecrets();
						signal.throwIfAborted();
						this.explicitBitwardenInstall = true;
						try {
							await this.manager.installBitwarden();
							signal.throwIfAborted();
						} finally {
							this.explicitBitwardenInstall = false;
						}
					}, async () => {
						if (previous) await this.restoreOpaqueSecrets(previous);
					});
					committed = true;
					return this.publicState();
				});
			}
			if (request.type === "external-secret-remove") {
				return await this.serialize(externalSignal, async (signal) => {
					this.staged = undefined;
					let previous: OpaqueSnapshot | undefined;
					await this.reconfigure(signal, async () => {
						signal.throwIfAborted();
						previous = await this.snapshotOpaqueSecrets();
						signal.throwIfAborted();
						await this.manager.remove(request.providerId);
						signal.throwIfAborted();
					}, async () => {
						if (previous) await this.restoreOpaqueSecrets(previous);
					});
					committed = true;
					return this.publicState();
				});
			}
			return { ok: false, error: "Invalid native external-secret request." };
		} catch {
			if (request.type === "external-secret-sync") this.staged = undefined;
			return { ok: false, error: committed
				? "The external secret change completed, but its status could not be reloaded. Check source status before retrying."
				: safeError(request.type) };
		}
	}

	private async publicState(signal?: AbortSignal): Promise<RendererResponse> {
		signal?.throwIfAborted();
		const state = await this.manager.status();
		signal?.throwIfAborted();
		return {
			ok: true,
			externalSecretSources: this.publicSources(state.sources),
			externalSecretConfiguration: state.configuration,
		};
	}

	private publicSources(sources: Awaited<ReturnType<ExternalSecretManager["status"]>>["sources"]) {
		return sources.map((source) => ({
			...source,
			detail:
				source.state === "error"
					? "Verification failed. Check the source settings and retry."
					: source.state === "verified"
						? `${source.resolvedCredentialIds.length} supported credentials verified.`
						: source.state === "ready"
							? "Configured and ready to verify."
							: source.state === "disabled"
								? "Disabled; saved settings are not resolved at startup."
								: "Finish setup and verify this source.",
		}));
	}

	private async executeProvider(
		file: string,
		args: string[],
		settings: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number },
	): Promise<{ stdout: string }> {
		const signals = [this.lifetimeController.signal, this.operationSignal].filter(
			(signal): signal is AbortSignal => Boolean(signal),
		);
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const child = execFile(
				file,
				args,
				{
					env: settings.env,
					timeout: settings.timeoutMs,
					maxBuffer: settings.maxBuffer,
					encoding: "utf8",
					windowsHide: true,
					killSignal: "SIGKILL",
				},
				(error, stdout) => {
					signal?.removeEventListener("abort", forceKill);
					if (error) reject(error);
					else resolve({ stdout: String(stdout) });
				},
			);
			const forceKill = () => { child.kill("SIGKILL"); };
			if (signal?.aborted) forceKill();
			else signal?.addEventListener("abort", forceKill, { once: true });
		});
	}

	async close(): Promise<void> {
		this.closing = true;
		this.lifetimeController.abort(new Error("Host closed."));
		this.activeController?.abort(new Error("Host closed."));
		const active = this.active;
		if (active) await active.catch(() => undefined);
		while (this.runtimeCredentialTasks.size > 0)
			await Promise.allSettled([...this.runtimeCredentialTasks]);
		this.staged = undefined;
	}
}
