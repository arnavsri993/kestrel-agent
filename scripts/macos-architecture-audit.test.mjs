import { describe, expect, it } from "vitest";
import {
	minosExceedsLimit,
	parseLipoArchitectures,
	parseMinos,
} from "./macos-architecture-audit.cjs";

describe("Apple Silicon packaging audit", () => {
	it("accepts thin arm64 slices and rejects extra architectures", () => {
		expect(
			parseLipoArchitectures(
				"Non-fat file: Kestrel is architecture: arm64\n",
			),
		).toEqual(["arm64"]);
		expect(
			parseLipoArchitectures(
				"Architectures in the fat file: helper are: arm64 x86_64\n",
			),
		).toEqual(["arm64", "x86_64"]);
	});

	it("treats macOS 13 as the highest packaged minos", () => {
		expect(parseMinos("platform MACOS\n    minos 12.0\n")).toEqual([12, 0]);
		expect(minosExceedsLimit([12, 0])).toBe(false);
		expect(minosExceedsLimit([13, 0, 0])).toBe(false);
		expect(minosExceedsLimit([13, 1])).toBe(true);
		expect(minosExceedsLimit([15, 0])).toBe(true);
	});
});
