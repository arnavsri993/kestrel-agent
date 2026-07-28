export function petTaskSessionRequest(prompt: string): {
  type: "runtime-create-session";
  title: string;
} {
  const task = prompt.trim();
  if (!task) throw new Error("Pet task prompt is required.");
  if (task.length > 10_000)
    throw new Error("Pet quick tasks are limited to 10,000 characters.");
  return {
    type: "runtime-create-session",
    title: `Pet · ${task.slice(0, 72)}`,
  };
}
