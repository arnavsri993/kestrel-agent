export function isForgetConversationCommand(text: string): boolean {
	let normalized = text
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\u2018\u2019]/gu, "'")
		.replace(/\s+/gu, " ")
		.trim();
	// An unanchored quantified suffix can rescan a long punctuation run after
	// every failed start position. Consume the suffix exactly once instead.
	let end = normalized.length;
	while (end > 0 && ".!?".includes(normalized[end - 1]!)) end--;
	normalized = normalized.slice(0, end);
	return /^(?:forget|delete|remove)(?:\s+everything)?\s+(?:you\s+)?(?:remember(?:ed)?|know)\s+(?:from|about)\s+(?:this|the current)\s+conversation$/.test(normalized)
		|| /^(?:don't|do not)\s+(?:remember|use)\s+(?:this|the current)\s+conversation\s+for\s+memory$/.test(normalized)
		|| /^(?:forget|delete|remove)\s+(?:this|the current)\s+conversation(?:\s+from\s+memory)?$/.test(normalized);
}
