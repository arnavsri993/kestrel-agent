export interface OllamaModelSummary {
  name: string;
  size: number;
  modifiedAt?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeOllamaModels(value: unknown): OllamaModelSummary[] {
  const models = objectValue(value)?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) => {
    const record = objectValue(item);
    if (typeof record?.name !== "string" || !record.name.trim()) return [];
    return [{
      name: record.name,
      size:
        typeof record.size === "number" && Number.isFinite(record.size)
          ? Math.max(0, Math.floor(record.size))
          : 0,
      ...(typeof record.modified_at === "string"
        ? { modifiedAt: record.modified_at }
        : {}),
    }];
  });
}
