export type ReleaseChannel = "development" | "beta" | "stable";

export interface ProductIdentity {
  productName: string;
  internalName: string;
  appId: string;
  protocol: string;
  keychainService: string;
  updateChannel: ReleaseChannel;
  userDataDirectoryName: string;
}

const runtimeProcess = Reflect.get(globalThis, "process") as { env?: Record<string, string | undefined> } | undefined;
const runtimeEnv = runtimeProcess?.env ?? {};
const channel = (runtimeEnv.KESTREL_RELEASE_CHANNEL ?? "development") as ReleaseChannel;
const suffix = channel === "stable" ? "" : `.${channel === "development" ? "dev" : channel}`;

/** Human-visible identity is centralized here; privileged compatibility identifiers migrate separately. */
export const PRODUCT_IDENTITY: ProductIdentity = {
  productName: runtimeEnv.KESTREL_PRODUCT_NAME ?? "Workstrand",
  internalName: "agent-one",
  appId: `com.kestrel.desktop${suffix}`,
  protocol: "kestrel",
  keychainService: `com.kestrel.desktop${suffix}`,
  updateChannel: channel,
  // Keep the existing storage name until a tested data migration can move it
  // without making an installed user's encrypted history appear to disappear.
  userDataDirectoryName: `Kestrel${channel === "stable" ? "" : ` ${channel}`}`
};
