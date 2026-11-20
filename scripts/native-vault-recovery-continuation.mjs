import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const maxBytes = 1024 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const witnessKeys = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function privateFile(info) {
	assert(info.isFile() && !info.isSymbolicLink(), "Evidence must be a regular file without symbolic links.");
	assert.equal(info.uid, BigInt(process.getuid()), "Evidence must belong to the current user.");
	assert.equal(info.nlink, 1n, "Evidence must have exactly one link.");
	assert.equal(info.mode & 0o077n, 0n, "Evidence must be private to the current user.");
	assert(info.size > 0n && info.size <= BigInt(maxBytes), "Evidence must be nonempty and bounded.");
}

function sameWitness(before, after) {
	for (const key of witnessKeys) assert.equal(after[key], before[key], "Evidence changed while being read.");
}

async function readEvidence(path) {
	assert.equal(typeof path, "string");
	assert.equal(path, resolve(path), "Evidence path must be absolute and canonical.");
	assert(!/[\x00-\x1f\x7f]/u.test(path), "Evidence path contains control characters.");
	assert.equal(await realpath(path), path, "Evidence path must not traverse a symbolic link or alias.");
	const before = await lstat(path, { bigint: true });
	privateFile(before);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat({ bigint: true });
		privateFile(opened); sameWitness(before, opened);
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const chunk = await handle.read(bytes, length, bytes.length - length, length);
			if (chunk.bytesRead === 0) break;
			length += chunk.bytesRead;
		}
		assert.equal(BigInt(length), opened.size, "Evidence size changed while being read.");
		sameWitness(opened, await handle.stat({ bigint: true }));
		const after = await lstat(path, { bigint: true });
		privateFile(after); sameWitness(opened, after);
		assert.equal(await realpath(path), path, "Evidence path changed while being read.");
		const content = bytes.subarray(0, length);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
		return { value: JSON.parse(text), sha256: createHash("sha256").update(content).digest("hex") };
	} finally { await handle.close(); }
}

function object(value, label) {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
	return value;
}

function exactKeys(value, expected, label) {
	assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields are invalid.`);
}

function validSha(value, label) {
	assert.equal(typeof value, "string", `${label} must be a SHA-256 digest.`);
	assert.match(value, sha256, `${label} must be a lowercase SHA-256 digest.`);
}

function absoluteCanonical(value, label) {
	assert.equal(typeof value, "string", `${label} must be a path.`);
	assert.equal(value, resolve(value), `${label} must be absolute and canonical.`);
	assert(!/[\x00-\x1f\x7f]/u.test(value), `${label} contains control characters.`);
	return value;
}

function candidatePath(value) {
	const candidate = absoluteCanonical(value, "Candidate");
	const tempRoot = join(repositoryRoot, ".tmp");
	const parts = relative(tempRoot, candidate).split(/[\\/]/u);
	assert.equal(parts.length, 2, "Candidate must be a direct build under repository .tmp.");
	assert(!parts.includes("..") && parts[0] !== "native-chromium-host" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[0]), "Candidate build path is reserved or invalid.");
	assert.equal(parts[1], "Kestrel.app", "Candidate must be a disposable Kestrel.app under repository .tmp.");
	assert.equal(dirname(candidate), join(tempRoot, parts[0]));
	return candidate;
}

async function temporaryProfile(value, label) {
	const path = absoluteCanonical(value, label);
	const temporaryRoot = await realpath(tmpdir());
	assert.equal(dirname(path), temporaryRoot, `${label} must be a direct temporary profile directory.`);
	assert(basename(path).startsWith("kestrel-chromium-desktop-canary-"), `${label} does not have the generated profile name.`);
	return path;
}

function passingPhase(receipt, name) {
	assert(Array.isArray(receipt.phases), "Failed receipt phases are missing.");
	assert(receipt.phases.some(item => item?.phase === name && item.passed === true), `Required phase ${name} did not pass.`);
}

function reviewSelection(value, relativePath) {
	object(value, "Reviewed selection");
	exactKeys(value, ["version", "active", "previous", "handoffs"], "Reviewed selection");
	assert.equal(value.version, 2); assert.equal(value.active, ""); assert.equal(value.previous, "");
	object(value.handoffs, "Reviewed handoffs");
	exactKeys(value.handoffs, ["", relativePath], "Reviewed handoffs");
	assert.equal(value.handoffs[""], null);
	assert.match(value.handoffs[relativePath], uuid, "Prepared handoff identifier is invalid.");
	return structuredClone(value);
}

function interruptionProof(value, receipt, candidate, candidateSha256, relativePath, reviewedSelection, postFailureWitnesses) {
	object(value, "Interruption proof");
	assert.equal(value.boundary, "published-before-activation");
	for (const flag of ["workerSignalled", "sourceKeyExported", "productWorkerInjected"]) assert.equal(value[flag], false, `${flag} must be false.`);
	const parent = object(value.parent, "Interrupted parent identity");
	assert(Number.isSafeInteger(parent.pid) && parent.pid > 1);
	assert(Number.isSafeInteger(parent.ppid) && parent.ppid > 1);
	assert.equal(parent.executable, join(candidate, "Contents/MacOS/Kestrel"));
	assert.equal(typeof parent.started, "string"); assert(parent.started.length > 0);
	const worker = object(value.journalOwner, "Journal worker identity");
	assert(Number.isSafeInteger(worker.pid) && worker.pid > 1);
	assert(Number.isSafeInteger(worker.ppid) && worker.ppid === parent.pid);
	assert.equal(worker.executable, join(candidate, "Contents/Resources/agent-core/node/bin/node"));
	assert.equal(typeof worker.started, "string"); assert(worker.started.length > 0);
	assert(Array.isArray(receipt.stages), "Failed receipt stages are missing.");
	const stages = receipt.stages.filter(item => item?.stage === "published-crash-D");
	assert.equal(stages.length, 1, "Failed receipt must contain exactly one published crash stage.");
	const stage = stages[0];
	assert.deepEqual(stage.parent, parent, "Interruption parent does not match the failed receipt.");
	assert.deepEqual(stage.journalOwner, worker, "Journal owner does not match the failed receipt.");
	assert.equal(stage.boundary, value.boundary);
	assert.equal(stage.workerSignalled, false); assert.equal(stage.sourceKeyExported, false); assert.equal(stage.productWorkerInjected, false);
	assert.equal(stage.pid, parent.pid); assert.equal(stage.code, null); assert.equal(stage.signal, "SIGKILL");
	const witnessFields = ["preparedRelative", "reviewedSelection", "journalSha256", "vaultSha256"];
	const completeWitnesses = witnessFields.every(key => Object.hasOwn(stage, key));
	assert(completeWitnesses || witnessFields.every(key => !Object.hasOwn(stage, key)), "Published crash witnesses are partial.");
	if (completeWitnesses) {
		assert.equal(stage.preparedRelative, relativePath, "Published crash stage maps to a different prepared profile.");
		assert.deepEqual(stage.reviewedSelection, reviewedSelection, "Published crash stage maps to a different reviewed selection.");
	} else assert(postFailureWitnesses, "Older crash evidence requires an explicit post-failure generated-fixture checkpoint.");
	assert.equal(receipt.candidate, candidate);
	assert.equal(receipt.candidateSha256, candidateSha256);
	return structuredClone(value);
}

// Continuation adoption is evidence-only. It never opens or stats profile paths.
export async function loadNativeVaultRecoveryContinuation(path, { candidateSha256 }) {
	assert.equal(typeof path, "string");
	const continuationPath = absoluteCanonical(path, "Continuation");
	validSha(candidateSha256, "Current candidate digest");
	const { value, sha256: continuationSha256 } = await readEvidence(continuationPath);
	const spec = object(value, "Recovery continuation");
	exactKeys(spec, ["kind", "version", "nonce", "candidateSha256", "failedReceipt", "interruption", "preparedRelative", "reviewedSelection", "journalSha256", "vaultSha256", ...(Object.hasOwn(spec,"witnessOrigin") ? ["witnessOrigin"] : [])], "Recovery continuation");
	assert(spec.witnessOrigin === undefined || ["published-crash-stage", "post-failure-generated-fixture"].includes(spec.witnessOrigin), "Unknown recovery witness origin.");
	assert.equal(spec.kind, "native-vault-recovery-continuation"); assert.equal(spec.version, 1);
	assert.match(spec.nonce, /^[a-f0-9]{8}$/u, "Continuation nonce is invalid.");
	assert.equal(spec.candidateSha256, candidateSha256, "Continuation belongs to a different candidate build.");
	validSha(spec.journalSha256, "Journal digest"); validSha(spec.vaultSha256, "Vault digest");
	assert.match(spec.preparedRelative, /^native-core-profiles\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, "Prepared profile reference is invalid.");
	const preparedRelative = spec.preparedRelative;
	const reviewed = reviewSelection(spec.reviewedSelection, preparedRelative);

	for (const [name, reference] of [["failed receipt", spec.failedReceipt], ["interruption", spec.interruption]]) {
		object(reference, `${name} reference`); exactKeys(reference, ["path", "sha256"], `${name} reference`);
		absoluteCanonical(reference.path, `${name} reference path`); validSha(reference.sha256, `${name} reference digest`);
	}
	assert.notEqual(spec.failedReceipt.path, spec.interruption.path, "Receipt and interruption evidence must be separate files.");
	const [{ value: receipt, sha256: failedReceiptSha256 }, { value: interruption, sha256: interruptionSha256 }] = await Promise.all([
		readEvidence(spec.failedReceipt.path), readEvidence(spec.interruption.path),
	]);
	assert.equal(failedReceiptSha256, spec.failedReceipt.sha256, "Failed receipt digest changed.");
	assert.equal(interruptionSha256, spec.interruption.sha256, "Interruption evidence digest changed.");
	object(receipt, "Failed receipt");
	assert.equal(receipt.kind, "native-vault-published-recovery-canary"); assert.equal(receipt.version, 1);
	assert.equal(receipt.result, "failed"); assert.equal(receipt.failedStage, "restart-D-after-crash");
	assert.equal(receipt.exactCandidateAbsent, true); assert.equal(receipt.generatedProfilesRemoved, false);
	assert.equal(receipt.publishedRecoveryRequested, true); assert.equal(receipt.modalQuitRequested, false);
	const candidate = candidatePath(receipt.candidate);
	assert.equal(receipt.candidateSha256, candidateSha256); assert.equal(receipt.candidateSha256After, candidateSha256);
	const profiles = object(receipt.retainedProfiles, "Retained profiles"); exactKeys(profiles, ["A", "D"], "Retained profiles");
	const sourceProfile = await temporaryProfile(profiles.A, "Source profile");
	const ownerProfile = await temporaryProfile(profiles.D, "Owner profile");
	assert.notEqual(sourceProfile, ownerProfile, "Source and owner profiles must be distinct.");
	const fixtureEvidence = object(receipt.fixtureEvidence, "Fixture evidence"); exactKeys(fixtureEvidence, ["A", "D"], "Fixture evidence");
	for (const name of ["A", "D"]) {
		const evidence = object(fixtureEvidence[name], `${name} fixture evidence`);
		assert.equal(evidence.kind, "native-browser-fixture-storage"); assert.equal(evidence.version, 1);
		assert.equal(evidence.mode, "production-vault"); assert.equal(evidence.candidate, candidate);
		assert.equal(evidence.candidateSha256, candidateSha256);
		assert.equal(evidence.profile, name === "A" ? sourceProfile : ownerProfile);
		validSha(evidence.vaultSha256, `${name} vault digest`);
	}
	const sourceSnapshot = object(object(receipt.sourceSnapshots, "Source snapshots").A, "Source snapshot A");
	passingPhase(receipt, "A-production-vault-generated-session-restart-readback-and-snapshot");
	passingPhase(receipt, "production-published-parent-crash-left-source-and-selection-preserved");
	const interruptionProofValue = interruptionProof(interruption, receipt, candidate, candidateSha256, preparedRelative, reviewed, spec.witnessOrigin === "post-failure-generated-fixture");
	const crashStage = receipt.stages.find(item => item?.stage === "published-crash-D");
	if (Object.hasOwn(crashStage,"journalSha256")) {
		assert.equal(crashStage.journalSha256, spec.journalSha256, "Journal digest does not match the continuation.");
		assert.equal(crashStage.vaultSha256, spec.vaultSha256, "Published recovery vault digest does not match the continuation.");
	}

	const nonce = spec.nonce;
	return {
		path: continuationPath,
		sha256: continuationSha256,
		spec: structuredClone(spec),
		failedReceipt: receipt,
		failedReceiptSha256,
		interruption: interruptionProofValue,
		interruptionSha256,
		witnessOrigin: Object.hasOwn(crashStage,"journalSha256") ? "published-crash-stage" : "post-failure-generated-fixture",
		sourceProfile,
		ownerProfile,
		prepared: { relative: preparedRelative, child: join(ownerProfile, preparedRelative), reviewedSelection: reviewed },
		sourceSnapshot,
		fixtureEvidence,
		sourceExpectation: { title: `Vault transfer A ${nonce}`, message: `Generated A message ${nonce}` },
		originalTitle: `Recovery D original ${nonce}`,
	};
}
