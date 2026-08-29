import type { MemoryRecallReceipt } from "./contracts";

export function buildMemoryRecallReceipt(input: {
	localMemoryCount?: number;
	userModelContext?: string;
	honchoContext?: string;
}): MemoryRecallReceipt | undefined {
	const memoryCount = Math.max(0, input.localMemoryCount ?? 0);
	const preferenceCount = countUserModelFacts(input.userModelContext ?? "");
	const honchoIncluded = Boolean(input.honchoContext?.trim());
	if (memoryCount === 0 && preferenceCount === 0 && !honchoIncluded)
		return undefined;
	return {
		memoryCount,
		preferenceCount,
		...(honchoIncluded ? { honchoIncluded: true } : {}),
	};
}

function countUserModelFacts(context: string): number {
	const trimmed = context.trim();
	if (!trimmed) return 0;
	return trimmed.split("\n").filter((line) => line.startsWith("- ")).length;
}

export function formatMemoryRecallReceipt(
	receipt: MemoryRecallReceipt,
): string {
	const parts: string[] = [];
	if (receipt.memoryCount > 0) {
		parts.push(
			`${receipt.memoryCount} ${receipt.memoryCount === 1 ? "memory" : "memories"}`,
		);
	}
	if (receipt.preferenceCount > 0) {
		parts.push(
			`${receipt.preferenceCount} confirmed ${receipt.preferenceCount === 1 ? "preference" : "preferences"}`,
		);
	}
	if (receipt.honchoIncluded) parts.push("optional remote memory");
	const summary =
		parts.length === 1
			? parts[0]!
			: parts.length === 2
				? `${parts[0]} · ${parts[1]}`
				: `${parts.slice(0, -1).join(" · ")} · ${parts.at(-1)}`;
	return `Used ${summary} from Life → Memory for this reply.`;
}
