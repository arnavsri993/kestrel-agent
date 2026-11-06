// Only the trusted native owner supplies this selection identity. Neither a
// renderer request nor a project path can select or synthesize it.
export function nativeProjectHandoffArgument(argv) {
  const positions = argv.flatMap((value, index) => value === "--project-handoff-id" ? [index] : []);
  if (!positions.length) return undefined;
  const value = argv[positions[0] + 1];
  if (positions.length !== 1 || typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new Error("The native project handoff selection is invalid.");
  return value;
}
