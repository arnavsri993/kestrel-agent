export function canCompleteOnboarding(
	modelReady: boolean,
	verifiedModelReady: boolean,
): boolean {
	return !modelReady || verifiedModelReady;
}
