import { describe, expect, it } from "vitest";
import { productIdentityForEnvironment } from "./identity";

describe("product identity", () => {
	it.each([
		{
			channel: "stable",
			environment: {},
			expected: {
				appId: "com.kestrel.desktop",
				keychainService: "Kestrel Safe Storage",
				runtimeApplicationName: "Kestrel",
				updateChannel: "stable",
				userDataDirectoryName: "Kestrel",
			},
		},
		{
			channel: "development",
			environment: { KESTREL_RELEASE_CHANNEL: "development" },
			expected: {
				appId: "com.kestrel.desktop.dev",
				keychainService: "Kestrel Safe Storage",
				runtimeApplicationName: "Kestrel",
				updateChannel: "development",
				userDataDirectoryName: "Kestrel",
			},
		},
	])(
		"uses the $channel bundle/update identity without orphaning data",
		({ environment, expected }) => {
			expect(productIdentityForEnvironment(environment)).toMatchObject({
				productName: "Kestrel",
				...expected,
			});
		},
	);

	it("fails closed to the stable identity for a removed channel", () => {
		expect(
			productIdentityForEnvironment({ KESTREL_RELEASE_CHANNEL: "beta" }),
		).toMatchObject({
			appId: "com.kestrel.desktop",
			keychainService: "Kestrel Safe Storage",
			updateChannel: "stable",
			userDataDirectoryName: "Kestrel",
		});
	});

	it("keeps privileged compatibility identity fixed across visible renames", () => {
		expect(
			productIdentityForEnvironment({ KESTREL_PRODUCT_NAME: "Field Agent" }),
		).toMatchObject({
			productName: "Field Agent",
			runtimeApplicationName: "Kestrel",
			keychainService: "Kestrel Safe Storage",
			userDataDirectoryName: "Kestrel",
		});
	});
});
