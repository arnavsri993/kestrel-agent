import { ComputerUseStatusSchema, LocalRuntimeStatusSchema, SystemReadinessSchema, type ComputerUseStatus, type SystemReadiness } from "@kestrel/shared-types";

export const NATIVE_READINESS_REQUEST_TYPES = new Set([
	"system-readiness",
	"computer-use-status",
	"computer-use-update",
	"computer-use-open-settings",
]);

type CoreRequest = (request: { type: "snapshot" | "runtime-list-providers" }) => Promise<unknown>;
interface Options {
	coreRequest: CoreRequest;
	workspaceConfiguration: () => Promise<unknown>;
	localStatus: () => Promise<unknown>;
	computerUseStatus: () => Promise<unknown>;
	backupStatus?: () => Promise<{ verified: boolean; createdAt?: string }>;
	now?: () => Date;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Read-only probes. Never runs inference, changes settings, or reads another profile. */
export async function nativeSystemReadiness(options: Options): Promise<SystemReadiness> {
	const now = options.now?.() ?? new Date();
	const checks: SystemReadiness["checks"] = [];
	let snapshot: unknown;
	try { snapshot = await options.coreRequest({ type: "snapshot" }); } catch { /* Core may be stopped. */ }
	const coreReady = object(snapshot) && snapshot.ok === true && object(snapshot.snapshot);
	checks.push({ id: "core", label: "Local agent core", status: coreReady ? "pass" : "fail",
		detail: coreReady ? "The local agent process responded to a snapshot request." : "The local agent process did not respond. Restart Kestrel before starting work." });
	let providers: unknown;
	if (coreReady) try { providers = await options.coreRequest({ type: "runtime-list-providers" }); } catch { /* Report unknown rather than an empty list. */ }
	let routeIds: string[] | undefined;
	if (object(providers) && providers.ok === true && Array.isArray(providers.providers) &&
		providers.providers.every(provider => object(provider) && typeof provider.id === "string" && provider.id.trim() === provider.id && provider.id.length > 0 && provider.id.length <= 200)) {
		routeIds = [...new Set(providers.providers.map(provider => (provider as { id: string }).id).filter(id => id !== "auto"))];
	}
	checks.push({ id: "models", label: "Model routes", status: !routeIds ? "warning" : routeIds.length ? "warning" : "fail",
		detail: !routeIds ? "Configured model routes could not be checked." : routeIds.length ? `${routeIds.length} model route${routeIds.length === 1 ? " is" : "s are"} configured. Configuration alone does not verify a live response.` : "No model route is configured." });
	let local: unknown;
	try { local = await options.localStatus(); } catch { /* Unavailable is not the same as no installed runtime. */ }
	const parsedLocal = object(local) && local.ok === true ? LocalRuntimeStatusSchema.safeParse(local.localRuntime) : undefined;
	if (parsedLocal?.success) {
		const state = parsedLocal.data;
		const verified = state.ollamaAvailable && state.verifiedModel && state.verifiedAt &&
			state.localModels.some(model => model.name === state.verifiedModel) && Date.parse(state.verifiedAt) <= now.getTime();
		checks.push({ id: "local-model", label: "Local model", status: "warning", detail: verified
			? `Ollama is reachable and ${state.verifiedModel} was previously verified at ${state.verifiedAt}. This check did not run a new model response.`
			: state.ollamaAvailable ? "Ollama is reachable. No previously verified selected model was confirmed." : "Ollama did not respond to the local model status probe." });
	} else checks.push({ id: "local-model", label: "Local model", status: "warning", detail: "The local model status could not be checked." });
	let workspace: unknown;
	try { workspace = await options.workspaceConfiguration(); } catch { /* Preserve unknown. */ }
	if (object(workspace) && Array.isArray(workspace.workspaceRoots) && Array.isArray(workspace.configuredWorkspaceRoots) &&
		workspace.workspaceRoots.every(root => typeof root === "string") && workspace.configuredWorkspaceRoots.every(root => typeof root === "string") &&
		workspace.workspaceRoots.every(root => (workspace.configuredWorkspaceRoots as unknown[]).includes(root))) {
		const active = workspace.workspaceRoots.length;
		const missing = workspace.configuredWorkspaceRoots.length - active;
		checks.push({ id: "workspace", label: "Project access", status: active && !missing ? "pass" : "warning", detail: missing
			? `${active} granted project folder${active === 1 ? " is" : "s are"} available; ${missing} configured folder${missing === 1 ? " is" : "s are"} unavailable.`
			: active ? `${active} granted project folder${active === 1 ? " is" : "s are"} available.` : "No project folder is granted. Conversation-only tasks can still work." });
	} else checks.push({ id: "workspace", label: "Project access", status: "warning", detail: "Project folder availability could not be checked." });
	let computerUse: ComputerUseStatus | undefined;
	try {
		const parsed = ComputerUseStatusSchema.safeParse(await options.computerUseStatus());
		if (parsed.success) computerUse = parsed.data;
	} catch { /* An unavailable native probe is not permission to claim readiness. */ }
	let backup: { verified: boolean; createdAt?: string } | undefined;
	try { backup = await options.backupStatus?.(); } catch { /* An unavailable receipt is not a verified backup. */ }
	const backupCreatedAt = backup?.verified === true && backup.createdAt && Number.isFinite(Date.parse(backup.createdAt)) && Date.parse(backup.createdAt) <= now.getTime()
		? backup.createdAt : undefined;
	checks.push(
		{
			id: "computer-use",
			label: "Whole-desktop computer use",
			status: computerUse?.enabled && computerUse.captureReady && computerUse.controlReady ? "pass" : "warning",
			detail: !computerUse
				? "Native computer-use permission status could not be checked."
				: !computerUse.enabled
					? "Disabled by default. Enable it in Settings → Agent → Permissions & sandbox before capture or control."
					: computerUse.captureReady && computerUse.controlReady
						? "Enabled with Screen Recording and Accessibility permission. This is a permission probe, not proof of a completed desktop action."
						: `Enabled, but permissions are incomplete: Screen Recording ${computerUse.screenRecording}; Accessibility ${computerUse.accessibility}.`,
		},
		{ id: "backup", label: "App data backup", status: backupCreatedAt ? "pass" : "warning", detail: backupCreatedAt
			? `A backup verified when created at ${backupCreatedAt} still matches its saved folder identity. This check did not re-read its contents or test restoration.`
			: "No verified backup receipt was confirmed in this session. Back up app data before changing the native profile." },
		{ id: "distribution", label: "Installed build", status: "fail", detail: "Production signing, canonical installation, and rollback have not been verified by the native host." },
	);
	// This screen's global ready label cannot imply release readiness while the
	// native installation and rollback checks are unverified.
	return SystemReadinessSchema.parse({ checkedAt: now.toISOString(), readyForLiveWork: false, backupScope: "native-core-data", checks });
}
