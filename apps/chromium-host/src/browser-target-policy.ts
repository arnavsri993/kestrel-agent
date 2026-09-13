export type FormAction = { type: "type"; target: string; text: string } | { type: "click"; target: string };
export type FormTarget = { ref: string; backendId: number; role: string; name: string; revision: number; tag: string; inputType: string; autocomplete: string };

const sensitive = /password|passcode|\bpin\b|\botp\b|one.?time|verification|security.?code|credit.?card|card.?number|\bcvv\b|\bcvc\b|api.?key|access.?token|private.?key|social.?security|\bssn\b/i;
export function safeFormTarget(target: Pick<FormTarget, "tag" | "inputType" | "autocomplete" | "name">): boolean {
  if (sensitive.test(`${target.name} ${target.autocomplete}`) || /(?:^|\s)cc-/.test(target.autocomplete)) return false;
  return target.tag === "TEXTAREA" || (target.tag === "INPUT" && ["", "text", "search", "url", "email", "tel"].includes(target.inputType));
}
export function parseFormAction(value: unknown): FormAction {
  if (!value || typeof value !== "object") throw new Error("Invalid browser action.");
  const action = value as Record<string, unknown>;
  if (typeof action.target !== "string" || !/^e[1-9][0-9]{0,4}$/.test(action.target)) throw new Error("Use an inspected page ref. CSS selectors are unavailable in this host.");
  if (action.type === "click" && Object.keys(action).length === 2) return { type: "click", target: action.target };
  if (action.type === "type" && typeof action.text === "string" && action.text.length <= 20_000 && Object.keys(action).length === 3) return { type: "type", target: action.target, text: action.text };
  throw new Error("This host supports approved text entry and button clicks only.");
}
