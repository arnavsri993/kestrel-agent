const maximumRecordingBytes = 25 * 1024 * 1024;

export function decodeVoiceRecording(encoded: string): Buffer {
	const invalid = () => new Error("Voice recording contains invalid base64 data.");
	// Inspect only the two possible padding positions. A suffix regex can
	// backtrack quadratically on a long run of '=' followed by a non-padding byte.
	let padding = 0;
	if (encoded.endsWith("=")) {
		padding = encoded.endsWith("==") ? 2 : 1;
	}
	const contentLength = encoded.length - padding;
	const remainder = contentLength % 4;
	if (
		contentLength === 0 ||
		remainder === 1 ||
		(padding > 0 && (encoded.length % 4 !== 0 || padding !== 4 - remainder))
	)
		throw invalid();
	const decodedLength = Math.floor((contentLength * 3) / 4);
	if (decodedLength > maximumRecordingBytes)
		throw new Error("Voice recording must be between 1 byte and 25 MB.");

	const data = Buffer.from(encoded, "base64");
	const canonical = data.toString("base64");
	// Buffer's decoder tolerates junk and noncanonical end bits. Exact comparison
	// rejects those, excess padding, whitespace, and URL-safe substitutions while
	// retaining support for both padded and unpadded standard base64.
	if (
		data.byteLength !== decodedLength ||
		(padding > 0
			? canonical !== encoded
			: canonical.slice(0, contentLength) !== encoded)
	)
		throw invalid();
	return data;
}
