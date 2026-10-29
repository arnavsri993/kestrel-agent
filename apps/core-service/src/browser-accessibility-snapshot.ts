import { z } from "zod";
import { isSensitiveBrowserInteractiveRef } from "@kestrel/agent-core";
import { browserObservationText, browserObservationUrl } from "./browser-page-context";

const axText = z.union([z.string().max(10_000), z.object({ value: z.string().max(10_000) })]);
const ref = z.string().regex(/^e[1-9][0-9]{0,8}$/);
const node = z.object({
	nodeId: z.string().max(200).optional(),
	role: axText,
	name: axText.optional(),
	backendDOMNodeId: z.number().int().positive().optional(),
	ref: ref.optional(),
	ignored: z.boolean().optional(),
	properties: z.array(z.object({ name: z.string().max(100), value: z.object({ value: z.union([z.string().max(1_000), z.boolean(), z.number().finite()]).optional() }) })).max(100).optional(),
});
const schema = z.object({
	url: z.string().max(8_192), title: z.string().max(10_000),
	accessibilityTree: z.object({ nodes: z.array(node).max(10_000) }),
	interactive: z.array(z.object({ ref, role: z.string().max(100), name: z.string().max(1_000).optional(), backendDOMNodeId: z.number().int().positive().optional() })).max(200).optional(),
	truncated: z.boolean().optional(),
});
const value = (text: z.infer<typeof axText>) => typeof text === "string" ? text : text.value;

// Validate host observations independently. Only structural accessibility
// fields enter Core: form values, properties and rich AX name sources cannot
// arrive through an alternate host or a compromised page response.
export function normalizeBrowserAccessibilitySnapshot(raw: unknown) {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw new Error("The browser returned an invalid accessibility snapshot.");
	const snapshot = parsed.data;
	const url = snapshot.url === "about:blank" ? snapshot.url : browserObservationUrl(snapshot.url);
	if (!url) throw new Error("The selected tab does not have a safe readable URL.");
	const sensitiveTargets = new Set<string>();
	const sensitiveNode = (node: z.infer<typeof schema>["accessibilityTree"]["nodes"][number]) => isSensitiveBrowserInteractiveRef({ name: [node.name === undefined ? "" : value(node.name), ...(node.properties ?? []).map(property => `${property.name} ${property.value.value ?? ""}`)].join(" ") });
	for (const node of snapshot.accessibilityTree.nodes) if (sensitiveNode(node)) {
		if (node.ref) sensitiveTargets.add(node.ref);
		if (node.backendDOMNodeId) sensitiveTargets.add(`node:${node.backendDOMNodeId}`);
	}
	return { url, title: browserObservationText(snapshot.title, 500), truncated: Boolean(snapshot.truncated),
		accessibilityTree: { nodes: snapshot.accessibilityTree.nodes.map(({ properties, ...node }) => {
			const sensitive = sensitiveNode({ ...node, ...(properties ? { properties } : {}) });
			return { ...node, role: { value: browserObservationText(value(node.role), 100) },
				...(sensitive ? { name: { value: "Sensitive field" } } : node.name === undefined ? {} : { name: { value: browserObservationText(value(node.name), 500) } }),
			};
		}) },
		...(snapshot.interactive ? { interactive: snapshot.interactive.map(item => ({ ref: item.ref,
			role: browserObservationText(item.role, 100), ...(sensitiveTargets.has(item.ref) || sensitiveTargets.has(`node:${item.backendDOMNodeId}`) ? { name: "Sensitive field" } : item.name === undefined ? {} : { name: browserObservationText(item.name, 500) }),
			...(item.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: item.backendDOMNodeId }),
		})) } : {}),
		trust: "untrusted_browser" as const,
	};
}
