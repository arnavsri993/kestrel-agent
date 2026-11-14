import { describe, expect, it } from "vitest";
import { decodeVoiceRecording } from "./voice-recording";

describe("voice recording base64 validation", () => {
	it("retains exact bytes for standard padded and unpadded edge lengths", () => {
		for (const bytes of [
			[0],
			[255],
			[0, 255],
			[251, 255, 255],
			[0, 1, 2, 3],
			[0, 1, 2, 3, 4],
			[0, 1, 2, 3, 4, 5],
		]) {
			const data = Buffer.from(bytes);
			const padded = data.toString("base64");
			const unpadded = padded.split("=")[0]!;
			expect(decodeVoiceRecording(padded)).toEqual(data);
			expect(decodeVoiceRecording(unpadded)).toEqual(data);
		}
	});

	it.each([
		"",
		"=",
		"==",
		"A",
		"AAAAA",
		"AA=",
		"AAA==",
		"AAAA=",
		"AAAA==",
		"AAAA====",
		"AA===",
		"AA====",
		"AA=A",
		"AA==AA",
		"AA==!",
		"AA\n",
		" AA==",
		"AA==\n",
		"AA!A",
		"_w==",
		"-w==",
		"AB",
		"AB==",
		"AAB",
		"AAB=",
	])("rejects malformed or noncanonical input %j", (encoded) => {
		expect(() => decodeVoiceRecording(encoded)).toThrow(
			"Voice recording contains invalid base64 data.",
		);
	});

	it("rejects long repeated padding with and without trailing garbage", () => {
		const padding = "=".repeat(1_000_000);
		for (const encoded of [`AA${padding}`, `AA${padding}!`, padding]) {
			expect(() => decodeVoiceRecording(encoded)).toThrow(
				"Voice recording contains invalid base64 data.",
			);
		}
	});

	it("accepts the decoded byte limit and rejects the next byte before decoding", () => {
		const limit = 25 * 1024 * 1024;
		const data = Buffer.alloc(limit, 255);
		const encoded = data.toString("base64");
		expect(decodeVoiceRecording(encoded).equals(data)).toBe(true);
		expect(decodeVoiceRecording(encoded.slice(0, -2)).equals(data)).toBe(true);
		for (const oversized of [
			Buffer.alloc(limit + 1).toString("base64"),
			Buffer.alloc(limit + 2).toString("base64"),
		]) {
			expect(() => decodeVoiceRecording(oversized)).toThrow(
				"Voice recording must be between 1 byte and 25 MB.",
			);
		}
	});
});
