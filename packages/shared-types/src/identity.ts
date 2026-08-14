export type ReleaseChannel = "development" | "beta" | "stable";

export interface ProductIdentity {
	productName: string;
	runtimeApplicationName: string;
	internalName: string;
	appId: string;
	protocol: string;
	keychainService: string;
	updateChannel: ReleaseChannel;
	userDataDirectoryName: string;
}

type ProductEnvironment = Record<string, string | undefined>;

/** Human-visible identity is centralized here; privileged compatibility identifiers migrate separately. */
export function productIdentityForEnvironment(
	runtimeEnv: ProductEnvironment,
): ProductIdentity {
	const requestedChannel = runtimeEnv.KESTREL_RELEASE_CHANNEL;
	const channel: ReleaseChannel =
		requestedChannel === "development" || requestedChannel === "beta"
			? requestedChannel
			: "stable";
	const suffix =
		channel === "stable"
			? ""
			: `.${channel === "development" ? "dev" : channel}`;
	const productName = runtimeEnv.KESTREL_PRODUCT_NAME ?? "Kestrel";
	const runtimeApplicationName = "Kestrel";

	return {
		productName,
		runtimeApplicationName,
		internalName: "agent-one",
		appId: `com.kestrel.desktop${suffix}`,
		protocol: "kestrel",
		// Electron uses the runtime application name as the macOS safeStorage
		// Keychain account and appends " Safe Storage" for the service name.
		// Keep it shared until a tested migration can move existing credentials.
		keychainService: `${runtimeApplicationName} Safe Storage`,
		updateChannel: channel,
		// Keep the existing storage name until a tested data migration can move it
		// without making an installed user's encrypted history appear to disappear.
		userDataDirectoryName: runtimeApplicationName,
	};
}

const runtimeProcess = Reflect.get(globalThis, "process") as
	| { env?: ProductEnvironment }
	| undefined;

export const PRODUCT_IDENTITY = productIdentityForEnvironment(
	runtimeProcess?.env ?? {},
);
