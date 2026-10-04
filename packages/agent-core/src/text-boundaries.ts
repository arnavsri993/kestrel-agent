/** Remove a suffix in one backward pass, including when the input has no suffix. */
export function stripTrailingCharacters(text: string, characters: string): string {
	let end = text.length;
	while (end > 0 && characters.includes(text[end - 1]!)) end -= 1;
	return text.slice(0, end);
}
