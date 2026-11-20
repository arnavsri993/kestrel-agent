import { createHash } from "node:crypto";
import { RuntimeToolExecutionSchema } from "@kestrel/shared-types";

export const SOURCE_EVIDENCE_REMOVED_TEXT = "Source evidence was deleted or expired.";
export const SOURCE_RECEIPT_DELETION_PREFIX = "source-receipt-deleted.";

export function sourceReceiptDeletionKey(id: string): string {
	return SOURCE_RECEIPT_DELETION_PREFIX + createHash("sha256").update(id).digest("hex");
}

// Pure projection shared by normal journal codecs and read-only migration.
// Generic JSON that merely resembles a tool result remains unchanged.
export function redactDeletedSourceToolResult(value: unknown, isDeleted: (id: string) => boolean): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		(value as Record<string, unknown>).toolName !== "sources.read") return value;
	const execution = RuntimeToolExecutionSchema.safeParse(value);
	if (!execution.success || !isDeleted(execution.data.id)) return value;
	if (execution.data.status === "failed" && execution.data.error === SOURCE_EVIDENCE_REMOVED_TEXT &&
		execution.data.output?.sourceEvidenceRemoved === true && Object.keys(execution.data.output).length === 1) return value;
	return { ...value, status: "failed", output: { sourceEvidenceRemoved: true }, error: SOURCE_EVIDENCE_REMOVED_TEXT };
}
