import { isSecureStorageError } from "./credential-broker";

export interface StartupRecoveryCopy {
	message: string;
	detail: string;
}

function errorDetail(cause: unknown): string {
	return cause instanceof Error
		? cause.message.trim()
		: typeof cause === "string"
			? cause.trim()
			: "An unknown startup error occurred.";
}

export function startupRecoveryCopy(cause: unknown): StartupRecoveryCopy {
	const detail = errorDetail(cause);
	if (isSecureStorageError(cause))
		return {
			message: "Kestrel needs access to its encrypted data.",
			detail: `${detail}\n\nKestrel will not open your data without its encryption boundary. Unlock the login keychain and choose “Always Allow” for Kestrel Safe Storage, then try again.`,
		};
	return {
		message: "Kestrel's local Agent Core could not start.",
		detail: `${detail}\n\nThis is separate from Keychain access. Fix the reported Agent Core error or choose Try again.`,
	};
}
