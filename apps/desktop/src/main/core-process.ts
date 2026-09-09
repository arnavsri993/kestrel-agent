// Host-owned process contract. No Electron or process-launch policy belongs here.
export interface CoreProcess {
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "exit", listener: (code: number | null) => void): unknown;
	once(event: "exit", listener: (code: number | null) => void): unknown;
	postMessage(message: unknown): void;
	kill(): boolean;
}

