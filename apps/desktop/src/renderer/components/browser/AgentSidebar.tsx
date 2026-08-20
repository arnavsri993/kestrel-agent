import type { ReactNode } from "react";
import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import { agentWorkspaceName } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";
import { sidebarReviewVisible } from "./agent-sidebar";

export function AgentSidebar({
	children,
	communicationAssistant,
	workspace,
	sessions,
	activeSessionId,
	agentName,
	collapsed,
	agentState,
	pendingApprovals = 0,
	onNewAgent,
	onToggleAgent,
	onExpandChat,
	onReviewApprovals,
}: {
	children: ReactNode;
	communicationAssistant?: ReactNode;
	workspace?: ReactNode;
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	agentName: string;
	collapsed: boolean;
	agentState: AgentState;
	pendingApprovals?: number;
	onNewAgent(prompt?: string): void;
	onToggleAgent(): void;
	onExpandChat(): void;
	onReviewApprovals?(): void;
}) {
	const activeSession = sessions.find((session) => session.id === activeSessionId);
	const currentTaskTitle = activeSession
		? sessionTitleForDisplay(activeSession.title)
		: "New chat";
	const projectName = agentWorkspaceName(activeSession?.workspaceRoot);
	const showReview = Boolean(
		onReviewApprovals &&
			sidebarReviewVisible({
				agentState,
				pendingCount: pendingApprovals,
			}),
	);
	return (
		<aside
			className={`agent-sidebar ${collapsed ? "is-collapsed" : ""}`}
			aria-label={`${agentName} chat`}
			aria-hidden={collapsed}
			inert={collapsed}
		>
			<div className="agent-sidebar-header">
				<div className="agent-sidebar-drag" />
				<div className="agent-chat-toolbar">
					<button
						type="button"
						className="agent-sidebar-expand"
						aria-label="Open chat in the full window"
						title="Open chat in the full window"
						onClick={onExpandChat}
					>
						<Icon name="expand" />
					</button>
					<button
						type="button"
						className="agent-sidebar-new"
						aria-label="New chat"
						aria-keyshortcuts="Meta+N"
						title="New chat"
						onClick={() => onNewAgent()}
					>
						<Icon name="plus" />
					</button>
					<div className="agent-chat-heading">
						<strong title={currentTaskTitle}>{currentTaskTitle}</strong>
						<small title={projectName}>{projectName}</small>
					</div>
					<button
						type="button"
						className="agent-sidebar-collapse"
						aria-label={`Minimize ${agentName}`}
						title={`Minimize ${agentName}`}
						onClick={onToggleAgent}
					>
						<Icon name="chevron" />
					</button>
				</div>
				{showReview && (
					<button
						type="button"
						className="agent-approval-action"
						onClick={() => onReviewApprovals?.()}
					>
						<Icon name="alert-triangle-filled" />
						<span>Your decision is needed</span>
						<strong>Review</strong>
					</button>
				)}
			</div>
			<div className="agent-sidebar-assist">{communicationAssistant}</div>
			<div className="agent-sidebar-main">
				<div className="agent-full-page-workspace">{workspace}</div>
				<div className="agent-conversation-host">{children}</div>
			</div>
		</aside>
	);
}
