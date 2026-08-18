const BINARY_TAG = "__kestrel_binary_base64__";

export function encodeNodeIpcMessage(value: unknown): unknown {
	if (value instanceof Uint8Array)
		return { [BINARY_TAG]: Buffer.from(value).toString("base64") };
	if (Array.isArray(value)) return value.map(encodeNodeIpcMessage);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			encodeNodeIpcMessage(entry),
		]),
	);
}

export function decodeNodeIpcMessage(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeNodeIpcMessage);
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value);
	if (
		entries.length === 1 &&
		entries[0]?.[0] === BINARY_TAG &&
		typeof entries[0][1] === "string"
	)
		return Uint8Array.from(Buffer.from(entries[0][1], "base64"));
	return Object.fromEntries(
		entries.map(([key, entry]) => [key, decodeNodeIpcMessage(entry)]),
	);
}
