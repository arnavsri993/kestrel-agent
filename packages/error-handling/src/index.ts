export interface KestrelErrorOptions {
  code: string;
  message: string;
  cause?: Error | unknown;
  metadata?: Record<string, unknown>;
  retryable?: boolean;
}

export class KestrelError extends Error {
  public readonly code: string;
  public readonly metadata?: Record<string, unknown>;
  public readonly retryable: boolean;

  constructor(options: KestrelErrorOptions) {
    super(options.message, { cause: options.cause as Error });
    this.name = "KestrelError";
    this.code = options.code;
    if (options.metadata !== undefined) {
      this.metadata = options.metadata;
    }
    this.retryable = options.retryable ?? false;
  }

  public toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      metadata: this.metadata,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

export function isKestrelError(error: unknown): error is KestrelError {
  return error instanceof KestrelError;
}
