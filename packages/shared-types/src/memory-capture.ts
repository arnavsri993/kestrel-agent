/**
 * Parses an explicit "remember that …" user command. Returns the captured fact
 * text when the message is a direct memory capture, otherwise undefined.
 */
export function parseExplicitMemoryCapture(text: string): string | undefined {
	return text
		.trim()
		.match(/^remember(?:\s+that)?\s+([\s\S]{1,100000})$/i)?.[1]
		?.trim();
}
