import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	resolve(
		import.meta.dirname,
		"..",
		".github",
		"workflows",
		"release-macos.yml",
	),
	"utf8",
);
const builder = readFileSync(
	resolve(
		import.meta.dirname,
		"..",
		"apps",
		"desktop",
		"electron-builder.yml",
	),
	"utf8",
);
const websiteWorkflow = readFileSync(
	resolve(
		import.meta.dirname,
		"..",
		".github",
		"workflows",
		"deploy-website.yml",
	),
	"utf8",
);

function between(start, end) {
	const startIndex = workflow.indexOf(start);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	const endIndex = end
		? workflow.indexOf(end, startIndex + start.length)
		: workflow.length;
	expect(endIndex).toBeGreaterThan(startIndex);
	return workflow.slice(startIndex, endIndex);
}

describe("macOS release workflow security contract", () => {
	it("uses GitHub Releases as the stable installation and update source", () => {
		expect(builder).toContain("provider: github");
		expect(builder).toContain("owner: arnavsri993");
		expect(builder).toContain("repo: kestrel-agent");
		expect(builder).toContain("releaseType: release");
		expect(builder).toContain("channel: latest");
		expect(builder).not.toContain("provider: generic");
		expect(builder).not.toContain("KESTREL_UPDATE_URL");
		expect(workflow).not.toContain("KESTREL_UPDATE_URL");
	});

	it("keeps verification read-only and release credentials step-local", () => {
		expect(workflow).toContain("permissions:\n  contents: read");

		const verifyJob = between("  verify-source:", "\n  sign-and-package:");
		const verifyJobHeader = verifyJob.slice(
			0,
			verifyJob.indexOf("\n    steps:"),
		);
		expect(verifyJobHeader).not.toContain("env:");
		expect(verifyJobHeader).not.toContain("contents: write");
		expect(verifyJob).toContain("persist-credentials: false");
		expect(verifyJob).not.toContain("secrets.");

		const signingJob = between("  sign-and-package:", "\n  publish:");
		expect(signingJob).toContain("needs: verify-source");
		expect(signingJob).toContain("environment:\n      name: macos-release");
		expect(signingJob).toContain("Require a stable release identity");
		const credentialStep = between(
			"      - name: Require release credentials",
			"      - name: Build signed Apple Silicon DMG, ZIP, and MDM PKG",
		);
		const buildStep = between(
			"      - name: Build signed Apple Silicon DMG, ZIP, and MDM PKG",
			"      - name: Verify signature and Gatekeeper",
		);
		const signingSecrets = [
			"CSC_LINK",
			"CSC_KEY_PASSWORD",
			"CSC_INSTALLER_LINK",
			"CSC_INSTALLER_KEY_PASSWORD",
			"APPLE_ID",
			"APPLE_APP_SPECIFIC_PASSWORD",
			"APPLE_TEAM_ID",
		];
		for (const secret of signingSecrets) {
			const reference = `\${{ secrets.${secret} }}`;
			expect(workflow.split(reference)).toHaveLength(3);
			expect(credentialStep).toContain(reference);
			expect(buildStep).toContain(reference);
		}

		expect(workflow.split("GH_TOKEN: ${{ github.token }}")).toHaveLength(3);
		expect(between("\n  publish:")).toContain("GH_TOKEN: ${{ github.token }}");
	});

	it("serializes each ref and never publishes a manual dispatch", () => {
		expect(workflow).toContain(
			"concurrency:\n  group: macos-release-${{ github.ref }}\n  cancel-in-progress: false",
		);

		const publishJob = between("\n  publish:");
		expect(publishJob).toContain(
			"if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
		);
		expect(publishJob).toContain("needs: sign-and-package");
		expect(publishJob).toContain("permissions:\n      contents: write");
		expect(publishJob).toContain(
			"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8",
		);
		expect(workflow).toContain(
			"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7",
		);
		expect(
			workflow.split("node scripts/verify-release-bundle.mjs release"),
		).toHaveLength(3);
		expect(workflow).toContain('test "$GITHUB_REF_NAME" = "v$version"');
		expect(publishJob).toContain(
			'gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_REF_NAME" --jq .sha',
		);
	});

	it("resumes only a matching draft and verifies every asset before publishing", () => {
		const publishStep = between("      - name: Publish verified tag artifacts");
		expect(publishStep).toContain("gh release view");
		expect(publishStep).toContain("kestrel-release-commit:$GITHUB_SHA");
		expect(publishStep).toContain("matching draft");
		expect(publishStep).toContain("exit 1");
		expect(publishStep).toContain("gh release create");
		expect(publishStep).toContain("--verify-tag");
		expect(publishStep).toContain("--generate-notes");
		expect(publishStep).toContain("--draft");
		expect(publishStep).toContain("gh release upload");
		expect(publishStep.split("gh release upload")).toHaveLength(2);
		expect(publishStep).not.toContain("--clobber");
		expect(publishStep).toContain(".digest");
		expect(publishStep).toContain(".size");
		expect(publishStep).toContain('.state == "uploaded"');
		expect(publishStep).toContain("gh release edit");
		expect(publishStep).toContain("--draft=false");
		expect(publishStep).toContain("--latest");
		for (const asset of [
			"release/*.dmg",
			"release/*.zip",
			"release/*.pkg",
			"release/*.blockmap",
			"release/latest-mac.yml",
			"release/SHA256SUMS",
			"release/release-manifest.json",
		]) {
			expect(publishStep).toContain(asset);
		}

		const createIndex = publishStep.indexOf("gh release create");
		const uploadIndex = publishStep.indexOf("gh release upload");
		const publishIndex = publishStep.indexOf("gh release edit");
		expect(createIndex).toBeGreaterThan(publishStep.indexOf("gh release view"));
		expect(uploadIndex).toBeGreaterThan(createIndex);
		expect(publishIndex).toBeGreaterThan(uploadIndex);
	});

	it("keeps Pages deployment credentials out of the dependency-running build", () => {
		const beforeJobs = websiteWorkflow.slice(
			0,
			websiteWorkflow.indexOf("\njobs:"),
		);
		expect(beforeJobs).toContain("permissions:\n  contents: read");
		expect(beforeJobs).not.toContain("pages: write");
		expect(beforeJobs).not.toContain("id-token: write");

		const deployJob = websiteWorkflow.slice(
			websiteWorkflow.indexOf("\n  deploy:"),
		);
		expect(deployJob).toContain(
			"permissions:\n      pages: write\n      id-token: write",
		);
		for (const pinnedAction of [
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
			"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
			"actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6",
			"actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5",
			"actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5",
		]) {
			expect(websiteWorkflow).toContain(pinnedAction);
		}
	});
});
