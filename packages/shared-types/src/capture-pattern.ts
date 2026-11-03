export const CAPTURE_PATTERN_MAX_STEPS = 65_536;

export class CapturePatternLimitError extends Error {
	constructor() { super("Capture pattern matching exceeded its work limit."); }
}

/** Case-insensitive literal matching with '*' as the only wildcard. */
export function capturePatternMatches(pattern: string, value: string): boolean {
	const mask = pattern.toLocaleLowerCase(), body = value.toLocaleLowerCase();
	let patternIndex = 0, valueIndex = 0, star = -1, retry = 0, steps = 0;
	const step = () => { if (++steps > CAPTURE_PATTERN_MAX_STEPS) throw new CapturePatternLimitError(); };
	while (valueIndex < body.length) {
		step();
		if (mask[patternIndex] === "*") {
			star = patternIndex++; retry = valueIndex;
		} else if (patternIndex < mask.length && mask[patternIndex] === body[valueIndex]) {
			patternIndex++; valueIndex++;
		} else if (star >= 0) {
			patternIndex = star + 1; valueIndex = ++retry;
		} else return false;
	}
	while (mask[patternIndex] === "*") { step(); patternIndex++; }
	return patternIndex === mask.length;
}
