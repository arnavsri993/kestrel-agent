export const FIRST_TASK_PROMPT_SIGNATURE =
	"I just finished Kestrel setup. Complete one guided read-only check";

export const FIRST_TASK_PROMPT = `${FIRST_TASK_PROMPT_SIGNATURE} with no network, browser, OAuth, or approvals.

Plan in at most three bullets, then:
- If this chat has a project folder: run workspace.list on ".", read one small manifest file (README.md or package.json), and state one concrete fact verified from its contents.
- Otherwise: call tools.search with query "read_only", report how many active tools were returned, and note that adding a project folder unlocks file inspection.

End with one sentence on what stayed local. Do not edit files, activate deferred tools, or suggest unrelated tasks. Finish in one turn if possible.`;

export const FIRST_TASK_SLOW_MODEL_NOTICE =
	"First local model turns can take 1–2 minutes while weights load. Kestrel is still working; cancel and retry if nothing changes after about 3 minutes.";

export function isFirstTaskPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(FIRST_TASK_PROMPT_SIGNATURE);
}
