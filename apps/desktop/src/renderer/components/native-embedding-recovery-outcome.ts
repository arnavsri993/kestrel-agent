export type RepairOutcome = "idle" | "in-progress" | "applied" | "restart-required" | "unconfirmed";
type Storage = Pick<StorageEventTarget, "getItem" | "setItem" | "removeItem">;
type StorageEventTarget = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
const KEY = "kestrel.memory-repair-outcome.v1";

export function createRepairOutcomeStore(storage?: Storage) {
	const listeners = new Set<() => void>();
	let outcome: RepairOutcome = "idle";
	let applying = false;
	try {
		const saved = storage?.getItem(KEY);
		if (saved === "in-progress") outcome = "unconfirmed";
		else if (saved === "applied" || saved === "restart-required" || saved === "unconfirmed") outcome = saved;
	} catch { /* Storage may be unavailable. */ }
	function set(next: RepairOutcome) {
		outcome = next;
		try { if (next === "idle") storage?.removeItem(KEY); else storage?.setItem(KEY, next); } catch { /* Keep in-memory status. */ }
		listeners.forEach(listener => listener());
	}
	return {
		get: () => outcome,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		set,
		async apply(run: () => Promise<"applied" | "restart-required">) {
			applying = true; set("in-progress");
			try { set(await run()); } catch { set("unconfirmed"); } finally { applying = false; }
		},
		reconcile(status: RepairOutcome) {
			if (applying) return;
			set(status);
		},
	};
}

let storage: Storage | undefined;
try { storage = window.sessionStorage; } catch { /* Storage may be unavailable. */ }
export const repairOutcome = createRepairOutcomeStore(storage);
