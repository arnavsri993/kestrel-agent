type StoppableStream = { getTracks(): readonly { stop(): void }[] };

export type VoiceCapture<Stream extends StoppableStream> = {
	stream: Stream;
	isCurrent(): boolean;
	release(): void;
};

/** Owns pending permission, late media streams, and one recording at a time. */
export class VoiceCaptureOwner<Stream extends StoppableStream = MediaStream> {
	private current: { stream?: Stream } | undefined;

	get busy(): boolean { return this.current !== undefined; }

	cancel(): void {
		const attempt = this.current;
		this.current = undefined;
		attempt?.stream?.getTracks().forEach((track) => track.stop());
	}

	async acquire(
		requestPermission: () => Promise<void>,
		openStream: () => Promise<Stream>,
	): Promise<VoiceCapture<Stream> | undefined> {
		if (this.current) return undefined;
		const attempt: { stream?: Stream } = {};
		this.current = attempt;
		try {
			await requestPermission();
			if (this.current !== attempt) return undefined;
			const stream = await openStream();
			if (this.current !== attempt) {
				stream.getTracks().forEach((track) => track.stop());
				return undefined;
			}
			attempt.stream = stream;
			return {
				stream,
				isCurrent: () => this.current === attempt,
				release: () => { if (this.current === attempt) this.cancel(); },
			};
		} catch (error) {
			if (this.current !== attempt) return undefined;
			this.cancel();
			throw error;
		}
	}
}
