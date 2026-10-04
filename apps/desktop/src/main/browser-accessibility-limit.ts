/** Keep a partial accessibility tree usable when a large page exceeds IPC limits. */
export function limitBrowserAccessibilityTree(
	accessibilityTree: { nodes: unknown[] },
	maximumBytes: number,
): {
	accessibilityTree: { nodes: unknown[] };
	retainedRefs: Set<string>;
	truncated: boolean;
} {
	const fits = (count: number) =>
		Buffer.byteLength(
			JSON.stringify({ nodes: accessibilityTree.nodes.slice(0, count) }),
			"utf8",
		) <= maximumBytes;
	let count = accessibilityTree.nodes.length;
	if (!fits(count)) {
		let low = 0;
		let high = count;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(middle)) low = middle;
			else high = middle - 1;
		}
		count = low;
	}
	const nodes = accessibilityTree.nodes.slice(0, count);
	const retainedRefs = new Set<string>();
	for (const node of nodes) {
		if (
			node && typeof node === "object" &&
			"ref" in node && typeof node.ref === "string"
		) retainedRefs.add(node.ref);
	}
	return {
		accessibilityTree: { nodes },
		retainedRefs,
		truncated: count < accessibilityTree.nodes.length,
	};
}
