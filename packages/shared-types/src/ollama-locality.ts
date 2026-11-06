/** A truthful Ollama daemon can advertise a remote-backed alias without any
 * identifying suffix. Reject advertised or malformed remote metadata. This
 * cannot attest a daemon that omits or falsifies its upstream information. */
export const OLLAMA_REMOTE_MODEL_ERROR = "This Ollama model is remote-backed or its location could not be confirmed. Choose a local model.";
export function assertLocalOllamaMetadata(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(OLLAMA_REMOTE_MODEL_ERROR);
	const metadata = value as Record<string, unknown>;
	for (const key of ["remote_host", "remote_model"]) {
		if (Object.hasOwn(metadata, key) && (typeof metadata[key] !== "string" || metadata[key] !== ""))
			throw new Error(OLLAMA_REMOTE_MODEL_ERROR);
	}
}
