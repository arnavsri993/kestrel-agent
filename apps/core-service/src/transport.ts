export interface CoreParentPort {
	on(event: "message", listener: (event: { data: unknown }) => void): void;
	postMessage(message: unknown): void;
}
