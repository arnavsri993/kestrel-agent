export function learnedSkillDisplayName(name: string): string {
	const readable = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	if (!readable) return name;
	return `${readable[0]!.toUpperCase()}${readable.slice(1)}`;
}
