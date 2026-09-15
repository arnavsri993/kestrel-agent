import { z } from "zod";

/** Exact resource identities supplied by trusted adapters, never wildcard grants. */
export const ResourceAccessSchema = z.object({
 connectionId: z.string().min(1).max(300),
 resourceId: z.string().min(1).max(1000),
 capability: z.enum(["read", "draft", "write", "send"]),
}).strict();
export type ResourceAccess = z.infer<typeof ResourceAccessSchema>;
export const ResourceScopeSchema = z.array(ResourceAccessSchema).max(500);
export function includesResource(scope: ResourceAccess[], resource: ResourceAccess): boolean {
 return scope.some(item => item.connectionId === resource.connectionId && item.resourceId === resource.resourceId && item.capability === resource.capability);
}
