export function canCompleteOnboarding(
	modelReady: boolean,
	verifiedModelReady: boolean,
): boolean {
	return !modelReady || verifiedModelReady;
}

export function setupVerificationCopy(passedRouteChecks: number, verifiedLocalModel?: string) {
	if (passedRouteChecks > 0) {
		return {
			description: "A configured route check passed. Try one guided task now, or open Kestrel and explore.",
			label: "Model route checked",
			detail: `${passedRouteChecks} route check${passedRouteChecks === 1 ? "" : "s"} passed`,
		};
	}
	if (verifiedLocalModel) {
		return {
			description: "A local model returned a real response. Try one guided task now, or open Kestrel and explore.",
			label: "Local model verified",
			detail: `${verifiedLocalModel} returned a real response during setup`,
		};
	}
	return {
		description: "The route is saved but not live-verified yet.",
		label: "Model route",
		detail: "Configured; check it before live work",
	};
}
