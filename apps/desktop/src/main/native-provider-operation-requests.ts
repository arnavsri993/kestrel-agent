/** Mutations whose lifetime belongs to the requesting first-party renderer. */
export const NATIVE_PROVIDER_OPERATION_REQUEST_TYPES = new Set([
	"oauth-google-connect",
	"oauth-google-disconnect",
	"external-secret-save",
	"external-secret-sync",
	"external-secret-install-bitwarden",
	"external-secret-remove",
]);
