/**
 * Capability contract for model transports. Routing decisions must use these
 * facts — never provider marketing names — and must fail closed when a task
 * requires tools that the transport cannot supply.
 */
export type TransportCapabilitySupport =
	| "native"
	| "bridged"
	| "unsupported"
	| "unknown";

export interface TransportCapabilityContract {
	streaming: boolean;
	reasoningEffort: boolean;
	structuredToolCalls: TransportCapabilitySupport;
	multimodalInput: {
		images: boolean;
		audio: boolean;
		documents: boolean;
		video: boolean;
	};
	sessionPersistence: boolean;
	cancellation: boolean;
	usageAccounting: boolean;
	contextLimitsKnown: boolean;
	subscriptionVersusApi: "subscription" | "api" | "local" | "mixed" | "unknown";
	/** True only when Kestrel can receive validated structured tool requests. */
	toolSupport: boolean;
	parallelToolSupport: boolean;
	retryFailoverSupport: boolean;
	/**
	 * When toolSupport is true via a bridge (not native provider tools),
	 * Kestrel still owns schema → grants → policy → approval → execution.
	 */
	toolAuthority: "kestrel" | "provider" | "none";
}

export interface CapabilityRequirement {
	requireTools?: boolean;
	requireStreaming?: boolean;
	requireVision?: boolean;
	requireCancellation?: boolean;
	requireUsageAccounting?: boolean;
}

export interface CapabilityFailure {
	code: "capability_unsatisfied";
	message: string;
	missing: string[];
	recoveryOptions: string[];
}

export function contractFromProviderCapabilities(input: {
	streaming: boolean;
	tools: boolean;
	images: boolean;
	audio: boolean;
	documents: boolean;
	video?: boolean;
	local?: boolean;
	structuredToolCalls?: TransportCapabilitySupport;
	subscriptionVersusApi?: TransportCapabilityContract["subscriptionVersusApi"];
	sessionPersistence?: boolean;
	cancellation?: boolean;
	usageAccounting?: boolean;
	contextLimitsKnown?: boolean;
	reasoningEffort?: boolean;
	parallelToolSupport?: boolean;
	retryFailoverSupport?: boolean;
	toolAuthority?: TransportCapabilityContract["toolAuthority"];
}): TransportCapabilityContract {
	const toolSupport = input.tools;
	return {
		streaming: input.streaming,
		reasoningEffort: input.reasoningEffort ?? false,
		structuredToolCalls:
			input.structuredToolCalls ??
			(toolSupport ? "native" : "unsupported"),
		multimodalInput: {
			images: input.images,
			audio: input.audio,
			documents: input.documents,
			video: input.video ?? false,
		},
		sessionPersistence: input.sessionPersistence ?? false,
		cancellation: input.cancellation ?? true,
		usageAccounting: input.usageAccounting ?? false,
		contextLimitsKnown: input.contextLimitsKnown ?? false,
		subscriptionVersusApi:
			input.subscriptionVersusApi ??
			(input.local ? "local" : "unknown"),
		toolSupport,
		parallelToolSupport: input.parallelToolSupport ?? false,
		retryFailoverSupport: input.retryFailoverSupport ?? true,
		toolAuthority: input.toolAuthority ?? (toolSupport ? "kestrel" : "none"),
	};
}

export function evaluateCapabilityRequirements(
	contract: TransportCapabilityContract,
	requirements: CapabilityRequirement,
): CapabilityFailure | undefined {
	const missing: string[] = [];
	if (requirements.requireTools && !contract.toolSupport)
		missing.push("structured_tool_calls");
	if (requirements.requireStreaming && !contract.streaming)
		missing.push("streaming");
	if (requirements.requireVision && !contract.multimodalInput.images)
		missing.push("multimodal_images");
	if (requirements.requireCancellation && !contract.cancellation)
		missing.push("cancellation");
	if (requirements.requireUsageAccounting && !contract.usageAccounting)
		missing.push("usage_accounting");
	if (missing.length === 0) return undefined;
	const recoveryOptions = [
		"Select a configured provider that advertises the missing capabilities.",
		...(missing.includes("structured_tool_calls")
			? [
					"Use an API or bridged tool-capable route (for example OpenAI/Anthropic/Gemini/Ollama with tools, or Codex with the Kestrel tool bridge).",
					"Do not fall back to a text-only CLI for executable agent work.",
				]
			: []),
		"Connect or enable an additional model account in Settings → Connections.",
	];
	return {
		code: "capability_unsatisfied",
		message:
			"No configured transport satisfies the required capabilities for this task. " +
			`Missing: ${missing.join(", ")}.`,
		missing,
		recoveryOptions,
	};
}

export function assertToolCapableOrThrow(
	contract: TransportCapabilityContract,
	label = "This agent",
): void {
	const failure = evaluateCapabilityRequirements(contract, {
		requireTools: true,
	});
	if (!failure) return;
	throw new Error(
		`${label} needs a provider with Kestrel tool support. ${failure.message} ` +
			failure.recoveryOptions.join(" "),
	);
}
