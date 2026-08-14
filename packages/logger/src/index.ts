export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
	context?: Record<string, unknown>;
	error?: Error;
}

export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(
		message: string,
		error?: Error,
		context?: Record<string, unknown>,
	): void;
	child(context: Record<string, unknown>): Logger;
}

export class NoopLogger implements Logger {
	debug() {}
	info() {}
	warn() {}
	error() {}
	child() {
		return this;
	}
}

export class ConsoleLogger implements Logger {
	constructor(private readonly baseContext?: Record<string, unknown>) {}

	private log(
		level: LogLevel,
		message: string,
		error?: Error,
		context?: Record<string, unknown>,
	) {
		const entry: LogEntry = {
			level,
			message,
			timestamp: new Date().toISOString(),
			context: { ...this.baseContext, ...context },
		};

		if (error) {
			entry.error = error;
		}

		// In a real application, we might format this differently based on environment.
		// For now, we output structured JSON or a readable format.
		const output = JSON.stringify(entry);

		switch (level) {
			case "debug":
				// eslint-disable-next-line no-console
				console.debug(output);
				break;
			case "info":
				// eslint-disable-next-line no-console
				console.info(output);
				break;
			case "warn":
				// eslint-disable-next-line no-console
				console.warn(output);
				break;
			case "error":
				// eslint-disable-next-line no-console
				console.error(output);
				break;
		}
	}

	debug(message: string, context?: Record<string, unknown>) {
		this.log("debug", message, undefined, context);
	}

	info(message: string, context?: Record<string, unknown>) {
		this.log("info", message, undefined, context);
	}

	warn(message: string, context?: Record<string, unknown>) {
		this.log("warn", message, undefined, context);
	}

	error(message: string, error?: Error, context?: Record<string, unknown>) {
		this.log("error", message, error, context);
	}

	child(context: Record<string, unknown>): Logger {
		return new ConsoleLogger({ ...this.baseContext, ...context });
	}
}
