export const NATIVE_PROVIDER_REQUEST_TYPES = new Set([
	"credential-list", "credential-set", "credential-remove",
	"provider-account-list", "provider-account-create", "provider-account-update", "provider-account-remove", "provider-account-connect",
	"subscription-cli-status", "subscription-cli-set",
	"oauth-chatgpt-connect", "oauth-chatgpt-cancel",
	"local-model-status", "local-model-pull", "local-runtime-bootstrap", "local-runtime-cancel",
]);
