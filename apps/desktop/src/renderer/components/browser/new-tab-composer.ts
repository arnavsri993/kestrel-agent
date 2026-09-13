import type { RuntimeApprovalPolicy, SelectedAttachment } from "@kestrel/shared-types";
import type { ModelSelectorChoice } from "./model-selector";

export type NewTabComposerDraft = {
	prompt: string;
	workspaceRoot?: string;
	projectId?: string;
	modelChoice: ModelSelectorChoice;
	approvalPolicy: RuntimeApprovalPolicy;
	attachments: SelectedAttachment[];
};
