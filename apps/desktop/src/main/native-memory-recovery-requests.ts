export const NATIVE_MEMORY_RECOVERY_REQUEST_TYPES = new Set([
	"memory-recovery-save-file",
	"memory-recovery-open-file",
]);

/** These requests carry backup data and are reserved for the trusted recovery host. */
export function isNativeMemoryRecoveryInternalRequest(type: string): boolean {
	return type === "memory-recovery-export" || type === "memory-recovery-preview";
}
