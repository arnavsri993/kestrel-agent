import { z } from "zod";

/**
 * Kestrel owns these values instead of exposing a runtime vendor's vocabulary.
 * A future Chromium adapter can improve a capability without changing the UI or
 * persisted compatibility evidence.
 */
export const ExtensionCapabilityStatusSchema = z.enum([
	"full",
	"partial",
	"emulated",
	"unsupported",
	"unknown",
]);
export type ExtensionCapabilityStatus = z.infer<
	typeof ExtensionCapabilityStatusSchema
>;

export const ExtensionCompatibilityStateSchema = z.enum([
	"verified",
	"expected_compatible",
	"partial",
	"unsupported",
	"unknown",
]);
export type ExtensionCompatibilityState = z.infer<
	typeof ExtensionCompatibilityStateSchema
>;

export const ExtensionCompatibilityEvidenceSchema = z.enum([
	"electron_documented",
	"manifest",
	"static_analysis",
	"runtime",
	"restart",
]);
export type ExtensionCompatibilityEvidence = z.infer<
	typeof ExtensionCompatibilityEvidenceSchema
>;

export const ExtensionCompatibilityFindingSchema = z.object({
	capability: z.string().min(1).max(200),
	status: ExtensionCapabilityStatusSchema,
	reason: z.string().min(1).max(600),
	evidence: ExtensionCompatibilityEvidenceSchema,
});
export type ExtensionCompatibilityFinding = z.infer<
	typeof ExtensionCompatibilityFindingSchema
>;

export const ExtensionManifestInspectionSchema = z.object({
	manifestVersion: z.number().int().min(1).max(4).nullable(),
	permissions: z.array(z.string().min(1).max(200)).max(200),
	optionalPermissions: z.array(z.string().min(1).max(200)).max(200),
	hostPermissions: z.array(z.string().min(1).max(2_000)).max(200),
	optionalHostPermissions: z.array(z.string().min(1).max(2_000)).max(200),
	contentScriptCount: z.number().int().min(0).max(10_000),
	background: z.enum(["none", "page", "service_worker"]),
	commands: z.array(z.string().min(1).max(200)).max(100),
	hasAction: z.boolean(),
	hasSidePanel: z.boolean(),
	hasDeclarativeNetRequest: z.boolean(),
	hasExternallyConnectable: z.boolean(),
	webAccessibleResourceCount: z.number().int().min(0).max(10_000),
	minimumChromeVersion: z.string().max(100).optional(),
	incognito: z.string().max(100).optional(),
	contentSecurityPolicy: z.string().max(2_000).optional(),
	unknownManifestKeys: z.array(z.string().min(1).max(200)).max(200),
});
export type ExtensionManifestInspection = z.infer<
	typeof ExtensionManifestInspectionSchema
>;

export const ExtensionStaticAnalysisSchema = z.object({
	filesScanned: z.number().int().min(0).max(10_000),
	sourceBytesScanned: z.number().int().min(0).max(100 * 1024 * 1024),
	truncated: z.boolean(),
	dynamicApiAccessDetected: z.boolean(),
});
export type ExtensionStaticAnalysis = z.infer<
	typeof ExtensionStaticAnalysisSchema
>;

export const ExtensionRuntimeCheckSchema = z.enum([
	"not_checked",
	"passed",
	"failed",
	"not_applicable",
]);
export type ExtensionRuntimeCheck = z.infer<typeof ExtensionRuntimeCheckSchema>;

export const ExtensionRuntimeVerificationSchema = z.object({
	status: z.enum(["not_run", "passed", "failed"]),
	registered: ExtensionRuntimeCheckSchema,
	ready: ExtensionRuntimeCheckSchema,
	backgroundServiceWorker: ExtensionRuntimeCheckSchema,
	contentScripts: ExtensionRuntimeCheckSchema,
	storageLocal: ExtensionRuntimeCheckSchema,
	extensionAction: ExtensionRuntimeCheckSchema,
	hostPermissions: ExtensionRuntimeCheckSchema,
	remainedLoaded: ExtensionRuntimeCheckSchema,
	persistedAcrossRestart: ExtensionRuntimeCheckSchema,
	checkedAt: z.string().datetime().optional(),
	findings: z.array(ExtensionCompatibilityFindingSchema).max(100),
});
export type ExtensionRuntimeVerification = z.infer<
	typeof ExtensionRuntimeVerificationSchema
>;

export const ExtensionCompatibilityReportSchema = z.object({
	state: ExtensionCompatibilityStateSchema,
	summary: z.string().min(1).max(600),
	manifest: ExtensionManifestInspectionSchema,
	declaredRequirements: z.array(z.string().min(1).max(200)).max(400),
	detectedApiUsage: z.array(z.string().min(1).max(200)).max(400),
	findings: z.array(ExtensionCompatibilityFindingSchema).max(400),
	staticAnalysis: ExtensionStaticAnalysisSchema,
	runtime: ExtensionRuntimeVerificationSchema,
});
export type ExtensionCompatibilityReport = z.infer<
	typeof ExtensionCompatibilityReportSchema
>;

export const ChromeWebStoreExtensionInspectionSchema = z.object({
	/** Single-use opaque review handle. It authorizes no package other than this inspection. */
	inspectionId: z.string().uuid(),
	id: z.string().regex(/^[a-p]{32}$/),
	name: z.string().min(1).max(200),
	version: z.string().min(1).max(50),
	description: z.string().max(2_000).optional(),
	source: z.literal("chrome_web_store"),
	compatibility: ExtensionCompatibilityReportSchema,
});
export type ChromeWebStoreExtensionInspection = z.infer<
	typeof ChromeWebStoreExtensionInspectionSchema
>;
