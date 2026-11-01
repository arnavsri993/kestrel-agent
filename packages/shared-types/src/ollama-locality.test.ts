import { describe, expect, it } from "vitest";
import { assertLocalOllamaMetadata, OLLAMA_REMOTE_MODEL_ERROR } from "./ollama-locality";

describe("Ollama locality metadata", () => {
	it.each([{}, { remote_model: "", remote_host: "" }])("accepts absent or empty remote fields: %o", value => {
		expect(() => assertLocalOllamaMetadata(value)).not.toThrow();
	});
	it.each([{ remote_model: "alias" }, { remote_host: "https://private.invalid" }, { remote_model: null }, { remote_host: 0 }, { remote_model: [] }, { remote_host: {} }, null, []])("rejects remote or malformed metadata without echoing it: %o", value => {
		expect(() => assertLocalOllamaMetadata(value)).toThrow(OLLAMA_REMOTE_MODEL_ERROR);
	});
});
