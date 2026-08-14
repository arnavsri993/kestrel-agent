const dimensions = 256;

function tokens(value: string): string[] {
	return (
		value
			.toLowerCase()
			.normalize("NFKC")
			.match(/[\p{L}\p{N}]{2,}/gu) ?? []
	);
}

function stem(token: string): string {
	for (const suffix of [
		"ization",
		"ational",
		"fulness",
		"ously",
		"ments",
		"ingly",
		"ation",
		"ities",
		"ment",
		"ness",
		"ing",
		"ers",
		"ies",
		"ed",
		"es",
		"s",
	]) {
		if (token.length > suffix.length + 3 && token.endsWith(suffix))
			return `${token.slice(0, -suffix.length)}${suffix === "ies" ? "y" : ""}`;
	}
	return token;
}

function hash(value: string): number {
	let output = 2166136261;
	for (let index = 0; index < value.length; index += 1)
		output = Math.imul(output ^ value.charCodeAt(index), 16777619);
	return output >>> 0;
}

export function localSemanticEmbedding(value: string): Float32Array {
	const words = tokens(value).map(stem);
	const vector = new Float32Array(dimensions);
	const add = (feature: string, weight: number) => {
		const digest = hash(feature);
		const index = digest % dimensions;
		vector[index] =
			(vector[index] ?? 0) + ((digest & 256) === 0 ? weight : -weight);
	};
	for (const word of words) {
		add(`word:${word}`, 2.5);
		const padded = `#${word}#`;
		for (let index = 0; index <= padded.length - 3; index += 1)
			add(`tri:${padded.slice(index, index + 3)}`, 0.55);
	}
	for (let index = 0; index < words.length - 1; index += 1)
		add(`pair:${words[index]}:${words[index + 1]}`, 1.2);
	let magnitude = 0;
	for (const component of vector) magnitude += component * component;
	if (magnitude > 0) {
		const divisor = Math.sqrt(magnitude);
		for (let index = 0; index < vector.length; index += 1)
			vector[index] = (vector[index] ?? 0) / divisor;
	}
	return vector;
}

export function semanticSimilarity(
	left: Float32Array,
	right: Float32Array,
): number {
	let score = 0;
	for (let index = 0; index < Math.min(left.length, right.length); index += 1)
		score += left[index]! * right[index]!;
	return Math.max(0, Math.min(1, score));
}
